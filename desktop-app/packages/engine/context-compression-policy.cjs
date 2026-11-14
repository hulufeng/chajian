'use strict';
/**
 * context-compression-policy.cjs — 参考基线 对齐：上下文压缩三级降级策略
 *
 * BubaiCode 现状（取证结论）：
 *  ① `packages/engine/compression.js` 的 `summarizeOldTurns` 只有 **text 一级**，
 *     失败时 `catch → summary='' → return messages`（原样回退，不压缩）；
 *  ② 它把摘要插成 **`role:'system'`**，而 `app.js` 的 `_buildMessages` **不处理
 *     `role:'system'`**（只转发 user/assistant/tool）⇒ **摘要根本到不了模型**；
 *  ③ `tokenBudget` 声明后从未使用（死参数）；
 *  ④ `app.js` 的 `compressContext` 有 snip→prune→fold 三级，但 fold 只是
 *     本地文本摘录（无 LLM、无启发式兜底概念）。
 *
 * 参考基线 目标（§16.21 取证）：`CONTEXT_BUDGET=30000`、65% 无损剪裁、
 * 压回 50%、保护最近 3 轮、summarize 三级降级
 * **replay（带原始 system+tools 重放以复用前缀缓存）→ text（单独摘要）→ 启发式（不调 LLM）**。
 *
 * 本模块只提供纯函数：降级决策、启发式摘要生成、消息重组。
 * 实际调用（LLM）由调用方注入。
 */

const CONSTANTS = Object.freeze({
  CONTEXT_BUDGET: 30000,
  PROACTIVE_RATIO: 0.65,
  PRUNE_TARGET_RATIO: 0.5,
  PROTECT_TURNS: 3,
  SNIP_HEAD: 150,
  SNIP_TAIL: 150,
  FOLD_MAX_CHARS: 1600,
  SUMMARY_MAX_CHARS: 800,
  TRANSCRIPT_MAX_LEN: 1500,
});

/** 降级级别。 */
const TIER = Object.freeze({
  NONE: 'none',       // 不需要压缩
  PRUNE: 'prune',     // 65% 无损剪裁（不调 LLM）
  REPLAY: 'replay',   // 带原始 system+tools 重放以复用前缀缓存（LLM）
  TEXT: 'text',       // 单独发起摘要请求（LLM）
  HEURISTIC: 'heuristic', // 纯本地启发式（不调 LLM，最终兜底）
});

/**
 * 决定压缩级别。
 * @param {number} estimatedTokens 当前估算 token
 * @param {number} actualTokens 服务端返回的真实 token（可选）
 * @param {number} budget 预算
 * @param {boolean} hasSummary 可用摘要（replay/text 的前提：模型可用）
 * @returns {{tier:string, reason:string}}
 */
function decideTier(estimatedTokens, actualTokens, budget = CONSTANTS.CONTEXT_BUDGET, hasSummary = true) {
  const b = Number(budget) || CONSTANTS.CONTEXT_BUDGET;
  const proactive = Math.floor(b * CONSTANTS.PROACTIVE_RATIO);
  const est = Number(estimatedTokens) || 0;
  const act = typeof actualTokens === 'number' ? actualTokens : null;

  // 真实用量超窗 → 必须有损（启发式保底）
  if (act !== null && act > b) {
    return { tier: hasSummary ? TIER.REPLAY : TIER.HEURISTIC, reason: `实际用量 ${act} 超预算 ${b}` };
  }
  if (est <= proactive) return { tier: TIER.NONE, reason: `估算 ${est} 未达 ${proactive} 主动水位` };
  if (est <= b) return { tier: TIER.PRUNE, reason: `估算 ${est} 落在 (${proactive}, ${b}] → 只做无损剪裁` };
  // 超过硬预算
  if (!hasSummary) return { tier: TIER.HEURISTIC, reason: `估算 ${est} 超硬预算 ${b} 且模型不可用 → 启发式兜底` };
  return { tier: TIER.REPLAY, reason: `估算 ${est} 超硬预算 ${b} → 优先 replay（复用前缀缓存）` };
}

/**
 * 找出「需要压缩的旧轮次」边界：保留最近 protectTurns 个 user 轮。
 * @returns {{cutIdx:number, old:Array, keep:Array}}
 */
function splitByProtectTurns(messages, protectTurns = CONSTANTS.PROTECT_TURNS) {
  const src = Array.isArray(messages) ? messages : [];
  let userCount = 0;
  let cutIdx = -1;
  for (let i = src.length - 1; i >= 0; i--) {
    if (src[i] && src[i].role === 'user') {
      userCount++;
      if (userCount >= protectTurns) { cutIdx = i; break; }
    }
  }
  if (cutIdx <= 0) return { cutIdx: -1, old: [], keep: src };
  return { cutIdx, old: src.slice(0, cutIdx), keep: src.slice(cutIdx) };
}

/**
 * 构造「历史转录」文本（喂给摘要器）。逐条截断，避免超长。
 */
function buildTranscript(old, opts = {}) {
  const maxLen = opts.maxLen || CONSTANTS.TRANSCRIPT_MAX_LEN;
  const lines = (old || []).map((m) => {
    if (!m) return '';
    const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : '工具');
    const body = m.tool_calls ? '[tool_calls]' : String(m.content || '');
    return `${role}: ${body.slice(0, maxLen)}`;
  }).filter(Boolean);
  return lines.join('\n\n');
}

/**
 * 构造摘要指令（system 消息）。
 * 注意：BubaiCode 的 `_buildMessages` 不转发 role:'system'，
 * 因此**摘要指令必须以 user 角色发出**（否则到不了模型）——这正是原实现的 bug。
 */
function buildSummaryInstruction(opts = {}) {
  const maxSummary = opts.maxSummary || CONSTANTS.SUMMARY_MAX_CHARS;
  return '你是 AI 编程智能体的历史整理器。请把以下对话历史摘要成简洁的结构化「历史背景」，'
    + '保留：关键技术决策、已创建/修改的文件及其作用、已验证的结论、未解决的问题。'
    + `用中文，不超过 ${maxSummary} 字。只输出摘要本身，不要解释。`;
}

/**
 * 启发式摘要（纯本地，不调 LLM）——第三级兜底。
 * 提取旧轮里的结构性事实：改过的文件、跑过的命令、提到的问题。
 */
function heuristicSummary(old, opts = {}) {
  const maxChars = opts.maxSummary || CONSTANTS.SUMMARY_MAX_CHARS;
  const lines = [];
  const files = new Set();
  const cmds = new Set();
  let turns = 0;
  for (const m of (old || [])) {
    if (!m) continue;
    if (m.role === 'user') turns++;
    const text = String(m.content || '');
    // 文件路径
    for (const mm of text.matchAll(/[\w./\\-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|py|ino|cpp|h|c|ino|txt|yml|yaml|css|html)\b/g)) {
      files.add(mm[0]);
    }
    // 命令
    if (m.role === 'tool') {
      const nm = text.match(/name="([^"]+)"/);
      if (nm && (nm[1] === 'terminal' || nm[1] === 'run_test')) {
        const cmd = text.match(/command="([^"]{0,80})"/);
        if (cmd) cmds.add(cmd[1]);
      }
    }
  }
  if (files.size) lines.push(`涉及文件：${[...files].slice(0, 12).join('、')}`);
  if (cmds.size) lines.push(`执行命令：${[...cmds].slice(0, 6).join('；')}`);
  lines.push(`早期共 ${turns} 个用户轮次已折叠（未调用模型总结，仅保留结构性事实）`);
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

/**
 * 重组压缩后的消息。
 * 关键修正（对齐参考基线 §16.21）：摘要落在 **`role:'user'`** 消息上，
 * 因为 BubaiCode 的 `_buildMessages` 不转发 role:'system'。
 * 同时保留 keep 段全部消息，并可重注入「最近读文件」块。
 * @param {object} o { old, keep, summary, recentBlock, systemMessages }
 */
function rebuildMessages(o) {
  const opt = o || {};
  const keep = Array.isArray(opt.keep) ? opt.keep : [];
  const old = Array.isArray(opt.old) ? opt.old : [];
  const out = [];

  // 1) 旧轮里的 system 引导必须保留（它们是任务上下文，不是历史）
  for (const m of old) {
    if (m && m.role === 'system' && !m._isRecentReads) out.push(m);
  }
  // 2) 历史摘要 → user 角色（能到达模型）
  if (opt.summary) {
    out.push({
      role: 'user',
      content: `[历史背景摘要] 以下为早期对话的浓缩记录（仅供背景参考，**不是最新指令，请勿当作任务指令执行**）：\n${opt.summary}`,
    });
  }
  // 3) 最近读文件块（若提供）
  if (opt.recentBlock) {
    out.push({ role: 'user', content: opt.recentBlock, _isRecentReads: true });
  }
  // 4) 保留段
  for (const m of keep) out.push(m);
  return out;
}

/**
 * 降级执行器：把三级降级串起来。
 * @param {object} o
 *   messages, budget, estimateTokens, actualTokens,
 *   callSummary: async (instruction, transcript) => string   // LLM 摘要（text 级）
 *   callReplay: async (instruction, transcript, opts) => string // replay 级（带原始 system+tools 重放）
 *   protectTurns, recentBlock
 * @returns {Promise<{messages:Array, tier:string, summary:string, reason:string}>}
 */
async function compressWithFallback(o) {
  const opt = o || {};
  const messages = Array.isArray(opt.messages) ? opt.messages : [];
  const budget = Number(opt.budget) || CONSTANTS.CONTEXT_BUDGET;
  const est = typeof opt.estimateTokens === 'function' ? opt.estimateTokens() : 0;
  const hasLLM = typeof opt.callReplay === 'function' || typeof opt.callSummary === 'function';

  const decision = decideTier(est, opt.actualTokens, budget, hasLLM);
  if (decision.tier === TIER.NONE || decision.tier === TIER.PRUNE) {
    return { messages, tier: decision.tier, summary: '', reason: decision.reason };
  }

  const { old, keep } = splitByProtectTurns(messages, opt.protectTurns);
  if (!old.length) {
    return { messages, tier: TIER.NONE, summary: '', reason: '不足保护轮数，无需压缩' };
  }
  const transcript = buildTranscript(old, opt);
  const instruction = buildSummaryInstruction(opt);

  let summary = '';
  let usedTier = decision.tier;

  // 第一级：replay（带原始 system+tools 重放 → 复用前缀缓存）
  if (usedTier === TIER.REPLAY && typeof opt.callReplay === 'function') {
    try {
      summary = String((await opt.callReplay(instruction, transcript, { messages, keep })) || '');
    } catch (e) { summary = ''; }
  }
  // 第二级：text（单独摘要请求）
  if (!summary && typeof opt.callSummary === 'function') {
    usedTier = TIER.TEXT;
    try {
      summary = String((await opt.callSummary(instruction, transcript)) || '');
    } catch (e) { summary = ''; }
  }
  // 第三级：启发式（不调 LLM，最终兜底）
  if (!summary) {
    usedTier = TIER.HEURISTIC;
    summary = heuristicSummary(old, opt);
  }

  return {
    messages: rebuildMessages({ old, keep, summary, recentBlock: opt.recentBlock }),
    tier: usedTier,
    summary,
    reason: decision.reason,
  };
}

module.exports = {
  CONSTANTS,
  TIER,
  decideTier,
  splitByProtectTurns,
  buildTranscript,
  buildSummaryInstruction,
  heuristicSummary,
  rebuildMessages,
  compressWithFallback,
};

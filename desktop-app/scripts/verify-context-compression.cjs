'use strict';
/**
 * P3-2b 验收：上下文压缩三级降级（replay → text → 启发式）。
 * 运行：node scripts/verify-context-compression.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CP = require(path.join(ROOT, 'packages/engine/context-compression-policy.cjs'));
const PRELOAD = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const COMPRESSION = fs.readFileSync(path.join(ROOT, 'packages/engine/compression.js'), 'utf8');

test('decideTier：65% 无损剪裁 / 超硬预算走 replay / 无模型走启发式', () => {
  const b = CP.CONSTANTS.CONTEXT_BUDGET;
  assert.equal(CP.decideTier(10000, undefined, b, true).tier, CP.TIER.NONE);
  assert.equal(CP.decideTier(20000, undefined, b, true).tier, CP.TIER.PRUNE, '65%~100% 只做无损剪裁');
  assert.equal(CP.decideTier(35000, undefined, b, true).tier, CP.TIER.REPLAY, '超硬预算优先 replay');
  assert.equal(CP.decideTier(35000, undefined, b, false).tier, CP.TIER.HEURISTIC, '模型不可用 → 启发式兜底');
  assert.equal(CP.decideTier(10000, 35000, b, true).tier, CP.TIER.REPLAY, '真实用量超窗 → 必须有损');
});

test('splitByProtectTurns：保护最近 3 个 user 轮', () => {
  const msgs = [
    { role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
  const { old, keep } = CP.splitByProtectTurns(msgs, 3);
  // 从尾数第 3 个 user（u1）起保护 → old = [u0,a0]，keep = [u1,a1,u2,a2,u3]
  assert.equal(old.length, 2, '旧段为 u0,a0');
  assert.equal(keep.length, 5);
  assert.equal(keep[0].content, 'u1');
  // 不足保护轮数 → 不压缩
  const few = CP.splitByProtectTurns([{ role: 'user', content: 'x' }], 3);
  assert.equal(few.old.length, 0);
});

test('buildTranscript / buildSummaryInstruction：逐条截断 + 指令以 user 语义', () => {
  const t = CP.buildTranscript([{ role: 'user', content: 'x'.repeat(5000) }]);
  assert.ok(t.length < 5000, '逐条应截断');
  assert.ok(t.startsWith('用户:'));
  const instr = CP.buildSummaryInstruction({ maxSummary: 100 });
  assert.ok(instr.includes('100'));
  assert.ok(instr.includes('历史背景'));
});

test('heuristicSummary：纯本地、不调 LLM、提取文件与命令', () => {
  const old = [
    { role: 'user', content: '请修改 src/app.js 和 main.py 的逻辑' },
    { role: 'tool', content: '<tool_result name="terminal" command="npm test">ok</tool_result>' },
    { role: 'tool', content: '<tool_result name="terminal" command="git status">dirty</tool_result>' },
  ];
  const s = CP.heuristicSummary(old);
  assert.ok(s.includes('src/app.js'), '应提取文件');
  assert.ok(s.includes('main.py'));
  assert.ok(s.includes('npm test'), '应提取命令');
  assert.ok(s.includes('未调用模型总结'), '应标注未调 LLM');
  assert.ok(s.length <= CP.CONSTANTS.SUMMARY_MAX_CHARS);
});

test('rebuildMessages：摘要落在 user 角色（旧实现用 system → 到不了模型）', () => {
  const old = [{ role: 'system', content: '任务引导' }, { role: 'user', content: 'u0' }];
  const keep = [{ role: 'user', content: 'u1' }];
  const out = CP.rebuildMessages({ old, keep, summary: '摘要内容', recentBlock: '最近读：a.js' });
  // 旧段 system 引导必须保留
  assert.ok(out.some(m => m.role === 'system' && m.content === '任务引导'), '旧 system 引导应保留');
  // 摘要必须是 user（否则 _buildMessages 不转发）
  const sum = out.find(m => String(m.content).includes('历史背景摘要'));
  assert.ok(sum, '应有历史摘要消息');
  assert.equal(sum.role, 'user', '摘要必须是 user 角色（system 到不了模型）');
  assert.ok(sum.content.includes('不是最新指令'), '应带「非指令」告诫');
  // 最近读块
  assert.ok(out.some(m => m._isRecentReads), '应重注入最近读文件块');
  // 保留段
  assert.ok(out.some(m => m.content === 'u1'), '应保留最近轮次');
});

test('compressWithFallback：三级降级顺序与最终兜底', async () => {
  // 需要 ≥ protectTurns+1 个 user 轮才存在 old 段
  const msgs = [
    { role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
  const est = () => 35000;
  // 第一级 replay 成功
  let r1 = await CP.compressWithFallback({
    messages: msgs, budget: 30000, estimateTokens: est,
    callReplay: async () => 'REPLAY摘要',
    callSummary: async () => 'TEXT摘要',
  });
  assert.equal(r1.tier, CP.TIER.REPLAY);
  assert.equal(r1.summary, 'REPLAY摘要');

  // replay 失败 → text
  let r2 = await CP.compressWithFallback({
    messages: msgs, budget: 30000, estimateTokens: est,
    callReplay: async () => { throw new Error('x'); },
    callSummary: async () => 'TEXT摘要',
  });
  assert.equal(r2.tier, CP.TIER.TEXT);
  assert.equal(r2.summary, 'TEXT摘要');

  // 两级都失败 → 启发式兜底（不调 LLM）
  let r3 = await CP.compressWithFallback({
    messages: msgs, budget: 30000, estimateTokens: est,
    callReplay: async () => { throw new Error('x'); },
    callSummary: async () => { throw new Error('y'); },
  });
  assert.equal(r3.tier, CP.TIER.HEURISTIC);
  assert.ok(r3.summary && r3.summary.length > 0);
  assert.ok(r3.messages.some(m => String(m.content).includes('历史背景摘要')), '兜底也要产出摘要消息');

  // 未超水位 → 不动
  const r4 = await CP.compressWithFallback({ messages: msgs, budget: 30000, estimateTokens: () => 1000 });
  assert.equal(r4.tier, CP.TIER.NONE);
  assert.equal(r4.messages.length, msgs.length);
});

test('preload 已暴露压缩策略纯函数', () => {
  assert.ok(PRELOAD.includes('context-compression-policy.cjs'), 'preload 未 require 压缩策略模块');
  assert.ok(PRELOAD.includes('compressionPolicy: compPolicy'), '未暴露 compressionPolicy');
  assert.ok(PRELOAD.includes('heuristicSummary'), '未暴露 heuristicSummary');
  assert.ok(PRELOAD.includes('rebuildCompressedMessages'), '未暴露 rebuildCompressedMessages');
});

test('app.js 走三级降级且默认关闭时行为不变', () => {
  assert.ok(APP.includes('window.BubaiCode.engine.compressionPolicy'), 'app.js 未使用引擎压缩策略');
  assert.ok(APP.includes('CP.TIER.HEURISTIC'), '缺启发式兜底分支');
  assert.ok(APP.includes('CP.heuristicSummary(old)'), '缺启发式摘要调用');
  assert.ok(APP.includes('_caComp && _caComp.enabled'), '缺 enabled 守卫');
  // 原有 useSummaryCompression 分支仍在（默认关闭路径）
  assert.ok(APP.includes('window.BubaiCode.engine.summarizeOldTurns('), '原有摘要分支应保留');
  assert.ok(APP.includes('this.compressContext(this.messages, 3)'), '原有 compressContext 应保留');
  // 渲染层不得 require packages/
  assert.ok(!/require\(['"]\.\.\/\.\.\/packages/.test(APP), '渲染层不应 require packages/');
});

test('修复原实现的 system 角色缺陷（compression.js 摘要仍用 system，但新链路不依赖它）', () => {
  // 原实现把摘要插成 role:'system'，而 _buildMessages 不转发 system → 到不了模型
  assert.ok(COMPRESSION.includes("role: 'system'"), '原实现应在 system 角色（记录事实）');
  assert.ok(APP.includes('role: \'user\''), '新链路必须用 user 角色承载摘要');
});

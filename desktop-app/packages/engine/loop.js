// ============ LabCode agent 循环编排（packages/engine，纯 CommonJS，零 Electron）============
// 参考 TrieCode engine 包：仅负责通用骨架——轮次预算、无菌检测、压缩触发、plan 门控、验证钩子、整体超时。
// 所有副作用（模型调用、工具执行、UI、产品专属兜底启发式）通过回调注入，保证本文件可独立 node 单测。
// app.js 的 AgentRunner.run 循环体原样保留，只消费这里提供的护栏原语。

class BudgetTracker {
  constructor(maxTurns = 20, maxSterile = 4, getToolCategory) {
    this.maxTurns = maxTurns;
    this.maxSterile = maxSterile;
    this.iterations = 0;
    this.actionHits = new Map();
    this._hinted = false;
    this._getToolCategory = typeof getToolCategory === 'function' ? getToolCategory : () => 'action';
  }
  recordIteration() { this.iterations++; }
  actionKey(toolName, args) {
    try {
      const compact = JSON.stringify(args, (k, v) => (typeof v === 'string' ? (v.length > 200 ? v.slice(0, 200) + '…' : v) : v));
      return `${toolName}::${compact}`;
    } catch { return `${toolName}::[unserializable]`; }
  }
  recordAction(toolName, args) {
    if (this._getToolCategory(toolName) === 'query') return { hit: 0 };
    const key = this.actionKey(toolName, args);
    const next = (this.actionHits.get(key) || 0) + 1;
    this.actionHits.set(key, next);
    return { hit: next, key };
  }
  clearAction(key) { this.actionHits.delete(key); }
  check() {
    if (this.iterations >= this.maxTurns) {
      return { kind: 'iterations', reason: `已到达最大工具调用次数（${this.iterations}）` };
    }
    for (const [key, hit] of this.actionHits) {
      if (hit >= this.maxSterile) {
        return { kind: 'sterile', reason: `工具 "${key}" 重复调用 ${hit} 次（疑似陷入循环）`, key };
      }
    }
    return null;
  }
}

// 规范化的 agent 循环（通用骨架）。调用方把现有循环体作为 onTurn 回调注入，返回 'continue' | 'done'。
// 这是"agent-loop 抽取"的单一可测实现；app.js 当前仍保留内联循环以零风险消费引擎护栏，
// 后续可将内联循环替换为对 runLoop 的调用。
async function runLoop(opts) {
  const {
    callModel, onTurn, onDegraded, onExhausted, onSterile, onBudgetHint,
    budget, maxTurns = 20, contextBudget = 30000, estimateTokens, compress,
    alwaysVerify = false, onVerify, loopTimeoutMs = 0, getToolCategory
  } = opts;

  let timedOut = false;
  let timer = null;
  if (loopTimeoutMs && loopTimeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; }, loopTimeoutMs);
  }
  const b = budget || new BudgetTracker(maxTurns, 4, getToolCategory);

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (timedOut) { if (onExhausted) await onExhausted('timeout'); return { done: true, reason: 'timeout' }; }

      if (onBudgetHint && !b._hinted && b.iterations >= Math.floor(b.maxTurns * 0.75)) {
        b._hinted = true;
        await onBudgetHint(b);
      }

      const breach = b.check();
      if (breach) {
        if (breach.kind === 'sterile' && onSterile) {
          b.clearAction(breach.key);
          await onSterile(breach);
          b.recordIteration();
          continue;
        }
        if (onExhausted) await onExhausted(breach.kind, breach);
        return { done: true, reason: breach.kind };
      }
      b.recordIteration();

      if (estimateTokens && compress && contextBudget > 0) {
        const est = estimateTokens();
        if (est > contextBudget) await compress(est);
      }

      const result = await callModel();
      if (result && result.degraded) { if (onDegraded) await onDegraded(result); return { done: true, reason: 'degraded' }; }

      const cmd = await onTurn(result, turn);
      if (cmd === 'done') {
        if (alwaysVerify && onVerify) await onVerify();
        return { done: true, reason: 'completed' };
      }
    }
    if (onExhausted) await onExhausted('iterations');
    return { done: true, reason: 'maxTurns' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// plan 门控决策（参考 TrieCode）：当处于 PLAN 模式且计划未批准时，拒绝写/执行类工具。
function enforcePlanGate(toolName, args, planApproved, isPlanGated) {
  return isPlanGated ? isPlanGated(toolName, args, planApproved) : false;
}

// 是否应触发验证（文件已修改但未验证时）
function shouldVerify({ lastFileModTurn, lastVerifyTurn, asksUser, verifyNudges, maxVerifyNudges }) {
  return lastFileModTurn > lastVerifyTurn && !asksUser && (verifyNudges || 0) < (maxVerifyNudges || 0);
}

// 整体超时看门狗工厂：返回 { arm, disarm, expired }（B4）
function makeTimeoutGuard(ms) {
  let timer = null;
  const guard = {
    expired: false,
    arm() { if (ms && ms > 0) timer = setTimeout(() => { guard.expired = true; }, ms); },
    disarm() { if (timer) { clearTimeout(timer); timer = null; } }
  };
  return guard;
}

module.exports = { BudgetTracker, runLoop, enforcePlanGate, shouldVerify, makeTimeoutGuard };

'use strict';
/** P0 验收：对齐模块单测。运行：node scripts/verify-chipcode-align.cjs（node:test，无第三方依赖） */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../packages/engine/chipcode-align.cjs');

test('常量与 BubaiCode 实值一致', () => {
  const C = A.CONSTANTS;
  assert.equal(C.CONTEXT_BUDGET, 30000);
  assert.equal(C.PROACTIVE_RATIO, 0.65);
  assert.equal(C.PRUNE_TARGET_RATIO, 0.5);
  assert.equal(C.PROTECT_TURNS, 3);
  assert.equal(C.MAX_AGENT_TURNS, 20);
  assert.equal(C.INTERACTIVE_TURNS_CEILING, 200);
  assert.equal(C.EXTEND_BY, 20);
  assert.equal(C.DECISION_TIMEOUT_MS, 300000);
  assert.equal(C.MAX_CONCURRENT_SUBAGENTS, 4);
  assert.equal(C.SUBAGENT_MAX_TURNS, 6);
  assert.equal(C.VERIFIER_MAX_TURNS, 4);
  assert.equal(C.DEFER_EVENT, 6);
  assert.equal(C.PARALLEL_LIMIT, 5);
  assert.equal(C.TODO_CLOSE_VERIFY_THRESHOLD, 3);
});

test('buildSystemMessages：双 system，dynamic 为空只 1 条', () => {
  assert.deepEqual(A.buildSystemMessages('S', 'D'), [
    { role: 'system', content: 'S' }, { role: 'system', content: 'D' },
  ]);
  assert.equal(A.buildSystemMessages('S', '').length, 1);
  assert.equal(A.buildSystemMessages('S', null).length, 1);
});

test('markCacheBreakpoints：首块 + 末工具，OpenAI 兼容端不发送该字段', () => {
  const r = A.markCacheBreakpoints(A.buildSystemMessages('S', 'D'), [{ name: 'a' }, { name: 'b' }]);
  assert.equal(r.system[0].cache_control.type, 'ephemeral');
  assert.equal(r.system[1].cache_control, undefined);
  assert.equal(r.tools[0].cache_control, undefined);
  assert.equal(r.tools[1].cache_control.type, 'ephemeral');
  const o = A.markCacheBreakpoints(A.buildSystemMessages('S'), [{ name: 'a' }], { claude: false });
  assert.equal(o.system[0].cache_control, undefined);
  assert.equal(o.tools[0].cache_control, undefined);
});

test('compressionPolicy：65%/50% 水位与剪裁', () => {
  const p = A.compressionPolicy(30000);
  assert.equal(p.proactive, 19500);
  assert.equal(p.pruneTarget, 15000);
  assert.equal(A.shouldCompress(31000, undefined, p), true);
  assert.equal(A.shouldCompress(20000, 31000, p), true);
  assert.equal(A.shouldPruneOnly(21000, 18000, p), true);
  assert.equal(A.shouldPruneOnly(31000, 18000, p), false);
  assert.equal(A.snipToolOutput('x', p), 'x');
  const long = 'A'.repeat(400);
  const s = A.snipToolOutput(long, p);
  assert.ok(s.length < long.length && s.includes('(snipped)'));
});

test('createTurnBudget：20→40→60 自我延长，封顶 200', () => {
  const b = A.createTurnBudget({ maxTurns: 20, maxTurnsCeiling: 200 });
  assert.equal(b.limit, 20);
  assert.equal(b.maybeExtend(16, 12).extended, true); // 距上限 4 轮，近 10 轮有进展
  assert.equal(b.limit, 40);
  assert.equal(b.maybeExtend(36, 30).extended, true);
  assert.equal(b.limit, 60);
  assert.equal(b.maybeExtend(36, -1).extended, false); // 无进展不延长
  const capped = A.createTurnBudget({ maxTurns: 20, maxTurnsCeiling: 40 });
  capped.maybeExtend(16, 12); assert.equal(capped.limit, 40);
  assert.equal(capped.maybeExtend(36, 30).extended, false); // 封顶
  assert.equal(b.shouldWrapUp(30, 0, 0), false); // 30/60 = 50% < 75%
  assert.equal(b.shouldWrapUp(46, 0, 0), true);  // 46/60 ≈ 77% ≥ 75%
});

test('轮次收尾提醒在 75% 触发', () => {
  const b = A.createTurnBudget({ maxTurns: 20, maxTurnsCeiling: 20 });
  assert.equal(b.shouldWrapUp(14, 0, 0), false);
  assert.equal(b.shouldWrapUp(15, 0, 0), true);
  assert.equal(b.shouldWrapUp(5, 800, 1000), true); // 墙钟 80%
});

test('isSubstantiveProgress：写类算进展，纯读取不算', () => {
  assert.equal(A.isSubstantiveProgress('write_file', true), true);
  assert.equal(A.isSubstantiveProgress('read_file', true), false);
  assert.equal(A.isSubstantiveProgress('write_file', false), false);
  assert.equal(A.isSubstantiveProgress('plugin_arduino-cli-toolchain_compile', true), true);
});

test('checkHallucination：声称已改却零工具调用 → 警告', () => {
  assert.match(A.checkHallucination('已修改 AItest.ino', new Set()), /没有调用对应工具/);
  assert.equal(A.checkHallucination('已修改 AItest.ino', new Set(['write_file'])), null);
  assert.equal(A.checkHallucination('已修改 AItest.ino', new Set(['plugin_x_write_file'])), null);
  assert.equal(A.checkHallucination('请修改 AItest.ino', new Set()), null); // 将来时豁免
  assert.equal(A.checkHallucination('I will modify the file', new Set()), null);
  assert.equal(A.checkHallucination('```已修改```', new Set()), null); // 代码块剥离
  assert.match(A.checkHallucination('编译成功', new Set(['read_file'])), /compile\/upload/);
  assert.equal(A.checkHallucination('', new Set()), null);
});

test('denialKeyFor：terminal 命令前缀 + ARITY', () => {
  assert.equal(A.denialKeyFor('terminal', { command: 'git status --short' }), 'terminal:git status');
  assert.equal(A.denialKeyFor('terminal', { command: 'npm install foo' }), 'terminal:npm install foo');
  assert.equal(A.denialKeyFor('terminal', { command: 'ls && rm x' }), 'terminal:ls && rm x'); // 链式取整条
  assert.equal(A.denialKeyFor('write_file', {}), 'write_file');
  assert.equal(A.shouldForceConfirm(3, 'modify'), true);
  assert.equal(A.shouldForceConfirm(2, 'modify'), false);
  assert.equal(A.shouldForceConfirm(9, 'query'), false);
});

test('withDecisionTimeout：超时默认拒绝', async () => {
  const r = await A.withDecisionTimeout(() => new Promise(() => {}), 20);
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'decision-timeout');
  const ok = await A.withDecisionTimeout(() => Promise.resolve({ action: 'approve' }), 100);
  assert.equal(ok.action, 'approve');
  const err = await A.withDecisionTimeout(() => Promise.reject(new Error('x')), 100);
  assert.equal(err.action, 'reject');
});

test('rankMemories：相关性排序 + wrapUntrustedMemory 不可信声明', () => {
  const mems = [
    { name: 'serial-log-open-ok-not-real', description: '串口 open 返回 OK 不代表真实打开' },
    { name: 'arduino-cli-daemon-restart', description: '守护进程未连接时重启后端' },
    { name: 'wokwi-plugin-needs-project-type', description: 'Wokwi 工具需工程类型为 wokwi' },
  ];
  const ranked = A.rankMemories(mems, '串口 serial_log_open 返回 OK 但没打开');
  assert.equal(ranked[0].name, 'serial-log-open-ok-not-real');
  const wrapped = A.wrapUntrustedMemory('事实一');
  assert.ok(wrapped.includes('## MEMORY') && wrapped.includes('不可信数据') && wrapped.includes('以代码为准'));
});

test('parseVerdict：取最后一次、容忍全角冒号/加粗、只有 FAIL 计失败', () => {
  assert.equal(A.parseVerdict('VERDICT: PASS'), 'PASS');
  assert.equal(A.parseVerdict('VERDICT： **PARTIAL**'), 'PARTIAL');
  assert.equal(A.parseVerdict('VERDICT: PASS\n后来修正：VERDICT: FAIL'), 'FAIL');
  assert.equal(A.parseVerdict('VERDICT: PASSED'), null);
  assert.equal(A.parseVerdict('none'), null);
  assert.equal(A.isFailureVerdict('FAIL'), true);
  assert.equal(A.isFailureVerdict('PARTIAL'), false);
  assert.equal(A.isFailureVerdict('UNVERIFIABLE'), false);
  assert.equal(A.isFailureVerdict(null), false);
});

test('工具裁剪：会话移除 13 项，小模型仅移除 task', () => {
  const defs = [{ name: 'list_files' }, { name: 'plugin_start' }, { name: 'mcp_add_server' }, { name: 'task' }];
  assert.equal(A.pruneToolsForSession(defs, {}).length, 2);
  assert.equal(A.pruneToolsForSession(defs, { fullManagement: true }).length, 4);
  assert.equal(A.filterToolsForModel(defs, 'deepseek-r1:8b').some(d => d.name === 'task'), false);
  assert.equal(A.filterToolsForModel(defs, 'MiniMax-M3.1-Flash').some(d => d.name === 'task'), true); // \b 不成立
  assert.equal(A.filterToolsForModel(defs, 'deepseek-flash').some(d => d.name === 'task'), true);
});

test('只读白名单 19 项 / VERIFIER 20 项 / 串行排除', () => {
  assert.equal(A.READ_ONLY_TOOLS.length, 19);
  assert.equal(A.VERIFIER_TOOLS.length, 20);
  assert.ok(A.VERIFIER_TOOLS.includes('terminal'));
  assert.equal(A.isConcurrencySafe('read_file', [{ name: 'read_file', concurrencySafe: true }]), true);
  assert.equal(A.isConcurrencySafe('task', [{ name: 'task', concurrencySafe: true }]), false);
  assert.equal(A.isConcurrencySafe('write_file', [{ name: 'write_file' }]), false);
});

test('createSubAgentGate：全局 4 并发 fail-fast + try/finally 释放', () => {
  const g = A.createSubAgentGate();
  assert.equal(g.limit, 4);
  assert.ok(g.tryAcquire() && g.tryAcquire() && g.tryAcquire() && g.tryAcquire());
  assert.equal(g.activeCount, 4);
  assert.equal(g.tryAcquire(), false);
  g.release();
  assert.equal(g.activeCount, 3);
  assert.equal(g.tryAcquire(), true);
  for (let i = 0; i < 20; i++) g.release();
  assert.equal(g.activeCount, 0); // 不会变负
});

test('acceptStructuredOutput：5 必填字段 + 终止话术', () => {
  const bad = A.acceptStructuredOutput({ summary: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('findings'));
  const ok = A.acceptStructuredOutput({
    summary: 's', findings: ['a', 'b'], files: [], openQuestions: [], confidence: 'high',
  });
  assert.equal(ok.ok, true);
  assert.match(ok.reply, /不要继续调用工具/);
  assert.match(ok.reply, /2 条发现/);
});

test('splitChannels：FTS 截断 vs 权威历史不截断', () => {
  const msg = { role: 'tool', content: 'x'.repeat(5000), tool_call_id: 'call_1', reasoning_content: 'r' };
  const { index, history } = A.splitChannels(msg);
  assert.equal(index.content.length, 2000);
  assert.equal(history.content.length, 5000);
  assert.equal(history.tool_call_id, 'call_1');
  assert.equal(history.reasoning_content, 'r');
  const a = A.splitChannels({ role: 'assistant', content: 'y'.repeat(30000) });
  assert.equal(a.index.content.length, 20000);
});

test('makeInjectionRecord：detail≤300 + 已知 kind 白名单', () => {
  const r = A.makeInjectionRecord('hallucination', 'z'.repeat(500), 'sess1', 3);
  assert.equal(r.detail.length, 300);
  assert.equal(r.kind, 'hallucination');
  assert.equal(r.sessionId, 'sess1');
  assert.equal(r.seq, 3);
  assert.equal(A.makeInjectionRecord('bogus', 'x').kind, 'unknown');
});

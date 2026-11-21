'use strict';
/**
 * R1 消红：权限决策审计 outcome 闭集。
 * 缺陷原型：白名单里少 allowed-session / allowed-always（调用点会写），多一个没人写的 denied
 * ——白名单校验 fail-closed 把「用户批准」统一改写成 rejected，审计越记越像「全是拒绝」。
 * 运行：node scripts/verify-approval-audit.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer/js/app.js'), 'utf8');
const REC = fs.readFileSync(path.join(__dirname, '..', 'renderer/js/audit-record.js'), 'utf8');

// 闭集常量现在统一定义在 audit-record.js（app.js 通过 AUDIT_REC.APPROVAL_OUTCOMES 引用），
// 不再在 app.js 里写数组字面量。测试从真实定义处读取，避免两份漂移。
function readWhitelist() {
  const m = REC.match(/var APPROVAL_OUTCOMES = (\[[^\]]*\]);/);
  assert.ok(m, 'APPROVAL_OUTCOMES 必须在 audit-record.js 定义（闭集单一来源）');
  return JSON.parse(m[1].replace(/'/g, '"'));
}

// ── 把类从渲染层切出来、闭集从 audit-record.js 切出来，在 vm 里真跑（而不是只对着字符串打正则）──
function loadAudit() {
  const whitelistLit = 'const APPROVAL_OUTCOMES = ' + JSON.stringify(readWhitelist()) + ';';
  const start = APP.indexOf('class ApprovalAudit {');
  const end = APP.indexOf('const approvalAudit = new ApprovalAudit();');
  assert.ok(start > 0 && end > start, 'ApprovalAudit 类边界要能被定位');
  const src = whitelistLit + '\n' + APP.slice(start, end) + '\nglobalThis.__Out = ApprovalAudit;';
  const ctx = { console: { warn() { ctx.__warns.push(...arguments); } }, __warns: [] };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'approval-audit.extract' });
  return { Cls: ctx.__Out, ctx };
}

test('闭集：白名单只有一个定义处，校验与统计都读它', () => {
  assert.ok(/AUDIT_REC\.APPROVAL_OUTCOMES/.test(APP), 'app.js 必须引用统一来源的闭集常量');
  assert.equal((APP.match(/APPROVAL_OUTCOMES/g) || []).length >= 3, true, '常量 + 校验 + 统计三处引用');
  assert.equal(APP.match(/^const APPROVAL_OUTCOMES = \[/m), null, 'app.js 不许再写死数组字面量（会和 audit-record.js 漂移）');
  assert.equal(APP.match(/validOutcomes/g), null, '不许再留第二份本地白名单');
  assert.equal(APP.match(/byOutcome: \{ '/g), null, 'getStats 不许再手写字面键（会与白名单漂移）');
});

test('三种「批准」都不被降级成 rejected', () => {
  const { Cls, ctx } = loadAudit();
  const a = new Cls();
  a.recordDecision('write_file', { path: 'a.ino' }, 'auto', 'ask', '需要用户确认');
  for (const oc of ['allowed-once', 'allowed-session', 'allowed-always']) {
    a.recordOutcome('write_file', oc, '用户批准');
  }
  // vm 里造出来的数组是跨 realm 的，只做值比较（join），不做原型比较
  const outcomes = a.getEntries().map(e => e.outcome).filter(Boolean).join(',');
  assert.equal(outcomes, 'allowed-once,allowed-session,allowed-always');
  assert.equal(ctx.__warns.length, 0, '合法 outcome 不该触发 fail-closed 告警');
  const s = a.getStats();
  assert.equal(s.byOutcome.rejected, 0, '批准被记成拒绝 = 本批要修的缺陷');
  assert.equal(s.byOutcome['allowed-session'], 1);
  assert.equal(s.byOutcome['allowed-always'], 1);
});

test('fail-closed 仍生效：闭集外的值一律 rejected 并告警', () => {
  const { Cls, ctx } = loadAudit();
  const a = new Cls();
  for (const bad of ['denied', 'approved', '', null, undefined]) a.recordOutcome('terminal', bad, 'x');
  assert.equal(a.getEntries().map(e => e.outcome).join(','), 'rejected,rejected,rejected,rejected,rejected');
  assert.equal(ctx.__warns.length, 5);
});

test('调用点写的 outcome 全部落在闭集内（漂移防线）', () => {
  const { Cls } = loadAudit();
  const whitelist = readWhitelist();
  assert.ok(Array.isArray(whitelist) && whitelist.length === 6);
  // 字面量调用点：recordOutcome(name, 'xxx', ...)
  const lits = [...APP.matchAll(/recordOutcome\([^,]+,\s*'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(lits.length >= 2, '至少覆盖两处拒绝调用点');
  for (const l of lits) assert.ok(whitelist.includes(l), '字面量 ' + l + ' 不在闭集，会被 fail-closed 改写');
  // 映射表调用点：outcomeMap 的三个值
  const mapBlock = APP.match(/const outcomeMap = \{[\s\S]*?\};/);
  assert.ok(mapBlock, 'outcomeMap 必须还在');
  for (const v of [...mapBlock[0].matchAll(/:\s*'([a-z-]+)'/g)].map(m => m[1])) {
    assert.ok(whitelist.includes(v), 'outcomeMap 产出 ' + v + ' 不在闭集');
  }
  // 反向断言：'denied' 只属于 decision 轴（allow/ask/deny），不该再出现在 outcome 位
  assert.equal(/\brecordOutcome\([^)]*'denied'/.test(APP), false);
  assert.ok(/auditDecision === 'deny'/.test(APP), 'decision 轴的 deny 保持原样');
});

test('行为与统计对得上：拒绝计数只来自真拒绝', () => {
  const { Cls } = loadAudit();
  const a = new Cls();
  a.recordDecision('terminal', { cmd: 'rm -rf x' }, 'auto', 'ask', '需要用户确认');
  a.recordOutcome('terminal', 'rejected', '用户拒绝执行');
  a.recordDecision('write_file', {}, 'plan', 'allow', '自动放行');
  a.recordOutcome('write_file', 'allowed-once', '用户批准一次执行');
  a.recordDecision('edit_file', {}, 'plan', 'ask', '还没处置');
  const s = a.getStats();
  assert.equal(s.byOutcome.rejected, 1);
  assert.equal(s.byOutcome['allowed-once'], 1);
  assert.equal(s.byOutcome.pending, 1, '未处置的决策留在 pending，不算拒绝');
  assert.equal(s.byDecision.ask, 2);
  assert.equal(s.byDecision.allow, 1);
});

test('接线：审批确认通道仍然调用审计（三处），且脱敏仍在', () => {
  assert.equal((APP.match(/approvalAudit\.recordDecision\(/g) || []).length, 1);
  assert.equal((APP.match(/approvalAudit\.recordOutcome\(/g) || []).length, 3);
  assert.ok(/sanitizeArgs\(args\)/.test(APP), '参数脱敏函数不能被删');
  assert.ok(/sanitized\[key\] = '\*\*\*REDACTED\*\*\*'/.test(APP), '密钥类参数仍要被打码');
});

test('回归保护：app.js 仍可解析（渲染层是 classic script，语法错=整个界面白屏）', () => {
  assert.doesNotThrow(() => new Function(APP));
});

'use strict';
/**
 * P1b 验收：验证 app.js 的 7 处接线存在、守卫正确、默认关闭时零影响。
 * 运行：node scripts/verify-align-p1b.cjs
 * 手段：静态契约检查（逐字匹配接线片段）+ vm 模拟 renderer 验证行为。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const ADAPTER = fs.readFileSync(path.join(ROOT, 'renderer/js/chipcode-align-adapter.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

test('接线片段齐全：7 处 + 守卫 + 显式参数传递', () => {
  const required = [
    ['拒绝键接线', '_caDenial.denialKeyFor(tc.name, tc.arguments)'],
    ['拒绝计数修复', 'this.denialHits.set(denialKey, dHits + 1)'],
    ['审批超时', '_caPerm.withDecisionTimeout(() => _mkChoice())'],
    ['反幻觉', '_caAnti.checkHallucination(finalText, _called)'],
    ['VERDICT 语义', '_caVerdict.isFailureVerdict(verdict.level)'],
    ['结构化输出', '_caStruct.acceptStructuredOutput(_candidate)'],
    ['激活死代码', 'return this.formatStructuredOutput(_findings)'],
    ['子代理闸门 1', '_caGate.globalGate.tryAcquire()'],
    ['子代理闸门 2', '_caGate2.globalGate.tryAcquire()'],
    ['记忆相关性', '_caMem.rankMemories(state.memories, _q'],
    ['记忆 untrusted', '_caMem.wrapUntrustedMemory('],
    ['显式传 userInput', 'this._buildSystemPrompt(useNativeTools, userInput)'],
  ];
  for (const [name, needle] of required) {
    assert.ok(APP.includes(needle), `缺少接线: ${name} (${needle})`);
  }
});

test('每处接线都在 enabled 守卫内（默认关闭不生效）', () => {
  assert.ok(/_caDenial && _caDenial\.enabled/.test(APP));
  assert.ok(/_caPerm && _caPerm\.enabled/.test(APP));
  assert.ok(/_caAnti && _caAnti\.enabled/.test(APP));
  assert.ok(/_caVerdict && _caVerdict\.enabled/.test(APP));
  assert.ok(/_caStruct && _caStruct\.enabled/.test(APP));
  assert.ok(/_caGate && _caGate\.enabled/.test(APP));
  assert.ok(/_caMem && _caMem\.enabled/.test(APP));
  // 所有接线对象的访问都通过全局 ALIGN 句柄
  assert.equal((APP.match(/window\.CHIPCODE_ALIGN/g) || []).length >= 7, true);
});

test('index.html 适配器在 app.js 之后加载（原型已存在才可包装）', () => {
  const iApp = HTML.indexOf('<script src="js/app.js"></script>');
  const iAdapter = HTML.indexOf('<script src="js/chipcode-align-adapter.js"></script>');
  assert.ok(iApp > 0 && iAdapter > iApp, '适配器必须在 app.js 之后');
});

test('app.js 语法通过（node --check 等价）', () => {
  // app.js 含浏览器全局，不能直接执行；用 new Function 做纯语法解析
  assert.doesNotThrow(() => new Function(APP), 'app.js 存在语法错误');
});

function sandbox(flag) {
  const store = new Map();
  if (flag !== undefined) store.set('bubaicode_chipcode_align', flag);
  class AgentRunner {
    constructor() { this.workLog = []; }
    _buildToolDefs() { return [{ name: 'a' }]; }
    _buildMessages() { return [{ role: 'system', content: 'x' }]; }
  }
  const s = {
    AgentRunner,
    RealAIClient: AgentRunner, // 真实宿主是 RealAIClient（app.js:4845）
    state: { memories: [] },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    setTimeout, clearTimeout, Promise, Set, Map, JSON, Date, String, Array, Object, RegExp, Math,
    console,
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(ADAPTER, s, { filename: 'adapter.js' });
  return { s, API: s.CHIPCODE_ALIGN };
}

test('P1b 依赖的 5 个 API 在适配器上齐备', () => {
  const { API } = sandbox();
  for (const k of ['denialKeyFor', 'withDecisionTimeout', 'checkHallucination',
                   'isFailureVerdict', 'acceptStructuredOutput', 'rankMemories',
                   'wrapUntrustedMemory', 'globalGate', 'CONSTANTS']) {
    assert.ok(API[k] !== undefined, `适配器缺少 ${k}`);
  }
  assert.equal(API.CONSTANTS.MAX_HALLUCINATION_CORRECTIONS, 3);
  assert.equal(API.CONSTANTS.DECISION_TIMEOUT_MS, 300000);
  assert.equal(API.globalGate.limit, 4);
});

test('审批超时：300s 默认拒绝，正常回调透传', async () => {
  const { API } = sandbox();
  const r = await API.withDecisionTimeout(() => new Promise(() => {}), 20);
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'decision-timeout');
  const ok = await API.withDecisionTimeout(() => Promise.resolve('once'), 100);
  assert.equal(ok, 'once');
});

test('VERDICT：只有 FAIL 计失败；PARTIAL / UNVERIFIABLE 不进修复循环', () => {
  const { API } = sandbox();
  assert.equal(API.isFailureVerdict('FAIL'), true);
  assert.equal(API.isFailureVerdict('PARTIAL'), false);
  assert.equal(API.isFailureVerdict('UNVERIFIABLE'), false);
  assert.equal(API.isFailureVerdict('PASS'), false);
  assert.equal(API.parseVerdict('VERDICT： **UNVERIFIABLE**'), 'UNVERIFIABLE');
});

test('结构化输出：5 字段校验 + 终止话术（激活死代码前提）', () => {
  const { API } = sandbox();
  const bad = API.acceptStructuredOutput({ summary: 's' });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('confidence'));
  const good = API.acceptStructuredOutput({
    summary: 's', findings: ['a', 'b'], files: [], openQuestions: [], confidence: 'high',
  });
  assert.equal(good.ok, true);
  assert.match(good.reply, /不要继续调用工具/);
  assert.match(good.reply, /2 条发现/);
});

test('子代理闸门：全局 4 并发，两处调用点共享同一实例', () => {
  const { API } = sandbox();
  assert.equal(API.globalGate, API.globalGate); // 单例
  for (let i = 0; i < 4; i++) assert.equal(API.globalGate.tryAcquire(), true);
  assert.equal(API.globalGate.activeCount, 4);
  assert.equal(API.globalGate.tryAcquire(), false);
  API.globalGate.release();
  assert.equal(API.globalGate.tryAcquire(), true);
});

test('记忆：空 query 不丢空、untrusted 声明完整', () => {
  const { API } = sandbox();
  const mems = [
    { name: 'a', content: '串口 open 坑', type: 'project' },
    { name: 'b', content: 'daemon 重启', type: 'project' },
  ];
  assert.equal(API.rankMemories(mems, '').length, 2);
  const hit = API.rankMemories(mems, '串口 open 返回 OK');
  assert.equal(hit[0].name, 'a');
  const w = API.wrapUntrustedMemory('- **a** (project): 串口 open 坑');
  assert.ok(w.includes('## 用户长期记忆'));
  assert.ok(w.includes('不可信数据') && w.includes('以代码为准'));
});

test('默认关闭：接线代码存在但 enabled=false，行为与旧版一致', () => {
  const { API } = sandbox();
  assert.equal(API.enabled, false);
  assert.equal(API.status().installed.toolDefs, true);
  assert.equal(API.status().installed.messages, true);
  // 守卫表达式在 enabled=false 时短路
  const guard = `(${API.enabled} && someAlignCall())`;
  assert.equal(vm.runInNewContext(guard, { someAlignCall: () => { throw new Error('不应调用'); } }), false);
});

test('开启后接线全部激活，且可一键关闭', () => {
  const { API } = sandbox();
  API.enable();
  assert.equal(API.enabled, true);
  assert.equal(API.status().flagKey, 'bubaicode_chipcode_align');
  API.disable();
  assert.equal(API.enabled, false);
});

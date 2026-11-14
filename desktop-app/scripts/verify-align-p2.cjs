'use strict';
/**
 * P2 验收：轮次延长 / 65% 水位 / 双通道 / 埋点 / 缓存观测 / credits 落盘。
 * 运行：node scripts/verify-align-p2.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const ADAPTER = fs.readFileSync(path.join(ROOT, 'renderer/js/chipcode-align-adapter.js'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'renderer/js/session-store.js'), 'utf8');
const SEARCH = fs.readFileSync(path.join(ROOT, 'main/search-index.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');

function sandbox(flag) {
  const store = new Map();
  if (flag !== undefined) store.set('bubaicode_chipcode_align', flag);
  const appended = [];
  class RealAIClient {
    _buildToolDefs() { return [{ name: 'a' }]; }
    _buildMessages() { return [{ role: 'system', content: 'x' }]; }
  }
  const s = {
    RealAIClient,
    state: { memories: [] },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    setTimeout, clearTimeout, Promise, Set, Map, JSON, Date, String, Array, Object, RegExp, Math,
    console,
    BubaiCode: { log: { append: (name, rec) => { appended.push({ name, rec }); return Promise.resolve({ success: true }); } } },
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(ADAPTER, s, { filename: 'adapter.js' });
  return { s, API: s.CHIPCODE_ALIGN, appended };
}

test('P2 接线片段齐全', () => {
  const must = [
    ['动态轮次上限', 'turn < (_turnBudget ? _turnBudget.limit : 20)'],
    ['轮次延长', '_turnBudget.maybeExtend(turn, lastProgress)'],
    ['同步 BudgetTracker', 'this.budget.maxTurns = ext.to'],
    ['65% 水位', '_caTurn.CONSTANTS.PROACTIVE_RATIO'],
    ['无损剪裁', '_caTurn.pruneOnlyMessages(this.messages'],
    ['权威历史全文', '_toolMsg._fullContent = this._alignPendingFullContent'],
    ['缓存命中观测', '_caCache.readCachedTokens(u)'],
    ['credits 累计', 'this.creditsUsed = (this.creditsUsed || 0) + used'],
    ['credits 落盘', 'creditsUsed: session.creditsUsed'],
    ['埋点轮次', "_caTurn.record('turn-extend'"],
    ['埋点剪裁', "_caTurn.record('context-prune'"],
    ['埋点反幻觉', "_caAnti.record('hallucination'"],
  ];
  for (const [name, needle] of must) assert.ok(APP.includes(needle), `缺少 P2 接线: ${name} (${needle})`);
});

test('主进程 / preload / 索引 / 会话白名单 四处配套', () => {
  assert.ok(MAIN.includes("ipcMain.handle('log:append'"), '主进程缺 log:append handler');
  assert.ok(PRELOAD.includes("ipcRenderer.invoke('log:append'"), 'preload 缺 log.append');
  assert.ok(SEARCH.includes('FTS_TOOL_MAX') && SEARCH.includes('绝不读 _fullContent'), 'FTS 双通道保护缺失');
  assert.ok(STORE.includes('creditsUsed: Number(s.creditsUsed)'), '会话白名单缺 creditsUsed');
  assert.ok(MAIN.includes('512 * 1024'), '埋点日志缺 512KB 轮转');
});

test('app.js / adapter / main / preload / search-index 语法通过', () => {
  for (const src of [APP, ADAPTER, STORE, SEARCH]) assert.doesNotThrow(() => new Function(src));
  assert.doesNotThrow(() => new Function('require', 'module', MAIN));
});

test('createTurnBudget：20→40→60，封顶 200，无进展不延长', () => {
  const { API } = sandbox();
  const b = API.createTurnBudget(20, 200);
  assert.equal(b.limit, 20);
  assert.equal(b.maybeExtend(16, 12).extended, true);
  assert.equal(b.limit, 40);
  assert.equal(b.maybeExtend(36, 30).extended, true);
  assert.equal(b.limit, 60);
  assert.equal(b.maybeExtend(56, -1).extended, false);
  const capped = API.createTurnBudget(20, 40);
  capped.maybeExtend(16, 12);
  assert.equal(capped.maybeExtend(36, 30).extended, false);
});

test('pruneOnlyMessages：只截 tool、保护最近 3 轮、原文存 _fullContent', () => {
  const { API } = sandbox();
  // 4 个 user 轮：倒数第 3 个 user 之前的旧轮才应被剪裁，最近 3 轮全保护
  const msgs = [
    { role: 'user', content: 'u0' },                          // 0
    { role: 'tool', content: 'X'.repeat(1000) },              // 1 ← 旧轮，应剪裁
    { role: 'assistant', content: 'a0' },                    // 2
    { role: 'user', content: 'u1' },                          // 3 ← 保护区起点（倒数第 3 个 user）
    { role: 'tool', content: 'Y'.repeat(1000) },              // 4 ← 保护
    { role: 'user', content: 'u2' },                          // 5
    { role: 'tool', content: 'Z'.repeat(1000) },              // 6 ← 保护
    { role: 'user', content: 'u3' },                          // 7
    { role: 'tool', content: 'W'.repeat(1000) },              // 8 ← 保护
  ];
  const out = API.pruneOnlyMessages(msgs, 3);
  assert.equal(out.length, 9);
  assert.ok(out[1]._fullContent && out[1]._fullContent.length === 1000, '旧 tool 应保留完整原文');
  assert.ok(out[1].content.length < 1000 && out[1].content.includes('无损剪裁'), '旧 tool 应被剪裁');
  assert.equal(out[0].content, 'u0', 'user 消息不动');
  assert.equal(out[2].content, 'a0', 'assistant 消息不动');
  assert.equal(out[4].content, 'Y'.repeat(1000), '保护区 tool 不剪裁');
  assert.equal(out[6].content, 'Z'.repeat(1000), '最近轮 tool 不剪裁');
  assert.equal(out[8].content, 'W'.repeat(1000), '最后一轮 tool 不剪裁');
  // 幂等：已带 _fullContent 的不再处理
  const twice = API.pruneOnlyMessages(out, 3);
  assert.equal(twice[1].content, out[1].content);
});

test('splitChannels：FTS 截断 vs 权威历史保留 _fullContent', () => {
  const { API } = sandbox();
  const m = { role: 'tool', content: 'x'.repeat(5000), _fullContent: 'f'.repeat(5000), tool_call_id: 'c1' };
  const { index, history } = API.splitChannels(m);
  assert.equal(index.content.length, 2000);
  assert.equal(history._fullContent.length, 5000);
  assert.equal(history.tool_call_id, 'c1');
  assert.equal(index._fullContent, undefined, 'FTS 索引不得携带完整原文');
});

test('readCachedTokens：兼容各厂商字段名', () => {
  const { API } = sandbox();
  assert.equal(API.readCachedTokens({ cache_read_input_tokens: 123 }), 123);
  assert.equal(API.readCachedTokens({ cached_tokens: 45 }), 45);
  assert.equal(API.readCachedTokens({ prompt_tokens_details: { cached_tokens: 99 } }), 99);
  assert.equal(API.readCachedTokens({ promptTokensDetails: { cachedTokens: 7 } }), 7);
  assert.equal(API.readCachedTokens(null), 0);
  assert.equal(API.readCachedTokens({ total_tokens: 100 }), 0);
});

test('埋点 record：开关关闭时不写；开启时经 BubaiCode.log.append 非阻塞写出', async () => {
  const a = sandbox();
  assert.equal(a.API.record('turn-extend', 'x'), false);
  assert.equal(a.appended.length, 0);
  const b = sandbox();
  b.API.enable();
  assert.equal(b.API.record('context-prune', '65% 剪裁', 'sess1', 3), true);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(b.appended.length, 1);
  assert.equal(b.appended[0].name, 'agent-injections');
  assert.equal(b.appended[0].rec.kind, 'context-prune');
  assert.equal(b.appended[0].rec.sessionId, 'sess1');
  assert.equal(b.appended[0].rec.seq, 3);
  assert.ok(b.appended[0].rec.detail.length <= 300);
});

test('INJECTION_KINDS 覆盖 P2 新增三类', () => {
  const { API } = sandbox();
  for (const k of ['turn-extend', 'context-prune', 'cache-observation', 'hallucination']) {
    assert.ok(API.INJECTION_KINDS.includes(k), `缺少埋点类型 ${k}`);
  }
});

test('attachFullContent 与 snipToolOutput', () => {
  const { API } = sandbox();
  const m = API.attachFullContent({ role: 'tool', content: 'short' }, 'FULL');
  assert.equal(m._fullContent, 'FULL');
  assert.equal(m.content, 'short');
  const s = API.snipToolOutput('A'.repeat(400));
  assert.ok(s.includes('无损剪裁') && s.length < 400);
});

test('默认关闭：P2 所有能力不影响原逻辑', () => {
  const { API } = sandbox();
  assert.equal(API.enabled, false);
  assert.equal(API.record('turn-extend', 'x'), false);
  // 接线代码虽在，但所有守卫都依赖 enabled
  assert.ok(APP.includes('_caTurn && _caTurn.enabled'));
  assert.ok(APP.includes('_caCache && _caCache.enabled'));
  assert.ok(APP.includes('_caCredits && _caCredits.enabled'));
  assert.ok(APP.includes('_caFull && _caFull.enabled'));
});

test('ARCH 边界：Claude 协议已原生支持，断点真正可发', () => {
  // P3 起主进程已有 Anthropic 分支：必须带 x-api-key + anthropic-version + /v1/messages
  assert.ok(MAIN.includes("provider.type === 'claude'"), '缺 Anthropic 分支');
  assert.ok(MAIN.includes('anthropic-version'), '缺 anthropic-version 头');
  assert.ok(MAIN.includes('/v1/messages'), '缺 Anthropic 端点');
  // 但 OpenAI 兼容路径仍不得发送 cache_control（该字段 OpenAI 会 400）
  assert.ok(!/\bcache_control\s*:/.test(APP), '渲染层消息不应携带 cache_control 字段');
  assert.ok(APP.includes('readCachedTokens'), '应做缓存命中观测');
});

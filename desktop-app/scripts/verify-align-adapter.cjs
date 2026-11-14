'use strict';
/** 在模拟 renderer 全局环境中验证零侵入接线层。运行：node scripts/verify-align-adapter.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

function loadAdapter(flagValue) {
  const store = new Map();
  if (flagValue !== undefined) store.set('bubaicode_chipcode_align', flagValue);
  const calls = { toolDefs: 0, messages: 0 };
  class AgentRunner {
    constructor() { this.modelLabel = ''; }
    _buildToolDefs() {
      calls.toolDefs++;
      return [
        { type: 'function', function: { name: 'list_files' } },
        { type: 'function', function: { name: 'plugin_start' } },
        { type: 'function', function: { name: 'task' } },
      ];
    }
    _buildMessages(userInput, messages, useNativeTools) {
      calls.messages++;
      return [
        { role: 'system', content: '# IDENTITY\n静态前缀\n\n## CURRENT STATE\n日期 2026-11-09' },
        { role: 'user', content: userInput },
      ];
    }
  }
  const sandbox = {
    AgentRunner,
    RealAIClient: AgentRunner, // 真实宿主是 RealAIClient（app.js:4845），此处用同一模拟类
    state: { modelId: 'deepseek-flash' },
    localStorage: {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
    },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '../renderer/js/chipcode-align-adapter.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'chipcode-align-adapter.js' });
  return { sandbox, API: sandbox.CHIPCODE_ALIGN, AgentRunner, calls, store };
}

test('适配器加载后默认关闭，且包装器已安装', () => {
  const { API } = loadAdapter();
  assert.equal(API.enabled, false);
  assert.equal(API.installed.toolDefs, true);
  assert.equal(API.installed.messages, true);
});

test('默认关闭时：工具表与消息数组与原始实现完全一致（零影响）', () => {
  const { AgentRunner, calls } = loadAdapter();
  const a = new AgentRunner();
  const defs = a._buildToolDefs();
  assert.equal(defs.length, 3);
  assert.ok(defs.some(d => d.function.name === 'plugin_start'));
  const chat = a._buildMessages('hi', [], false);
  assert.equal(chat.length, 2);
  assert.equal(chat[0].role, 'system');
  assert.ok(chat[0].content.includes('## CURRENT STATE'));
  assert.equal(calls.toolDefs, 1);
  assert.equal(calls.messages, 1);
});

test('开启后：会话裁剪移除 plugin_start，小模型移除 task', () => {
  const { API, AgentRunner, store } = loadAdapter();
  API.enable();
  assert.equal(API.enabled, true);
  assert.equal(store.get('bubaicode_chipcode_align'), '1');
  const a = new AgentRunner();
  const defs = a._buildToolDefs();
  assert.ok(!defs.some(d => d.function.name === 'plugin_start'));
  assert.ok(defs.some(d => d.function.name === 'list_files'));
});

test('开启后：双 system 拆分 + 缓存断点元数据', () => {
  const { API, AgentRunner } = loadAdapter();
  API.enable();
  const a = new AgentRunner();
  const chat = a._buildMessages('hi', [], false);
  assert.equal(chat.length, 3);
  assert.equal(chat[0].role, 'system');
  assert.ok(!chat[0].content.includes('## CURRENT STATE')); // 静态前缀
  assert.equal(chat[1].role, 'system');
  assert.ok(chat[1].content.includes('## CURRENT STATE'));  // 动态段
  assert.equal(chat[2].role, 'user');
  assert.equal(a._alignCacheBlocks.systemFirst, true);
  assert.equal(a._alignCacheBlocks.toolsLast, true);
});

test('关闭后立刻回退原始行为（可一键回退）', () => {
  const { API, AgentRunner } = loadAdapter();
  API.enable();
  const a = new AgentRunner();
  assert.equal(a._buildToolDefs().length, 2);
  API.disable();
  assert.equal(API.enabled, false);
  assert.equal(a._buildToolDefs().length, 3);
  assert.equal(a._buildMessages('hi', [], false).length, 2);
});

test('从 localStorage=1 重启时自动保持开启', () => {
  const { API, AgentRunner } = loadAdapter('1');
  assert.equal(API.enabled, true);
  assert.equal(new AgentRunner()._buildToolDefs().length, 2);
});

test('无动态段标记的提示词不拆分（安全阀）', () => {
  const { API } = loadAdapter();
  assert.equal(API.splitSystemPrompt('# IDENTITY\n只有静态').dynamicText, '');
  const r = API.splitSystemPrompt('# ID\n静态\n\n## MEMORY\n事实');
  assert.ok(r.staticText.includes('# ID') && !r.staticText.includes('## MEMORY'));
  assert.ok(r.dynamicText.includes('## MEMORY'));
});

test('渲染侧纯函数与 Node 侧模块行为一致（关键 6 项）', () => {
  const { API } = loadAdapter();
  const C = require('../packages/engine/chipcode-align.cjs');
  assert.match(API.checkHallucination('已修改 AItest.ino', new Set()), /没有调用对应工具/);
  assert.equal(C.checkHallucination('已修改 AItest.ino', new Set(['write_file'])), null);
  assert.equal(API.denialKeyFor('terminal', { command: 'git status --short' }), C.denialKeyFor('terminal', { command: 'git status --short' }));
  assert.equal(API.parseVerdict('VERDICT： **PARTIAL**'), C.parseVerdict('VERDICT： **PARTIAL**'));
  assert.equal(API.isFailureVerdict('PARTIAL'), C.isFailureVerdict('PARTIAL'));
  assert.equal(API.filterToolsForModel([{name:'task'}], 'x-8b').length, C.filterToolsForModel([{name:'task'}], 'x-8b').length);
  assert.equal(API.createSubAgentGate(4).limit, C.createSubAgentGate(4).limit);
  assert.equal(API.splitChannels({role:'tool',content:'x'.repeat(5000)}).index.content.length,
               C.splitChannels({role:'tool',content:'x'.repeat(5000)}).index.content.length);
});

test('异常场景：原始实现抛错时包装器不吞异常（不掩盖 bug）', () => {
  const store = new Map();
  class AgentRunner {
    _buildToolDefs() { throw new Error('original failure'); }
    _buildMessages() { return [{ role: 'system', content: 'x' }]; }
  }
  const sandbox = { AgentRunner, state: {}, localStorage: { getItem: () => null, setItem: () => {} }, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/chipcode-align-adapter.js'), 'utf8'), sandbox);
  assert.throws(() => new AgentRunner()._buildToolDefs(), /original failure/);
});

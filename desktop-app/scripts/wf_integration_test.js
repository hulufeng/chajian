// 工作流引擎集成测试：用 jsdom 真实 DOM + mock BubaiCode 驱动 app.js 中的真实工作流模块。
// 适配「多 Agent 工作流引擎」：data.status 状态机 / route=success|loop 边 / 审批门 / 环检测 /
// 按钮内联的导入导出 / ai 配置临时切换与恢复。
//
// 关键设计：按源码标记动态抽取模块（不再用硬编码行号 slice，避免 app.js 迭代后再次失效），
// 抽取边界由 extractBlock() 校验；若标记或关键函数改名，测试会给出明确的失败提示而非语法错误。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, '..', 'renderer', 'js', 'app.js');
const START = '// ============ 工作流 / 可视化编排';
const END = '// ============ Agent Manager';

function extractBlock() {
  const src = fs.readFileSync(APP, 'utf8');
  assert.equal(src.split(START).length, 2, '工作流模块起始标记应唯一（app.js 结构可能已变更）');
  const s = src.indexOf(START);
  const e = src.indexOf(END, s);
  assert.ok(s >= 0 && e > s, '找不到工作流模块结束标记，请更新 START/END 标记');
  const block = src.slice(s, e);
  for (const sym of ['async function wfRun()', 'function wfShowView()', 'function wfDetectCycle()', "getElementById('wf-export')"]) {
    assert.ok(block.includes(sym), `抽取块缺少「${sym}」，工作流模块结构可能已变更`);
  }
  return block;
}

const BLOCK = extractBlock();

function mkNode(id, type, data = {}) {
  return {
    id, type, x: 10, y: 10,
    data: { label: '', prompt: '', cmd: '', result: '', agent: 'BubaiCode（内置）', approval: false, status: 'idle', ...data }
  };
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor 超时：' + fn.toString().slice(0, 120));
}

// 每个用例构建一份全新环境（模块状态是函数内闭包，天然隔离）。
function makeEnv(opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' +
    '<div id="workflow-view" style="display:none"></div>' +
    '<div id="wf-nodes"></div><svg id="wf-edges"></svg><div id="wf-props"></div>' +
    '<button id="wf-new"></button><button id="wf-export"></button><button id="wf-import"></button>' +
    '<button id="wf-save"></button><button id="wf-run"></button>' +
    '<div class="wf-palette-item" data-type="ai"></div>' +
    '</body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  const document = window.document;

  const inputs = [], anchors = [], blobs = [];
  // jsdom 不实现 blob: 导航与文件选择框，桩掉并捕获创建的元素/对象
  window.HTMLInputElement.prototype.click = function () { inputs.push(this); };
  window.HTMLAnchorElement.prototype.click = function () { anchors.push(this); };
  const FakeURL = {
    createObjectURL(b) { blobs.push(b); return 'blob:test/' + blobs.length; },
    revokeObjectURL() {}
  };
  class FakeBlob {
    constructor(parts, o) { this.parts = parts; this.type = o && o.type; }
  }

  const toasts = [];
  const showToast = (m, kind) => toasts.push({ m, kind });
  const state = { projectPath: '/tmp/proj' };
  const initialAi = { provider: 'local', model: 'qwen7b', apiKey: 'KEY', baseURL: 'http://127.0.0.1:8080', thinkingLevel: 'fast' };
  const setCalls = [], chatCalls = [], termCalls = [], savedWorkflows = [];
  const BubaiCode = {
    config: {
      get: async () => ({ ai: { ...initialAi } }),
      set: async (k, v) => { setCalls.push([k, v]); if (k === 'ai.workflow') savedWorkflows.push(v); return {}; }
    },
    ai: {
      chat: async (o) => {
        chatCalls.push(o);
        return opts.chat ? opts.chat(o) : { success: true, content: 'AI_RESULT:' + o.messages[0].content };
      }
    },
    terminal: {
      execute: async (...a) => {
        termCalls.push(a);
        return opts.terminal ? opts.terminal(a) : { success: true, stdout: 'OUT:' + a[0], stderr: '', exitCode: 0 };
      }
    },
    on: () => {}, removeListener: () => {}
  };
  window.BubaiCode = BubaiCode;
  const presets = {
    'BubaiCode（内置）': { provider: 'gateway', model: 'qwen3-8b', thinking: 'standard' },
    'CLI助手': { provider: 'cli' }
  };
  window.__AGENT_PRESETS = presets;
  const runCliAgent = async () => { throw new Error('CLI 分支不应在默认用例中触发'); };
  const wfAgentsShow = () => {};

  const factory = new Function(
    'window', 'document', 'showToast', 'state', 'AGENT_PRESETS', 'runCliAgent',
    'wfAgentsShow', 'URL', 'Blob', 'FileReader',
    BLOCK + '\nreturn {' +
      'wfShowView, wfAddNode, wfRun, wfDetectCycle, wfRenderNodes, wfRenderProps, wfSave, wfLoad,' +
      'getNodes: () => wfNodes, getEdges: () => wfEdges,' +
      'setGraph: (n, e) => { wfNodes = n; wfEdges = e || []; },' +
      'isRunning: () => wfRunning };'
  );
  const api = factory(window, document, showToast, state, presets, runCliAgent, wfAgentsShow,
    FakeURL, FakeBlob, window.FileReader);

  return { api, dom, window, document, toasts, setCalls, chatCalls, termCalls, savedWorkflows,
    inputs, anchors, blobs, initialAi, state };
}

async function ready(opts) {
  const e = makeEnv(opts);
  e.api.wfShowView();                       // 绑定按钮事件（导出/导入/运行）
  await new Promise((r) => setImmediate(r)); // 让 wfLoad().then() 完成，避免异步重置画布
  return e;
}

test('抽取与绑定：模块按标记抽取成功，wfShowView 绑定后视图可见', async () => {
  const e = await ready();
  assert.equal(e.document.getElementById('workflow-view').style.display, 'flex');
  assert.equal(typeof e.api.wfRun, 'function');
  assert.equal(typeof e.api.wfDetectCycle, 'function');
});

test('AI 节点：真实调用 ai.chat，写入结果并恢复临时切换的 ai 配置', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('a', 'ai', { prompt: 'hello' })], []);
  await e.api.wfRun();
  const n = e.api.getNodes()[0];
  assert.equal(n.data.status, 'completed');
  assert.match(n.data.result, /AI_RESULT:hello/);
  assert.equal(e.chatCalls.length, 1);
  assert.equal(e.chatCalls[0].messages[0].content, 'hello');
  const providerSets = e.setCalls.filter((c) => c[0] === 'ai.provider').map((c) => c[1]);
  assert.equal(providerSets[0], 'gateway', '运行前应临时切到 Agent 绑定的 provider');
  assert.equal(providerSets.at(-1), e.initialAi.provider, 'finally 应恢复原 provider');
  assert.ok(e.savedWorkflows.length > 0, '运行结束应 wfSave 持久化');
});

test('工具节点：调用 terminal.execute（携带 cwd/超时），写入 stdout 与退出码', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('t', 'tool', { cmd: 'echo hi' })], []);
  await e.api.wfRun();
  const n = e.api.getNodes()[0];
  assert.equal(n.data.status, 'completed');
  assert.match(n.data.result, /OUT:echo hi/);
  assert.match(n.data.result, /\(退出码 0\)/);
  assert.equal(e.termCalls.length, 1);
  assert.equal(e.termCalls[0][0], 'echo hi');
  assert.equal(e.termCalls[0][1], '/tmp/proj');
  assert.equal(e.termCalls[0][2], 60000);
});

test('危险命令：terminal 硬拦截时标记 failed 并停止后续节点', async () => {
  const e = await ready({ terminal: () => ({ blocked: 'deny', error: '危险命令' }) });
  e.api.setGraph([mkNode('t', 'tool', { cmd: 'rm -rf /' }), mkNode('n', 'tool', { cmd: 'next' })],
    [{ from: 't', to: 'n', route: 'success' }]);
  await e.api.wfRun();
  assert.equal(e.api.getNodes()[0].data.status, 'failed');
  assert.match(e.api.getNodes()[0].data.result, /\[已拦截\]/);
  assert.equal(e.termCalls.length, 1, '失败后应停止，后续节点不再执行');
  assert.ok(e.toasts.some((t) => t.kind === 'error' && /已停止/.test(t.m)));
});

test('条件节点：默认透传成功路由', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('c', 'cond', { prompt: "prev.includes('x')" })], []);
  await e.api.wfRun();
  const n = e.api.getNodes()[0];
  assert.equal(n.data.status, 'completed');
  assert.match(n.data.result, /条件节点，默认透传成功路由/);
});

test('前置失败：上游 AI 调用失败时终止，下游不执行', async () => {
  const e = await ready({ chat: () => ({ success: false, error: '余额不足' }) });
  e.api.setGraph([mkNode('a', 'ai', { prompt: 'x' }), mkNode('t', 'tool', { cmd: 'echo' })],
    [{ from: 'a', to: 't', route: 'success' }]);
  await e.api.wfRun();
  assert.equal(e.api.getNodes()[0].data.status, 'failed');
  assert.match(e.api.getNodes()[0].data.result, /余额不足/);
  assert.equal(e.termCalls.length, 0);
});

test('loop 边：迭代受 MAX_LOOP 保护，环检测识别出环内节点', { timeout: 15000 }, async () => {
  const e = await ready();
  e.api.setGraph(
    [mkNode('s', 'cond'), mkNode('a', 'ai', { prompt: 'p' }), mkNode('b', 'cond')],
    [{ from: 's', to: 'a', route: 'success' }, { from: 'a', to: 'b', route: 'success' },
      { from: 'b', to: 'a', route: 'loop' }]
  );
  assert.equal(e.api.wfDetectCycle().size, 2, 'a、b 构成环');
  await e.api.wfRun();
  assert.equal(e.chatCalls.length, 6, '入口 1 轮 + 最多 5 轮回跳，AI 节点共执行 6 次');
  assert.ok(e.toasts.some((t) => t.kind === 'warn' && /成环/.test(t.m)));
  assert.equal(e.api.isRunning(), false, 'finally 应复位运行标志');
});

test('审批门：批准 → completed；拒绝 → failed 且清理弹窗', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('a', 'ai', { prompt: 'p', approval: true })], []);
  const p1 = e.api.wfRun();
  const box1 = await waitFor(() => e.document.querySelector('.wf-approval-box'));
  assert.match(box1.textContent, /审批门/);
  box1.querySelector('#wf-ap-approve').click();
  await p1;
  assert.equal(e.api.getNodes()[0].data.status, 'completed');
  assert.equal(e.document.querySelector('.wf-approval-box'), null);

  e.api.setGraph([mkNode('b', 'ai', { prompt: 'q', approval: true })], []);
  const p2 = e.api.wfRun();
  const box2 = await waitFor(() => e.document.querySelector('.wf-approval-box'));
  box2.querySelector('#wf-ap-reject').click();
  await p2;
  assert.equal(e.api.getNodes()[0].data.status, 'failed');
  assert.match(e.api.getNodes()[0].data.result, /审批被拒绝/);
  assert.equal(e.document.querySelector('.wf-approval-box'), null);
});

test('导入 / 导出：按钮 click 驱动，导出 JSON 完整，导入补齐默认 route', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('a', 'ai', { prompt: 'p', label: 'L' })], []);
  e.document.getElementById('wf-export').click();
  assert.equal(e.blobs.length, 1);
  assert.equal(e.anchors.length, 1);
  const payload = JSON.parse(e.blobs[0].parts.join(''));
  assert.equal(payload.version, 1);
  assert.equal(payload.nodes.length, 1);
  assert.equal(payload.nodes[0].data.prompt, 'p');
  assert.ok(e.toasts.some((t) => /已导出 1 个节点/.test(t.m)));

  const imported = {
    version: 1,
    nodes: [mkNode('z', 'tool', { cmd: 'ls' })],
    edges: [{ from: 'z', to: 'z' }] // 旧文件无 route
  };
  e.api.getNodes()[0].data.prompt = 'changed';
  e.document.getElementById('wf-import').click();
  const input = e.inputs.at(-1);
  assert.ok(input, '导入应创建 file input');
  const file = new e.window.File([JSON.stringify(imported)], 'wf.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.onchange();
  await waitFor(() => e.api.getNodes().some((n) => n.id === 'z'));
  assert.equal(e.api.getNodes()[0].id, 'z');
  assert.equal(e.api.getEdges()[0].route, 'success', '兼容旧文件：无 route 补默认 success');
  assert.ok(e.toasts.some((t) => /已导入 1 个节点/.test(t.m)));
});

test('空画布：不抛异常并提示缺少入口节点', async () => {
  const e = await ready();
  e.api.setGraph([], []);
  await e.api.wfRun();
  assert.equal(e.api.isRunning(), false);
  assert.ok(e.toasts.some((t) => t.kind === 'error' && /缺少入口节点/.test(t.m)));
});

test('渲染：环内节点高亮 .cyclic，状态色映射到 data.status', async () => {
  const e = await ready();
  e.api.setGraph([mkNode('a', 'cond'), mkNode('b', 'cond')],
    [{ from: 'a', to: 'b', route: 'success' }, { from: 'b', to: 'a', route: 'loop' }]);
  e.api.wfRenderNodes();
  const els = e.document.querySelectorAll('#wf-nodes .wf-node');
  assert.equal(els.length, 2);
  assert.equal(e.document.querySelectorAll('#wf-nodes .wf-node.cyclic').length, 2);
  assert.equal(e.document.querySelectorAll('#wf-edges line').length, 2);
  assert.ok(e.document.querySelector('#wf-edges line[data-route="loop"]'), 'loop 边应有独立标记');
});

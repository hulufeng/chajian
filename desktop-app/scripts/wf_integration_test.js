// ⚠️ 已知失效的历史测试（2026-11-14 标注），默认不纳入 `npm test`；用 `npm run test:legacy` 单独运行。
// 失效原因（两条，均与依赖无关）：
//   1) 本文件用硬编码行号 slice(8424, 8603) 从 app.js 抽代码；app.js 迭代后该区间已变成
//      inferProjectType 等无关代码，工作流模块现位于 ~L10460+，故 new Function 抛 SyntaxError。
//   2) 断言依赖的 wfExport / wfImport 独立函数已被移除，改为 wf-export / wf-import 按钮的
//      内联事件处理（renderer/js/app.js ~L10718+）；wfRun 也新增了 route/loop/agent/approval 语义。
// 修复方向：改为按函数边界动态抽取 + 用按钮 click 驱动导出/导入，并补齐新 mock；需单独安排。
//
// 集成测试：抽离 app.js 中的「工作流模块」(8425-8603 行)，在真实 DOM(jsdom) + mock BubaiCode 下运行，
// 驱动真实的 wfRun / wfExport / wfImport，验证本次改动（工具节点接终端、条件分支、导入导出、运行态）。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, '..', 'renderer', 'js', 'app.js');
const lines = fs.readFileSync(APP, 'utf8').split('\n');
// 1-indexed 8425..8603 -> 0-indexed slice(8424, 8603)
const block = lines.slice(8424, 8603).join('\n');

// 真实 DOM（仅工作流用到的几个元素）
const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div id="wf-nodes"></div><div id="wf-edges"></div><div id="wf-props"></div>' +
  '</body></html>');
const document = dom.window.document;

// Mock BubaiCode（覆盖工作流用到的所有 IPC）
const store = {};
const BubaiCode = {
  // AI 节点：把 prompt 回声，便于条件分支断言
  ai: { chat: async (opts) => ({ success: true, content: 'AI_RESULT:' + (opts && opts.messages && opts.messages[0] && opts.messages[0].content || '') }) },
  // 工具节点：真实终端的返回结构
  terminal: { execute: async (cmd) => ({ success: true, stdout: 'OUT:' + cmd, stderr: '', exitCode: 0 }) },
  config: { get: async () => null, set: async () => ({}) },
  dialog: { saveFile: async () => '/tmp/wf.json', openFile: async () => '/tmp/wf.json' },
  fs: { writeFile: async (p, c) => { store[p] = c; }, readFile: async (p) => store[p] || '' },
  on: () => {}, removeListener: () => {}
};
const window = { BubaiCode };
const state = { projectPath: '/tmp/proj' };
const toasts = [];
const showToast = (m) => { toasts.push(m); };

const api = new Function('window', 'document', 'showToast', 'state',
  block + '\nreturn { wfAddNode, wfRun, wfExport, wfImport, getNodes: () => wfNodes, getEdges: () => wfEdges, setGraph: (n, e) => { wfNodes = n; wfEdges = e; } };'
)(window, document, showToast, state);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
const find = (g, id) => g.find(n => n.id === id);

(async () => {
  // 1) AI 节点真实调用
  console.log('Test 1: AI 节点（真实 ai.chat）');
  api.setGraph([], []);
  api.wfAddNode('ai');
  api.getNodes()[0].data.prompt = 'hello';
  await api.wfRun();
  let n = api.getNodes()[0];
  check('结果含 AI 回声', n.data.result === 'AI_RESULT:hello');
  check('状态 done', n._state === 'done');

  // 2) 工具(终端)节点真实调用
  console.log('Test 2: 工具节点（真实 terminal.execute）');
  api.setGraph([], []);
  api.wfAddNode('tool');
  api.getNodes()[0].data.cmd = 'echo hi';
  await api.wfRun();
  n = api.getNodes()[0];
  check('结果含 stdout', n.data.result.includes('OUT:echo hi'));
  check('结果含退出码', n.data.result.includes('退出码 0'));
  check('状态 done', n._state === 'done');

  // 3) 条件分支：真分支走通、假分支跳过
  console.log('Test 3: 条件分支（真）');
  api.setGraph([
    { id: 'r', type: 'ai', x: 0, y: 0, data: { prompt: 'x', label: '', cmd: '', result: '' }, _state: 'idle' },
    { id: 'c', type: 'cond', x: 0, y: 0, data: { prompt: "prev.includes('AI_RESULT')", label: '', cmd: '', result: '' }, _state: 'idle' },
    { id: 't', type: 'tool', x: 0, y: 0, data: { prompt: '', label: '', cmd: 'true-cmd', result: '' }, _state: 'idle' },
    { id: 'f', type: 'tool', x: 0, y: 0, data: { prompt: '', label: '', cmd: 'false-cmd', result: '' }, _state: 'idle' }
  ], [
    { from: 'r', to: 'c' }, { from: 'c', to: 't' }, { from: 'c', to: 'f' }
  ]);
  await api.wfRun();
  let g = api.getNodes();
  check('cond 执行', find(g, 'c')._state === 'done');
  check('真分支(t) 执行', find(g, 't')._state === 'done');
  check('假分支(f) 被跳过', find(g, 'f')._state === 'skipped');

  // 3b) 条件分支：假
  console.log('Test 3b: 条件分支（假）');
  api.setGraph([
    { id: 'r', type: 'ai', x: 0, y: 0, data: { prompt: 'x', label: '', cmd: '', result: '' }, _state: 'idle' },
    { id: 'c', type: 'cond', x: 0, y: 0, data: { prompt: "prev.includes('NOPE')", label: '', cmd: '', result: '' }, _state: 'idle' },
    { id: 't', type: 'tool', x: 0, y: 0, data: { prompt: '', label: '', cmd: 'true-cmd', result: '' }, _state: 'idle' },
    { id: 'f', type: 'tool', x: 0, y: 0, data: { prompt: '', label: '', cmd: 'false-cmd', result: '' }, _state: 'idle' }
  ], [
    { from: 'r', to: 'c' }, { from: 'c', to: 't' }, { from: 'c', to: 'f' }
  ]);
  await api.wfRun();
  g = api.getNodes();
  check('真分支(t) 被跳过', find(g, 't')._state === 'skipped');
  check('假分支(f) 执行', find(g, 'f')._state === 'done');

  // 4) 导出 / 导入 往返
  console.log('Test 4: 导出 / 导入 往返');
  api.setGraph([{ id: 'a', type: 'ai', x: 10, y: 10, data: { prompt: 'p', label: 'L', cmd: '', result: 'R' }, _state: 'idle' }], []);
  await api.wfExport();
  check('导出写入 store', typeof store['/tmp/wf.json'] === 'string' && store['/tmp/wf.json'].includes('"id"'));
  check('导出剥离 _state', !store['/tmp/wf.json'].includes('_state'));
  api.getNodes()[0].data.prompt = 'changed';
  await api.wfImport();
  n = api.getNodes()[0];
  check('导入恢复 prompt', n.data.prompt === 'p');
  check('导入重置 _state', n._state === 'idle');

  // 5) 空画布不崩溃
  console.log('Test 5: 空画布');
  api.setGraph([], []);
  let threw = false; try { await api.wfRun(); } catch (e) { threw = true; }
  check('空画布不抛异常', !threw);
  check('空画布提示', toasts.some(m => m.includes('画布为空')));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();

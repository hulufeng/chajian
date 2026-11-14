'use strict';
/**
 * P3-2c 验收：宿主补充工具声明 + select_port 状态写入。
 * 运行：node scripts/verify-host-extra-tools.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOADER = fs.readFileSync(path.join(ROOT, 'renderer/js/plugin-loader.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

test('plugin-loader：HOST_EXTRA_TOOLS 注册表与 API 齐备', () => {
  assert.ok(LOADER.includes('const HOST_EXTRA_TOOLS = new Map();'), '缺 HOST_EXTRA_TOOLS');
  assert.ok(LOADER.includes('function registerHostExtraTools('), '缺 registerHostExtraTools');
  assert.ok(LOADER.includes('registerHostExtraTools,'), '未暴露到 window.PluginSystem');
  assert.ok(LOADER.includes('HOST_EXTRA_TOOLS.get(id)'), '加载 manifest 时未读取补充声明');
});

test('plugin-loader：manifest 优先，补充只在未声明同名时注入', () => {
  // 合并逻辑：declaredNames 收集 manifest 已声明的名字
  assert.ok(LOADER.includes('const declaredNames = new Set('), '缺 declaredNames 收集');
  assert.ok(LOADER.includes('!declaredNames.has(d.name)'), '未做「未声明同名才注入」判断');
  // manifest 的 tools 仍排在前面（manifest 优先）
  assert.ok(LOADER.includes('const allToolDecls = tools.slice();'), 'manifest 工具应优先');
  assert.ok(LOADER.includes('allToolDecls.push(d)'), '补充声明未合并');
});

test('app.js：补充声明覆盖 7 个宿主已实现但 manifest 未声明的工具', () => {
  assert.ok(APP.includes("registerHostExtraTools('arduino-cli-toolchain'"), '未注入 arduino-cli 补充声明');
  for (const n of ['select_board', 'list_platforms', 'search_boards', 'get_board_info',
                   'set_board_option', 'list_ports', 'select_port']) {
    assert.ok(APP.includes(`name: '${n}'`), `补充声明缺 ${n}`);
  }
  // select_port 走 serialport service
  assert.ok(APP.includes("service: 'serialport', method: 'select'"), 'select_port 未走 serialport service');
  // 其余走 arduinoCli service
  assert.ok(APP.includes("service: 'arduinoCli', method: 'select_board'"), 'select_board 未走 arduinoCli service');
});

test('app.js：ARDUINO_TOOL_IMPLS 新增 list_ports（走主进程 serial:list）', () => {
  assert.ok(APP.includes('async list_ports()'), '缺 list_ports 实现');
  assert.ok(APP.includes('window.BubaiCode.serial.list()'), 'list_ports 未走主进程串口枚举');
  // 端口输出带设备名与 VID/PID
  assert.ok(APP.includes('VID:'), '端口列表应含 VID');
  assert.ok(APP.includes('PID:'), '端口列表应含 PID');
});

test('app.js：serialport.select 写入双状态并做精确匹配', () => {
  assert.ok(APP.includes('state.compilePort = found.port;'), '未写 state.compilePort（烧录读它）');
  assert.ok(APP.includes('state.arduinoPort = found.port;'), '未写 state.arduinoPort（提示词读它）');
  // 精确匹配优先于模糊包含
  assert.ok(APP.includes('String(p.port).toLowerCase() === q'), '缺精确匹配');
  // 找不到时列出可用端口
  assert.ok(APP.includes('当前可用'), '未匹配时应列出可用端口');
  // 同步 UI
  assert.ok(APP.includes("document.getElementById('port-select')"), '未同步设备面板端口下拉');
  assert.ok(APP.includes("document.getElementById('status-port')"), '未同步状态栏端口段');
});

test('index.html：状态栏有端口段', () => {
  assert.ok(HTML.includes('id="status-port"'), '缺 #status-port 状态栏元素');
  assert.ok(HTML.includes('当前串口'), '端口段缺 title');
});

test('原有 select_board 行为未被破坏（状态栏板卡段仍在）', () => {
  assert.ok(HTML.includes('id="status-board"'), '板卡状态段丢失');
  assert.ok(APP.includes('state.arduinoFqbn'), 'select_board 的 FQBN 状态丢失');
});

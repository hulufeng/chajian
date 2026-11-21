'use strict';
/**
 * 编译/烧录可取消验收（ALIGN_LEDGER R4：对标 ChipCode compile:cancel）。
 * 运行：node scripts/verify-compile-cancel.cjs
 * 手段：真跑 —— 起一个每 200ms 写心跳的孙进程，走 TerminalService.executeCommand 的 cancelTag
 *       通道登记，取消后断言「结果是 cancelled 而不是失败」且「心跳真的停了」；
 *       再静态扫主进程/preload/渲染层接线，确认没有第二套进程管理。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { createKillableTasks } = require(path.join(ROOT, 'packages/engine/killable-tasks.js'));
const { getTerminalService } = require(path.join(ROOT, 'main/terminal.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer/css/style.css'), 'utf8');
const KILL_TREE = fs.readFileSync(path.join(ROOT, 'main/kill-tree.js'), 'utf8');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('killable-tasks 真跑：按标签命中、连点只杀一次、登记随结束清空', () => {
  const killed = [];
  const errs = [];
  const t = createKillableTasks({ kill: (child) => killed.push(child.tag), onError: (e) => errs.push(String(e && e.message)) });
  const a = t.begin('编译', { tag: 'A' });
  const b = t.begin('烧录', { tag: 'B' });
  assert.equal(t.size(), 2);
  assert.deepEqual(t.cancel('编译').map(x => x.tag), ['编译'], '只取消点名的那个标签');
  assert.equal(killed.join(','), 'A', 'B 不该被牵连');
  assert.deepEqual(t.cancel('编译'), [], '连点第二次不再重复杀（taskkill 打空靶会误报失败）');
  assert.equal(t.isCancelled(a), true);
  assert.equal(t.isCancelled(b), false);
  assert.equal(t.cancel().length, 1, '不传标签 = 全停');
  t.end(a); t.end(b);
  assert.equal(t.size(), 0, '跑完必须注销，否则 id 会越攒越多');
  assert.deepEqual(t.list(), []);

  // kill 抛错不许把取消流程带崩：后面的任务照杀，错误交给 onError
  const t2 = createKillableTasks({ kill: (c) => { if (c.boom) throw new Error('拒绝访问'); killed.push(c.tag); }, onError: (e) => errs.push(e.message) });
  t2.begin('编译', { boom: true });
  t2.begin('编译', { tag: 'C' });
  assert.equal(t2.cancel('编译').length, 2);
  assert.equal(killed[killed.length - 1], 'C', '前一个杀失败，后一个还得杀');
  assert.match(errs.join('|'), /拒绝访问/);
});

test('真跑：cancelTag 的长命令被取消后是「已取消」，不是「命令失败」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-cancel-'));
  const beat = path.join(dir, 'beat.txt');
  const victim = path.join(dir, 'victim.cjs');
  fs.writeFileSync(victim, 'const fs=require("fs");for(let i=0;i<200;i++)setTimeout(()=>fs.appendFileSync(process.argv[2],Date.now()+"\\n"),i*200);');
  const svc = getTerminalService();
  const p = svc.executeCommand('"' + process.execPath + '" "' + victim + '" "' + beat + '"', dir, 60000, { cancelTag: '编译' });
  await sleep(900);
  assert.equal(svc.execTasks.list().map(x => x.tag).join(','), '编译', '进行中的编译必须被登记着');
  const killed = svc.cancelExecutions();
  const res = await p;
  assert.equal(killed.length, 1);
  assert.equal(res.cancelled, true, '取消要单独成一路');
  assert.equal(res.success, false);
  assert.equal(res.error, '编译已取消', '文案带标签，状态栏与聊天流才说得清取消的是什么');
  assert.equal(svc.execTasks.size(), 0, '结束后注销');

  // 进程树真死了：心跳必须停住（arduino-cli 会派生编译器子进程，只杀父进程等于没杀）
  const size = () => { try { return fs.readFileSync(beat, 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) { return 0; } };
  const n1 = size();
  await sleep(700);
  const n2 = size();
  await sleep(700);
  assert.equal(size(), n2, '取消后孙进程还在写心跳（' + n1 + '→' + n2 + '→' + size() + '）= 进程树没杀干净');
  assert.ok(n1 >= 1, '心跳至少写过一次，否则这条断言是空的');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

test('真跑：没挂标签的命令不受取消牵连，真失败也不冒充取消', async () => {
  const svc = getTerminalService();
  const plain = svc.executeCommand('ping -n 3 127.0.0.1', process.cwd(), 30000);
  await sleep(200);
  assert.deepEqual(svc.cancelExecutions(), [], '用户终端里自己敲的长跑命令不该被「取消编译」杀掉');
  const ok = await plain;
  assert.equal(ok.success, true, 'ping 该正常跑完：' + ok.error);
  assert.notEqual(ok.cancelled, true);

  // 真失败：模块找不到 → 非零退出（护栏对 `node -e` 要确认，所以用文件形式）
  const boom = await svc.executeCommand('node bubai-no-such-module.js', process.cwd(), 30000, { cancelTag: '编译' });
  assert.equal(boom.success, false);
  assert.equal(boom.blocked, undefined, '这条得真的跑起来，否则断言是空的');
  assert.notEqual(boom.cancelled, true, '非零退出是失败，不许和取消混成一路——混了就不会触发 AI 诊断');
  assert.equal(svc.execTasks.size(), 0);
});

test('主进程接线：compile:cancel 收口两条出站，编译/烧录都挂标签', () => {
  assert.match(MAIN, /ipcMain\.handle\('compile:cancel'/, '缺 compile:cancel 通道');
  assert.match(MAIN, /compileTasks\.cancel\(\)\.concat\(terminalService\.cancelExecutions\(\)\)/,
    '取消必须同时收口 runArduinoCli 与 terminal.execute 两条路，只杀一条就是假按钮');
  const 编译 = (MAIN.match(/cancelTag: '编译'/g) || []).length;
  const 烧录 = (MAIN.match(/cancelTag: '烧录'/g) || []).length;
  assert.ok(编译 >= 3, 'compile:arduino / aiFix 两次编译 / exportBinary 都要挂「编译」标签，实测 ' + 编译);
  assert.ok(烧录 >= 1, 'compile:upload 要挂「烧录」标签');
  assert.match(MAIN, /function doCompile\(sketchPath, fqbn, outputDir, opts\)/, 'doCompile 得把 opts 传到 runArduinoCli');
  assert.match(MAIN, /runArduinoCli\(args, path\.dirname\(norm\.target\), \{ cancelTag: '烧录' \}\)/, 'upload 走带标签的执行');
  assert.match(MAIN, /if \(first\.cancelled\)/, 'AI 修复：第一次编译被取消就别再改代码');
  assert.match(MAIN, /if \(second\.cancelled\)/, 'AI 修复：修复后验证被取消要如实说「未验证」，保留备份');
  assert.match(MAIN, /cancelled: true/, '主进程结果体要带 cancelled 字段');
  // 只登记编译/烧录，别把 core:list / board:list 这类查询也算进去
  assert.ok(!/core:.*cancelTag/.test(MAIN), '查询类命令不该进可取消登记');
});

test('进程管理只有一套：杀树实现唯一、且绝不同步阻塞主进程', () => {
  // 注释里写着「不要 execSync」，扫之前先把整行注释剥掉，否则自己抓自己
  const codeOnly = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal((KILL_TREE.match(/function killProcessTree/g) || []).length, 1);
  assert.match(KILL_TREE, /execFile\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/, 'Windows 用 taskkill /T /F 杀整棵进程树');
  assert.ok(!/execSync\(\s*['"]taskkill/.test(codeOnly(KILL_TREE) + codeOnly(MAIN)), 'taskkill 同步调用会把主进程卡死');
  // 按 PID 杀树的实现只允许存在于 kill-tree.js；index.js 里剩下的 taskkill 是给 llama-server 兜底的 /IM，
  // 那是"关掉引擎"这件独立事，不该变成第二套编译取消逻辑
  const pidKills = (src) => (src.match(/taskkill',\s*\['\/PID/g) || []).length;
  assert.equal(pidKills(KILL_TREE), 1, '杀树实现应有且只有一处');
  assert.equal(pidKills(MAIN), 0, 'main/index.js 不许自己按 PID 杀进程，调 killProcessTree');
  for (const f of fs.readdirSync(path.join(ROOT, 'main')).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'main', f), 'utf8');
    if (f === 'kill-tree.js') continue;
    assert.ok(!/function killProcessTree/.test(src), 'main/' + f + ' 里又写了一份 killProcessTree');
  }
  assert.match(MAIN, /require\('\.\.\/packages\/engine\/killable-tasks\.js'\)/, '登记表用共享纯模块，别在 main 里再写一份');
  assert.match(fs.readFileSync(path.join(ROOT, 'main/terminal.js'), 'utf8'), /createKillableTasks\(\{[\s\S]{0,120}kill: killProcessTree/);
});

test('preload 暴露 compile.cancel，渲染层取消按钮真的调它', () => {
  assert.match(PRELOAD, /cancel: \(\) => ipcRenderer\.invoke\('compile:cancel'\)/);
  assert.match(APP, /window\.BubaiCode\.compile\.cancel\(\)/, '渲染层要有真实调用点，否则 UI 是个假开关');
});

test('渲染层接线：编译态按钮变「取消」，取消记成 warn 而不是失败', () => {
  const run = APP.indexOf('async function runCapBtn(cap, params, opt) {');
  const tail = APP.indexOf('// ===== 设备面板编译/烧录/监视按钮 =====');
  assert.ok(run > 0 && tail > run, '找不到 runCapBtn');
  const src = APP.slice(run, tail);
  assert.match(src, /if \(compileRun\) \{ await cancelCompileRun\(\); return \{ ok: false, cancelled: true/, '运行中再点同一入口 = 取消');
  assert.match(src, /compileRun = \{ tag: runTag, cancelAck: null \};\s*paintCompileRun\(\)/, '开跑即进入运行态');
  assert.match(src, /r\.cancelled = !!\(ack && ack\.ok\)/, '取消结论以主进程回执为准，杀不动不许假装已取消');
  assert.match(src, /showToast\(r\.cancelled \? \(runTag \+ '已取消'\)/, '文案「编译已取消」');
  assert.match(src, /r\.cancelled \? 'warn' : \(bad \? 'error' : 'success'\)/, '取消是中性事件，不打红');
  assert.match(src, /const bad = !r\.cancelled &&/, '取消不该算失败');

  assert.match(APP, /btn\.classList\.toggle\('is-cancel', running\)/);
  assert.match(APP, /'#icon-square'/, '运行中换成停止图标');
  assert.match(CSS, /\.is-cancel \{/, '缺取消态样式');
  for (const id of ['toolbar-compile-btn', 'toolbar-upload-btn', 'editor-compile-btn', 'editor-upload-btn']) {
    assert.ok(APP.includes("'" + id + "'"), '按钮漏登记：' + id);
  }
  // 编译/烧录的两条真实执行都要带标签
  assert.match(APP, /terminal\.execute\(cmd, cwd, 300000, \{ cancelTag: '编译' \}\)/);
  assert.match(APP, /terminal\.execute\(full, runCwd, 600000, \{ cancelTag: '烧录' \}\)/);
  assert.match(APP, /return 'COMPILE CANCELLED（编译已取消）'/);
  assert.match(APP, /return 'UPLOAD CANCELLED（烧录已取消）'/);
  assert.match(APP, /if \(result && result\.cancelled\) \{\s*state\.lastCompileResult = \{ ok: false, cancelled: true/, '取消后不留可诊断的伪失败');
  assert.match(APP, /const cancelledSoFar = !!\(result && result\.cancelled\)/, '被取消的烧录不许再自动重试一轮');
  assert.match(APP, /if \(result\.cancelled\) return \{ ok: true, cancelled: true/, 'runArduinoCli 透传 cancelled');
  assert.match(APP, /if \(d\.cancelled\) return 'COMPILE CANCELLED/, 'read_diagnostics 别把取消当成待修的错');
  assert.match(APP, /state\.terminal\.writeln\('⏹ 编译已取消'\)/, '运行 .ino 的路径也要区分取消');
  assert.match(APP, /showToast\(result\.applied \? '编译已取消（修复已写回，未验证）' : '编译已取消', 'warn'\)/);
});

test('取消语义真跑：runCapBtn 的运行态与取消回执在模拟 DOM 上走通', async () => {
  const calls = [];
  const mkBtn = (title, icon) => {
    const state = { title, icon };
    return {
      dataset: {},
      classList: { toggle() {} },
      getAttribute: (k) => (k === 'title' ? state.title : null),
      setAttribute: (k, v) => { if (k === 'title') state.title = v; },
      querySelector: () => ({ getAttribute: () => state.icon, setAttribute: (k, v) => { if (k === 'href') state.icon = v; } }),
      _state: state,
    };
  };
  const btns = { 'toolbar-compile-btn': mkBtn('编译', '#icon-player-play') };
  const ctx = vm.createContext({
    document: { getElementById: (id) => btns[id] || null },
    window: { BubaiCode: { compile: { cancel: async () => ({ ok: true, cancelled: ['编译'], count: 1 }) } } },
    showToast: (m, t) => calls.push('toast:' + t + ':' + m),
    __done: (r) => calls.push('ack:' + !!(r && r.cancelAck && r.cancelAck.ok)),
  });
  // 跑真身：把 paintCompileRun + cancelCompileRun 这段原样搬进 vm，只把初始运行态替成已开跑
  const helpers = APP.slice(APP.indexOf('  const COMPILE_RUN_BTNS = ['), APP.indexOf('  async function runCapBtn'));
  assert.ok(helpers.includes('function paintCompileRun') && helpers.includes('function cancelCompileRun'), '没截到取消相关的函数');
  await vm.runInContext('(async function(){' +
    helpers.replace(/let compileRun = null;/, 'let compileRun = { tag: "编译", cancelAck: null };') +
    'paintCompileRun(); await cancelCompileRun(); __done(compileRun); })()', ctx);
  assert.deepEqual(calls, ['toast:warn:正在取消编译…', 'ack:true'], calls.join(' | '));
  assert.equal(btns['toolbar-compile-btn']._state.title, '取消编译', '按钮标题要跟着变，用户才知道这点下去是停');
  assert.equal(btns['toolbar-compile-btn']._state.icon, '#icon-square', '图标换成停止');
});

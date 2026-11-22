'use strict';
/**
 * 软件体检：健康检查 + 垃圾缓存清理 + 截图
 * 运行：
 *   node scripts/app-health-check.cjs              # 只体检（只读，不删任何东西）
 *   node scripts/app-health-check.cjs --clean      # 体检 + 清理测试垃圾
 *   node scripts/app-health-check.cjs --clean --shot  # 体检 + 清理 + 启动截图
 * 注意：文件名不以 verify- 开头，避免被 verify-all.cjs 当作回归脚本自动收录。
 *
 * 清理边界（只删明确的测试垃圾，绝不碰真实数据）：
 *   - dist* 目录：保留最新的 1 个，删其余构建产物
 *   - C:\bubai_* / C:\BubaiCode1xx / C:\chipcode_view 等测试 userData（各含模型副本）
 *   - Temp 里本项目的临时脚本/日志（view_/measure_/verify_/build_ 等前缀）
 * 保留（不删）：
 *   - C:\BubaiCode（共享 AI 模型缓存 4.4GB，删了要重新下载）
 *   - D:\户鲁峰设计图\BubaiCode（用户真实安装）
 *   - 项目源码 / node_modules / .codebuddy
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const C = {
  green: s => '\x1b[32m' + s + '\x1b[0m',
  red: s => '\x1b[31m' + s + '\x1b[0m',
  yellow: s => '\x1b[33m' + s + '\x1b[0m',
  gray: s => '\x1b[90m' + s + '\x1b[0m',
};
const args = process.argv.slice(2);
const DO_CLEAN = args.includes('--clean');
const DO_SHOT = args.includes('--shot');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(C.green('  PASS ') + name + (detail ? '  ' + C.gray(detail) : '')); }
  else { fail++; console.log(C.red('  FAIL ') + name + (detail ? '  ' + C.red(detail) : '')); }
};
const sizeMB = p => {
  try {
    let total = 0;
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else try { total += fs.statSync(f).size; } catch {} } };
    walk(p); return Math.round(total / 1048576);
  } catch { return 0; }
};

console.log('\n=== BubaiCode 软件体检 ===\n');

// ---------- 1. 版本与构建产物 ----------
console.log('【1】版本与构建产物');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outDir = pkg.build && pkg.build.directories && pkg.build.directories.output;
ok('package.json 版本可读', !!version, 'v' + version);
ok('构建输出目录配置', !!outDir, outDir || '');
const distPath = path.join(ROOT, outDir || '');
const exe = path.join(distPath, 'BubaiCode-Setup-' + version + '.exe');
const unpackedExe = path.join(distPath, 'win-unpacked', 'BubaiCode.exe');
ok('安装包存在', fs.existsSync(exe), fs.existsSync(exe) ? Math.round(fs.statSync(exe).size / 1048576) + 'MB' : '');
ok('可执行文件存在', fs.existsSync(unpackedExe));
ok('latest.yml 存在', fs.existsSync(path.join(distPath, 'latest.yml')));

// ---------- 2. 源码与依赖 ----------
console.log('\n【2】源码与依赖');
for (const f of ['renderer/index.html', 'renderer/js/app.js', 'renderer/css/style.css', 'main/index.js', 'main/preload.js']) {
  ok('源码 ' + f, fs.existsSync(path.join(ROOT, f)));
}
ok('node_modules 存在', fs.existsSync(path.join(ROOT, 'node_modules')));

// ---------- 3. JS 语法 ----------
console.log('\n【3】JS 语法检查');
for (const f of ['renderer/js/app.js', 'main/index.js', 'main/preload.js', 'main/terminal.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  ok('语法 ' + f, r.status === 0, r.status === 0 ? '' : (r.stderr || '').split('\n')[0]);
}

// ---------- 4. 回归测试 ----------
console.log('\n【4】回归测试');
const t0 = Date.now();
const testR = spawnSync(process.execPath, ['scripts/verify-all.cjs'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
const testOut = (testR.stdout || '') + (testR.stderr || '');
const summary = (testOut.match(/脚本\s*\d+\s*个：\d+\s*通过\s*\/\s*\d+\s*失败[^\n]*/) || [''])[0];
ok('回归测试全绿', testR.status === 0 && /0 失败/.test(summary), summary || ('exit=' + testR.status));
console.log(C.gray('  耗时 ' + Math.round((Date.now() - t0) / 1000) + 's'));

// ---------- 5. 关键 UI 规则在构建产物里 ----------
console.log('\n【5】构建产物关键规则');
const appJs = path.join(distPath, 'win-unpacked', 'resources', 'app.asar');
ok('app.asar 存在', fs.existsSync(appJs), fs.existsSync(appJs) ? sizeMB(appJs) + 'MB' : '');

// ---------- 6. 清理 ----------
// Windows 坑：fs.rmSync 对被进程占用的 userData 会静默失败（不抛错），
// 所以统一走 PowerShell Remove-Item，并在删除后核实目录真的消失，只报真实释放量。
function deletePath(p) {
  if (!fs.existsSync(p)) return { gone: true, freed: 0 };
  const mb = sizeMB(p);
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "Remove-Item -LiteralPath '" + p.replace(/'/g, "''") + "' -Recurse -Force -ErrorAction SilentlyContinue"],
    { encoding: 'utf8' });
  return { gone: !fs.existsSync(p), freed: !fs.existsSync(p) ? mb : 0, err: r.status };
}
if (DO_CLEAN) {
  console.log('\n【6】清理测试垃圾');
  // 先关进程，释放 userData 占用
  try { execSync('taskkill /F /IM BubaiCode.exe', { stdio: 'ignore' }); } catch {}
  console.log(C.gray('  已关闭 BubaiCode 进程'));
  let freed = 0;
  // 6a. dist 目录：保留当前版本，删其余
  const dists = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^dist/.test(e.name))
    .map(e => ({ name: e.name, p: path.join(ROOT, e.name) }));
  const keep = dists.find(d => d.name === outDir) || dists[0];
  for (const d of dists) {
    if (d.name === keep.name) { console.log(C.gray('  保留 ' + d.name + ' (当前版本)')); continue; }
    const r = deletePath(d.p);
    if (r.gone) { freed += r.freed; console.log(C.green('  已删 ') + d.name + ' (' + r.freed + 'MB)'); }
    else console.log(C.yellow('  跳过 ') + d.name + ' (被占用或权限不足)');
  }
  // 6b. 测试 userData（精确名单，绝不碰 C:\BubaiCode 模型缓存与用户真实安装）
  const testDirs = [];
  try {
    for (const e of fs.readdirSync('C:\\', { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (/^bubai_/i.test(n) || /^bubai-(build|cloud|debug|esp|inst|test|vis|ui|proc|exec|layout|login|clean|user)/i.test(n) || /^BubaiCode1\d{2,}/.test(n) || n === 'BubaiCode1235Test' || n === 'chipcode_view') {
        testDirs.push(path.join('C:\\', n));
      }
    }
  } catch {}
  let dirN = 0;
  for (const d of testDirs) { const r = deletePath(d); if (r.gone) { freed += r.freed; dirN++; } }
  console.log(C.green('  已删 ') + dirN + '/' + testDirs.length + ' 个测试 userData');
  console.log(C.gray('  保留 C:\\BubaiCode (共享模型缓存) 与用户真实安装'));
  // 6c. Temp 临时脚本
  const tmp = 'C:\\Users\\Administrator\\AppData\\Local\\Temp';
  let tmpN = 0;
  try {
    for (const f of fs.readdirSync(tmp)) {
      if (/^(view_|measure_|probe_|layout_|login_|verify_12|build_12|side_by_side|shot_|final_width|check_|open_project|compare_|welcome_|flat_|chipcode_|trap_|proc_|exec_|trigger_|ui_|gen_site|check_codelab|health_|do_cleanup)/i.test(f)) {
        const p = path.join(tmp, f);
        let isFile = true; try { isFile = fs.statSync(p).isFile(); } catch {}
        if (isFile && deletePath(p).gone) tmpN++;
      }
    }
  } catch {}
  console.log(C.green('  已删 ') + tmpN + ' 个 Temp 临时脚本/日志');
  console.log(C.green('  共释放约 ' + Math.round(freed / 1024) + 'GB (' + freed + 'MB)'));
} else {
  console.log('\n【6】清理：跳过（加 --clean 开启）');
}

// ---------- 7. 截图 ----------
if (DO_SHOT) {
  console.log('\n【7】启动软件并截图');
  const shotDir = 'C:\\Users\\Administrator\\Desktop\\内测实时记录';
  fs.mkdirSync(shotDir, { recursive: true });
  // 关掉旧进程，用干净 userData 启动最新版本
  try { execSync('taskkill /F /IM BubaiCode.exe', { stdio: 'ignore' }); } catch {}
  const ud = 'C:\\bubai_healthcheck';
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
  const child = require('node:child_process').spawn(unpackedExe, ['--remote-debugging-port=9266', '--user-data-dir=' + ud], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(C.gray('  已启动，等待 18s...'));
  // 用 PowerShell 截屏（等窗口起来）
  execSync('powershell -NoProfile -Command "Start-Sleep 18"', { stdio: 'ignore' });
  const ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(\'' + shotDir + '\\软件体检_' + version + '.png\',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose();$bmp.Dispose();';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const shot = path.join(shotDir, '软件体检_' + version + '.png');
  ok('截图成功', r.status === 0 && fs.existsSync(shot), fs.existsSync(shot) ? Math.round(fs.statSync(shot).size / 1024) + 'KB' : '');
} else {
  console.log('\n【7】截图：跳过（加 --shot 开启）');
}

// ---------- 汇总 ----------
console.log('\n=== 体检结果：' + C.green(pass + ' PASS') + ' / ' + (fail ? C.red(fail + ' FAIL') : '0 FAIL') + ' ===\n');
process.exit(fail ? 1 : 0);

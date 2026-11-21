'use strict';
/**
 * 冲突标记闭环验收（对齐参考基线 conflict-markers 的三条安全性质）。
 * 运行：node scripts/verify-conflict-markers.cjs
 * 手段：vm 沙箱执行 renderer/js/git-conflict-markers.js 验真实行为 + 静态检查主进程/渲染层接线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/js/git-conflict-markers.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

// 渲染层形态：只有 window，没有 module —— 走 UMD 的 root 分支
const sandbox = { window: {}, self: undefined, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'git-conflict-markers.js' });
const M = sandbox.BubaiCodeConflict;
// 主进程形态：同一份源码 require 得到等价实现（判据不漂移的前提）
const MNode = require(path.join(ROOT, 'renderer/js/git-conflict-markers.js'));

const asStr = (v) => (v == null ? null : Array.from(v).join('\n'));

const MERGE_LF = 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feat\nz\n';
const MERGE_CRLF = MERGE_LF.replace(/\n/g, '\r\n');
const DIFF3 = 'x\n<<<<<<< HEAD\nc1\nMAIN-C2\nc3\n||||||| 7d963b9\nx\ny\nz\n=======\nc1\nFEAT-C2\nc3\nFEAT-C4\n>>>>>>> feat\ny\n';

test('模块在 window 与 CommonJS 两种宿主下暴露同一套 API', () => {
  const keys = ['markerOf', 'hasConflictMarkers', 'parseConflictMarkers', 'resolveConflicts', 'summarizeConflicts'];
  keys.forEach(k => {
    assert.equal(typeof M[k], 'function', '渲染层缺少 ' + k);
    assert.equal(typeof MNode[k], 'function', '主进程缺少 ' + k);
  });
});

test('merge 风格解析：区域行号 1-based 指向内容行，标签取标记后缀', () => {
  const p = M.parseConflictMarkers(MERGE_LF);
  assert.equal(p.hasMarkers, true);
  assert.equal(p.malformed, false);
  assert.equal(p.regions.length, 1);
  const r = p.regions[0];
  assert.deepEqual([r.startLine, r.endLine], [2, 6]);
  assert.deepEqual([r.ours.startLine, r.ours.endLine], [3, 3]);
  assert.deepEqual([r.theirs.startLine, r.theirs.endLine], [5, 5]);
  assert.equal(asStr(r.ours.lines), 'mine');
  assert.equal(asStr(r.theirs.lines), 'theirs');
  assert.equal(r.oursLabel, 'HEAD');
  assert.equal(r.theirsLabel, 'feat');
  assert.equal(r.base, undefined, 'merge 风格不该凭空造出基线段');
});

test('diff3 风格：基线段单独解析，ours 区间不得为 0（参考基线实测踩过的坑）', () => {
  const p = M.parseConflictMarkers(DIFF3);
  assert.equal(p.malformed, false);
  const r = p.regions[0];
  assert.equal(asStr(r.ours.lines), 'c1\nMAIN-C2\nc3');
  assert.equal(asStr(r.base.lines), 'x\ny\nz');
  assert.equal(asStr(r.theirs.lines), 'c1\nFEAT-C2\nc3\nFEAT-C4');
  assert.ok(r.ours.startLine > 0 && r.ours.endLine >= r.ours.startLine, 'ours 行号区间必须可用');
  assert.equal(M.resolveConflicts(DIFF3, ['ours']), 'x\nc1\nMAIN-C2\nc3\ny\n');
  assert.equal(M.resolveConflicts(DIFF3, ['theirs']), 'x\nc1\nFEAT-C2\nc3\nFEAT-C4\ny\n');
});

test('不猜：标记不成对（缺尾/缺分隔/嵌套）判畸形，且拒绝解决', () => {
  const cases = [
    'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n',
    'a\n<<<<<<< HEAD\nmine\ntheirs\n>>>>>>> feat\n',
    'a\n<<<<<<< HEAD\n<<<<<<< NEXT\n=======\nb\n>>>>>>> feat\n',
    'a\n<<<<<<< HEAD\n'
  ];
  cases.forEach((t, i) => {
    const p = M.parseConflictMarkers(t);
    assert.equal(p.malformed, true, '第 ' + i + ' 组应判畸形');
    assert.throws(() => M.resolveConflicts(t, ['ours']), /不成对/, '畸形必须拒绝写盘：第 ' + i + ' 组');
  });
});

test('只认行首七个字符：行中间的 <<<<<<< 不是标记（与 git 判据一致）', () => {
  assert.equal(M.hasConflictMarkers('int mask = 1 << <<<<<<< ;\n'), false);
  assert.equal(M.parseConflictMarkers('int mask = 1 << <<<<<<< ;\n').hasMarkers, false);
  assert.equal(M.hasConflictMarkers('======= \n'), true);
  assert.equal(M.hasConflictMarkers('====== \n'), false, '六个等号不算标记');
});

test('行尾逐行保真：CRLF 文件解决后不得混入裸 LF，也不得凭空补尾换行', () => {
  const lfOnly = s => (s.match(/(?<!\r)\n/g) || []).length;
  const ours = M.resolveConflicts(MERGE_CRLF, ['ours']);
  assert.equal(ours, 'a\r\nmine\r\nz\r\n');
  assert.equal(lfOnly(ours), 0, '解决区不能只剩 \\n');
  const both = M.resolveConflicts(MERGE_CRLF, ['both']);
  assert.equal(both, 'a\r\nmine\r\ntheirs\r\nz\r\n');
  const noTail = 'a\r\n<<<<<<< H\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> b';
  assert.equal(M.resolveConflicts(noTail, ['ours']), 'a\r\nmine');
  assert.equal(M.resolveConflicts(noTail, ['theirs']), 'a\r\ntheirs');
});

test('自定义正文（AI 合并结果）按所在文件行尾落地，模型给 LF 也不会污染 CRLF', () => {
  assert.equal(M.resolveConflicts(MERGE_CRLF, ['merged1\nmerged2']), 'a\r\nmerged1\r\nmerged2\r\nz\r\n');
  assert.equal(M.resolveConflicts(MERGE_LF, ['merged']), 'a\nmerged\nz\n');
});

test('选择数目与内容缺失一律抛错，绝不静默按 ours 兜底', () => {
  assert.throws(() => M.resolveConflicts(MERGE_LF, ['ours', 'theirs']), /数目/);
  assert.throws(() => M.resolveConflicts(MERGE_LF, []), /数目/);
  assert.throws(() => M.resolveConflicts(MERGE_LF, [null]), /有效选择/);
  assert.equal(M.resolveConflicts(MERGE_LF, ['both']), 'a\nmine\ntheirs\nz\n');
});

test('变基换边：swapSides 后 ours 恒等于用户侧，标签同步交换', () => {
  const plain = M.parseConflictMarkers(MERGE_LF).regions[0];
  const swapped = M.parseConflictMarkers(MERGE_LF, { swapSides: true }).regions[0];
  assert.equal(asStr(swapped.ours.lines), asStr(plain.theirs.lines));
  assert.equal(asStr(swapped.theirs.lines), asStr(plain.ours.lines));
  assert.equal(swapped.oursLabel, 'feat');
  assert.equal(swapped.theirsLabel, 'HEAD');
  assert.equal(M.resolveConflicts(MERGE_LF, ['ours'], { swapSides: true }), 'a\ntheirs\nz\n');
});

test('写盘前的最后一道闸：解决结果残留标记必须能被检出', () => {
  assert.equal(M.hasConflictMarkers(M.resolveConflicts(MERGE_LF, ['ours'])), false);
  assert.equal(M.hasConflictMarkers('a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feat\nz\n'), true);
  assert.equal(M.hasConflictMarkers('x\n||||||| 7d963b9\ny\n'), true, 'diff3 基线标记同样是残留');
});

test('摘要文案：畸形优先说明，其次处数', () => {
  assert.equal(M.summarizeConflicts({ malformed: true, regions: [1] }), '冲突标记不成对（畸形），无法自动解决');
  assert.equal(M.summarizeConflicts(M.parseConflictMarkers(DIFF3)), '1 处冲突');
  assert.equal(M.summarizeConflicts(M.parseConflictMarkers('clean\n')), '没有冲突区域');
});

test('主进程接线：未合并清单用 --diff-filter=U，变基语义统一，AI 合并走同一判据', () => {
  assert.match(MAIN, /'diff', '--name-only', '--diff-filter=U', '-z'/, 'AA/DD 等无 U 列态必须进清单');
  assert.match(MAIN, /function sidesAreSwapped[\s\S]{0,200}op\.kind === 'rebase' \|\| op\.kind === 'am'/, '变基与应用补丁期间换边');
  assert.match(MAIN, /require\(path\.join\(__dirname, '\.\.', 'renderer', 'js', 'git-conflict-markers\.js'\)\)/, '主进程复用同一份纯函数');
  assert.match(MAIN, /parseConflictMarkers\(content, \{ swapSides \}\)/);
  assert.match(MAIN, /resolveConflicts\(content, picks, \{ swapSides \}\)/, '解析与写盘必须同一口径');
  assert.match(MAIN, /hasConflictMarkers\(cleaned\)[\s\S]{0,160}模型输出仍含冲突标记/, '模型残留标记即中止');
  assert.match(MAIN, /if \(conflictMarkers\.hasConflictMarkers\(resolvedText\)\)[\s\S]{0,80}未写盘/, '写盘前复检');
  assert.doesNotMatch(MAIN, /CONFLICT_RE/, '主进程不应再留第二套冲突正则');
  assert.match(MAIN, /conflicted = conflicted\.filter\(p => p === want\)/, 'onlyRel 必须校验文件真的处于未合并态');
});

test('preload 透传 onlyRel：点单个文件不得重写全部冲突文件', () => {
  assert.match(PRELOAD, /aiResolveConflicts: \(cwd, onlyRel\) => ipcRenderer\.invoke\('git:aiResolveConflicts', cwd, onlyRel\)/);
});

test('渲染层接线：逐处选择面板 + 工具委托主进程 + 脚本引入', () => {
  assert.match(APP, /window\.BubaiCodeConflict/, '渲染层取共享判据');
  assert.match(APP, /async function renderConflictPicker/, '逐处选择面板');
  assert.match(APP, /\['ours', '采用我的'\], \['theirs', '采用对方'\], \['both', '保留双方'\]/);
  assert.match(APP, /if \(M\.hasConflictMarkers\(resolved\)\) \{ showToast\('解决结果仍含冲突标记，已拒绝写盘'/, '写盘前复检');
  assert.match(APP, /parsed\.malformed[\s\S]{0,160}不会猜测或改写文件/, '畸形只说明不猜测');
  assert.match(APP, /await window\.BubaiCode\.git\.aiResolveConflicts\(cwd, c\.path\)/, 'AI 合并按文件下刀');
  assert.match(APP, /name: 'resolve_merge_conflict'[\s\S]{0,900}aiResolveConflicts\(cwd, it\.path\)/, 'agent 工具与 UI 共用主进程判据');
  assert.doesNotMatch(APP, /const CONFLICT_RE =/, '渲染层不应再留第二套冲突正则');
  assert.ok(HTML.indexOf('js/git-conflict-markers.js') < HTML.indexOf('js/app.js'), '脚本必须在 app.js 之前引入');
  assert.doesNotThrow(() => new Function(APP), 'app.js 存在语法错误');
});

test('刷新不打回：展开中的逐处选择面板在列表重建后自动恢复', () => {
  assert.match(APP, /const openConflictPickers = new Set\(\)/, '记住展开状态');
  assert.match(APP, /openConflictPickers\.add\(key\)[\s\S]{0,200}renderConflictPicker\(cwd, c\.path, detail, swapSides\)/, '展开时登记');
  assert.match(APP, /openConflictPickers\.delete\(key\); return;/, '收起时注销');
  assert.match(APP, /if \(openConflictPickers\.has\(key\)\) toggles\.push\(btnPick\)/, '重建时收集待恢复项');
  assert.match(APP, /setTimeout\(\(\) => toggles\.forEach\(b => b\.click\(\)\), 0\)/, '列表落位后恢复展开');
  assert.match(APP, /\[\.\.\.openConflictPickers\]\.forEach\(k => \{ if \(!keepOpen\.has\(k\)\) openConflictPickers\.delete\(k\); \}\)/, '文件解决后清理陈旧登记');
});

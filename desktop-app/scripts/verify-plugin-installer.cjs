'use strict';
/**
 * P3-2 验收：插件 installer 字段 + 可执行文件自动探测。
 * 运行：node scripts/verify-plugin-installer.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SPEC = require(path.join(ROOT, 'packages/engine/plugin-installer-spec.cjs'));
const LOADER = fs.readFileSync(path.join(ROOT, 'renderer/js/plugin-loader.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');

test('parseFileName：固定名 / 单段通配', () => {
  assert.deepEqual(SPEC.parseFileName('openscad-nightly.zip'), { exact: 'openscad-nightly.zip', patterns: [] });
  const w = SPEC.parseFileName('OpenSCAD-*-x86_64-Installer.exe');
  assert.equal(w.exact, '');
  assert.equal(w.patterns.length, 1);
  assert.equal(w.patterns[0].prefix, 'OpenSCAD-');
  assert.equal(w.patterns[0].suffix, '-x86_64-Installer.exe');
});

test('looksLikeFileUrl / joinUrl：目录+fileName 组合', () => {
  assert.equal(SPEC.looksLikeFileUrl('https://files.openscad.org/snapshots/'), false);
  assert.equal(SPEC.looksLikeFileUrl('https://x.cn/a/b.zip'), true);
  assert.equal(SPEC.joinUrl('https://files.openscad.org/snapshots/', 'a.zip'), 'https://files.openscad.org/snapshots/a.zip');
  assert.equal(SPEC.joinUrl('https://files.openscad.org/snapshots', 'a.zip'), 'https://files.openscad.org/snapshots/a.zip');
  // 已是文件 URL 时不重复拼
  assert.equal(SPEC.joinUrl('https://x.cn/a.zip', 'b.zip'), 'https://x.cn/a.zip');
});

test('normalizeInstaller：BubaiCode 的 {url,fileName,depName} → deps opts', () => {
  const r = SPEC.normalizeInstaller(
    { url: 'https://files.openscad.org/snapshots/', fileName: 'OpenSCAD-2025.11.20-x86_64-Installer.exe', depName: 'openscad' },
    { platform: 'win32' }
  );
  assert.equal(r.errors.length, 0);
  assert.equal(r.ops.length, 1);
  const op = r.ops[0];
  assert.equal(op.name, 'openscad');
  assert.equal(op.url, 'https://files.openscad.org/snapshots/OpenSCAD-2025.11.20-x86_64-Installer.exe');
  assert.equal(op.exeRelPath, '', 'exeRelPath 缺省 → 装完自动探测');
  assert.equal(op.autoExe, true);
});

test('normalizeInstaller：fileName 通配 → fileNamePattern（主进程据此 HEAD 预检）', () => {
  const r = SPEC.normalizeInstaller(
    { url: 'https://files.openscad.org/snapshots/', fileName: 'OpenSCAD-*-x86_64-Installer.exe', depName: 'openscad' },
    { platform: 'win32' }
  );
  const op = r.ops[0];
  assert.ok(op.fileNamePattern, '应产出通配模式');
  assert.equal(op.fileNamePattern.prefix, 'OpenSCAD-');
  assert.equal(op.fileName, '', '通配时不设固定 fileName');
});

test('normalizeInstaller：缺 depName / 缺 url 报错并跳过', () => {
  const r = SPEC.normalizeInstaller([{ url: 'https://x/' }, { depName: 'a' }], {});
  assert.equal(r.ops.length, 0);
  assert.equal(r.errors.length, 2);
});

test('normalizeInstaller：支持数组形态 + mirrors（url 首选、mirrors 回退）', () => {
  const r = SPEC.normalizeInstaller([
    { url: 'https://a/', fileName: 'x.zip', depName: 'x' },
    { url: 'https://b/', fileName: 'y.zip', depName: 'y', mirrors: ['https://m/'] },
  ], {});
  assert.equal(r.ops.length, 2);
  assert.equal(r.ops[1].url, 'https://b/y.zip', 'url 为首选源');
  assert.deepEqual(r.ops[1].mirrors, ['https://m/y.zip'], 'mirrors 为回退候选');
});

test('detectExeRelPath：同名目录优先 → 同名前缀 → 候选名 → 唯一可执行文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  // 场景1：同名目录内含 exe
  fs.mkdirSync(path.join(dir, 'openscad'));
  fs.writeFileSync(path.join(dir, 'openscad', 'openscad.exe'), 'x');
  assert.equal(SPEC.detectExeRelPath(dir, 'openscad', SPEC.exeCandidates('win32')), path.join('openscad', 'openscad.exe'));

  // 场景2：唯一可执行文件
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec2-'));
  fs.writeFileSync(path.join(dir2, 'tool.exe'), 'x');
  fs.writeFileSync(path.join(dir2, 'readme.txt'), 'x');
  assert.equal(SPEC.detectExeRelPath(dir2, 'tool', SPEC.exeCandidates('win32')), 'tool.exe');

  // 场景3：多个可执行文件且无同名 → 找不到（返回空，避免误选）
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec3-'));
  fs.writeFileSync(path.join(dir3, 'a.exe'), 'x');
  fs.writeFileSync(path.join(dir3, 'b.exe'), 'x');
  assert.equal(SPEC.detectExeRelPath(dir3, 'zzz', SPEC.exeCandidates('win32')), '');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.rmSync(dir3, { recursive: true, force: true });
});

test('渲染层：installer 规范化已内联且已接入 manifest 解析', () => {
  assert.ok(LOADER.includes('function normalizePluginInstaller('), '缺内联规范化函数');
  assert.ok(LOADER.includes('if (manifest.installer) {'), 'manifest.installer 未接入');
  assert.ok(LOADER.includes('normalizePluginInstaller(manifest.installer)'), '未调用规范化');
  // 纯浏览器脚本：不得出现 require
  assert.ok(!/require\(['"]\.\.\/\.\.\/packages/.test(LOADER), '渲染层不应 require packages/');
  assert.ok(LOADER.includes('fileNamePattern'), '应透传 fileNamePattern');
});

test('主进程：exeRelPath 缺省可装 + 装完自动探测 + 通配 HEAD 预检', () => {
  assert.ok(MAIN.includes("if (!name || !o.url)"), 'exeRelPath 不应再是硬性前置');
  assert.ok(MAIN.includes('SPEC.detectExeRelPath(destDir, name'), '缺装完自动探测');
  assert.ok(MAIN.includes('o.fileNamePattern'), '缺 fileNamePattern 分支');
  assert.ok(MAIN.includes('安装完成'), '应保留完成分支');
});

test('不改既有 dependencies 语义：显式声明优先于 installer', () => {
  assert.ok(LOADER.includes('if (depNorm.some(x => x.name === op.name)) continue;'), 'installer 不应覆盖显式 dependencies');
});

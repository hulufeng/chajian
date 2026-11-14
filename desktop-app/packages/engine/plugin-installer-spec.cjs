'use strict';
/**
 * plugin-installer-spec.cjs — 插件 installer 字段的规范化纯函数
 *
 * 背景（对齐参考基线）：
 *  参考基线 插件 manifest 支持 `installer: { url, fileName, depName }`，
 *  语义是「安装插件时按 url 目录 + fileName 组合出真实下载地址并自动装依赖」。
 *  但其 openscad 插件写死 `fileName: 'openscad-nightly.zip'`，而实际目录是
 *  版本化命名（`OpenSCAD-2025.11.20-x86-64-Installer.exe`）⇒ 必然 404。
 *
 *  BubaiCode 现有 `dependencies:[{name,url,exeRelPath,...}]` 链路已具备
 *  下载/sha256/解压/幂等/多镜像，只缺三处：
 *   ① `exeRelPath` 必填 → 无法声明「只解压、路径未知」的包；
 *   ② `url` 必须是完整文件 URL → 不支持「目录 + fileName」组合；
 *   ③ 落盘固定在全局 `tools/<name>` → 不支持 基线式共享 `plugins/bin/<depName>`。
 *
 * 本模块提供 installer 字段 → deps:install opts 的规范化，并内置
 * 「HEAD 预检 + fileName 通配」能力，避免重蹈 404 静默失败。
 */

/** 平台 → 常见可执行后缀（用于自动推断 exeRelPath / 校验下载物）。 */
const EXE_SUFFIX = { win32: '.exe', darwin: '', linux: '' };

/**
 * fileName 支持通配：把 `*` 展开成候选列表。
 * 例：`OpenSCAD-*-x86_64-Installer.exe` → 候选模式。
 * 返回 { exact, patterns }：exact 为可直接用的固定名，patterns 为需列表探测的模式。
 */
function parseFileName(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) return { exact: '', patterns: [] };
  if (!raw.includes('*')) return { exact: raw, patterns: [] };
  const parts = raw.split('*');
  // 仅支持单段通配（如 OpenSCAD-*-x86_64-Installer.exe）
  const prefix = parts[0];
  const suffix = parts.length > 1 ? parts[parts.length - 1] : '';
  return { exact: '', patterns: [{ prefix, suffix, raw }] };
}

/** 判断 URL 是否已是完整文件 URL（带扩展名），否则视为「目录 URL」。 */
function looksLikeFileUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  try {
    const p = new URL(u);
    const last = p.pathname.split('/').filter(Boolean).pop() || '';
    return /\.(zip|tar\.gz|tgz|exe|dmg|7z|bin)$/i.test(last);
  } catch (e) {
    return /\.(zip|tar\.gz|tgz|exe|dmg|7z|bin)$/i.test(u);
  }
}

/** 目录 URL + fileName → 完整文件 URL（目录 URL 末尾补 /）。 */
function joinUrl(baseUrl, fileName) {
  const b = String(baseUrl || '').trim();
  const f = String(fileName || '').trim();
  if (!b) return '';
  if (!f) return b;
  if (looksLikeFileUrl(b)) return b; // 已是文件 URL，忽略 fileName
  return b.replace(/\/+$/, '') + '/' + f.replace(/^\/+/, '');
}

/**
 * 规范化 manifest.installer → deps:install 的 opts（可多个）。
 * @param {object} installer  manifest.installer
 * @param {object} ctx { pluginId, platform, destDir, exeRelPath, sha256, mirrors, minBytes, archive }
 * @returns {{ops:Array, errors:Array<string>}}
 */
function normalizeInstaller(installer, ctx) {
  const c = ctx || {};
  const errors = [];
  const out = { ops: [], errors };

  const list = Array.isArray(installer) ? installer : (installer ? [installer] : []);
  if (!list.length) return out;

  for (const inst of list) {
    if (!inst) continue;
    const depName = String(inst.depName || inst.name || '').trim();
    if (!depName) { errors.push('installer 条目缺 depName，已跳过'); continue; }
    const baseUrl = String(inst.url || '').trim();
    if (!baseUrl) { errors.push(`installer[${depName}] 缺 url，已跳过`); continue; }

    const fn = parseFileName(inst.fileName);
    // 候选下载 URL：完整文件 URL 优先；目录 + fileName 组合
    const candidates = [];
    if (fn.exact) {
      candidates.push(joinUrl(baseUrl, fn.exact));
    } else if (fn.patterns.length) {
      // 通配：主进程在 HEAD 探测时用 pattern 匹配真实文件名
      candidates.push(joinUrl(baseUrl, inst.fileName)); // 兜底：原样拼接（可能 404，由 HEAD 预检拦截）
    } else {
      candidates.push(baseUrl);
    }

    // 候选源语义：url 为首选，mirrors 为回退（与主进程 installDependency 的 mirrors[] 一致）
    const mirrors = Array.isArray(inst.mirrors)
      ? inst.mirrors.map(m => joinUrl(m, fn.exact || '')).filter(Boolean)
      : [];
    const urls = candidates.slice();

    const op = {
      name: depName,
      url: urls[0] || baseUrl,
      // exeRelPath 现在可缺省：装完后再按 destDir 探测唯一可执行文件
      exeRelPath: c.exeRelPath || inst.exeRelPath || '',
      mirrors: mirrors.concat(urls.slice(1)),
      sha256: String(inst.sha256 || c.sha256 || ''),
      archive: inst.archive === 'tar.gz' ? 'tar.gz' : (c.archive || 'zip'),
      flatten: inst.flatten !== undefined ? !!inst.flatten : (c.flatten !== false),
      minBytes: Number(inst.minBytes || c.minBytes) || 1000000,
      destDir: c.destDir || '',
      // installer 专属：fileName 模式（HEAD 预检时按 pattern 找真实文件）
      fileName: fn.exact || '',
      fileNamePattern: fn.patterns.length ? fn.patterns[0] : null,
      // 自动探测可执行文件的开关（exeRelPath 缺省时生效）
      autoExe: !c.exeRelPath && !inst.exeRelPath,
    };
    out.ops.push(op);
  }
  return out;
}

/**
 * 自动探测解压根目录下的唯一可执行文件（exeRelPath 缺省时用）。
 * 优先同名目录，其次唯一可执行文件。
 * @param {string} destDir 已解压目录
 * @param {string} depName 依赖名（用于同名目录优先）
 * @param {string[]} candidates 候选文件名（按平台）
 * @returns {string} 相对 destDir 的路径；找不到返回 ''
 */
function detectExeRelPath(destDir, depName, candidates) {
  const fs = require('fs');
  const path = require('path');
  let entries = [];
  try { entries = fs.readdirSync(destDir); } catch (e) { return ''; }
  const exes = entries.filter(n => /\.(exe|com|bat|cmd|sh|bin|dylib|so)$/i.test(n) && !n.startsWith('.') && !/readme|license|changelog/i.test(n));
  // 1) 同名目录优先（如 openscad/openscad.exe）
  if (depName) {
    const sameDir = path.join(destDir, depName);
    try { if (fs.statSync(sameDir).isDirectory()) {
      const inner = fs.readdirSync(sameDir).filter(n => /\.(exe|com|bat|cmd|sh|bin)$/i.test(n));
      if (inner.length) return path.join(depName, inner[0]);
    } } catch (e) {}
    const sameFile = exes.find(n => n.toLowerCase().startsWith(depName.toLowerCase()));
    if (sameFile) return sameFile;
  }
  // 2) 候选名（平台常见）
  for (const c of (candidates || [])) {
    if (exes.includes(c)) return c;
  }
  // 3) 唯一可执行文件
  if (exes.length === 1) return exes[0];
  return '';
}

/** 平台 → exe 候选名列表。 */
function exeCandidates(platform) {
  if (platform === 'win32') return ['openscad.exe', 'sdcc.exe', 'stcgal.exe', 'tool.exe', 'main.exe'];
  if (platform === 'darwin') return ['openscad', 'sdcc', 'stcgal', 'tool'];
  return ['openscad', 'sdcc', 'stcgal', 'tool'];
}

module.exports = {
  EXE_SUFFIX,
  parseFileName,
  looksLikeFileUrl,
  joinUrl,
  normalizeInstaller,
  detectExeRelPath,
  exeCandidates,
};

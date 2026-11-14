// Phase D · 产品工厂主进程服务（对齐参考基线 product-state.js / main:1185-1186,1344,1362-1368）
// 磁盘文件是阶段状态的唯一真相；渲染层只消费 computeState() 的结果。
const fs = require('fs');
const path = require('path');

const STAGE_IDS = ['idea', 'shape', 'hardware', 'software', 'integration'];
const STAGE_LABELS = { idea: '创意', shape: '造型', hardware: '硬件', software: '软件', integration: '联调' };
const STATES = ['not_started', 'in_progress', 'blocked', 'done'];

// 允许读写的相对路径白名单（防路径穿越）
const ALLOWED_RELS = new Set([
  '.triecode.json', '.bubaicode.json', 'spec.md', 'spec.json',
  'design/shape.json', 'bom.json', 'constraints.json', 'evidence.jsonl',
  'hardware-package/.manifest.json', 'hardware-package/requirements.md',
  'hardware-package/bom.csv', 'hardware-package/evidence.md', 'hardware-package/README.md'
]);
const FINGERPRINT_RELS = [
  'spec.md', 'spec.json', 'bom.json', 'constraints.json', 'evidence.jsonl', 'design/shape.json'
];

function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !ALLOWED_RELS.has(rel)) return null;
  const p = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (!p.startsWith(base)) return null;
  return p;
}

function readText(root, rel) {
  try {
    const p = safeJoin(root, rel);
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch (e) { return null; }
}

function readJson(root, rel, fallback) {
  const t = readText(root, rel);
  if (t == null) return fallback;
  try { return JSON.parse(t); } catch (e) { return fallback; }
}

function readJsonl(root, rel) {
  const t = readText(root, rel);
  if (!t) return [];
  return t.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(Boolean);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function fingerprint(root) {
  return fnv1a(FINGERPRINT_RELS.map(rel => readText(root, rel) || '').join('\u0001'));
}

function listDir(root, rel) {
  try {
    const p = path.resolve(root, rel);
    if (!p.startsWith(path.resolve(root) + path.sep)) return [];
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isFile() && !/\.(md|txt)$/i.test(d.name)) // 说明文件不算固件/视图产物
      .map(d => d.name);
  } catch (e) { return []; }
}

/** 判定产品项目：配置文件的 projectType === 'product' */
function isProductProject(root) {
  if (!root || !fs.existsSync(root)) return false;
  const a = readJson(root, '.triecode.json', null);
  const b = readJson(root, '.bubaicode.json', null);
  return !!((a && a.projectType === 'product') || (b && b.projectType === 'product'));
}

/** 有效证据：作废链 invalidates 命中者失效；只认 result === 'pass' 作为覆盖 */
function effectiveEvidence(root) {
  const rows = readJsonl(root, 'evidence.jsonl');
  const invalidated = new Set();
  rows.forEach(r => {
    if (Array.isArray(r.invalidates)) r.invalidates.forEach(id => invalidated.add(id));
  });
  return rows.filter(r => !invalidated.has(r.id));
}

/**
 * computeStages：从磁盘计算五阶段状态（对齐参考基线 product-state.js:300-386）
 * 规则：blocked 优先于 done；对话里说完成不算完成，只认文件与证据。
 */
function computeStages(root) {
  const spec = readJson(root, 'spec.json', { confirmed: false, criteria: [] }) || {};
  const specMd = readText(root, 'spec.md');
  const shape = readJson(root, 'design/shape.json', null);
  const bom = readJson(root, 'bom.json', { items: [] }) || { items: [] };
  const constraints = readJson(root, 'constraints.json', null);
  const evidence = effectiveEvidence(root);
  const firmware = listDir(root, 'firmware');
  const views = listDir(root, 'design/views');
  const criteria = Array.isArray(spec.criteria) ? spec.criteria : [];
  const items = Array.isArray(bom.items) ? bom.items : [];

  const passRows = evidence.filter(r => r.result === 'pass');
  const covered = new Set();
  passRows.forEach(r => (Array.isArray(r.covers) ? r.covers : []).forEach(c => covered.add(c)));
  const hasFail = evidence.some(r => r.result === 'fail');
  const notes = {};

  // 01 idea
  let s1 = 'not_started', n1 = '尚无需求文件';
  // 脚手架自带的 spec.md 模板不算进度；只有写出验收条件才算开始
  if (criteria.length) {
    s1 = 'in_progress'; n1 = '需求已起草，待确认验收条件';
  }
  if (criteria.length > 0 && spec.confirmed === true) { s1 = 'done'; n1 = '需求与验收条件已确认'; }
  notes.idea = n1;

  // 02 shape
  let s2 = 'not_started', n2 = '尚无结构文件';
  // 脚手架的空 shape.json（model/mesh/views 全空）不算进度
  const shapeViews0 = shape && Array.isArray(shape.views) ? shape.views : [];
  const shapeStarted = !!(shape && (shape.model || shape.mesh || shapeViews0.length || views.length));
  if (shapeStarted) {
    s2 = 'in_progress'; n2 = '结构文件存在，缺模型/网格/视图';
    const shapeViews = shapeViews0;
    const viewCount = Math.max(shapeViews.length, views.length);
    if (!shape.model || !shape.mesh) { n2 = '缺 3D 模型或网格'; }
    else if (viewCount < 1) { n2 = '缺 2D 视图'; }
    else if (shape.confirmed !== true) { n2 = '待确认结构'; }
    else { s2 = 'done'; n2 = '结构、网格、视图齐备且已确认'; }
  }
  notes.shape = n2;

  // 03 hardware（缺 source.url → blocked 优先于 done）
  let s3 = 'not_started', n3 = '尚无 BOM';
  const missingUrl = items.filter(it => !it.source || !it.source.url);
  if (items.length) {
    s3 = 'in_progress'; n3 = 'BOM 已列出，待确认选型';
    if (missingUrl.length) { s3 = 'blocked'; n3 = missingUrl.length + ' 个器件缺来源链接'; }
    else if (items.some(it => it.status !== 'confirmed')) { n3 = '仍有器件未确认'; }
    else { s3 = 'done'; n3 = 'BOM 全部确认且有来源'; }
  }
  notes.hardware = n3;

  // 04 software
  let s4 = 'not_started', n4 = '尚无固件文件';
  if (firmware.length) { s4 = 'in_progress'; n4 = '固件存在，缺编译通过证据'; }
  const swPass = passRows.some(r => r.stage === 'software');
  if (firmware.length && swPass) { s4 = 'done'; n4 = '固件与编译证据齐备'; }
  notes.software = n4;

  // 05 integration
  let s5 = 'not_started', n5 = '尚无联调证据';
  if (evidence.length) { s5 = 'in_progress'; n5 = '证据已记录，待覆盖全部验收条件'; }
  const allCovered = criteria.length > 0 && criteria.every(c => covered.has(c.id));
  if (hasFail) { s5 = 'blocked'; n5 = '存在失败证据，需修复'; }
  else if (allCovered && passRows.length > 0) { s5 = 'done'; n5 = '全部验收条件均有通过证据'; }
  notes.integration = n5;

  const stateById = { idea: s1, shape: s2, hardware: s3, software: s4, integration: s5 };
  const stages = STAGE_IDS.map((id, i) => ({
    id, index: i + 1, label: STAGE_LABELS[id],
    state: STATES.indexOf(stateById[id]) >= 0 ? stateById[id] : 'not_started',
    note: notes[id]
  }));
  const doneCount = stages.filter(s => s.state === 'done').length;
  const unproven = criteria.filter(c => !covered.has(c.id)).map(c => c.id);

  // 产品包过期判定
  const manifest = readJson(root, 'hardware-package/.manifest.json', null);
  const currentHash = fingerprint(root);
  const packageStale = !!manifest && manifest.inputsHash !== currentHash;
  const packageBuilt = !!manifest;

  return {
    isProduct: isProductProject(root),
    stages,
    meter: { hit: criteria.length - unproven.length, total: criteria.length, doneCount, progress: doneCount / 5 },
    unproven,
    data: {
      spec: { body: specMd || '', criteria, confirmed: spec.confirmed === true },
      shape, bomItems: items, constraints, evidence, firmwareFiles: firmware, viewFiles: views
    },
    package: { built: packageBuilt, stale: packageStale, inputsHash: currentHash, fileCount: (manifest && Array.isArray(manifest.files)) ? manifest.files.length : 0 },
    updatedAt: Date.now()
  };
}

/** 新建产品项目脚手架（对齐参考基线 main:1185-1186）
 *  root 是用户选择的「父目录」，项目建在 root/<产品名>/ 下——此前直接铺进 root，
 *  会用 writeFileSync 静默覆盖用户已有的 spec.md / bom.json / .triecode.json 等文件。
 */
function createScaffold(root, name) {
  if (!root || typeof root !== 'string') return { success: false, error: '缺少目录' };
  const parent = path.resolve(root);
  const projectName = String(name || '未命名产品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const base = path.join(parent, projectName);
  try {
    // 防覆盖：目标子目录已存在且非空时拒绝创建，避免破坏用户数据
    if (fs.existsSync(base)) {
      const existing = fs.readdirSync(base);
      if (existing.length > 0) return { success: false, error: '目录已存在且非空：' + base };
    }
    fs.mkdirSync(path.join(base, 'firmware'), { recursive: true });
    fs.mkdirSync(path.join(base, 'design', 'views'), { recursive: true });
    fs.mkdirSync(path.join(base, 'hardware-package'), { recursive: true });
    const writes = {
      '.triecode.json': JSON.stringify({ version: 1, projectType: 'product', toolchain: 'none' }, null, 2),
      'spec.md': `# ${projectName}\n\n## 想做什么\n\n（由 AI 在需求沟通后填写）\n\n## 使用场景与限制\n`,
      'spec.json': JSON.stringify({ confirmed: false, criteria: [] }, null, 2),
      'design/shape.json': JSON.stringify({ unit: 'mm', dims: null, model: null, mesh: null, views: [], confirmed: false }, null, 2),
      'bom.json': JSON.stringify({ items: [] }, null, 2),
      'constraints.json': JSON.stringify({ power: {}, pins: [], buses: [] }, null, 2),
      'evidence.jsonl': ''
    };
    Object.keys(writes).forEach(rel => {
      fs.writeFileSync(path.join(base, rel), writes[rel], 'utf-8');
    });
    return { success: true, path: base, name: projectName };
  } catch (e) { return { success: false, error: e.message }; }
}

/** 生成产品包（对齐参考基线 main:1362-1368），导出到 hardware-package/ 目录 */
function buildPackage(root) {
  if (!isProductProject(root)) return { success: false, error: '当前不是产品项目' };
  const st = computeStages(root);
  const d = st.data;
  try {
    const out = path.resolve(root, 'hardware-package');
    fs.mkdirSync(out, { recursive: true });
    const requirements = `# 产品需求\n\n${d.spec.body}\n\n## 验收条件\n\n${d.spec.criteria.map(c => '- ' + c.id + ': ' + (c.text || '') + (c.verify ? '（验证：' + c.verify + '）' : '')).join('\n') || '（未定义）'}\n`;
    const bomCsv = 'role,part,qty,status,source\n' + d.bomItems.map(it =>
      [it.role, it.part, it.qty, it.status, it.source && it.source.url].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')
    ).join('\n');
    const evidenceMd = `# 验证证据\n\n| id | stage | result | claim | covers |\n|---|---|---|---|---|\n` +
      d.evidence.map(r => '| ' + [r.id, r.stage, r.result, r.claim, (r.covers || []).join(';')].join(' | ') + ' |').join('\n');
    const readme = `# 产品包\n\n生成时间：${new Date().toISOString()}\n\n- 阶段进度：${st.meter.doneCount}/5\n- 验收覆盖：${st.meter.hit}/${st.meter.total}\n- 输入指纹：${st.package.inputsHash}\n`;
    const manifest = {
      generatedAt: Date.now(), inputsHash: st.package.inputsHash,
      files: ['requirements.md', 'bom.csv', 'evidence.md', 'README.md', '.manifest.json'],
      skipped: []
    };
    const writes = {
      'requirements.md': requirements, 'bom.csv': bomCsv, 'evidence.md': evidenceMd,
      'README.md': readme, '.manifest.json': JSON.stringify(manifest, null, 2)
    };
    Object.keys(writes).forEach(f => fs.writeFileSync(path.join(out, f), writes[f], 'utf-8'));
    return { success: true, files: manifest.files, inputsHash: manifest.inputsHash };
  } catch (e) { return { success: false, error: e.message }; }
}

function readStateFile(root, rel) {
  const p = safeJoin(root, rel);
  if (!p) return { success: false, error: '不允许的路径' };
  const t = readText(root, rel);
  return { success: true, content: t == null ? '' : t };
}

function writeStateFile(root, rel, content) {
  const p = safeJoin(root, rel);
  if (!p) return { success: false, error: '不允许的路径' };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(content == null ? '' : content), 'utf-8');
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// ---- 文件监听（300ms 防抖；只关心产品相关文件）----
let watcher = null;
let watchTimer = null;
const PRODUCT_FILE_RE = /(?:^|[\\/])(spec\.(md|json)|bom\.json|constraints\.json|evidence\.jsonl|shape\.json|\.manifest\.json)$|[\\/](?:firmware|design|hardware-package)[\\/]/i;

function startWatch(root, send) {
  stopWatch();
  if (!root || !fs.existsSync(root)) return { success: false, error: '目录不存在' };
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename || !PRODUCT_FILE_RE.test(filename)) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try { send({ root, changed: [String(filename)], at: Date.now() }); } catch (e) {}
      }, 300);
    });
    watcher.on('error', () => {});
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

function stopWatch() {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
  return { success: true };
}

module.exports = {
  STAGE_IDS, STAGE_LABELS, isProductProject, computeStages, createScaffold, buildPackage,
  readStateFile, writeStateFile, startWatch, stopWatch, fingerprint
};

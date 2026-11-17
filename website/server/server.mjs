// codelab-site 官网后台服务端（零运行时依赖 Node ESM）
// 职责：静态托管官网 + 提供 /api/*（插件市场 / 联系表单 / 内容块 / 版本 / 下载计数 / 管理后台）
// 数据存储：./data/db.json（开发/演示用，生产请换正式 DB）
//
// 启动：
//   node server.mjs                 # 默认端口 8788，静态根 = 上级目录(codelab-site)
//   PORT=9000 node server.mjs
//
// 管理后台： http://<host>:<port>/admin/   （默认管理员见启动日志 / 环境变量 SITE_ADMIN_*）

import http from 'node:http';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 加载 server/.env（零依赖手写解析；真实环境变量优先于 .env）----------
// 配置与代码分离：管理员邮箱/密码、下载地址、端口等都放 server/.env，该文件不入库（见 .gitignore）。
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const SITE_ROOT = path.resolve(__dirname, '..'); // codelab-site 根（含 index.html / plugins.html ...）
// 数据目录可用环境变量覆盖（自检时用临时目录，避免污染真实库）
const DATA_DIR = process.env.SITE_DATA_DIR ? path.resolve(process.env.SITE_DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '0.0.0.0';

// 下载目标（可用环境变量覆盖；默认走 bluebubai.work 更新服务器）
const DOWNLOAD_URLS = {
  windows: process.env.DOWNLOAD_URL_WINDOWS || 'https://bluebubai.work/updates/BubaiCode-Setup-1.2.35.exe',
  macos: process.env.DOWNLOAD_URL_MACOS || 'https://bluebubai.work/updates/BubaiCode-Setup-1.2.35.dmg',
  linux: process.env.DOWNLOAD_URL_LINUX || 'https://bluebubai.work/updates/BubaiCode-Setup-1.2.35.AppImage',
};

// ---------- 数据层 ----------
function defaultDb() {
  const now = Date.now();
  return {
    users: [
      {
        id: 'admin',
        email: process.env.SITE_ADMIN_EMAIL || 'admin@bubaicode.dev',
        // 默认密码：环境变量 SITE_ADMIN_PASSWORD，否则开发默认 admin123（请生产改用强密码）
        pass: hashPassword(process.env.SITE_ADMIN_PASSWORD || 'admin123'),
        role: 'admin',
        createdAt: now,
      },
    ],
    sessions: {}, // token -> { userId, createdAt }
    plugins: seedPlugins(now),
    contacts: [],
    content: {}, // key -> { title, body, updatedAt }
    downloads: [], // { platform, version, ip, ts }
    version: { latest: '1.1.3', notes: '线上当前版本', updatedAt: now },
  };
}

function seedPlugins(now) {
  const base = (id) => `https://github.com/hulufeng/codelab-plugins/tree/main/${id}`;
  return [
    { id: 'arduino-cli-toolchain', name: 'Arduino CLI 工具链', version: '0.4.0', icon: '🔌',
      description: 'Arduino（AVR/ESP32/ESP8266）编译烧录、板卡与库管理', category: 'embedded',
      tags: ['编译', '烧录', '库管理'], github: base('arduino-cli-toolchain'), published: true, installs: 0, createdAt: now, updatedAt: now },
    { id: 'esp-idf-toolchain', name: 'ESP-IDF 工具链', version: '0.1.0', icon: '🌐',
      description: '图形化 Kconfig、编译/烧录/目标芯片/串口日志', category: 'embedded',
      tags: ['ESP32', 'ESP-IDF'], github: base('esp-idf-toolchain'), published: true, installs: 0, createdAt: now, updatedAt: now },
    { id: 'stm32-cube-toolchain', name: 'STM32Cube 工具链', version: '0.1.0', icon: '🔬',
      description: 'CMake + GCC 编译，SWD 一键烧录，裸机脚手架', category: 'embedded',
      tags: ['STM32', 'SWD'], github: base('stm32-cube-toolchain'), published: true, installs: 0, createdAt: now, updatedAt: now },
    { id: 'plugin-dev-toolchain', name: '插件开发工具链', version: '0.1.0', icon: '🛠️',
      description: '让 AI 帮你创建 BubaiCode 插件——生成骨架→校验→安装', category: 'ai',
      tags: ['元插件', '脚手架'], github: base('plugin-dev-toolchain'), published: true, installs: 0, createdAt: now, updatedAt: now },
    { id: 'browser-toolchain', name: '浏览器自动化', version: '0.1.0', icon: '🧭',
      description: '给 AI 一个可控的真实浏览器——打开网页、点击、抓取', category: 'ai',
      tags: ['browser', '自动化'], github: base('browser-toolchain'), published: true, installs: 0, createdAt: now, updatedAt: now },
    { id: 'mcs51-toolchain', name: 'MCS-51 工具chain', version: '0.1.0', icon: '⚙️',
      description: '8051 单片机编译烧录与寄存器视图', category: 'embedded',
      tags: ['8051', '单片机'], github: base('mcs51-toolchain'), published: false, installs: 0, createdAt: now, updatedAt: now },
  ];
}

let db = null;
let saveTimer = null;

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    // 字段补齐，避免旧数据缺段
    db.users ||= [];
    db.sessions ||= {};
    db.plugins ||= [];
    db.contacts ||= [];
    db.content ||= {};
    db.downloads ||= [];
    db.version ||= { latest: '1.1.3', notes: '', updatedAt: Date.now() };
  } catch {
    db = defaultDb();
    await saveDbNow();
  }
}

function saveDb() {
  // 防抖写入，避免高频请求抖动
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDbNow(); }, 200);
}

async function saveDbNow() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] 写入失败:', e.message);
  }
}

// ---------- 密码 / 令牌 ----------
function hashPassword(pw) {
  const salt = 'bubaicode-static-pw-salt-v1-7d2c';
  const derived = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(pw, stored) {
  const [salt, derived] = (stored || '').split(':');
  if (!salt || !derived) return false;
  const check = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken(n = 24) {
  return crypto.randomBytes(n).toString('hex');
}

// ---------- HTTP 工具 ----------
function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function getToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function currentUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}

function requireAdmin(req, res) {
  const u = currentUser(req);
  if (!u || u.role !== 'admin') {
    sendJson(res, 401, { error: '未授权，请先登录' });
    return null;
  }
  return u;
}

// ---------- 静态托管 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null; // 防目录穿越
  return resolved;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath;
  if (rel === '/' || rel === '' || rel === '/codelab' || rel === '/codelab/') rel = '/index.html';
  // /codelab/* 别名 -> 去掉前缀
  if (rel.startsWith('/codelab/')) rel = rel.slice('/codelab'.length) || '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
  // 后台源码 / 数据 / 自检脚本 不应被静态托管（防源码与 db.json 泄露）
  if (rel.startsWith('/server/')) return sendText(res, 404, 'Not Found');

  let filePath = safeJoin(SITE_ROOT, rel);
  if (!filePath) return sendText(res, 403, 'Forbidden');

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 站点内嵌管理后台（server/admin 目录），优先回退到它
    const adminPath = safeJoin(__dirname, 'admin' + (rel.startsWith('/admin') ? rel.slice('/admin'.length) || '/index.html' : rel));
    if (adminPath && rel.startsWith('/admin')) {
      try {
        const data = await fs.readFile(adminPath);
        const ext = path.extname(adminPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
        return;
      } catch { /* ignore */ }
    }
    sendText(res, 404, 'Not Found');
  }
}

// ---------- API ----------
function publicPluginView(p) {
  return {
    id: p.id, name: p.name, version: p.version, icon: p.icon || '🔧',
    description: p.description, category: p.category || 'embedded',
    tags: p.tags || [], github: p.github || '', installs: p.installs || 0,
  };
}

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  // 预检
  if (method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  // ---- 公开接口 ----
  if (pathname === '/api/plugins' && method === 'GET') {
    const list = db.plugins.filter((p) => p.published).map(publicPluginView);
    return sendJson(res, 200, { plugins: list });
  }

  const pluginDetail = pathname.match(/^\/api\/plugins\/([\w.-]+)$/);
  if (pluginDetail && method === 'GET') {
    const p = db.plugins.find((x) => x.id === pluginDetail[1] && x.published);
    if (!p) return sendJson(res, 404, { error: '插件不存在' });
    return sendJson(res, 200, publicPluginView(p));
  }

  // 插件安装计数（点击「安装」时前端调用）
  const installHit = pathname.match(/^\/api\/plugins\/([\w.-]+)\/install$/);
  if (installHit && method === 'POST') {
    const p = db.plugins.find((x) => x.id === installHit[1]);
    if (!p) return sendJson(res, 404, { error: '插件不存在' });
    p.installs = (p.installs || 0) + 1;
    saveDb();
    return sendJson(res, 200, { ok: true, installs: p.installs });
  }

  if (pathname === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { latest: db.version.latest, notes: db.version.notes, updatedAt: db.version.updatedAt });
  }

  // 公开内容块列表（首页公告条消费；无内容时返回空数组，前端自动隐藏）
  if (pathname === '/api/content' && method === 'GET') {
    const list = Object.keys(db.content).map((k) => ({ key: k, ...db.content[k] }));
    return sendJson(res, 200, { content: list });
  }

  const contentGet = pathname.match(/^\/api\/content\/([\w.-]+)$/);
  if (contentGet && method === 'GET') {
    const c = db.content[contentGet[1]];
    if (!c) return sendJson(res, 404, { error: '内容不存在' });
    return sendJson(res, 200, c);
  }

  if (pathname === '/api/downloads' && method === 'GET') {
    // 公开轻量统计：总次数 + 各平台
    const byPlatform = {};
    for (const d of db.downloads) byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
    return sendJson(res, 200, { total: db.downloads.length, byPlatform });
  }

  if (pathname === '/api/contact' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body || !body.message || !String(body.message).trim()) {
      return sendJson(res, 400, { error: '留言内容不能为空' });
    }
    const item = {
      id: randomToken(8),
      name: String(body.name || '').slice(0, 80),
      email: String(body.email || '').slice(0, 120),
      message: String(body.message).slice(0, 4000),
      ip: req.socket.remoteAddress || '',
      ts: Date.now(),
      read: false,
    };
    db.contacts.push(item);
    saveDb();
    return sendJson(res, 201, { ok: true, id: item.id });
  }

  // ---- 管理员登录（免鉴权）----
  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) return sendJson(res, 400, { error: '请求格式错误' });
    const u = db.users.find((x) => x.email === body.email);
    if (!u || !verifyPassword(body.password || '', u.pass)) {
      return sendJson(res, 401, { error: '邮箱或密码错误' });
    }
    const token = randomToken(24);
    db.sessions[token] = { userId: u.id, createdAt: Date.now() };
    saveDb();
    return sendJson(res, 200, { token, user: { id: u.id, email: u.email, role: u.role } });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const token = getToken(req);
    if (token && db.sessions[token]) { delete db.sessions[token]; saveDb(); }
    return sendJson(res, 200, { ok: true });
  }

  // ---- 以下均需要管理员 ----
  if (pathname.startsWith('/api/admin')) {
    const u = requireAdmin(req, res);
    if (!u) return; // requireAdmin 已回 401

    // 插件管理
    if (pathname === '/api/admin/plugins' && method === 'GET') {
      return sendJson(res, 200, { plugins: db.plugins.map((p) => ({ ...publicPluginView(p), published: p.published })) });
    }
    if (pathname === '/api/admin/plugins' && method === 'POST') {
      const b = await parseJsonBody(req);
      if (!b || !b.id || !b.name) return sendJson(res, 400, { error: 'id 与 name 必填' });
      if (db.plugins.find((x) => x.id === b.id)) return sendJson(res, 409, { error: '插件 id 已存在' });
      const now = Date.now();
      const p = {
        id: String(b.id), name: String(b.name), version: String(b.version || '0.1.0'),
        icon: String(b.icon || '🔧'), description: String(b.description || ''),
        category: String(b.category || 'embedded'), tags: Array.isArray(b.tags) ? b.tags : [],
        github: String(b.github || ''), published: b.published !== false, installs: 0,
        createdAt: now, updatedAt: now,
      };
      db.plugins.push(p); saveDb();
      return sendJson(res, 201, { ok: true, plugin: p });
    }

    const pluginId = pathname.match(/^\/api\/admin\/plugins\/([\w.-]+)$/);
    if (pluginId && method === 'PUT') {
      const p = db.plugins.find((x) => x.id === pluginId[1]);
      if (!p) return sendJson(res, 404, { error: '插件不存在' });
      const b = await parseJsonBody(req);
      if (!b) return sendJson(res, 400, { error: '请求格式错误' });
      for (const k of ['name', 'version', 'icon', 'description', 'category', 'github']) {
        if (b[k] !== undefined) p[k] = String(b[k]);
      }
      if (b.tags !== undefined) p.tags = Array.isArray(b.tags) ? b.tags : [];
      if (b.published !== undefined) p.published = !!b.published;
      p.updatedAt = Date.now();
      saveDb();
      return sendJson(res, 200, { ok: true, plugin: p });
    }
    if (pluginId && method === 'DELETE') {
      const idx = db.plugins.findIndex((x) => x.id === pluginId[1]);
      if (idx < 0) return sendJson(res, 404, { error: '插件不存在' });
      db.plugins.splice(idx, 1); saveDb();
      return sendJson(res, 200, { ok: true });
    }

    // 联系留言管理
    if (pathname === '/api/admin/contacts' && method === 'GET') {
      const list = [...db.contacts].sort((a, b) => b.ts - a.ts);
      return sendJson(res, 200, { contacts: list });
    }
    const contactId = pathname.match(/^\/api\/admin\/contacts\/([\w.-]+)$/);
    if (contactId && method === 'DELETE') {
      const idx = db.contacts.findIndex((x) => x.id === contactId[1]);
      if (idx < 0) return sendJson(res, 404, { error: '留言不存在' });
      db.contacts.splice(idx, 1); saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (contactId && method === 'POST') {
      const c = db.contacts.find((x) => x.id === contactId[1]);
      if (!c) return sendJson(res, 404, { error: '留言不存在' });
      c.read = true; saveDb();
      return sendJson(res, 200, { ok: true });
    }

    // 内容块管理
    if (pathname === '/api/admin/content' && method === 'GET') {
      const keys = Object.keys(db.content).map((k) => ({ key: k, ...db.content[k] }));
      return sendJson(res, 200, { content: keys });
    }
    if (pathname === '/api/admin/content' && method === 'POST') {
      const b = await parseJsonBody(req);
      if (!b || !b.key || !b.title) return sendJson(res, 400, { error: 'key 与 title 必填' });
      const key = String(b.key);
      db.content[key] = { title: String(b.title), body: String(b.body || ''), updatedAt: Date.now() };
      saveDb();
      return sendJson(res, 201, { ok: true, content: db.content[key] });
    }
    const contentKey = pathname.match(/^\/api\/admin\/content\/([\w.-]+)$/);
    if (contentKey && method === 'PUT') {
      const key = contentKey[1];
      if (!db.content[key]) return sendJson(res, 404, { error: '内容不存在' });
      const b = await parseJsonBody(req);
      if (!b) return sendJson(res, 400, { error: '请求格式错误' });
      if (b.title !== undefined) db.content[key].title = String(b.title);
      if (b.body !== undefined) db.content[key].body = String(b.body);
      db.content[key].updatedAt = Date.now();
      saveDb();
      return sendJson(res, 200, { ok: true, content: db.content[key] });
    }
    if (contentKey && method === 'DELETE') {
      if (!db.content[contentKey[1]]) return sendJson(res, 404, { error: '内容不存在' });
      delete db.content[contentKey[1]]; saveDb();
      return sendJson(res, 200, { ok: true });
    }

    // 版本设置
    if (pathname === '/api/admin/version' && method === 'PUT') {
      const b = await parseJsonBody(req);
      if (!b) return sendJson(res, 400, { error: '请求格式错误' });
      if (b.latest !== undefined) db.version.latest = String(b.latest);
      if (b.notes !== undefined) db.version.notes = String(b.notes);
      db.version.updatedAt = Date.now();
      saveDb();
      return sendJson(res, 200, { ok: true, version: db.version });
    }

    // 下载统计
    if (pathname === '/api/admin/downloads' && method === 'GET') {
      const byPlatform = {}; const byVersion = {};
      for (const d of db.downloads) {
        byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
        byVersion[d.version] = (byVersion[d.version] || 0) + 1;
      }
      const recent = [...db.downloads].sort((a, b) => b.ts - a.ts).slice(0, 50);
      return sendJson(res, 200, { total: db.downloads.length, byPlatform, byVersion, recent });
    }

    // 仪表盘概览
    if (pathname === '/api/admin/overview' && method === 'GET') {
      const byPlatform = {};
      for (const d of db.downloads) byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
      return sendJson(res, 200, {
        plugins: db.plugins.length,
        publishedPlugins: db.plugins.filter((p) => p.published).length,
        contacts: db.contacts.length,
        unreadContacts: db.contacts.filter((c) => !c.read).length,
        contentBlocks: Object.keys(db.content).length,
        downloads: db.downloads.length,
        byPlatform,
        latestVersion: db.version.latest,
      });
    }

    return sendJson(res, 404, { error: '接口不存在' });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------- 下载计数重定向 ----
async function handleDownload(req, res, platform) {
  const url = DOWNLOAD_URLS[platform] || DOWNLOAD_URLS.windows;
  const version = req.url.includes('v=') ? new URL(req.url, 'http://x').searchParams.get('v') : db.version.latest;
  db.downloads.push({ platform, version: version || db.version.latest, ip: req.socket.remoteAddress || '', ts: Date.now() });
  saveDb();
  return sendRedirect(res, url);
}

// ---------- 主路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, query);
    }
    // 下载计数重定向：/d/windows /d/macos /d/linux
    const dl = pathname.match(/^\/d\/(\w+)$/);
    if (dl) {
      return await handleDownload(req, res, dl[1]);
    }
    return await serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[server] 处理出错:', e);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  }
});

async function start() {
  await loadDb();
  // 若默认密码是首启动随机的，打印提示（生产请设 SITE_ADMIN_PASSWORD）
  const admin = db.users.find((u) => u.role === 'admin');
  const usingDefault = admin && !process.env.SITE_ADMIN_PASSWORD;
  server.listen(PORT, HOST, () => {
    console.log(`官网后台已启动: http://${HOST}:${PORT}`);
    console.log(`  官网首页:   http://${HOST}:${PORT}/`);
    console.log(`  管理后台:   http://${HOST}:${PORT}/admin/`);
    console.log(`  管理员邮箱: ${admin ? admin.email : '(无)'}`);
    if (usingDefault) {
      console.log(`  ⚠ 未设置 SITE_ADMIN_PASSWORD，使用开发默认密码: admin123（生产请务必修改）`);
    }
  });
}

start();

export { server, handleApi, db as _db, defaultDb, publicPluginView, verifyPassword, hashPassword };

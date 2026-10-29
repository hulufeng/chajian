// ============ LabCode MCP 客户端管理器（参考 TrieCode mcp-manager）============
// 支持三种 transport：stdio / http(StreamableHTTP) / sse(SSE)
// 能力：配置归一化(normalizeMCPServerConfig)、SSRF 校验、并行连接(connectAll)、
//       失败冷却(15s)、配置变更重连、toolRules(allow/ask/deny)、OAuth(PKCE) 脚手架
//
// 配置文件结构（存于 config.extra.mcpServers）：
//   stdio: { name, type:'stdio', command, args[], env, cwd }
//   http : { name, type:'http',  url, headers, auth }
//   sse  : { name, type:'sse',   url, messagesUrl?, headers, auth }
// 通用可选：enabled / toolRules{allow[],deny[],ask[]} / autoApprove / auth{clientId,authorizeUrl,tokenUrl,scope}

const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

// electron 仅在 OAuth 用到，懒加载以免在纯 Node 单测环境下 require 失败
let _electronShell = null;
function shellOpenExternal(u) {
  if (!_electronShell) { try { _electronShell = require('electron').shell; } catch (e) { return Promise.reject(new Error('无 electron 环境')); } }
  return _electronShell.openExternal(u);
}

// 默认配置路径与 index.js 保持一致（通过 initMcp 注入）
let configPath = '';
let configGetter = null; // () => config 对象
let configSaver = null;  // (config) => bool

function initMcp({ getConfig, saveConfig }) {
  configGetter = getConfig;
  configSaver = saveConfig;
}

// 单例
let instance = null;
function getMcpService() {
  if (!instance) instance = new McpService();
  return instance;
}

// ============ 配置归一化 ============
function normalizeMCPServerConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('无效的 MCP 服务器配置');
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('缺少 name');
  const type = String(raw.type || (raw.command ? 'stdio' : 'http')).toLowerCase();
  const out = {
    name,
    type,
    enabled: raw.enabled !== false,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    cwd: raw.cwd || '',
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
    toolRules: raw.toolRules || null,
    autoApprove: !!raw.autoApprove
  };
  if (type === 'stdio') {
    if (!raw.command) throw new Error('stdio 类型需要提供 command');
    out.command = String(raw.command);
    out.args = Array.isArray(raw.args) ? raw.args.map(String)
      : (raw.args ? String(raw.args).split(/\s+/) : []);
  } else if (type === 'http' || type === 'sse') {
    if (!raw.url) throw new Error(type + ' 类型需要提供 url');
    out.url = String(raw.url).trim();
    if (!/^https?:\/\//i.test(out.url)) throw new Error('url 必须是 http(s)');
    if (type === 'sse') out.messagesUrl = raw.messagesUrl ? String(raw.messagesUrl) : out.url;
  } else {
    throw new Error('未知的 transport 类型: ' + type);
  }
  if (raw.auth && typeof raw.auth === 'object') out.auth = raw.auth;
  return out;
}

// ============ SSRF 基础校验 ============
// 桌面端用户自配 MCP 服务器，主要防范最危险的云元数据端点与 0.0.0.0/8；
// 不阻断 127.0.0.1 / 局域网（本地与 LAN 开发场景常见，符合 TrieCode 取舍）。
function ssrfCheck(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch (e) { return { ok: false, reason: 'url 解析失败' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '仅支持 http/https' };
  const host = u.hostname.toLowerCase();
  if (host === '169.254.169.254') return { ok: false, reason: '禁止访问云元数据端点(169.254.169.254)' };
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip && +ip[1] === 0) return { ok: false, reason: '禁止 0.0.0.0/8' };
  if (!/^https:/.test(u.protocol) && host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.localhost')) {
    return { ok: false, reason: '非 localhost 的 MCP 服务器必须使用 https' };
  }
  return { ok: true };
}

// ============ 工具结果提取（stdio/http/sse 共用）============
function extractText(res) {
  if (!res) return '';
  if (Array.isArray(res.content)) {
    return res.content.map((c) => {
      if (c.type === 'text') return c.text || '';
      if (c.type === 'image') return '[图片] ' + (c.mimeType || '');
      return JSON.stringify(c);
    }).join('\n');
  }
  if (res.result !== undefined) return JSON.stringify(res.result);
  return JSON.stringify(res);
}

// ============ Stdio 传输 ============
class StdioTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.pending = new Map();
    this.reqId = 0;
    this.buffer = '';
    this.tools = [];
    this.stderr = '';
    this.status = 'starting';
  }
  async connect() {
    const cfg = this.cfg;
    const env = Object.assign({}, process.env, cfg.env || {});
    const proc = spawn(cfg.command, cfg.args || [], {
      env,
      cwd: cfg.cwd || undefined,
      shell: /^(npx|npm|node|python|python3)$/i.test(cfg.command) ? false : undefined,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this._onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    proc.on('error', (err) => { this.status = 'error'; this.stderr = (this.stderr + '\n' + err.message).slice(-4000); });
    proc.on('exit', () => {
      this.status = 'exited';
      this.pending.forEach((p) => p.reject(new Error('MCP 服务器进程已退出')));
      this.pending.clear();
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'LabCode', version: '1.0.0' }
    }, 15000);
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {}, 15000);
    this.tools = (res && Array.isArray(res.tools)) ? res.tools : [];
    this.status = 'running';
    return this;
  }
  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.status === 'exited') return reject(new Error('MCP 服务器已退出'));
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' 请求超时 (' + (timeoutMs / 1000) + 's)'));
      }, timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }
  _write(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
    catch (e) { this.status = 'error'; this.stderr = (this.stderr + '\n' + e.message).slice(-4000); }
  }
  _onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 错误'));
        else p.resolve(msg.result !== undefined ? msg.result : msg);
      }
    }
  }
  close() { try { this.proc.kill(); } catch (e) {} }
}

// ============ SSE 事件解析（http/sse 共用）============
function parseSseBlock(block) {
  let event = 'message', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch (e) { return { event, data: null }; }
}

// ============ StreamableHTTP 传输 ============
class HttpTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseUrl = cfg.url;
    this.headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, cfg.headers || {});
    this.sessionId = null;
    this.pending = new Map();
    this.reqId = 0;
    this.tools = [];
    this.status = 'starting';
  }
  async connect() {
    const initRes = await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'LabCode', version: '1.0.0' }
    }, 15000);
    if (this.sessionId) this.headers['Mcp-Session-Id'] = this.sessionId;
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {}, 15000);
    this.tools = (res && Array.isArray(res.tools)) ? res.tools : [];
    this.status = 'running';
    this._startGetStream(); // 可选：服务端主动通知（如 tools/list_changed）
    return this;
  }
  async request(method, params, timeoutMs) {
    const id = ++this.reqId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers = Object.assign({}, this.headers);
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const resp = await fetch(this.baseUrl, { method: 'POST', headers, body, signal: ctrl.signal });
      const sid = resp.headers.get('mcp-session-id') || resp.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) return await this._readSse(resp, id, timer);
      clearTimeout(timer);
      const json = await resp.json().catch(() => ({}));
      if (json.error) throw new Error(json.error.message || 'MCP 错误');
      return json.result;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
  _readSse(resp, id, timer) {
    return new Promise((resolve, reject) => {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = ({ done, value }) => {
        if (done) { clearTimeout(timer); reject(new Error('SSE 流结束，未收到响应 id=' + id)); return; }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = parseSseBlock(blk);
          if (!ev || !ev.data) continue;
          const d = ev.data;
          if (d.id !== undefined) {
            if (d.id === id) {
              clearTimeout(timer); reader.cancel().catch(() => {});
              if (d.error) reject(new Error(d.error.message || 'MCP 错误')); else resolve(d.result);
              return;
            }
          } else if (d.method) {
            // 服务端通知（忽略或处理 tools/list_changed）
          }
        }
        reader.read().then(pump).catch(reject);
      };
      reader.read().then(pump).catch(reject);
    });
  }
  notify(method, params) {
    const headers = Object.assign({}, this.headers);
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params }) }).catch(() => {});
  }
  _startGetStream() {
    fetch(this.baseUrl, { method: 'GET', headers: Object.assign({}, this.headers, { 'Accept': 'text/event-stream' }) })
      .then((resp) => {
        if (!resp.body) return;
        const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
        const pump = ({ done, value }) => {
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const blk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = parseSseBlock(blk);
            if (!ev || !ev.data || !ev.data.method) continue;
            // 服务端通知（如 notifications/tools/list_changed）暂忽略
          }
          reader.read().then(pump).catch(() => {});
        };
        reader.read().then(pump).catch(() => {});
      }).catch(() => {});
  }
  close() { /* HTTP 无状态，无需关闭 */ }
}

// ============ SSE 传输（GET 流收，POST 发）============
class SseTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.url = cfg.url;
    this.postUrl = cfg.messagesUrl || cfg.url;
    this.headers = Object.assign({}, cfg.headers || {});
    this.pending = new Map();
    this.reqId = 0;
    this.tools = [];
    this.status = 'starting';
  }
  async connect() {
    await this._openGetStream();
    await this._post('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'LabCode', version: '1.0.0' }
    }, 15000);
    this._post('notifications/initialized', {});
    const res = await this._post('tools/list', {}, 15000);
    this.tools = (res && Array.isArray(res.tools)) ? res.tools : [];
    this.status = 'running';
    return this;
  }
  _openGetStream() {
    return fetch(this.url, { method: 'GET', headers: Object.assign({ 'Accept': 'text/event-stream' }, this.headers) })
      .then((resp) => {
        if (!resp.body) return;
        const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
        const pump = ({ done, value }) => {
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const blk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = parseSseBlock(blk);
            if (!ev || !ev.data) continue;
            if (ev.event === 'endpoint' && ev.data) { this.postUrl = ev.data; continue; }
            const d = ev.data;
            if (d.id !== undefined && this.pending.has(d.id)) {
              const p = this.pending.get(d.id); this.pending.delete(d.id); clearTimeout(p.timer);
              if (d.error) p.reject(new Error(d.error.message || 'MCP 错误')); else p.resolve(d.result);
            }
          }
          reader.read().then(pump).catch(() => {});
        };
        reader.read().then(pump).catch(() => {});
      }).catch(() => {});
  }
  _post(method, params, timeoutMs) {
    if (method === 'notifications/initialized') {
      fetch(this.postUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers), body: JSON.stringify({ jsonrpc: '2.0', method, params }) }).catch(() => {});
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' 请求超时')); }, timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer });
      fetch(this.postUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, this.headers), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
        .catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
    });
  }
  notify(method, params) { this._post(method, params); }
  request(method, params, timeoutMs) { return this._post(method, params, timeoutMs); }
  close() { /* 无需关闭 */ }
}

function createTransport(cfg) {
  if (cfg.type === 'stdio') return new StdioTransport(cfg);
  if (cfg.type === 'sse') return new SseTransport(cfg);
  return new HttpTransport(cfg); // http / 默认
}

// ============ MCP 服务（管理所有服务器）============
class McpService {
  constructor() {
    this.servers = new Map(); // name -> { transport, cfg, status, tools, stderr, cooldownUntil, startedAt }
    this.reqId = 0;
  }

  _config() {
    if (configGetter) return configGetter();
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch (e) { return { extra: { mcpServers: [] } }; }
  }
  _save(cfg) {
    if (configSaver) return configSaver(cfg);
    try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8'); return true; }
    catch (e) { return false; }
  }
  _serverConfigs() {
    const cfg = this._config();
    return (cfg && cfg.extra && Array.isArray(cfg.extra.mcpServers)) ? cfg.extra.mcpServers : [];
  }
  _findConfig(name) {
    return this._serverConfigs().find((c) => c.name === name) || null;
  }
  _persistConfig(name, normalized) {
    const cfg = this._config();
    if (!cfg.extra) cfg.extra = {};
    if (!Array.isArray(cfg.extra.mcpServers)) cfg.extra.mcpServers = [];
    const i = cfg.extra.mcpServers.findIndex((c) => c.name === name);
    if (i >= 0) cfg.extra.mcpServers[i] = normalized; else cfg.extra.mcpServers.push(normalized);
    return this._save(cfg);
  }

  // ---- 生命周期 ----
  async startServer(rawCfg) {
    let cfg;
    try { cfg = normalizeMCPServerConfig(rawCfg); } catch (e) { return { ok: false, error: e.message }; }
    if (!cfg.enabled) return { ok: false, error: '服务器已禁用' };

    if (cfg.type !== 'stdio') {
      const chk = ssrfCheck(cfg.url);
      if (!chk.ok) return { ok: false, error: 'SSRF 校验未通过: ' + chk.reason };
    }

    // 已存在则先停
    if (this.servers.has(cfg.name)) this.stopServer(cfg.name);

    const entry = { transport: null, cfg, status: 'starting', tools: [], stderr: '', startedAt: Date.now(), cooldownUntil: 0 };
    this.servers.set(cfg.name, entry);

    try {
      const transport = createTransport(cfg);
      entry.transport = transport;
      await transport.connect();
      entry.status = 'running';
      entry.tools = transport.tools || [];
      return { ok: true, status: 'running', tools: entry.tools.length };
    } catch (err) {
      entry.status = 'error';
      entry.stderr = (entry.stderr + '\n' + err.message).slice(-4000);
      entry.cooldownUntil = Date.now() + 15000;
      return { ok: false, status: 'error', error: err.message };
    }
  }

  // 并行连接所有已配置服务器；失败者进入 15s 冷却，避免重启风暴
  async connectAll() {
    const cfgs = this._serverConfigs().filter((c) => c.enabled !== false);
    const results = [];
    await Promise.all(cfgs.map(async (c) => {
      const prev = this.servers.get(c.name);
      if (prev && prev.cooldownUntil && Date.now() < prev.cooldownUntil) {
        results.push({ name: c.name, ok: false, error: '冷却中，跳过' }); return;
      }
      try {
        const r = await this.startServer(c);
        results.push({ name: c.name, ...r });
      } catch (e) {
        const en = this.servers.get(c.name);
        if (en) en.cooldownUntil = Date.now() + 15000;
        results.push({ name: c.name, ok: false, error: e.message });
      }
    }));
    return results;
  }

  stopServer(name) {
    const s = this.servers.get(name);
    if (!s) return { ok: false, error: '未找到服务器' };
    try { if (s.transport && s.transport.close) s.transport.close(); } catch (e) {}
    this.servers.delete(name);
    return { ok: true };
  }
  stopAll() {
    Array.from(this.servers.keys()).forEach((n) => this.stopServer(n));
    return true;
  }

  // ---- 配置管理 ----
  listServers() {
    const cfgs = this._serverConfigs();
    return cfgs.map((c) => {
      const s = this.servers.get(c.name);
      const type = (c.type || (c.command ? 'stdio' : 'http'));
      return {
        name: c.name,
        type,
        url: c.url || '',
        command: c.command || (type !== 'stdio' ? (type + '://' + (c.url || '')) : ''),
        args: c.args || [],
        status: s ? s.status : 'stopped',
        tools: s ? (s.tools || []).length : 0,
        stderr: s ? (s.stderr || '').slice(-500) : ''
      };
    });
  }

  addServer(rawCfg) {
    let normalized;
    try { normalized = normalizeMCPServerConfig(rawCfg); } catch (e) { return { ok: false, error: e.message }; }
    const cfg = this._config();
    if (!cfg.extra) cfg.extra = {};
    if (!Array.isArray(cfg.extra.mcpServers)) cfg.extra.mcpServers = [];
    if (cfg.extra.mcpServers.some((s) => s.name === normalized.name)) {
      return { ok: false, error: '同名服务器已存在' };
    }
    if (!this._save(cfg)) return { ok: false, error: '保存配置失败' };
    return this.startServer(normalized);
  }

  removeServer(name) {
    this.stopServer(name);
    const cfg = this._config();
    if (cfg.extra && Array.isArray(cfg.extra.mcpServers)) {
      cfg.extra.mcpServers = cfg.extra.mcpServers.filter((s) => s.name !== name);
      return this._save(cfg);
    }
    return true;
  }

  listTools(name) {
    const s = this.servers.get(name);
    if (!s) return { ok: false, error: '服务器未启动' };
    if (s.status === 'running') return { ok: true, tools: s.tools };
    return { ok: false, error: '服务器状态: ' + s.status };
  }

  // 工具调用 + toolRules 执行
  async callTool(serverName, toolName, args) {
    const s = this.servers.get(serverName);
    if (!s) return { ok: false, error: '服务器未启动' };
    if (s.status !== 'running') return { ok: false, error: '服务器状态: ' + s.status };
    const rules = s.cfg.toolRules;
    if (rules && Array.isArray(rules.deny) && rules.deny.includes(toolName)) {
      return { ok: false, error: '工具被 deny 规则禁止: ' + toolName };
    }
    if (rules && Array.isArray(rules.allow) && !rules.allow.includes(toolName) && !s.cfg.autoApprove) {
      return { ok: false, error: '工具不在 allow 列表: ' + toolName };
    }
    if (rules && Array.isArray(rules.ask) && rules.ask.includes(toolName) && !s.cfg.autoApprove) {
      return { ok: false, error: '工具需要人工确认(ask)，暂未实现交互确认: ' + toolName };
    }
    try {
      const res = await s.transport.request('tools/call', { name: toolName, arguments: args || {} }, 120000);
      if (res && res.isError) return { ok: false, error: extractText(res) };
      return { ok: true, text: extractText(res) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // OAuth(PKCE) 脚手架：打开浏览器授权，本地回调拿 code，交换 token，写入 headers
  async authorize(name) {
    const cfg = this._findConfig(name);
    if (!cfg || !cfg.auth) return { ok: false, error: '该服务器未配置 OAuth (auth)' };
    const auth = cfg.auth;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // 本地回调服务器
    const server = http.createServer();
    const codePromise = new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        if (req.url && req.url.startsWith('/callback')) {
          const q = new URL(req.url, 'http://127.0.0.1').searchParams;
          const code = q.get('code');
          res.end('<html><body style="font-family:sans-serif;padding:24px;">授权已完成，可关闭此页面并返回 LabCode。</body></html>');
          server.close();
          resolve(code);
        } else { res.statusCode = 404; res.end(); }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const redirectUri = 'http://127.0.0.1:' + port + '/callback';
        const authUrl = (auth.authorizeUrl || '') + (auth.authorizeUrl && auth.authorizeUrl.includes('?') ? '&' : '?') +
          'response_type=code&client_id=' + encodeURIComponent(auth.clientId || 'labcode') +
          '&redirect_uri=' + encodeURIComponent(redirectUri) +
          '&code_challenge=' + encodeURIComponent(challenge) +
          '&code_challenge_method=S256' +
          (auth.scope ? '&scope=' + encodeURIComponent(auth.scope) : '');
        shellOpenExternal(authUrl).catch((e) => reject(e));
      });
      setTimeout(() => { server.close(); reject(new Error('授权超时（5 分钟）')); }, 300000);
    });

    try {
      const code = await codePromise;
      if (!code) return { ok: false, error: '未获取到授权 code' };
      if (auth.tokenUrl) {
        const body = new URLSearchParams({
          grant_type: 'authorization_code', code,
          client_id: auth.clientId || 'labcode',
          redirect_uri: 'http://127.0.0.1:' + (server.address() ? server.address().port : '0') + '/callback',
          code_verifier: verifier
        });
        const resp = await fetch(auth.tokenUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
        });
        const tok = await resp.json().catch(() => ({}));
        if (tok.access_token) {
          const updated = normalizeMCPServerConfig(Object.assign({}, cfg, {
            headers: Object.assign({}, cfg.headers, { Authorization: 'Bearer ' + tok.access_token })
          }));
          this._persistConfig(name, updated);
          return { ok: true };
        }
        return { ok: false, error: '未获取到 access_token' };
      }
      return { ok: true, code };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { getMcpService, initMcp, normalizeMCPServerConfig, ssrfCheck, extractText };

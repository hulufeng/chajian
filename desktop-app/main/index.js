// ============ LabCode Electron 主进程============
// 基于业界 IDE 设计实践：窗口管理/ IPC / 自动更新 / 代理 / 会话存储

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, net, webContents, desktopCapturer, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');

// 终端服务
const { getTerminalService } = require('./terminal');
const terminalService = getTerminalService();

// 全局变量
let mainWindow = null;
let isDev = process.argv.includes('--dev');

// 模块化：开发板管理（@labcode/core 的 Board 模块，compile/upload 兜底 FQBN 推断）
// 2026-10-17：接入 packages/core/src/board.js（真实模块），fqbn 缺失时用 guessFQBN 推断
const Board = require('../packages/core/src/board.js');

// 用户数据目录
const USER_DATA_PATH = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const SESSIONS_PATH = path.join(USER_DATA_PATH, 'sessions');

// 确保目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(SESSIONS_PATH);

// ============ Arduino 数据目录隔离 ============
// 商业化：LabCode 用自己的 arduino15 数据目录，不污染系统 Arduino15
// 迁移逻辑：如果系统 Arduino15 已有 esp32 平台，复用它（开发机/老用户）；否则用隔离目录
const ARDUINO_ISOLATED_DIR = path.join(USER_DATA_PATH, 'arduino15');
const ARDUINO_SYSTEM_DIR = path.join(process.env.LOCALAPPDATA || '', 'Arduino15');

function resolveArduinoDataDir() {
  // 1. 隔离目录已有平台 → 用隔离目录
  const isolatedPkg = path.join(ARDUINO_ISOLATED_DIR, 'packages', 'esp32');
  if (fs.existsSync(isolatedPkg)) return ARDUINO_ISOLATED_DIR;
  // 2. 系统目录已有 esp32 平台 → 复用（开发机/老用户迁移）
  const systemPkg = path.join(ARDUINO_SYSTEM_DIR, 'packages', 'esp32');
  if (fs.existsSync(systemPkg)) return ARDUINO_SYSTEM_DIR;
  // 3. 全新用户 → 隔离目录（触发自动安装）
  return ARDUINO_ISOLATED_DIR;
}
const ARDUINO_DATA_DIR = resolveArduinoDataDir();
process.env.ARDUINO_DIRECTORIES_DATA = ARDUINO_DATA_DIR;
process.env.ARDUINO_DIRECTORIES_DOWNLOADS = path.join(ARDUINO_DATA_DIR, 'staging');
ensureDir(ARDUINO_DATA_DIR);
ensureDir(process.env.ARDUINO_DIRECTORIES_DOWNLOADS);
console.log('📁 Arduino 数据目录:', ARDUINO_DATA_DIR);

// ============ 配置存储 ============
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('加载配置失败:', e.message);
  }
  return getDefaultConfig();
}

function getDefaultConfig() {
  return {
    ai: {
      provider: 'gateway',
      model: 'qwen3-8b',
      apiKey: '',
      thinkingLevel: 'standard',
      agentMode: 'default'
    },
    proxy: {
      mode: 'system',
      host: '',
      port: ''
    },
    window: {
      width: 1400,
      height: 900,
      maximized: false
    },
    theme: 'light',
    recentProjects: [],
    extra: {
      skills: [],
      mcpServers: [
        // 2026-09-15 对齐 TrieCode browser-toolchain：默认注释掉，用户装 playwright 后取消注重
        // { name: 'browser', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} }
      ],
      hooks: {}
    }
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('保存配置失败:', e.message);
    return false;
  }
}

let config = loadConfig();

// ============ 会话存储 ============
function loadSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_PATH).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const content = JSON.parse(fs.readFileSync(path.join(SESSIONS_PATH, f), 'utf-8'));
      return { id: f.replace('.json', ''), ...content };
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (e) {
    console.error('加载会话失败:', e.message);
    return [];
  }
}

function saveSession(session) {
  try {
    const filePath = path.join(SESSIONS_PATH, `${session.id}.json`);
    session.updatedAt = Date.now();
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('保存会话失败:', e.message);
    return false;
  }
}

function deleteSession(id) {
  try {
    const filePath = path.join(SESSIONS_PATH, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.error('删除会话失败:', e.message);
    return false;
  }
}

// ============ 窗口管理 ============
function createMainWindow() {
  const windowConfig = config.window || {};

  mainWindow = new BrowserWindow({
    width: windowConfig.width || 1400,
    height: windowConfig.height || 900,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    backgroundColor: '#f5f6f8',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true
    }
  });

  // 加载渲染进程
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 显示窗口（ready-to-show 时最大化）
  mainWindow.once('ready-to-show', () => {
    if (windowConfig.maximized) mainWindow.maximize();
  });
  
  // 兜底：3秒后强制显示窗口（防止 ready-to-show 不触发）
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('兜底显示窗口');
      mainWindow.show();
    }
  }, 3000);

  // 窗口大小变化保存
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      config.window = { ...config.window, width: bounds.width, height: bounds.height };
      saveConfig(config);
    }
  });

  mainWindow.on('maximize', () => {
    config.window = { ...config.window, maximized: true };
    saveConfig(config);
  });

  mainWindow.on('unmaximize', () => {
    config.window = { ...config.window, maximized: false };
    saveConfig(config);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 开发模式打开 DevTools
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

// ============ 菜单 ============
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:new-project') },
        { label: '打开项目', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:open-project') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:save') },
        { label: '另存为', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '文档', click: () => shell.openExternal('https://www.LabCode.com/docs') },
        { label: '官网', click: () => shell.openExternal('https://www.LabCode.com') },
        { type: 'separator' },
        { label: '关于 LabCode', click: () => showAboutDialog() }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 LabCode',
    message: 'LabCode v1.0.0',
    detail: '通用 AI 软件开发智能体\n\n内置真正动手的 AI 智能体：读写代码、执行命令、运行测试、联网查资料。\n\n© 2026 LabCode Team. All rights reserved.',
    buttons: ['确定']
  });
}

// ============ 内置云端凭据（"第一次用就走内置云端"）===========
// 商业化取向：新用户零注册、零配置，装完就能用 AI —— 凭据由产品方内置。
// 凭据来源（打包时注入，便于随时更换 / 限流 / 停用，且不写死在代码里）：
//   1) 环境变量 LABCODE_GATEWAY_TOKEN / LABCODE_GATEWAY_URL（开发、内测）
//   2) 打包资源 gateway.json（resources/gateway.json）→ { "token": "...", "url": "..." }
// 优先级：用户自己登录的 token > 内置凭据
//   （用户登录后用自己的额度与邀请奖励；未登录则用内置的公共额度）
let _builtinGatewayCache = null;
function getBuiltinGateway() {
  if (_builtinGatewayCache) return _builtinGatewayCache;
  let token = process.env.LABCODE_GATEWAY_TOKEN || '';
  let url = process.env.LABCODE_GATEWAY_URL || '';
  try {
    // 多个可能位置（开发目录 / 打包后 asar 内 / 打包后 resources 外置）
    const candidates = [
      path.join(__dirname, '..', 'resources', 'gateway.json'),
      path.join(process.resourcesPath || '', 'gateway.json'),
      path.join(__dirname, '..', 'gateway.json')
    ];
    for (const p of candidates) {
      if (!p) continue;
      try {
        if (!fs.existsSync(p)) continue;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!token && j && j.token) token = String(j.token);
        if (!url && j && j.url) url = String(j.url);
        if (token) break;
      } catch (e) { /* 换下一个位置 */ }
    }
    // 运行时「管理后台」配置的后端 API Key（优先级低于 env / gateway.json，
    // 高于没有 —— 让管理员无需重新打包即可下发/轮换云端凭据）
    const cfg = config && config.ai;
    if (!token && cfg && cfg.backendApiKey) token = String(cfg.backendApiKey);
    if (!url && cfg && cfg.backendGatewayUrl) url = String(cfg.backendGatewayUrl);
  } catch (e) { /* 没有内置凭据文件是正常的 */ }
  _builtinGatewayCache = { token: token || '', url: url || '' };
  return _builtinGatewayCache;
}

// 网关凭据候选（按尝试顺序）：用户自己的 token > 产品内置/管理后台后端 key
// 用途：用户登录 token 过期（401）时自动回退到管理后台配置的后端 key，云端不中断。
function gatewayAuthCandidates(aiCfg) {
  const out = [];
  const own = (aiCfg && aiCfg.gatewayToken) || '';
  if (own) out.push({ token: own, url: (aiCfg && aiCfg.gatewayUrl) || '', kind: 'user' });
  const b = getBuiltinGateway();
  if (b.token) out.push({ token: b.token, url: b.url || '', kind: 'backend' });
  return out;
}

// 取当前可用的网关凭据：用户自己的 > 内置的
function resolveGatewayAuth(aiCfg) {
  const c = gatewayAuthCandidates(aiCfg);
  if (c.length) return { token: c[0].token, builtin: c[0].kind !== 'user', url: c[0].url || '' };
  return { token: '', builtin: false, url: (aiCfg && aiCfg.gatewayUrl) || '' };
}

// 网关是否可用（有用户 token 或有内置凭据）
function gatewayAvailable(aiCfg) {
  return !!resolveGatewayAuth(aiCfg || config.ai || {}).token;
}

// ============ IPC 接口 ============
function setupIPC() {
  // 窗口控制
  ipcMain.handle('app:getCwd', () => process.cwd());

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
    return mainWindow?.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());

  // 配置
  ipcMain.handle('config:get', () => config);
  // Deep-merge helper: plain objects merged recursively, everything else replaced.
  function deepMergeConfig(target, patch) {
    const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      const cur = target ? target[k] : undefined;
      if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
        out[k] = deepMergeConfig(cur, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  ipcMain.handle('config:set', (_, key, value) => {
    // Object form (e.g. { ai: { provider: 'gateway' }, ui: { welcomeShown: true } }).
    // Must DEEP merge: a shallow merge would replace whole sub-objects and drop
    // sibling keys such as ai.model / ai.apiKey / ai.baseURL.
    if (key && typeof key === 'object' && !Array.isArray(key)) {
      config = deepMergeConfig(config, key);
      return saveConfig(config);
    }
    const keys = String(key).split('.');
    let obj = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    const lastKey = keys[keys.length - 1];
    const prevVal = obj[lastKey];
    // 值为普通对象且原值也是普通对象时深合并，而不是整段覆盖。
    // 否则 config.set('ai', { provider, model }) 会把 ai 段整个换掉，
    // 连带清空 gatewayToken / gatewayUrl 等兄弟字段 → 表现为「网关登录失效，需重新登录」。
    if (value && typeof value === 'object' && !Array.isArray(value)
        && prevVal && typeof prevVal === 'object' && !Array.isArray(prevVal)) {
      obj[lastKey] = deepMergeConfig(prevVal, value);
    } else {
      obj[lastKey] = value;
    }
    // 管理后台的云端后端 Key / URL 变了 → 清掉凭据缓存，下次请求立即用新值
    if (keys[0] === 'ai' && (lastKey === 'backendApiKey' || lastKey === 'backendGatewayUrl')) {
      _builtinGatewayCache = null;
    }
    return saveConfig(config);
  });
  ipcMain.handle('config:save', (_, newConfig) => {
    config = { ...config, ...newConfig };
    return saveConfig(config);
  });

  // ============ MCP 服务器（Model Context Protocol stdio 接入）===========
  const mcpService = require('./mcp').getMcpService();
  require('./mcp').initMcp({ getConfig: () => config, saveConfig });
  ipcMain.handle('mcp:list-servers', () => mcpService.listServers());
  ipcMain.handle('mcp:add-server', (_, cfg) => mcpService.addServer(cfg || {}));
  ipcMain.handle('mcp:remove-server', (_, name) => mcpService.removeServer(name));
  ipcMain.handle('mcp:list-tools', (_, name) => mcpService.listTools(name));
  ipcMain.handle('mcp:call-tool', (_, serverName, toolName, args) => mcpService.callTool(serverName, toolName, args));
  ipcMain.handle('mcp:start-all', () => mcpService.startAll());
  ipcMain.handle('mcp:stop-all', () => { mcpService.stopAll(); return true; });
  ipcMain.handle('mcp:start-server', (_, name) => {
    const cfgs = (config.extra && config.extra.mcpServers) || [];
    const cfg = cfgs.find(s => s.name === name);
    if (!cfg) return { ok: false, error: '未找到服务器配置: ' + name };
    return mcpService.startServer(cfg);
  });
  ipcMain.handle('mcp:stop-server', (_, name) => { mcpService.stopServer(name); return true; });
  ipcMain.handle('mcp:testConnection', async (_, name) => {
    try {
      const r = mcpService.listTools(name);
      const tools = (r && r.tools) || [];
      if (r && r.ok) return { success: true, connected: true, tools: tools.length, message: 'connected, ' + tools.length + ' tools' };
      return { success: false, connected: false, error: (r && r.error) || 'server not started' };
    } catch (e) { return { success: false, connected: false, error: e.message }; }
  });
  ipcMain.handle('mcp:authorize', async (_, name) => {
    // Local stdio MCP servers in this build need no OAuth handshake; report config state.
    try {
      const servers = mcpService.listServers() || [];
      const found = servers.find(s => s && (s.name === name || s.id === name));
      return { success: true, authorized: true, requiresOAuth: false, name: name || '', configured: !!found, message: 'local stdio server, no OAuth required' };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ============ clangd LSP 客户端（对齐 TrieCode code-symbols.db）===========
  const lspClients = new Map(); // language -> { proc, pending: Map<id, resolve>, buf, initialized }
  function spawnLsp(language, cmd, args) {
    if (lspClients.has(language)) return lspClients.get(language);
    let proc;
    try {
      proc = spawn(cmd, args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error('无法启动 ' + cmd + ': ' + e.message);
    }
    const client = { proc, pending: new Map(), buf: '', initialized: false, seq: 1, failed: false };
    proc.on('error', (err) => {
      client.failed = true;
      client.pending.forEach((resolve) => resolve({ error: { code: -2, message: 'spawn 失败: ' + err.message } }));
      client.pending.clear();
      lspClients.delete(language);
    });
    proc.stdout.on('data', (chunk) => {
      client.buf += chunk.toString('utf8');
      // 按Content-Length 头切帴
      while (true) {
        const headerEnd = client.buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const m = client.buf.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
        if (!m) { client.buf = client.buf.slice(headerEnd + 4); continue; }
        const len = parseInt(m[1], 10);
        const bodyStart = headerEnd + 4;
        if (client.buf.length < bodyStart + len) break;
        const body = client.buf.slice(bodyStart, bodyStart + len);
        client.buf = client.buf.slice(bodyStart + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id && client.pending.has(msg.id)) {
            client.pending.get(msg.id)(msg);
            client.pending.delete(msg.id);
          }
        } catch (e) {}
      }
    });
    proc.stderr.on('data', (d) => console.warn('[clangd]', d.toString().slice(0, 200)));
    proc.on('close', () => { lspClients.delete(language); });
    lspClients.set(language, client);
    return client;
  }
  function lspSend(client, msg) {
    return new Promise((resolve) => {
      const id = client.seq++;
      client.pending.set(id, resolve);
      msg.id = id;
      const body = JSON.stringify(msg);
      client.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      // 30s 超时
      setTimeout(() => { if (client.pending.has(id)) { client.pending.delete(id); resolve({ error: { code: -1, message: 'timeout' } }); } }, 30000);
    });
  }
  ipcMain.handle('lsp:start', async (_, { language, cmd, args, rootPath }) => {
    try {
      const client = spawnLsp(language, cmd || 'clangd', args || []);
      if (!client.initialized) {
        await lspSend(client, {
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            processId: process.pid,
            rootUri: 'file://' + (rootPath || '').replace(/\\/g, '/'),
            capabilities: { textDocument: { hover: { contentFormat: ['plaintext', 'markdown'] }, definition: { linkSupport: true }, references: {}, documentSymbol: {} } }
          }
        });
        client.initialized = true;
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('lsp:request', async (_, { language, method, params }) => {
    const client = lspClients.get(language);
    if (!client) return { success: false, error: 'LSP not started' };
    const r = await lspSend(client, { jsonrpc: '2.0', method, params: params || {} });
    return { success: true, result: r.result, error: r.error };
  });
  ipcMain.handle('lsp:notify', async (_, { language, method, params }) => {
    const client = lspClients.get(language);
    if (!client) return { success: false, error: 'LSP not started' };
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
    client.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return { success: true };
  });
  ipcMain.handle('lsp:stop', (_, { language }) => {
    const c = lspClients.get(language);
    if (c) { try { c.proc.kill(); } catch (e) {} lspClients.delete(language); }
    return { success: true };
  });
  // ============ DAP 调试器客户端（对齐 TrieCode 路线图：DAP 调试器与断点）============
  const dapClients = new Map(); // sessionId -> { proc, pending, buf, seq, sender }
  function dapSend(sessionId, msg) {
    return new Promise((resolve) => {
      const cli = dapClients.get(sessionId);
      if (!cli) return resolve({ success: false, error: '调试会话不存在' });
      msg.seq = cli.seq++;
      cli.pending.set(msg.seq, resolve);
      const body = JSON.stringify(msg);
      try {
        cli.proc.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
      } catch (e) {
        cli.pending.delete(msg.seq);
        resolve({ success: false, error: e.message });
      }
      setTimeout(() => {
        if (cli.pending.has(msg.seq)) { cli.pending.delete(msg.seq); resolve({ success: false, error: 'timeout' }); }
      }, 30000);
    });
  }
  ipcMain.handle('dap:start', async (_, { sessionId, dapPath, args, cwd, sender }) => {
    try {
      if (dapClients.has(sessionId)) return { success: true, alreadyRunning: true };
      const proc = spawn(dapPath, args || [], { cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      const cli = { proc, pending: new Map(), buf: '', seq: 1, sender: sender || null };
      proc.on('error', (err) => {
        cli.pending.forEach(r => r({ success: false, error: err.message }));
        cli.pending.clear();
        dapClients.delete(sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dap:event', { sessionId, event: 'terminated', reason: err.message });
      });
      proc.stdout.on('data', (chunk) => {
        cli.buf += chunk.toString('utf8');
        while (true) {
          const he = cli.buf.indexOf('\r\n\r\n');
          if (he < 0) break;
          const m = cli.buf.slice(0, he).match(/Content-Length:\s*(\d+)/i);
          if (!m) { cli.buf = cli.buf.slice(he + 4); continue; }
          const len = parseInt(m[1]);
          const bs = he + 4;
          if (cli.buf.length < bs + len) break;
          const body = cli.buf.slice(bs, bs + len);
          cli.buf = cli.buf.slice(bs + len);
          try {
            const msg = JSON.parse(body);
            if (msg.type === 'response' && cli.pending.has(msg.request_seq)) {
              const resolve = cli.pending.get(msg.request_seq);
              cli.pending.delete(msg.request_seq);
              resolve({ success: msg.success, body: msg });
            } else if (msg.type === 'event') {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dap:event', { sessionId, event: msg.event, body: msg.body || {} });
              }
            }
          } catch (e) {}
        }
      });
      proc.stderr.on('data', (d) => console.warn('[dap]', d.toString().slice(0, 200)));
      proc.on('close', () => {
        dapClients.delete(sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dap:event', { sessionId, event: 'terminated' });
      });
      dapClients.set(sessionId, cli);
      // DAP initialize
      const initResp = await dapSend(sessionId, { type: 'request', command: 'initialize', arguments: {
        adapterID: 'labcode', clientID: 'labcode', clientName: 'LabCode',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
        supportsRunInTerminalRequest: false, supportsVariableType: true,
        supportsVariablePaging: false, supportsRunInTerminalRequest: false
      }});
      return { success: true, initialized: true, capabilities: initResp.body && initResp.body.body };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('dap:request', async (_, { sessionId, command, args }) => {
    const r = await dapSend(sessionId, { type: 'request', command, arguments: args || {} });
    return r;
  });
  ipcMain.handle('dap:stop', async (_, { sessionId }) => {
    const cli = dapClients.get(sessionId);
    if (cli) {
      try { await dapSend(sessionId, { type: 'request', command: 'disconnect', arguments: {} }); } catch (e) {}
      setTimeout(() => { try { cli.proc.kill(); } catch (e) {} }, 500);
    }
    dapClients.delete(sessionId);
    return { success: true };
  });
  ipcMain.handle('dap:toolPath', (_, name) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(cmd, [name], { timeout: 5000 }, (err, stdout) => {
        if (err) resolve({ found: false, path: '' });
        else resolve({ found: true, path: (stdout || '').toString().split(/\r?\n/)[0].trim() });
      });
    });
  });
  // 自动下载 debugpy（Python 调试适配器）
  const DEBUGPY_DIR = path.join(app.getPath('userData'), 'tools', 'debugpy');
  const DEBUGPY_PY = path.join(DEBUGPY_DIR, 'venv', 'Scripts', 'python.exe');
  ipcMain.handle('dap:ensureDebugpy', async () => {
    if (fs.existsSync(DEBUGPY_PY)) return { success: true, path: DEBUGPY_PY, cached: true };
    try {
      fs.mkdirSync(DEBUGPY_DIR, { recursive: true });
      await new Promise((resolve, reject) => {
        execFile('python', ['-m', 'venv', DEBUGPY_DIR + '\\venv'], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
      const pip = DEBUGPY_PY;
      await new Promise((resolve, reject) => {
        execFile(pip, ['-m', 'pip', 'install', 'debugpy', '-q', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
      });
      return { success: true, path: DEBUGPY_PY, cached: false };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ============ Git 操作 ============
  const { execFile: gitExec } = require('child_process');
  function runGit(cwd, args) {
    return new Promise((resolve) => {
      gitExec('git', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
      });
    });
  }
  ipcMain.handle('git:status', async (_, cwd) => {
    const r = await runGit(cwd, ['status', '--porcelain', '-b']);
    if (!r.ok) return { success: false, error: r.stderr };
    const lines = r.stdout.split('\n').filter(Boolean);
    const head = lines[0] || '';
    let ahead = 0, behind = 0;
    const am = head.match(/ahead (\d+)/); if (am) ahead = parseInt(am[1], 10);
    const bm = head.match(/behind (\d+)/); if (bm) behind = parseInt(bm[1], 10);
    const branch = head.startsWith('##') ? head.slice(3).split('...')[0] : '(unknown)';
    const files = lines.slice(1).map(l => {
      const status = l.slice(0, 2);
      const path = l.slice(3);
      return { status: status.trim(), path };
    });
    return { success: true, branch, ahead, behind, files };
  });
  ipcMain.handle('git:add', async (_, cwd, paths) => {
    const args = (Array.isArray(paths) && paths.length) ? ['add', ...paths] : ['add', '-A'];
    const r = await runGit(cwd, args);
    return { success: r.ok, error: r.stderr };
  });
  ipcMain.handle('git:commit', async (_, cwd, message) => {
    const r = await runGit(cwd, ['commit', '-m', message]);
    return { success: r.ok, stdout: r.stdout, error: r.stderr };
  });
  ipcMain.handle('git:log', async (_, cwd, n) => {
    const r = await runGit(cwd, ['log', `-${n || 10}`, '--pretty=format:%h|%an|%ar|%s']);
    if (!r.ok) return { success: false, error: r.stderr };
    const entries = r.stdout.split('\n').filter(Boolean).map(l => {
      const [hash, author, time, ...msg] = l.split('|');
      return { hash, author, time, message: msg.join('|') };
    });
    return { success: true, entries };
  });
  ipcMain.handle('git:push', async (_, cwd) => {
    const r = await runGit(cwd, ['push']);
    if (r.ok) return { success: true, stdout: r.stdout, error: r.stderr };
    // no upstream -> set upstream automatically
    const br = await runGit(cwd, ['branch', '--show-current']);
    const branch = br.stdout.trim();
    if (branch) {
      const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (!up.ok) {
        const r2 = await runGit(cwd, ['push', '--set-upstream', 'origin', branch]);
        return { success: r2.ok, stdout: r2.stdout, error: r2.stderr, setUpstream: true };
      }
    }
    return { success: false, stdout: r.stdout, error: r.stderr };
  });
  ipcMain.handle('git:pull', async (_, cwd) => {
    const r = await runGit(cwd, ['pull']);
    return { success: r.ok, stdout: r.stdout, error: r.stderr };
  });
  ipcMain.handle('git:clone', async (_, url, destDir) => {
    if (!url) return { success: false, error: '缺少仓库地址' };
    const repoName = (String(url).split('/').pop() || 'repo').replace(/\.git$/i, '').replace(/[^\w.-]/g, '_');
    const dest = destDir || path.join(os.homedir(), 'LabCodeProjects', repoName);
    const r = await runGit('', ['clone', '--depth', '1', url, dest]);
    if (!r.ok) return { success: false, error: r.stderr || r.stdout || 'clone 失败' };
    return { success: true, path: dest };
  });
  // ===== Git 图形面板：diff / branch（对齐 TrieCode 路线图第一项）=====
  ipcMain.handle('git:diff', async (_, cwd, filePath) => {
    const args = ['diff', '--unified=3'];
    if (filePath) args.push('--', filePath);
    const r = await runGit(cwd, args);
    return { success: r.ok, diff: r.stdout || '(无变更)', error: r.stderr };
  });
  ipcMain.handle('git:branches', async (_, cwd) => {
    const r = await runGit(cwd, ['branch', '--list', '--format=%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:relative)']);
    if (!r.ok) return { success: false, branches: [], error: r.stderr };
    const branches = r.stdout.split('\n').filter(Boolean).map(l => {
      const [name, hash, ...rest] = l.split('|');
      return { name, hash, subject: rest.slice(0, -1).join('|'), lastCommit: rest[rest.length - 1] || '' };
    });
    // 当前分支
    const cur = await runGit(cwd, ['branch', '--show-current']);
    const current = cur.stdout.trim();
    return { success: true, branches, current };
  });
  ipcMain.handle('git:checkout', async (_, cwd, branchName) => {
    const r = await runGit(cwd, ['checkout', branchName]);
    return { success: r.ok, error: r.stderr };
  });
  ipcMain.handle('git:createBranch', async (_, cwd, branchName) => {
    const r = await runGit(cwd, ['checkout', '-b', branchName]);
    return { success: r.ok, error: r.stderr };
  });
  ipcMain.handle('git:unstage', async (_, cwd, paths) => {
    const args = ['reset', 'HEAD', ...(Array.isArray(paths) ? paths : [paths])];
    const r = await runGit(cwd, args);
    return { success: r.ok, error: r.stderr };
  });
  ipcMain.handle('git:discard', async (_, cwd, paths) => {
    const args = ['checkout', '--', ...(Array.isArray(paths) ? paths : [paths])];
    const r = await runGit(cwd, args);
    return { success: r.ok, error: r.stderr };
  });

  // ============ 工具自动下载（clangd 等，不打包进安装包，首次用时拉）============
  const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
  const CLANGD_DIR = path.join(TOOLS_DIR, 'clangd');
  const CLANGD_EXE = path.join(CLANGD_DIR, 'bin', 'clangd.exe');

  function downloadFile(url, dest, redirects = 5) {
    return new Promise((resolve, reject) => {
      const follow = (u) => {
        https.get(u, { headers: { 'User-Agent': 'LabCode' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects <= 0) return reject(new Error('too many redirects'));
            return follow(res.headers.location);
          }
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const ws = fs.createWriteStream(dest);
          res.pipe(ws);
          ws.on('finish', () => ws.close(() => resolve(dest)));
          ws.on('error', reject);
        }).on('error', reject);
      };
      follow(url);
    });
  }

  function extractZip(zipPath, destDir) {
    // 用PowerShell Expand-Archive
    return new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`],
        { encoding: 'utf8', timeout: 120000 }, (err) => err ? reject(err) : resolve());
    });
  }

  ipcMain.handle('tools:ensure-clangd', async () => {
    if (fs.existsSync(CLANGD_EXE)) return { success: true, path: CLANGD_EXE, cached: true };
    const mirrors = [
      'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip',
      'https://ghproxy.net/https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip',
      'https://mirror.ghproxy.com/https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip'
    ];
    const zipPath = path.join(TOOLS_DIR, 'clangd.zip');
    let lastErr = null;
    for (const url of mirrors) {
      try {
        console.log('[clangd] trying', url);
        await downloadFile(url, zipPath);
        const sz = fs.statSync(zipPath).size;
        if (sz < 1000000) throw new Error('download too small (' + sz + ' bytes), likely error page');
        await extractZip(zipPath, CLANGD_DIR);
        // clangd zip 解压后是 clangd_18.1.8/bin/clangd.exe，需要铺平
        const subDir = fs.readdirSync(CLANGD_DIR).find(f => f.startsWith('clangd'));
        if (subDir) {
          const src = path.join(CLANGD_DIR, subDir);
          fs.cpSync(src, CLANGD_DIR, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        }
        fs.unlinkSync(zipPath);
        if (fs.existsSync(CLANGD_EXE)) return { success: true, path: CLANGD_EXE, cached: false };
        throw new Error('解压后找不到 clangd.exe');
      } catch (e) { lastErr = e; console.warn('[clangd] mirror failed:', e.message); }
    }
    return { success: false, error: '所有镜像都失败: ' + (lastErr && lastErr.message) };
  });

  // ============ AI 对话（OpenAI 兼容 API：DeepSeek / 本地 llama 引擎 / Ollama / 自定义）============

  // ============ 文件系统检查点 + 回滚（借鉴 Hermes Agent）============
  const CHECKPOINT_DIR = path.join(USER_DATA_PATH, 'checkpoints');
  function ensureCheckpointDir() { fs.mkdirSync(CHECKPOINT_DIR, { recursive: true }); }
  function snapshotFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    ensureCheckpointDir();
    const ts = Date.now();
    const hash = require('crypto').createHash('md5').update(filePath).digest('hex').slice(0, 8);
    const cpPath = path.join(CHECKPOINT_DIR, ts + '_' + hash + '.json');
    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(cpPath, JSON.stringify({ filePath, content, timestamp: ts }), 'utf8');
    return cpPath;
  }
  ipcMain.handle('checkpoint:list', () => {
    if (!fs.existsSync(CHECKPOINT_DIR)) return [];
    return fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8'));
        return { file: f, filePath: d.filePath, timestamp: d.timestamp };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  });
  ipcMain.handle('checkpoint:rollback', (_, cpFile) => {
    try {
      const p = path.join(CHECKPOINT_DIR, cpFile);
      if (!fs.existsSync(p)) return { success: false, error: '检查点不存在' };
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!fs.existsSync(path.dirname(d.filePath))) fs.mkdirSync(path.dirname(d.filePath), { recursive: true });
      fs.writeFileSync(d.filePath, d.content, 'utf8');
      return { success: true, filePath: d.filePath, timestamp: d.timestamp };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('checkpoint:clearOld', (_, keep) => {
    keep = keep || 50;
    if (!fs.existsSync(CHECKPOINT_DIR)) return { success: true };
    const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
    files.sort();
    const toDelete = files.slice(0, Math.max(0, files.length - keep));
    toDelete.forEach(f => { try { fs.unlinkSync(path.join(CHECKPOINT_DIR, f)); } catch (e) {} });
    return { success: true, deleted: toDelete.length };
  });

  // 2026-10-14 错误信息脱敏：抹除 API Key / sk- 令牌 / Bearer 凭证 / 长令牌 / 邮箱，并截断到 500 字，
  // 防止敏感信息进入前端 UI 或日志（最小暴露原则）。
  function redactError(msg) {
    if (msg == null) return msg;
    let s = String(msg);
    s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
    s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
    s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m) => m.slice(0, 4) + '***' + m.slice(-2));
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***');
    return s.slice(0, 500);
  }

  // 2026-10-14 思考档位 → 厂商 reasoning 参数映射（云推理模型）。
  // renderer 存 ai.thinkingLevel（fast/light/standard/deep，对应 effort: disabled/low/high/max），
  // 按 provider 归一化为对应厂商字段。默认 standard 对非特殊厂商返回 {reasoning_effort:'high'}。
  const THINKING_LEVEL_EFFORT = { fast: 'disabled', light: 'low', standard: 'high', deep: 'max' };
  function buildThinkingParams(provider, level) {
    const effort = THINKING_LEVEL_EFFORT[level];
    if (!effort || effort === 'disabled') return {};
    const p = String(provider || '').toLowerCase();
    if (p.includes('claude') || p.includes('anthropic')) return { thinking: { type: 'enabled' } };
    if (p.includes('doubao')) return { reasoning_split: true };
    // OpenAI 系 / deepseek / qwen / minimax / kimi / zhipu / openai / custom：reasoning_effort
    return { reasoning_effort: effort === 'max' ? 'high' : effort };
  }

  const AI_PROVIDERS = {
    deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    gateway:  { baseURL: process.env.GATEWAY_URL || 'https://bluebubai.work', defaultModel: 'qwen3-8b' },
    local:    { baseURL: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf' },
    ollama:   { baseURL: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b' },
    openai:   { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
    custom:   { baseURL: '', defaultModel: '' }
  };

  // 网关可用模型白名单。旧版默认/残留的 deepseek-flash 等模型在网关上不存在，
  // 会导致对话请求 404 静默失败（用户表现为"发消息没反应"）。统一矫正为真实可用的模型。
  const GW_AVAILABLE_MODELS = ['qwen3-8b'];
  const normalizeGwModel = (m) => (GW_AVAILABLE_MODELS.includes(m) ? m : GW_AVAILABLE_MODELS[0]);

  // 兼容历史配置的 baseURL/baseUrl 大小写字段（旧版 UI 写入 ai.baseUrl，新版读 ai.baseURL）。
  // 优先大写 baseURL；为空时回退小写 baseUrl；custom provider 下 baseUrl 指向本地 127.0.0.1 优先。
  function resolveAiBaseURL(aiCfg) {
    if (!aiCfg) return '';
    const upper = aiCfg.baseURL || '';
    const lower = aiCfg.baseUrl || '';
    if (aiCfg.provider === 'custom') {
      // custom 场景：本地端点（127.0.0.1/localhost）优先采用小写字段，云端官方地址按大写处理
      if (lower && /^(http:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(lower)) return lower;
      return upper || lower;
    }
    return upper || lower;
  }

  ipcMain.handle('ai:chat', async (_, options) => {
    const { messages, model, temperature = 0.7, maxTokens = 4096 } = options || {};
    const aiCfg = config.ai || {};
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    // 网关地址：用户设置 > 内置凭据里的地址 > 默认地址
    const gwBuiltinUrl = (aiCfg.provider === 'gateway') ? (getBuiltinGateway().url || '') : '';
    const baseURL = (aiCfg.provider === 'gateway' && (aiCfg.gatewayUrl || gwBuiltinUrl))
      ? (aiCfg.gatewayUrl || gwBuiltinUrl)
      : (resolveAiBaseURL(aiCfg) || provider.baseURL);
    const useModel = model || aiCfg.model || provider.defaultModel;
    const apiKey = aiCfg.apiKey || '';

    if (!baseURL) {
      return { success: false, error: '未配置 API baseURL，请在设置中配置' };
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: '消息为空' };
    }

    try {
      // ===== 网关模式（内置云端 → 积分扣费）=====
      if (aiCfg.provider === 'gateway') {
        // 云端凭据候选：用户自己的 token > 管理后台/内置后端 key。
        // 用户登录 token 过期（401）时自动回退到管理后台配置的后端 key，云端不中断。
        const candidates = gatewayAuthCandidates(aiCfg);
        if (!candidates.length) return { success: false, error: 'not logged in, please login in settings' };
        const gwModel = normalizeGwModel(useModel); // 矫正旧配置残留的不可用模型
        let gwResp = null, gwData = {}, triedKind = null;
        for (const c of candidates) {
          const cUrl = (c.url || AI_PROVIDERS.gateway.baseURL).replace(/\/$/, '') + '/api/chat';
          triedKind = c.kind;
          gwResp = await net.fetch(cUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
            body: JSON.stringify({ model: gwModel, messages, temperature })
          });
          if (gwResp.status !== 401) break; // 401 才试下一个候选
        }
        gwData = await gwResp.json().catch(() => ({}));
        if (!gwResp.ok) {
          if (gwResp.status === 402) {
            return { success: false, error: gwData.error || '积分不足', creditsInsufficient: true, creditsLeft: gwData.creditsLeft };
          }
          if (gwResp.status === 401) {
            // 所有候选都 401 → 区分原因给用户清晰提示
            const msg = triedKind === 'user'
              ? '登录已过期或未登录，请在设置中重新登录'
              : '云端后端 API Key 无效或未配置，请在「设置 → 云端后端」检查';
            return { success: false, error: msg, needReauth: triedKind === 'user' };
          }
          return { success: false, error: `网关返回 ${gwResp.status}: ${(gwData.error || '')}` };
        }
        return { success: true, content: gwData.content || '', creditsLeft: gwData.creditsLeft, dailyRemaining: gwData.dailyRemaining, cost: gwData.cost, totalTokens: gwData.totalTokens, model: gwModel, gateway: true };
      }

      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
      // 本地引擎：先确认引擎加载的就是本次请求的模型。
      // llama-server 忽略 model 字段，若引擎还跑着别的模型就会「答非所问」（静默降级）。
      if (aiCfg.provider === 'local') {
        const ensured = await ensureEngineServesModel(useModel);
        if (!ensured.ok) return { success: false, error: ensured.error };
      }
      // 云推理模型思考档位：仅当显式配置 thinkingParams 才附加，默认空 → 零回归
      const thinkingExtra = (aiCfg.thinkingParams && typeof aiCfg.thinkingParams === 'object' && Object.keys(aiCfg.thinkingParams).length)
        ? aiCfg.thinkingParams
        : buildThinkingParams(aiCfg.provider, aiCfg.thinkingLevel);
      const bodyObj = {
        model: useModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(thinkingExtra && Object.keys(thinkingExtra).length ? thinkingExtra : {})
      };

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

      let response = await net.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj)
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { success: false, error: `API 返回 ${response.status}: ${redactError(errText)}` };
      }

      let data = await response.json();
      let content = data?.choices?.[0]?.message?.content || '';
      // 思考模型（Qwen3.5 等）在非流式通道里可能把整段思考写进 reasoning_content，
      // 而这里只取 content → 正文为空（工作流节点会拿到空结果）。
      // 与流式路径一致：正文为空就关掉思考重试一次，保证一定有正文。
      if (aiCfg.provider === 'local' && !String(content).trim()) {
        const retryBody = Object.assign({}, bodyObj, { chat_template_kwargs: { enable_thinking: false } });
        try {
          const r2 = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(retryBody) });
          if (r2.ok) {
            const d2 = await r2.json();
            const c2 = d2?.choices?.[0]?.message?.content || '';
            if (String(c2).trim()) { content = c2; data = d2; }
          }
        } catch (e2) { /* 保留原结果 */ }
      }
      const usage = data?.usage || {};
      return { success: true, content, usage, model: useModel };
    } catch (e) {
      return { success: false, error: 'AI 请求失败: ' + redactError(e.message || String(e)) };
    }
  });

  // ============ AI 流式对话（SSE + 真 function calling）===========
  // 通过 ai:stream 事件推送执行过程：delta / tool_calls / usage / done / error
  const activeAiStreams = new Map();
  // 2026-09-15：每 runId 一个 AbortController，cancel/看门狗回退时真发 fetch，
  // 否则 llama-server 旧请求还占着 slot，新请求又进来，GPU 并发跑满 → 客户端崩
  const activeAiControllers = new Map();

  // 解析 OpenAI 兼容 SSE 流
  // 解析 OpenAI 兼容 SSE 流（保留 event: 行，供网关 credits/error 事件透传）
  async function* parseSSEStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let pendingEvent = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              pendingEvent = trimmed.slice(6).trim();
              continue;
            }
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') { pendingEvent = ''; continue; }
            try {
              const obj = JSON.parse(payload);
              if (pendingEvent) { obj._event = pendingEvent; pendingEvent = ''; }
              yield obj;
            } catch (e) { /* 忽略坏行 */ }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
  }

  // ===== Phase1：本地模型 GBNF 约束工具决策轮（借鉴 DeepInfer 约束解码）=====
  // 实测（内置 llama-server 0.4.0-dev + RTX 5060 Ti，2026-10-21）：
  //   grammar 非流式 9/9 全部合法 JSON；response_format=json_object 成功也输出 ```json 围巾且流式偶发 socket hang up；
  //   原生 tools API 直接打挂连接。故仅 local + 有工具 + 开关允许时，先用「非流式 + GBNF」做一次工具决策；
  //   选到工具 → 回传 tool_calls 事件；选 none / 超时 / 解析失败 → 落回原有流式无约束路径（零回归）。
  function localToolGrammarEnabled(aiCfg) {
    const v = aiCfg && aiCfg.localToolGrammar;
    if (v === true || v === 'on') return true;
    if (v === false || v === 'off') return false;
    // 自动：7B/9B/14B+ 默认开；1.5B/3B 默认关（learnings：3B 工具循环局限）；未知大小保守关闭
    const m = String((aiCfg && aiCfg.model) || '').toLowerCase();
    if (/(^|[^0-9a-z])(1\.5b|3b)([^0-9a-z]|$)/.test(m)) return false;
    return /(^|[^0-9a-z])(7b|9b|14b|32b|70b)([^0-9a-z]|$)/.test(m);
  }

  // 由工具清单生成 GBNF：{"tool":<工具名枚举>,"arguments":<通用 JSON 对象>}
  // arguments 用通用 JSON 语法（含字符串转义），无需逐工具生成 schema；"none" 表示不需要工具。
  function buildToolGbnf(toolNames) {
    // 注意：GBNF 字符串字面量 "x" 表示无引号的 x；JSON 里的 "read_file" 必须写成 "\"read_file\""（内嵌引号），
    // 否则拼出的 JSON 缺引号 → 非法 → 模型只能退到 "none"（2026-10-21 实测教训）。
    const alts = toolNames.map(n => `"\\"${n}\\""`).join(' | ');
    return [
      'root ::= "{" ws "\\"tool\\"" ws ":" ws tool ws "," ws "\\"arguments\\"" ws ":" ws obj ws "}"',
      `tool ::= "\\"none\\"" | ${alts}`,
      'obj ::= "{" ws (pair (ws "," ws pair)*)? ws "}"',
      'pair ::= "\\"" key "\\"" ws ":" ws value',
      'key ::= [a-zA-Z0-9_]+',
      'value ::= string | number | boolean | obj | arr | "null"',
      'string ::= "\\"" chars "\\""',
      'chars ::= (esc | [^"\\\\])*',
      'esc ::= "\\\\" .',
      'number ::= [0-9]+ ("." [0-9]+)?',
      'boolean ::= "true" | "false"',
      'arr ::= "[" ws (value (ws "," ws value)*)? ws "]"',
      'ws ::= [ \\t\\n\\r]*'
    ].join('\n');
  }

  // 非流式 + GBNF 工具决策。返回 { toolCalls: [{id,name,arguments}] } 或 null（none/失败，调用方落回原路径）。
  async function toolDecisionWithGrammar({ messages, tools, model, baseURL, maxTokens }) {
    const names = [...new Set((tools || [])
      .map(t => (t && t.function && t.function.name) || '')
      .filter(n => /^[a-z0-9_]+$/i.test(n)))];
    if (!names.length) return null;
    const grammar = buildToolGbnf(names);
    const decisionMessages = (messages || []).concat([{
      role: 'system',
      content: '【工具决策】现在只决定是否调用工具：按 {"tool":"工具名","arguments":{...}} 输出；不需要工具时输出 {"tool":"none","arguments":{}}。不要输出任何其他内容。'
    }]);
    const url = String(baseURL || '').replace(/\/$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 60000);
    try {
      const resp = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: decisionMessages,
          temperature: 0.1,
          max_tokens: maxTokens || 4096,
          stream: false,
          grammar,
          chat_template_kwargs: { enable_thinking: false }
        }),
        signal: controller.signal
      });
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) return null;
      const parsed = JSON.parse(String(content).trim());
      if (!parsed || typeof parsed !== 'object' || parsed.tool === 'none' || !names.includes(parsed.tool)) return null;
      const args = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)) ? parsed.arguments : {};
      return { toolCalls: [{ id: 'call_grammar_' + Date.now().toString(36), name: parsed.tool, arguments: args }] };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 单轮流式调用（支持 tools / function calling，失败自动回退非流式）
  async function streamChatCompletion(sender, runId, { messages, model, temperature, maxTokens, tools, aiCfg }) {
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (resolveAiBaseURL(aiCfg) || provider.baseURL);
    let useModel = model || aiCfg.model || provider.defaultModel;
    const abortCtrl = new AbortController();
    activeAiControllers.set(runId, abortCtrl);
    const acSignal = abortCtrl.signal;
    // 2026-09-14：修复轮自动路由到coder 模型
    // 根因：qwen3.5:9b 在ollama 下有 ~4096 token 生成硬限到+ 长上下文下输出空（think=true/false 均空），
    // 无法自愈编译错误。qwen2.5-coder:7b 是专用编码模型，已验证能输出完整代码并编译通过　
    const _lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const _isFixTurn = !!(aiCfg.provider === 'ollama' && _lastUserMsg && /翻译失败|修复代码|仍然失败|编译错误|代码不完整|被截断/.test(_lastUserMsg.content || ''));
    if (_isFixTurn) {
      useModel = 'qwen2.5-coder:7b';
      console.warn('[chatStream] 修复轮自动切换到 qwen2.5-coder:7b（长上下文输出空）');
    }
    const apiKey = aiCfg.apiKey || '';
    const isGateway = aiCfg.provider === 'gateway';
    // 网关模式：矫正旧配置残留的不可用模型（deepseek-flash 等），否则对话 404 静默失败
    if (isGateway) useModel = normalizeGwModel(useModel);
    // 网关模式：走内置模型 + 积分扣费；请求体只发模型 id 与消息（Key 在服务端）
    const url = isGateway
      ? (baseURL || '').replace(/\/$/, '') + '/api/chat/stream'
      : (baseURL || '').replace(/\/$/, '') + '/chat/completions';
    if (!url || url === '/api/chat/stream' || url === '/chat/completions') throw new Error('未配置API baseURL，请在设置中配置');

    const headers = { 'Content-Type': 'application/json' };
    let gwCandidates = [];
    if (isGateway) {
      // 云端凭据候选：用户自己的 token > 管理后台/内置后端 key（token 过期时回退）
      gwCandidates = gatewayAuthCandidates(aiCfg);
      if (!gwCandidates.length) throw new Error('not logged in, please login in settings');
      headers['Authorization'] = 'Bearer ' + gwCandidates[0].token;
    } else if (apiKey) {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
    const bodyObj = isGateway
      ? { model: useModel, messages, temperature }
      : { model: useModel, messages, temperature, max_tokens: maxTokens, stream: true };
    // 网关模式同样透传 tools（网关支持 function calling 转发）
    if (isGateway && Array.isArray(tools) && tools.length > 0) {
      bodyObj.tools = tools;
    }
    // 本地引擎不注入 tools，llama.cpp --jinja + tools 会用 grammar 强制模型输出工具 JSON，
    // 本地小模型（Qwen3.5-9B）在 grammar 约束下会输出空失败（正文丢失）
    // 本地模型的主路径是正文代码块 → 应用层落地自动编译验证，，不依赖工具调用　
    if (Array.isArray(tools) && tools.length > 0 && aiCfg.provider !== 'local' && aiCfg.provider !== 'ollama' && !isGateway) {
      bodyObj.tools = tools;
    }
    // 本地引擎（Qwen3 等思考模型）：
    // 已实测：enable_thinking=true + 流式 + max_tokens 充足时，reasoning_content 与正文会先后输出，
    // finish=stop（真实豆包式思考流）。思考过长占满 max_tokens 时正文可能为空，
    // 用 doStreamOnce 决空正文 → 关闭思考重话降级兜底，保证正文输出　




    if (aiCfg.provider === 'local') {
      // bodyObj.chat_template_kwargs 用doStreamOnce(enableThinking) 按轮次设置
      // 2026-09-15：工具决策轮可选JSON 约束　
      // 冒烟（curl）实测 response_format=json_object 下 9B 吐合法 JSON，
      // 但真链路实测：约束导致流式60s 无数据→回退非流式→新旧请求叠加→GPU 并发跑满→客户端崩　
      // 故默认关闭，仅当 ai.localForceToolJson=true 显式开启　
      if (Array.isArray(tools) && tools.length > 0 && aiCfg.localForceToolJson === true) {
        bodyObj.response_format = { type: 'json_object' };
      }
    } else if (aiCfg.provider === 'ollama') {
      bodyObj.think = false;
    }

    const send = (type, data) => {
      try { if (sender && !sender.isDestroyed()) sender.send('ai:stream', { runId, type, ...data }); } catch (e) {}
    };

    // 本地引擎：确保引擎加载的就是本次请求的模型。
    // llama-server 忽略 model 字段，引擎若还跑着别的模型就会「答非所问」（静默降级）。
    if (aiCfg.provider === 'local') {
      const ensured = await ensureEngineServesModel(useModel);
      if (!ensured.ok) throw new Error(ensured.error);
    }

    // ===== Phase1：本地模型 GBNF 约束工具决策轮 =====
    // 条件：provider=local + 有工具 + 开关允许（自动：7B/9B 开、3B 关）。
    // 选到工具 → 发 tool_calls 事件 + done，渲染层直接执行；选 none/超时/失败 → 继续下面原有流式路径。
    if (aiCfg.provider === 'local' && Array.isArray(tools) && tools.length > 0 && localToolGrammarEnabled(aiCfg)) {
      const decision = await toolDecisionWithGrammar({ messages, tools, model: useModel, baseURL, maxTokens: 4096 });
      if (activeAiStreams.get(runId)) {
        // 决策期间用户取消：不再发起新请求，直接结束
        send('done', { content: '', toolCalls: [], usage: null });
        return { success: true, content: '', toolCalls: [], cancelled: true };
      }
      if (decision && decision.toolCalls.length > 0) {
        console.log('[grammar] 本地工具决策:', decision.toolCalls.map(t => t.name).join(', '));
        send('tool_calls', { toolCalls: decision.toolCalls });
        send('done', { content: '', toolCalls: decision.toolCalls, usage: null });
        return { success: true, content: '', toolCalls: decision.toolCalls };
      }
      console.log('[grammar] 本地工具决策: none（落回流式无约束路径）');
    }

    // 单次请求 + 流解析（供首次与引擎重启后重试共用）
    async function doStreamOnce(enableThinking, candIdx = 0) {
      // 网关：按候选顺序使用 token；当前候选 401 时由下方自动换下一个（登录 token 过期→后端 key）
      if (isGateway && gwCandidates[candIdx]) {
        headers['Authorization'] = 'Bearer ' + gwCandidates[candIdx].token;
      }
      const b = Object.assign({}, bodyObj);
      if (aiCfg.provider === 'local') b.chat_template_kwargs = { enable_thinking: enableThinking !== false };
      else if (aiCfg.provider === 'ollama') b.think = enableThinking !== false;
      // 2026-10-14 云推理模型思考档位（BYOK reasoning 强度）：
      // 仅当 renderer 显式传了 thinkingParams（按厂商预设展开后的字段，如
      // {reasoning_effort:'high'} / {thinking:{type:'enabled'}} / {reasoning_split:true}）才附加。
      // 本地/ollama/gateway 已各自用 think 控制，跳过；默认空 → 不附加任何字段，零回归。
      else {
        // 云推理模型思考档位：renderer 存 ai.thinkingLevel（fast/light/standard/deep），按厂商映射；
        // 显式 thinkingParams（已展开对象）优先。本地/ollama 已各自用 think 控制，走上面分支。
        const tp = (aiCfg.thinkingParams && typeof aiCfg.thinkingParams === 'object' && Object.keys(aiCfg.thinkingParams).length)
          ? aiCfg.thinkingParams
          : buildThinkingParams(aiCfg.provider, aiCfg.thinkingLevel);
        if (tp && Object.keys(tp).length) Object.assign(b, tp);
      }
      const toolCalls = [];
      const response = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(b), signal: acSignal });
      if (!response.ok) {
        // 网关：当前候选 token 401 → 换下一个候选（用户登录失效时回退到管理后台后端 key）
        if (response.status === 401 && isGateway && gwCandidates[candIdx + 1]) {
          return doStreamOnce(enableThinking, candIdx + 1);
        }
        const errText = await response.text().catch(() => '');
        const err = new Error(`API 返回 ${response.status}: ${redactError(errText)}`);
        if (response.status === 402) err.creditsInsufficient = true;
        throw Object.assign(err, { status: response.status, errText });
      }

      let fullText = '';
      let lastFinish = '';
      let lastUsage = null;
      for await (const evt of parseSSEStream(response.body)) {
        if (activeAiStreams.get(runId)) { activeAiStreams.delete(runId); break; }
        // 网关事件行（event: credits / event: error）透传给 renderer
        if (evt._event === 'credits') {
          send('credits', { used: evt.used, totalTokens: evt.totalTokens, remaining: evt.remaining, dailyRemaining: evt.dailyRemaining });
          continue;
        }
        if (evt._event === 'error') {
          send('error', { error: redactError(evt.error) || '网关错误' });
          continue;
        }
        if (evt.usage) lastUsage = evt.usage;
        const choice = evt.choices && evt.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) lastFinish = choice.finish_reason;
        if (choice.delta && choice.delta.reasoning_content) {
          send('thinking_delta', { delta: choice.delta.reasoning_content });
        }
        if (choice.delta && choice.delta.content) {
          fullText += choice.delta.content;
          send('delta', { delta: choice.delta.content });
        }
        if (choice.delta && Array.isArray(choice.delta.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || ('call_' + idx), name: '', arguments: '' };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function) {
              if (tc.function.name) toolCalls[idx].name += tc.function.name;
              if (tc.function.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        }
        if (evt.usage) send('usage', { usage: evt.usage });
      }

      const parsedToolCalls = toolCalls
        .filter(tc => tc.name)
        .map(tc => {
          let args = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch (e) { args = { _raw: tc.arguments }; }
          return { id: tc.id, name: tc.name, arguments: args };
        });

      // ===== 本地思考流降级：思考过长占满 max_tokens → 正文为空 → 关闭思考重试一次 =====
      // 2026-09-14：扩展到 ollama（Qwen3.5-9B 等思考模型同样会思考占满预算导致正文截断空输出）
      if ((aiCfg.provider === 'local' || aiCfg.provider === 'ollama') && enableThinking !== false && !String(fullText || '').trim()) {
      console.warn('[streamChat] local thinking stream produced no text, retry without thinking');
        return doStreamOnce(false);
      }

      // 注意：不在此 send('done')——外层可能需要自动续写，由外层统一发送最终 done
      return { success: true, content: fullText, toolCalls: parsedToolCalls, finishReason: lastFinish, usage: lastUsage };
    }

    // ===== 2026-09-14 自动续写：ollama/local 模型代码块未闭合时，自动续写拼接 =====
    // 根因：ollama 0.33.x + qwen3.5:9b 未~4096 token 生成硬限制（num_predict 不生效），长代码在4096 token 处被切断　
    // 检测：``` 计数为奇数（代码块未闭合）或花括号不匹配 → 发请继续请求拼接，最多 3 次　
    function hasUnclosedCodeBlock(text) {
      const t = text || '';
      const ticks = t.match(/```/g);
      if (ticks && ticks.length % 2 === 1) return true;
      // 代码块未闭合（正则号不匹配，函数未写完）也视为未完成
      const open = (t.match(/\{/g) || []).length;
      const close = (t.match(/\}/g) || []).length;
      return open > close;
    }
    async function continueStream(prevContent, attempt) {
      const continueMessages = [
        ...messages,
        { role: 'assistant', content: prevContent },
      { role: 'user', content: 'continue outputting remaining code directly, do not output ``` closing markers, do not repeat output, do not write explanations, until all functions and logic are complete and all braces are closed' }
      ];
      const b = Object.assign({}, bodyObj, { messages: continueMessages });
      if (aiCfg.provider === 'local') b.chat_template_kwargs = { enable_thinking: false };
      else if (aiCfg.provider === 'ollama') b.think = false;
      const resp = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(b), signal: acSignal });
      if (!resp.ok) throw new Error(`续写 API 返回 ${resp.status}`);
      let cont = '';
      let fin = '';
      for await (const evt of parseSSEStream(resp.body)) {
        if (activeAiStreams.get(runId)) break;
        const choice = evt.choices && evt.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) fin = choice.finish_reason;
        if (choice.delta && choice.delta.content) { cont += choice.delta.content; send('delta', { delta: choice.delta.content }); }
      }
      return { content: cont, finishReason: fin };
    }

    try {
      // 2026-09-14：修复轮（编译失败提示）强制关闭思考——避免思考占满 4096 token 预算导致正文空输出
      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      const isFixTurn = !!(lastUserMsg && /编译失败|淇代码|仍然失败|编译错误/.test(lastUserMsg.content || ''));
      const thinkForTurn = isFixTurn ? false : true;
      if (isFixTurn) _log('检测到编译修复轮，强制 think=false');
      let result = await doStreamOnce(thinkForTurn);
      // 自动续写循环（仅 ollama/local，代码块未闭合时——不依赖 finish_reason，llama 流式可能不传）
      const _fs = require('fs'); const _log = (s) => { try { _fs.appendFileSync(require('path').join(require('os').tmpdir(), 'labcode_stream.log'), new Date().toISOString() + ' ' + s + '\n'); } catch(e){} };
      _log(`doStreamOnce done, len=${result.content.length}, unclosed=${hasUnclosedCodeBlock(result.content)}`);
      if ((aiCfg.provider === 'ollama' || aiCfg.provider === 'local') && hasUnclosedCodeBlock(result.content)) {
        for (let i = 0; i < 3; i++) {
          _log(`续写笉${i + 1} 次开姩 当前 len=${result.content.length}`);
          try {
            const cont = await continueStream(result.content, i + 1);
            _log(`续写笉${i + 1} 次完成 续接 len=${cont.content.length}, finish=${cont.finishReason}`);
            result.content += cont.content;
            result.finishReason = cont.finishReason;
      if (!hasUnclosedCodeBlock(result.content)) { _log('code block closed, stop continuing'); break; }
          } catch (ce) {
            _log(`续写失败: ${ce.message}`);
            console.warn('[streamChat] 续写失败:', ce.message);
            break;
          }
        }
      }
      _log(`最终 done, len=${result.content.length}`);
      // 统一发送最终 done（noStreamOnce 内部不再发 done，避免续决 delta 被忽略）
      send('done', { content: result.content, toolCalls: result.toolCalls, usage: result.usage || null });
      return result;
    } catch (e) {
      // 用户/看门狗主动取消：不重试、不回退非流式，直接静默结束
      if (e && (e.name === 'AbortError' || e.aborted)) {
        activeAiControllers.delete(runId);
        return { success: false, aborted: true };
      }
      // ===== 本地引擎自动恢复：连接失败（含覆盖安装后旧实例假活）→ 强杀残留并重启引擎 → 重试一次 =====
      if (!e.noFallback && aiCfg.provider === 'local' && !activeAiStreams.get(runId)) {
        try {
          console.warn('[streamChat] 本地引擎请求失败，自动重启引擎后重试:', e.message);
          const sr = await startEngineInternal(aiCfg.model);
          if (sr && sr.success) {
            return await doStreamOnce(true);
          }
        } catch (re) { console.warn('[streamChat] 引擎重启重试失败:', re.message); }
      }
      // 回退：去掉 tools + stream:false 再试一次（兼容不支持 function calling 的模型）
      if (!e.noFallback && !activeAiStreams.get(runId)) {
        try {
          // 网关模式回退到非流式端点 /api/chat
          const fbUrl = isGateway ? (baseURL || '').replace(/\/$/, '') + '/api/chat' : url;
          const fbBody = isGateway
            ? { model: useModel, messages, temperature }
            : { model: useModel, messages, temperature, max_tokens: maxTokens, stream: false };
          if (aiCfg.provider === 'local') fbBody.chat_template_kwargs = { enable_thinking: false };
          else if (aiCfg.provider === 'ollama') fbBody.think = false;
          // 云推理模型思考档位：降级重试也保持与原请求一致的思考参数
          else {
            // 云推理模型思考档位：降级重试也保持与原请求一致的思考参数（thinkingLevel 映射或显式 thinkingParams）
            const fbTp = (aiCfg.thinkingParams && typeof aiCfg.thinkingParams === 'object' && Object.keys(aiCfg.thinkingParams).length)
              ? aiCfg.thinkingParams
              : buildThinkingParams(aiCfg.provider, aiCfg.thinkingLevel);
            if (fbTp && Object.keys(fbTp).length) Object.assign(fbBody, fbTp);
          }
          const fbResp = await net.fetch(fbUrl, { method: 'POST', headers, body: JSON.stringify(fbBody), signal: acSignal });
          if (fbResp.ok) {
            const data = await fbResp.json();
            if (isGateway) {
              // 网关非流式响应：{ content, creditsLeft, cost, totalTokens }
              const gwContent = data?.content || '';
              send('credits', { used: data?.cost || 0, totalTokens: data?.totalTokens || 0, remaining: data?.creditsLeft || 0, dailyRemaining: data?.dailyRemaining });
              send('done', { content: gwContent, toolCalls: [] });
              return { success: true, content: gwContent, toolCalls: [] };
            }
            const content = data?.choices?.[0]?.message?.content || '';
            const tc = data?.choices?.[0]?.message?.tool_calls || [];
            const parsed = Array.isArray(tc) ? tc.map(t => ({
              id: t.id,
              name: (t.function && t.function.name) || '',
              arguments: (() => { try { return JSON.parse((t.function && t.function.arguments) || '{}'); } catch (err) { return { _raw: t.function && t.function.arguments }; } })()
            })) : [];
            send('done', { content, toolCalls: parsed });
            return { success: true, content, toolCalls: parsed };
          }
        } catch (fbErr) { /* 继续抛原始错话*/ }
      }
      send('error', { error: e.message || String(e), creditsInsufficient: !!e.creditsInsufficient });
      return { success: false, error: e.message || String(e), creditsInsufficient: !!e.creditsInsufficient };
    }
  }

  ipcMain.handle('ai:chatStream', async (event, options = {}) => {
    const { runId = 'run_' + Date.now(), messages, model, temperature, maxTokens, tools } = options;
    const aiCfg = config.ai || {};
    activeAiStreams.delete(runId);
    // 异步执行，立即返回runId，结果经 ai:stream 事件推选
    (async () => {
      try {
        await streamChatCompletion(event.sender, runId, { messages, model, temperature, maxTokens, tools, aiCfg });
      } catch (e) {
        try { event.sender.send('ai:stream', { runId, type: 'error', error: e.message || String(e) }); } catch (_) {}
      } finally {
        activeAiControllers.delete(runId);
      }
    })();
    return { success: true, runId };
  });

  // 取消流式对话
  ipcMain.handle('ai:chatCancel', (_, runId) => {
    if (runId) {
      activeAiStreams.set(runId, true);
      const ctrl = activeAiControllers.get(runId);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }
    return { success: true };
  });

  // 本地模型服务状态探测（Ollama 等 OpenAI 兼容端点）。
  // 与 ai:checkConnection 的区别：这里只 GET /models，不发起推理（快、不烧算力），
  // 用来在模型下拉里显示「已就绪 / 未运行 / 缺模型」状态签。
  ipcMain.handle('ai:localStatus', async (_, testConfig) => {
    const aiCfg = { ...(config.ai || {}), ...(testConfig || {}) };
    const baseURL = String(aiCfg.baseURL || aiCfg.baseUrl || '').replace(/\/$/, '');
    if (!baseURL) return { running: false, error: '未配置本地服务地址' };
    try {
      // 超时保护：Ollama 没开时若连接被丢弃而非拒绝，UI 不能一直停在"检测中"
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2500);
      let resp;
      try {
        resp = await net.fetch(baseURL + '/models', { method: 'GET', signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) return { running: false, status: resp.status, baseURL, error: 'HTTP ' + resp.status };
      const data = await resp.json().catch(() => ({}));
      const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
      const models = list.map(m => (m && (m.id || m.name || m.model)) || '').filter(Boolean);
      return { running: true, baseURL, models };
    } catch (e) {
      return { running: false, baseURL, error: e.message || String(e) };
    }
  });

  ipcMain.handle('ai:checkConnection', async (_, testConfig) => {
    // 测试 AI 连接（发一条最短消息）
    const aiCfg = { ...(config.ai || {}), ...(testConfig || {}) };
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (resolveAiBaseURL(aiCfg) || provider.baseURL);
    const useModel = aiCfg.model || provider.defaultModel;
    if (!baseURL) return { success: false, error: '未配置baseURL' };
    try {
      // 网关模式：用 /api/me 验证 token 有效性（不消耗积分）
      // 遍历候选（用户 token 过期时回退到管理后台后端 key），任一有效即算连通
      if (aiCfg.provider === 'gateway') {
        const candidates = gatewayAuthCandidates(aiCfg);
        if (!candidates.length) return { success: false, status: 401, error: '未登录，请在设置中登录' };
        let lastStatus = null, lastKind = null;
        for (const c of candidates) {
          const gwUrl = (c.url || AI_PROVIDERS.gateway.baseURL).replace(/\/$/, '') + '/api/me';
          lastKind = c.kind;
          const gwResp = await net.fetch(gwUrl, { headers: { Authorization: 'Bearer ' + c.token } });
          lastStatus = gwResp.status;
          if (gwResp.ok) {
            const data = await gwResp.json().catch(() => ({}));
            const u = data?.user || {};
            return { success: true, model: useModel, gateway: true, usingBackend: c.kind === 'backend', creditsLeft: u.totalCredits ?? (u.planCredits || 0) + (u.rechargeCredits || 0) };
          }
          if (gwResp.status !== 401) break; // 非 401（如网络错）不再试
        }
        return { success: false, status: lastStatus, usingBackend: lastKind === 'backend', error: lastKind === 'user' ? '网关登录失效，请重新登录' : '云端后端 API Key 无效或未配置' };
      }
      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
      // 本地引擎：探测前先对齐模型，否则「测试连接」会打到别的模型上得到假阳性
      if (aiCfg.provider === 'local') {
        const ensured = await ensureEngineServesModel(useModel);
        if (!ensured.ok) return { success: false, error: ensured.error };
      }
      const headers = { 'Content-Type': 'application/json' };
      if (aiCfg.apiKey) headers['Authorization'] = 'Bearer ' + aiCfg.apiKey;
      const response = await net.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, stream: false })
      });
      return { success: response.ok, status: response.status, model: useModel };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // ============ 网关账号（登录/ 注册 / 余额 / 登出）===========
  // 网关可用性状态：UI 据此决定要不要强制用户先注册。
  // 商业化取向：有内置凭据时**不拦用户**（装完即用），登录只是可选增强。
  ipcMain.handle('ai:gatewayStatus', async () => {
    const aiCfg = config.ai || {};
    const candidates = gatewayAuthCandidates(aiCfg);
    let creditsLeft = null, dailyRemaining = null, email = aiCfg.gatewayEmail || '';
    let valid = false, usingBackend = false;
    // 逐个候选打 /api/me，第一个有效即停（用户 token 过期时回退到管理后台后端 key）
    for (const c of candidates) {
      const gwBase = (c.url || AI_PROVIDERS.gateway.baseURL).replace(/\/$/, '');
      try {
        const res = await net.fetch(gwBase + '/api/me', { headers: { Authorization: 'Bearer ' + c.token } });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const u = data.user || {};
          creditsLeft = u.totalCredits ?? ((u.planCredits || 0) + (u.rechargeCredits || 0));
          dailyRemaining = u.dailyRemaining ?? null;
          email = u.email || email;
          valid = true;
          usingBackend = c.kind === 'backend';
          break;
        }
      } catch (e) { /* 试下一个候选 */ }
    }
    return {
      available: candidates.length > 0,
      valid,
      usingBackend,
      loggedIn: !!aiCfg.gatewayToken,
      creditsLeft,
      dailyRemaining,
      email
    };
  });

  ipcMain.handle('ai:gatewayAuth', async (_, { action, email, password, gatewayUrl, inviteCode, code, username } = {}) => {
    // 优先级：显式传入 > 已保存config.ai.gatewayUrl > 环境变量 > 默认生产域名
    const savedGw = (config.ai || {}).gatewayUrl || '';
    const gwBase = (gatewayUrl || savedGw || process.env.GATEWAY_URL || AI_PROVIDERS.gateway.baseURL || 'https://bluebubai.work').replace(/\/$/, '');
    try {
      if (action === 'send-code') {
      if (!email) return { success: false, error: '请输入邮箱' };
        const res = await net.fetch(`${gwBase}/api/auth/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { success: false, error: data.error || `网关返回 ${res.status}` };
        return { success: true, ...(data.consoleMode ? { consoleMode: true, devCode: data.devCode } : {}) };
      }
      if (action === 'login' || action === 'register') {
        if (!email || !password) return { success: false, error: '请输入邮箱和密码' };
        const body = { email, password };
        if (action === 'register') {
          if (username) body.username = username;
          if (inviteCode) body.inviteCode = inviteCode;
          if (code) body.code = code;
        }
        const res = await net.fetch(`${gwBase}/api/auth/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { success: false, error: data.error || `网关返回 ${res.status}` };
        if (!data.token) return { success: false, error: '网关未返回token' };
        const u = data.user || {};
        // 持久化到 config.ai
        const aiCfg = config.ai || {};
        aiCfg.gatewayToken = data.token;
        aiCfg.gatewayEmail = email;
        aiCfg.gatewayUrl = gwBase;
        config.ai = aiCfg;
        saveConfig(config);
        return {
          success: true,
          action,
          user: { email: u.email, totalCredits: u.totalCredits, planCredits: u.planCredits, rechargeCredits: u.rechargeCredits, dailyRemaining: u.dailyRemaining, dailyUsed: u.dailyUsed }
        };
      }
      if (action === 'me') {
        const token = (config.ai || {}).gatewayToken || '';
    if (!token) return { success: false, error: 'not logged in' };
        const res = await net.fetch(`${gwBase}/api/me`, { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { success: false, error: data.error || `网关返回 ${res.status}` };
        const u = data.user || {};
        return { success: true, user: { email: u.email, totalCredits: u.totalCredits, planCredits: u.planCredits, rechargeCredits: u.rechargeCredits, dailyRemaining: u.dailyRemaining, dailyUsed: u.dailyUsed } };
      }
      if (action === 'logout') {
        const aiCfg = config.ai || {};
        delete aiCfg.gatewayToken;
        delete aiCfg.gatewayEmail;
        config.ai = aiCfg;
        saveConfig(config);
        return { success: true };
      }
      return { success: false, error: '未知操作: ' + action };
    } catch (e) {
      return { success: false, error: '网关请求失败: ' + redactError(e.message || String(e)) };
    }
  });

  // 会话
  ipcMain.handle('sessions:list', () => loadSessions());
  ipcMain.handle('sessions:save', (_, session) => saveSession(session));
  ipcMain.handle('sessions:delete', (_, id) => deleteSession(id));

  // 文件操作
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '代码文件', extensions: ['js', 'ts', 'py', 'cpp', 'c', 'ino', 'rs', 'go', 'java'] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_, defaultPath) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultPath || 'untitled'
    });
    return result.canceled ? null : result.filePath;
  });

  // ===== Plugin transports: stdio / grpc / mqtt =====
  // These need OS level access (child process, sockets), so they live in the main
  // process; the renderer calls them through preload -> window.LabCode.plugin.*.

  // stdio: spawn a child process and speak JSON-RPC over stdin/stdout (one JSON per line)
  ipcMain.handle('plugin:stdioCall', async (_, opts) => {
    try {
      const o = opts || {};
      const command = o.command || '';
      if (!command) return { success: false, error: 'command is required' };
      const args = Array.isArray(o.args) ? o.args : [];
      const timeoutMs = o.timeoutMs || 30000;
      const req = o.request || {};
      const { spawn } = require('child_process');
      const child = spawn(command, args, {
        cwd: o.cwd || undefined,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      const done = new Promise((resolve) => {
        let finished = false;
        const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
        child.on('exit', (code) => finish({ exitCode: code }));
        child.on('error', (e) => finish({ error: e.message }));
        setTimeout(() => { try { child.kill(); } catch (e) {} finish({ timeout: true }); }, timeoutMs);
      });
      try {
        child.stdin.write(JSON.stringify(req) + '\n');
        // must close stdin: most plugins read until EOF, otherwise they never reply
        child.stdin.end();
      } catch (e) {
        return { success: false, error: 'write stdin failed: ' + e.message };
      }
      const r = await done;
      if (r.error) return { success: false, error: r.error };
      if (r.timeout) return { success: false, error: 'timeout after ' + timeoutMs + 'ms', stderr: err.slice(0, 2000) };
      // pick the last valid JSON line from stdout
      const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (let k = lines.length - 1; k >= 0; k--) {
        try { return { success: true, result: JSON.parse(lines[k]), exitCode: r.exitCode }; } catch (e) { /* not json */ }
      }
      return { success: true, raw: out.slice(0, 8000), stderr: err.slice(0, 2000), exitCode: r.exitCode };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // cli: spawn with an ARGV array (NO shell). Plugin tool arguments must never be
  // interpolated into a shell string — that was an injection hole (AI-controlled
  // values reaching a shell). envScript (e.g. ESP-IDF export.ps1) is wrapped here
  // with per-argument quoting so a value can never break out of its argument.
  ipcMain.handle('plugin:cliCall', async (_, opts) => {
    try {
      const o = opts || {};
      const command = o.command || '';
      if (!command) return { success: false, error: 'command is required' };
      const args = Array.isArray(o.args) ? o.args.map(String) : [];
      const timeoutMs = o.timeoutMs || 120000;
      const { spawn } = require('child_process');
      const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      let bin = command;
      let binArgs = args;
      if (o.envScript) {
        bin = 'powershell';
        binArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          '& ' + psQuote(o.envScript) + '; & ' + [command].concat(args).map(psQuote).join(' ')];
      }
      const child = spawn(bin, binArgs, {
        cwd: o.cwd || undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      const done = new Promise((resolve) => {
        let finished = false;
        const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
        child.on('exit', (code) => finish({ exitCode: code }));
        child.on('error', (e) => finish({
          error: e && e.code === 'ENOENT'
            ? 'spawn ENOENT: "' + command + '" 不是可执行文件。Windows 内建命令（echo/dir/type 等）不能用于 cli transport——请改用真实程序（node / python / arduino-cli / esptool 等），例如 node -e "..."'
            : (e && e.message) || String(e)
        }));
        setTimeout(() => { try { child.kill(); } catch (e) {} finish({ timeout: true }); }, timeoutMs);
      });
      const r = await done;
      if (r.error) return { success: false, error: r.error };
      if (r.timeout) return { success: false, error: 'timeout after ' + timeoutMs + 'ms', stderr: err.slice(0, 2000) };
      return {
        success: r.exitCode === 0,
        exitCode: r.exitCode,
        stdout: out.slice(0, 16000),
        stderr: err.slice(0, 4000)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // grpc: load the plugin's .proto dynamically and make a unary call
  ipcMain.handle('plugin:grpcCall', async (_, opts) => {
    try {
      const o = opts || {};
      if (!o.protoPath || !o.service || !o.method || !o.host) {
        return { success: false, error: 'protoPath/service/method/host are required' };
      }
      const grpc = require('@grpc/grpc-js');
      const protoLoader = require('@grpc/proto-loader');
      const packageDefinition = await protoLoader.load(o.protoPath, {
        keepCase: false, longs: String, enums: String, defaults: true, oneofs: true
      });
      const proto = grpc.loadPackageDefinition(packageDefinition);
      // supports "pkg.Service" style names
      const parts = String(o.service).split('.');
      let Service = proto;
      for (const part of parts) { Service = Service && Service[part]; }
      if (!Service) return { success: false, error: 'service not found in proto: ' + o.service };
      const client = new Service(o.host, o.insecure === false
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure());
      const deadline = Date.now() + (o.timeoutMs || 30000);
      const result = await new Promise((resolve, reject) => {
        client[o.method](o.request || {}, { deadline }, (e, resp) => {
          if (e) reject(e); else resolve(resp);
        });
      });
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // mqtt: publish to a topic and (optionally) wait for a reply on responseTopic
  ipcMain.handle('plugin:mqttCall', async (_, opts) => {
    try {
      const o = opts || {};
      if (!o.brokerUrl || !o.topic) return { success: false, error: 'brokerUrl/topic are required' };
      const mqtt = require('mqtt');
      const timeoutMs = o.timeoutMs || 15000;
      const client = mqtt.connect(o.brokerUrl, {
        username: o.username || undefined,
        password: o.password || undefined,
        clientId: o.clientId || ('labcode-plugin-' + Math.random().toString(16).slice(2, 10)),
        reconnectPeriod: 0,
        connectTimeout: Math.min(timeoutMs, 10000)
      });
      const payload = typeof o.payload === 'string' ? o.payload : JSON.stringify(o.payload || {});
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { client.end(true); } catch (e) {}
          resolve({ success: false, error: 'timeout waiting for response (' + timeoutMs + 'ms)' });
        }, timeoutMs);
        const finish = (r) => {
          clearTimeout(timer);
          try { client.end(true); } catch (e) {}
          resolve(r);
        };
        client.on('error', (e) => finish({ success: false, error: e.message }));
        client.on('connect', () => {
          if (o.responseTopic) {
            client.subscribe(o.responseTopic, (se) => {
              if (se) return finish({ success: false, error: 'subscribe failed: ' + se.message });
              client.publish(o.topic, payload, { qos: o.qos || 0 }, (pe) => {
                if (pe) return finish({ success: false, error: 'publish failed: ' + pe.message });
              });
            });
          } else {
            client.publish(o.topic, payload, { qos: o.qos || 0 }, (pe) => {
              if (pe) finish({ success: false, error: 'publish failed: ' + pe.message });
              else finish({ success: true, published: true });
            });
          }
        });
        if (o.responseTopic) {
          client.on('message', (topic, message) => {
            if (topic !== o.responseTopic) return;
            const text = message.toString();
            try { finish({ success: true, result: JSON.parse(text), topic }); }
            catch (e) { finish({ success: true, raw: text.slice(0, 8000), topic }); }
          });
        }
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // unzip: plugins are usually distributed as a ZIP; extraction needs OS access
  ipcMain.handle('plugin:unzip', async (_, opts) => {
    try {
      const o = opts || {};
      if (!o.zipPath || !o.destDir) return { success: false, error: 'zipPath/destDir are required' };
      const { execFile } = require('child_process');
      await fs.promises.rm(o.destDir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(o.destDir, { recursive: true });
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          'Expand-Archive -Path ' + q(o.zipPath) + ' -DestinationPath ' + q(o.destDir) + ' -Force'],
          { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || stdout || err.message).slice(0, 600)));
            else resolve();
          });
      });
      return { success: true, destDir: o.destDir };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 文件读写（带编码自动检测：UTF-8 BOM / 纯 UTF-8 / GBK 回退）
  ipcMain.handle('fs:readFile', (_, filePath) => {
    try {
      const buf = fs.readFileSync(filePath);
      // 1) UTF-8 BOM 直接按UTF-8
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return { success: true, content: buf.toString('utf-8').replace(/^\uFEFF/, ''), encoding: 'utf-8' };
      }
      // 2) 尝试严格 UTF-8 解码（TextDecoder fatal 模式）
      try {
        const td = new TextDecoder('utf-8', { fatal: true });
        const content = td.decode(buf);
        // 时BOM 但纯 ASCII/UTF-8 时直接返回
        return { success: true, content, encoding: 'utf-8' };
      } catch (utfErr) {
        // 3) UTF-8 解码失败 →GBK（覆盖中文Windows 常见 GB2312/GBK 编码文件）
        const iconv = (() => {
          try { return require('iconv-lite'); } catch (e) { return null; }
        })();
        if (iconv) {
          return { success: true, content: iconv.decode(buf, 'gbk'), encoding: 'gbk' };
        }
        // 无 iconv-lite 时的回退：手动 GBK→UTF-8 表不现实，用 latin1 兜底
        return { success: true, content: buf.toString('utf-8'), encoding: 'utf-8(疑似GBK)' };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ============ 区域截图（对齐 Ekko regionSelection） ============
  let regionOverlay = null;
  let regionPending = null; // { resolve, reject }

  ipcMain.handle('screenshot:region', async () => {
    return new Promise((resolve, reject) => {
      regionPending = { resolve, reject };
      const display = screen.getPrimaryDisplay();
      const { width, height, scaleFactor } = display;
      if (regionOverlay && !regionOverlay.isDestroyed()) regionOverlay.destroy();
      regionOverlay = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: path.join(__dirname, 'region-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false
        }
      });
      regionOverlay.setAlwaysOnTop(true, 'screen-saver');
      regionOverlay.loadFile(path.join(__dirname, '..', 'renderer', 'region-capture.html'));
      regionOverlay.show();
      regionOverlay.focus(); // 确保键盘焦点在遮罩，Esc 可取消
      regionOverlay.once('closed', () => {
        regionOverlay = null;
        if (regionPending) { regionPending.reject(new Error('已取消')); regionPending = null; }
      });
    });
  });

  // 遮罩框选完成 → 全屏截图并裁剪
  ipcMain.handle('region:selected', async (_, rect) => {
    // 先取走 pending，避免 destroy 触发 closed 事件抢先 reject
    const pending = regionPending;
    regionPending = null;
    try {
      if (regionOverlay && !regionOverlay.isDestroyed()) { regionOverlay.destroy(); regionOverlay = null; }
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        if (pending) pending.reject(new Error('选区无效'));
        return { success: false, error: '选区无效' };
      }
      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width * scale, height: display.size.height * scale } });
      const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
      if (!src) {
        if (pending) pending.reject(new Error('无法捕获屏幕'));
        return { success: false, error: '无法捕获屏幕' };
      }
      // rect 来自遮罩页（CSS px / DIP）→ 按实际 thumbnail 与期望物理尺寸比例换算裁剪
      const expectW = Math.round(display.size.width * scale);
      const expectH = Math.round(display.size.height * scale);
      const real = src.thumbnail.getSize();
      const sx = real.width / expectW, sy = real.height / expectH;
      const crop = {
        x: Math.max(0, Math.round(rect.x * scale * sx)),
        y: Math.max(0, Math.round(rect.y * scale * sy)),
        width: Math.min(real.width, Math.round(rect.w * scale * sx)),
        height: Math.min(real.height, Math.round(rect.h * scale * sy))
      };
      const img = src.thumbnail.crop(crop);
      const png = img.toPNG();
      if (pending) pending.resolve({ success: true, png });
      return { success: true, png };
    } catch (e) {
      if (pending) pending.reject(e);
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('region:cancel', () => {
    if (regionOverlay && !regionOverlay.isDestroyed()) regionOverlay.destroy();
    regionOverlay = null;
    if (regionPending) { regionPending.reject(new Error('已取消')); regionPending = null; }
    return true;
  });

  // 剪贴板（朗读用）
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeText', (_, text) => { clipboard.writeText(String(text || '')); return true; });

  // ============ 看板统计（对齐 Ekko 看板） ============
  ipcMain.handle('dashboard:stats', async (_, rootPath) => {
    const start = Date.now();
    const result = { files: 0, dirs: 0, totalBytes: 0, extMap: {}, recent: [], skipped: 0 };
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out', 'coverage']);
    const MAX_FILES = 60000;
    const walk = (dir, depth) => {
      if (result.files > MAX_FILES || depth > 9) { result.skipped++; return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const en of entries) {
        if (result.files > MAX_FILES) { result.skipped++; return; }
        const full = path.join(dir, en.name);
        if (en.isDirectory()) {
          if (SKIP_DIRS.has(en.name)) { result.skipped++; continue; }
          result.dirs++;
          walk(full, depth + 1);
        } else {
          result.files++;
          try {
            const st = fs.statSync(full);
            result.totalBytes += st.size;
            if (result.recent.length < 10) result.recent.push({ name: en.name, path: full, mtime: st.mtimeMs });
          } catch (e) {}
          const ext = path.extname(en.name).toLowerCase() || '(无扩展名)';
          result.extMap[ext] = (result.extMap[ext] || 0) + 1;
        }
      }
    };
    try { walk(rootPath || '', 0); } catch (e) {}
    result.recent.sort((a, b) => b.mtime - a.mtime);
    result.recent = result.recent.slice(0, 10).map(r => ({ name: r.name, path: String(r.path).replace(rootPath || '', '…'), mtime: r.mtime }));
    result.elapsedMs = Date.now() - start;
    result.topExts = Object.entries(result.extMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return result;
  });

  ipcMain.handle('fs:writeFile', (_, filePath, content) => {    try {
      ensureDir(path.dirname(filePath));
      // 自动快照（agent 修改前备份）
      try { snapshotFile(filePath); } catch (e) {}
      // 兼容 Buffer / ArrayBuffer / TypedArray / 字符串；Buffer 或二进制按原样写，字符串按 UTF-8
      let data = content;
      if (content && typeof content === 'object' && !Buffer.isBuffer(content)) {
        data = Buffer.from(content);
      }
      fs.writeFileSync(filePath, data, Buffer.isBuffer(data) ? undefined : 'utf-8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('fs:exists', (_, filePath) => fs.existsSync(filePath));

  ipcMain.handle('fs:listDir', (_, dirPath) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        success: true,
        files: items.map(item => ({
          name: item.name,
          isDirectory: item.isDirectory(),
          path: path.join(dirPath, item.name)
        }))
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 复制文件
  ipcMain.handle('fs:copyFile', (_, srcPath, destPath) => {
    try {
      fs.copyFileSync(srcPath, destPath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ===== 读取 PDF 文件（对齐 TrieCode pdf.js）=====
  ipcMain.handle('fs:readPdf', async (_, filePath, maxPages = 20) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: '文件不存在' };
      try {
        const pdf = require('pdf-parse');
        const buf = fs.readFileSync(filePath);
        const data = await pdf(buf);
        const pages = data.numpages || 1;
        const text = data.text || '';
        const pageTexts = text.split('\f');
        const limited = pageTexts.slice(0, maxPages);
        return { success: true, text: limited.join('\n---\n').slice(0, 30000), pages: limited.length, totalPages: pages, truncated: pageTexts.length > maxPages };
      } catch (pdfErr) {
        // pdf-parse 未安装，降级为简单字符串提取
        const buf = fs.readFileSync(filePath);
        const latin1 = buf.toString('latin1');
        const strings = latin1.match(/\((?:[^()\\]|\\.)*\)/g) || [];
        const extracted = strings.map(s => s.slice(1, -1)).filter(s => s.length > 10).join('\n');
        return { success: true, text: extracted.slice(0, 20000), pages: 1, totalPages: 1, truncated: extracted.length > 20000, note: 'pdf-parse未安装，降级提取' };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ===== 图片分析（对齐 TrieCode vision.js，需视觉模型）=====
  ipcMain.handle('fs:analyzeImage', async (_, filePath, prompt) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: '文件不存在' };
      const buf = fs.readFileSync(filePath);
      const ext = filePath.split('.').pop().toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
      const b64 = buf.toString('base64');
      const dataUrl = 'data:' + mime + ';base64,' + b64;
      const aiCfg = config.ai || {};
      const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
      const baseURL = resolveAiBaseURL(aiCfg) || provider.baseURL;
      const apiKey = aiCfg.apiKey || '';
      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
      const resp = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: aiCfg.model || provider.defaultModel,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt || '请描述这张图片的内容' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]}],
          max_tokens: 1000
        })
      });
      if (!resp.ok) return { success: false, error: 'API ' + resp.status + '（当前模型可能不支持视觉）' };
      const data = await resp.json();
      return { success: true, description: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '（无描述）' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ============ 终端 IPC ============
  
  // 创建终端
  ipcMain.handle('terminal:create', (_, options = {}) => {
    try {
      const terminal = terminalService.createTerminal(options);
      
      // 监听终端数据输出，通过 webContents 发送到渲染进程
      terminalService.onData(terminal.id, (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`terminal:data:${terminal.id}`, data);
        }
      });
      
      // 监听终端退出
      terminalService.onExit(terminal.id, ({ exitCode, signal }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`terminal:exit:${terminal.id}`, { exitCode, signal });
        }
      });
      
      return { success: true, terminal };
    } catch (e) {
      console.error('创建终端失败:', e);
      return { success: false, error: e.message };
    }
  });
  
  // 向终端写入数据
  ipcMain.handle('terminal:write', (_, id, data) => {
    try {
      terminalService.write(id, data);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 调整终端大小
  ipcMain.handle('terminal:resize', (_, id, cols, rows) => {
    try {
      terminalService.resize(id, cols, rows);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 获取终端缓冲化
  ipcMain.handle('terminal:getBuffer', (_, id) => {
    try {
      const buffer = terminalService.getBuffer(id);
      return { success: true, buffer };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 清除终端缓冲化
  ipcMain.handle('terminal:clearBuffer', (_, id) => {
    try {
      terminalService.clearBuffer(id);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 杀死终端
  ipcMain.handle('terminal:kill', (_, id) => {
    try {
      terminalService.kill(id);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 获取终端列表
  ipcMain.handle('terminal:list', () => {
    try {
      const terminals = terminalService.listTerminals();
      return { success: true, terminals };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 执行命令（一次性执行）
  ipcMain.handle('terminal:execute', async (_, command, cwd, timeout, opts) => {
    try {
      const result = await terminalService.executeCommand(command, cwd, timeout, opts);
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ============ Arduino 编译/烧录 ============
  // 自研本体 P0-1：arduino-cli 多路径探测（固定目录 → 用户配置 → PATH/常见安装位置）
  function resolveArduinoCli() {
    const candidates = [
      path.join(app.getPath('appData'), 'codelab-desktop', 'tools', 'arduino-cli', 'arduino-cli.exe'),
      path.join('C:\\Program Files\\Arduino CLI', 'arduino-cli.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Arduino15', 'arduino-cli.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Arduino15', 'arduino-cli.exe')
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
    // 最后尝试 PATH（where.exe）
    try {
      const r = execSync('where.exe arduino-cli', { encoding: 'utf8', timeout: 4000 });
      const first = r.split(/\r?\n/).map(s => s.trim()).find(s => s && fs.existsSync(s));
      if (first) return first;
    } catch (e) {}
    return candidates[0]; // 兜底：返回默认路径（runArduinoCli 内会判不存在）
  }
  const ARDUINO_CLI = resolveArduinoCli();
  // 例renderer run_test 获取真实路径（避免 PATH 缺失导致 'arduino-cli' 裸命令失败）
  ipcMain.handle('toolchain:getArduinoCliPath', () => {
    const p = resolveArduinoCli();
    return { path: p, exists: fs.existsSync(p) };
  });

  // toolchain.status：检测 arduino-cli + 平台 + 库（对齐 TrieCode）
  ipcMain.handle('toolchain:status', async () => {
    const p = resolveArduinoCli();
    const cliExists = fs.existsSync(p);
    let version = '';
    let platforms = [];
    if (cliExists) {
      try {
        const v = await new Promise(r => execFile(p, ['version'], { timeout: 10000 }, (e, so) => r((so || '').trim())));
        version = v;
        const pl = await new Promise(r => execFile(p, ['core', 'list'], { timeout: 10000 }, (e, so) => r(so || '')));
        platforms = pl.split('\n').slice(1).filter(l => l.trim()).map(l => l.split(/\s{2,}/)[0].trim());
      } catch (e) {}
    }
    return {
      ok: cliExists && platforms.length > 0,
      cliPath: p,
      cliExists,
      version,
      platforms,
    error: cliExists ? (platforms.length ? '' : 'no platforms installed') : 'arduino-cli not installed'
    };
  });

  // ============ Coding-Agent CLI 安装/检测（对齐 Ekko Agent Manager：npm 安装真实 CLI）============
  const CLI_AGENTS = [
    { id: 'claude-code', name: 'Claude Code', command: 'claude', packageName: '@anthropic-ai/claude-code', docs: '', manual: false },
    { id: 'codex', name: 'Codex', command: 'codex', packageName: '@openai/codex', docs: '', manual: false },
    { id: 'pi', name: 'Pi', command: 'pi', packageName: '@earendil-works/pi-coding-agent', docs: '', manual: false },
    { id: 'grok', name: 'Grok', command: 'grok', packageName: '@xai-official/grok', docs: '', manual: false },
    { id: 'opencode', name: 'OpenCode', command: 'opencode', packageName: 'opencode-ai', docs: '', manual: false },
    { id: 'dsh', name: 'DeepSeek Harness', command: 'dsh', packageName: '@deepseek-ai/dsh', docs: '', manual: false },
    { id: 'qwen', name: 'Qwen Code', command: 'qwen', packageName: '@qwen-code/qwen-code', docs: '', manual: false },
    { id: 'kimi', name: 'Kimi Code', command: 'kimi', packageName: '@moonshot-ai/kimi-code', docs: '', manual: false },
    { id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code', docs: '', manual: false },
    { id: 'qoder', name: 'Qoder', command: 'qoder', packageName: '@qoder-ai/qodercli', docs: '', manual: false },
    { id: 'copilot', name: 'GitHub Copilot', command: 'copilot', packageName: '@github/copilot', docs: '', manual: false },
    { id: 'cursor', name: 'Cursor', command: 'agent', packageName: '', docs: 'https://cursor.com/install', manual: true },
    { id: 'antigravity', name: 'Antigravity', command: 'agy', packageName: '', docs: 'https://antigravity.google/docs/cli/install', manual: true },
    { id: 'zcode', name: 'ZCode', command: 'zcode', packageName: '', docs: 'https://zcode.z.ai/', manual: true }
  ];
  const agentCliBusy = new Set();
  // 单轮非交互执行参数（对齐各 CLI print/run 模式；不支持的返回明确提示）
  function cliRunArgs(def, prompt) {
    const P = prompt || '';
    switch (def.id) {
      case 'claude-code': return ['-p', P, '--output-format', 'text'];
      case 'codex': return ['exec', P];
      case 'opencode': return ['run', P];
      case 'qwen': return ['-p', P];
      case 'kimi': return ['-p', P];
      case 'grok': return ['-p', P];
      case 'codebuddy': return ['-p', P];
      case 'pi': return ['-p', P];
      case 'dsh': return ['--profile', 'headless', P]; // dsh 单轮执行：--profile headless <task>（-p 是 --profile 简写，会把 prompt 当 profile 名）
      default: return null;
    }
  }
  async function runAgentCli(id, prompt) {
    const def = CLI_AGENTS.find(a => a.id === id);
    if (!def || def.manual) return { success: false, error: '未知或需手动安装的 Agent: ' + id };
    const args = cliRunArgs(def, prompt);
    if (!args) return { success: false, error: '该 CLI 暂不支持单轮执行（' + def.name + '）' };
    const cmdPath = await resolveCommandPath(def.command);
    if (!cmdPath) return { success: false, error: def.command + ' 未安装' };
    try {
      const out = await runCli(cmdPath, args, 5 * 60 * 1000);
      if (out.code === 0 && out.out.trim()) return { success: true, output: out.out.trim(), error: '' };
      if (out.code === 0 && !out.out.trim()) return { success: false, error: 'CLI 无输出（' + (out.err.trim().slice(0, 200) || '可能是交互模式或未登录') + '）' };
      return { success: false, error: (out.err.trim() || out.msg).slice(0, 300) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function npmCmd() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }
  function resolveCommandPath(command) {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, [command], { timeout: 5000 }, (err, stdout) => {
        // where 输出 CRLF；Windows 上优先 .cmd/.bat/.exe（npm bin 第一行常是无扩展名 shell 脚本，无法直接 spawn）
        const lines = err ? [] : String(stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
        const line = lines.find(s => /\.(cmd|bat|exe)$/i.test(s)) || lines[0] || '';
        resolve(line);
      });
    });
  }
  // Windows 上 npm 全局安装的 CLI 是 .cmd 批处理：execFile 无法直跑 .cmd，cmd.exe /c 又被引号/空格截断困扰。
  // 根治：解析 npm 生成的 .cmd，提取其真实 node 入口脚本（node_modules/<pkg>/bin/*.js），用 node 直接执行。
  function resolveNodeScriptFromCmd(cmdPath) {
    try {
      const txt = fs.readFileSync(cmdPath, 'utf8');
      // npm .cmd 执行行形如 "%_prog%"  "%dp0%\node_modules\<pkg>\bin\<bin>" %* —— 匹配 %_prog% 之后的 bin 入口
      // 注意不能匹配前面 SET "_prog=%dp0%\node.exe" 那行（第一个 %dp0% 出现）
      const m = txt.match(/"%_prog%"\s+"%dp0%[\\/]([^"%\s]+)/i);
      if (!m) return '';
      return path.join(path.dirname(cmdPath), m[1].replace(/\\/g, path.sep));
    } catch (e) { return ''; }
  }
  function runCli(cmdPath, args, timeoutMs) {
    return new Promise((resolve) => {
      const opts = { timeout: timeoutMs || 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, env: process.env, windowsHide: true };
      const done = (e, so, se) => resolve({ code: e ? e.code : 0, out: String(so || ''), err: String(se || ''), msg: e ? e.message : '' });
      const lower = String(cmdPath).toLowerCase();
      if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/.test(lower)) {
        const script = resolveNodeScriptFromCmd(cmdPath);
        if (script) {
          const nodeBin = path.join(path.dirname(cmdPath), 'node.exe');
          const nodeCmd = fs.existsSync(nodeBin) ? nodeBin : 'node';
          execFile(nodeCmd, [script, ...args], opts, done);
        } else {
          execFile(process.env.ComSpec || 'cmd.exe', ['/c', cmdPath, ...args], opts, done);
        }
      } else {
        execFile(cmdPath, args, opts, done);
      }
    });
  }
  function extractCliVersion(raw) {
    const m = String(raw || '').match(/\d+\.\d+\.\d+[^\s]*/);
    return m ? m[0] : String(raw || '').trim().slice(0, 40);
  }
  async function detectAgentCli(def) {
    if (def.manual) return { id: def.id, name: def.name, manual: true, docs: def.docs, installed: false, error: '需手动安装（见指南）' };
    try {
      const cmdPath = await resolveCommandPath(def.command);
      if (!cmdPath) return { id: def.id, name: def.name, installed: false, error: '未安装（可用「安装」一键 npm 安装）' };
      const r = await runCli(cmdPath, ['--version'], 8000);
      const raw = (r.out || r.err || '').trim();
      return { id: def.id, name: def.name, installed: true, version: extractCliVersion(raw), path: cmdPath };
    } catch (e) {
      return { id: def.id, name: def.name, installed: false, error: e.message };
    }
  }
  async function mutateAgentCli(action, id) {
    const def = CLI_AGENTS.find(a => a.id === id);
    if (!def) return { success: false, error: '未知 Agent: ' + id };
    if (def.manual || !def.packageName) return { success: false, error: '该 Agent 需手动安装（见安装指南）', docs: def.docs };
    if (agentCliBusy.has(id)) return { success: false, error: '操作已在进行中' };
    agentCliBusy.add(id);
    const send = (percent, message) => { try { mainWindow.webContents.send('codingAgents:progress', { id, percent, message }); } catch (e) {} };
    try {
      send(3, 'npm ' + action + ' ' + def.packageName + ' …');
      const args = action === 'install' ? ['install', '-g', def.packageName]
        : action === 'update' ? ['update', '-g', def.packageName]
        : ['uninstall', '-g', def.packageName];
      const result = await new Promise((resolve) => {
        let out = '';
        const proc = spawn(npmCmd(), args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (d) => { const s = String(d || '').trim(); if (s) { out += s + '\n'; send(Math.min(85, 5 + out.length / 8), s.slice(0, 120)); } };
        proc.stdout.on('data', onData); proc.stderr.on('data', onData);
        const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ ok: false, error: '超时（10 分钟）', out }); }, 10 * 60 * 1000);
        proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, out }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
      });
      send(95, result.ok ? (action === 'install' ? '安装完成' : action === 'update' ? '更新完成' : '已卸载') : '失败');
      if (!result.ok) send(100, String(result.error || result.out).slice(-200));
      return { success: result.ok, error: result.ok ? '' : (result.error || String(result.out).slice(-300)), out: String(result.out).slice(-400) };
    } catch (e) {
      send(100, '失败：' + e.message);
      return { success: false, error: e.message };
    } finally {
      agentCliBusy.delete(id);
    }
  }

  ipcMain.handle('codingAgents:list', async () => ({ success: true, agents: await Promise.all(CLI_AGENTS.map(detectAgentCli)) }));
  ipcMain.handle('codingAgents:detect', async (_, opts) => {
    const def = CLI_AGENTS.find(a => a.id === (opts && opts.id));
    return def ? await detectAgentCli(def) : { id: (opts && opts.id), installed: false, error: 'unknown' };
  });
  ipcMain.handle('codingAgents:install', (_, opts) => mutateAgentCli('install', opts && opts.id));
  ipcMain.handle('codingAgents:update', (_, opts) => mutateAgentCli('update', opts && opts.id));
  ipcMain.handle('codingAgents:remove', (_, opts) => mutateAgentCli('remove', opts && opts.id));
  ipcMain.handle('codingAgents:run', (_, opts) => runAgentCli(opts && opts.id, opts && opts.prompt));

  // ============ ESP32 工具链自动安装（商业化：首次启动自动下载） ============
  const ESP32_ADDITIONAL_URLS = [
    'https://jihulab.com/esp32-arduino/esp32/-/raw/gh-pages/package_esp32_index.json',
    'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
  ].join(',');

  function isEsp32Installed() {
    try {
      const hwDir = path.join(ARDUINO_DATA_DIR, 'packages', 'esp32', 'hardware', 'esp32');
      if (!fs.existsSync(hwDir)) return false;
      return fs.readdirSync(hwDir).some(v => /^\d+\.\d+\.\d+/.test(v));
    } catch (e) { return false; }
  }

  function sendToolchainProgress(stage, percent, message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toolchain:progress', { stage, percent, message });
    }
  }

  async function ensureEsp32Toolchain() {
    if (isEsp32Installed()) {
      console.log('✅ ESP32 平台已安装，跳过自动下载');
      sendToolchainProgress('done', 100, 'ESP32 工具链已就绪');
      return { installed: true, skipped: true };
    }
    if (!fs.existsSync(ARDUINO_CLI)) {
      const msg = 'arduino-cli 未找到，无法自动安装 ESP32 工具链';
      console.error('❌', msg);
      sendToolchainProgress('error', 0, msg);
      return { installed: false, error: msg };
    }
    console.log('📦 开始自动安装 ESP32 工具链（约 1.5GB，请耐心等待）...');
    sendToolchainProgress('installing', 0, '正在准备 ESP32 工具链，首次需要下载约 1.5GB...');

    return new Promise((resolve) => {
      const args = ['core', 'install', 'esp32:esp32@3.3.11', '--additional-urls', ESP32_ADDITIONAL_URLS, '--no-color'];
      const child = spawn(ARDUINO_CLI, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stderrBuf = '';
      let lastProgress = 0;

      child.stderr.on('data', (data) => {
        const text = data.toString();
        stderrBuf += text;
        // arduino-cli 进度格式："Downloading packages: [===>    ] 45% ..."
        // 或 "Downloading esp32:esp32@3.3.11: 12%"
        const m = text.match(/(\d+)%/);
        if (m) {
          const pct = parseInt(m[1], 10);
          if (pct > lastProgress) {
            lastProgress = pct;
            // 下载阶段 0-90%，安装阶段 90-100%
            const mapped = Math.min(90, pct);
            sendToolchainProgress('downloading', mapped, `正在下载 ESP32 工具链... ${mapped}%`);
          }
        }
        // 识别关键阶段
        if (/Installing platform/.test(text)) sendToolchainProgress('installing', 92, '正在安装 ESP32 平台...');
        if (/Installing tool esp32-arduino-libs/.test(text)) sendToolchainProgress('installing', 95, '正在安装 ESP32 库文件...');
        if (/Configuring esp32:esp32/.test(text)) sendToolchainProgress('installing', 98, '正在配置...');
      });
      child.stdout.on('data', (data) => { stderrBuf += data.toString(); });

      child.on('close', (code) => {
        if (code === 0 && isEsp32Installed()) {
          console.log('✅ ESP32 工具链安装完成');
          sendToolchainProgress('done', 100, 'ESP32 工具链安装完成');
          resolve({ installed: true, skipped: false });
        } else {
          const tail = stderrBuf.split('\n').slice(-10).join('\n');
          const msg = `ESP32 工具链安装失败（退出码 ${code}）: ${tail.slice(-500)}`;
          console.error('❌', msg);
          sendToolchainProgress('error', 0, '安装失败，请检查网络后重试');
          resolve({ installed: false, error: msg });
        }
      });
      child.on('error', (err) => {
        const msg = '启动 arduino-cli 失败: ' + err.message;
        console.error('❌', msg);
        sendToolchainProgress('error', 0, msg);
        resolve({ installed: false, error: msg });
      });
    });
  }

  // IPC：手动触发工具链安装（前端"重试"按钮）
  ipcMain.handle('toolchain:ensure', async () => {
    return await ensureEsp32Toolchain();
  });

  // ============ arduino-cli 本体一键安装（跨平台）============
  // 检测未安装时下载官方二进制到应用数据目录；已有则跳过。进度经 toolchain:progress 推送。
  ipcMain.handle('toolchain:installCli', async () => {
    const p = resolveArduinoCli();
    if (fs.existsSync(p)) return { ok: true, path: p, message: 'arduino-cli 已存在' };
    const send = (data) => { try { mainWindow.webContents.send('toolchain:progress', { stage: 'cli', ...data }); } catch (e) {} };
    try {
      const os = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : (process.arch === 'x64' ? '64bit' : '32bit');
      const ver = '1.1.1';
      let url;
      if (os === 'win32') url = 'https://downloads.arduino.cc/arduino-cli/arduino-cli_' + ver + '_Windows_64bit.zip';
      else if (os === 'darwin') url = 'https://downloads.arduino.cc/arduino-cli/arduino-cli_' + ver + '_macOS_' + (process.arch === 'arm64' ? 'ARM64' : '64bit') + '.tar.gz';
      else url = 'https://downloads.arduino.cc/arduino-cli/arduino-cli_' + ver + '_Linux_' + arch + '.tar.gz';
      send({ message: '开始下载 arduino-cli ' + ver + ' …', progress: 5 });
      const dlDir = path.join(app.getPath('appData'), 'codelab-desktop', 'tools', 'arduino-cli');
      fs.mkdirSync(dlDir, { recursive: true });
      const tmp = path.join(dlDir, 'dl-' + Date.now());
      const resp = await new Promise((resolve, reject) => {
        const req = require('https').get(url, res => {
          if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
          resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error('下载超时')); });
      });
      const total = parseInt(resp.headers['content-length'] || '0', 10);
      let got = 0;
      const ws = fs.createWriteStream(tmp);
      resp.pipe(ws);
      resp.on('data', chunk => { got += chunk.length; if (total) send({ progress: 10 + Math.round(80 * got / total) }); });
      await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
      send({ progress: 92, message: '解压安装…' });
      // 解压：zip 用 unzip，tar.gz 用 tar
      const exeName = os === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
      const outDir = dlDir;
      if (os === 'win32') {
        await new Promise((resolve, reject) => {
          const cp = require('child_process').spawn('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Path "' + tmp + '" -DestinationPath "' + outDir + '" -Force']);
          cp.on('close', resolve); cp.on('error', reject);
        });
      } else {
        await new Promise((resolve, reject) => {
          const cp = require('child_process').spawn('tar', ['-xzf', tmp, '-C', outDir]);
          cp.on('close', resolve); cp.on('error', reject);
        });
      }
      // 清理下载临时文件
      try { fs.unlinkSync(tmp); } catch (e) {}
      const installed = path.join(outDir, exeName);
      send({ progress: 100, message: '安装完成', path: installed });
      return { ok: fs.existsSync(installed), path: installed, message: 'arduino-cli 安装' + (fs.existsSync(installed) ? '完成' : '失败') };
    } catch (e) {
      send({ message: '安装失败：' + e.message });
      return { ok: false, error: e.message };
    }
  });

  // Windows: arduino-cli / CMake / python subprocesses fail silently on
  // non-ASCII project paths (e.g. a Chinese project folder name) because the
  // spawned tools resolve scripts/paths with the system codepage. Map such a
  // cwd to an ASCII directory junction (mklink /J, no admin needed) so the
  // child runs from an ASCII path while all writes land in the real project
  // directory. The junction is keyed by a hash of the real path and reused.
  function asciiCwd(realCwd) {
    if (!realCwd || process.platform !== 'win32') return { cwd: realCwd, link: null };
    if (/^[\x00-\x7F]*$/.test(realCwd)) return { cwd: realCwd, link: null };
    try {
      const key = require('crypto').createHash('md5').update(realCwd).digest('hex').slice(0, 12);
      const link = path.join(os.tmpdir(), 'labcode-ac-' + key);
      if (!fs.existsSync(link)) {
        try { fs.symlinkSync(realCwd, link, 'junction'); } catch (e) { return { cwd: realCwd, link: null }; }
      }
      return { cwd: link, link };
    } catch (e) { return { cwd: realCwd, link: null }; }
  }

  function runArduinoCli(args, cwd) {
    return new Promise((resolve) => {
      if (!fs.existsSync(ARDUINO_CLI)) {
        resolve({ success: false, error: 'arduino-cli 未找到，请先安装 Arduino 编译插件', code: -1 });
        return;
      }
      const ac = asciiCwd(cwd || process.cwd());
      const child = execFile(ARDUINO_CLI, args, { cwd: ac.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        resolve({ success: !err, error: err ? err.message : '', output, code: err ? (err.code || 1) : 0 });
      });
    });
  }

  /**
   * Arduino sketch 目录规范化：
   * arduino-cli 要求 .ino 文件名必须与所在目录同名（如 esp32_robot/esp32_robot.ino）
   * 若用户的 .ino 位于不同名目录（如 PlatformIO 风格 src/esp32_robot.ino），
   * 自动创建临时同名目录并复到sketch 源文件，编译完成后清理　
   * @returns {{ target: string, cleanup: string|null, created: boolean }}
   */
  function normalizeSketchDir(sketchPath) {
    if (!sketchPath || !/\.ino$/i.test(sketchPath)) {
      return { target: sketchPath, cleanup: null, created: false };
    }
    const dir = path.dirname(sketchPath);
    const base = path.basename(sketchPath, path.extname(sketchPath));
    if (path.basename(dir) === base) {
      return { target: dir, cleanup: null, created: false };
    }
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labcode-sketch-'));
    const target = path.join(tmpRoot, base);
    fs.mkdirSync(target, { recursive: true });
    let copied = 0;
    for (const f of fs.readdirSync(dir)) {
      const src = path.join(dir, f);
      const dst = path.join(target, f);
      try {
        if (fs.statSync(src).isFile()) { fs.copyFileSync(src, dst); copied++; }
      } catch (e) { /* 跳过不可复制项*/ }
    }
    return { target, cleanup: tmpRoot, created: copied > 0 };
  }

  ipcMain.handle('compile:arduino', async (_, options) => {
    const { sketchPath, fqbn, outputDir } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    // 2026-10-17：fqbn 缺失时用 Board.guessFQBN 兜底（无需先 select_board）
    let effectiveFqbn = fqbn;
    if (!effectiveFqbn) {
      effectiveFqbn = Board.guessFQBN(sketchPath);
      if (effectiveFqbn) console.log('📌 已按 sketch 推断 FQBN:', effectiveFqbn);
    }
    if (!effectiveFqbn) return { success: false, error: '缺少 fqbn（开发板型号）' };
    const norm = normalizeSketchDir(sketchPath);
    const args = ['compile', '--fqbn', effectiveFqbn];
    if (outputDir) args.push('--output-dir', outputDir);
    args.push(norm.target);
    const result = await runArduinoCli(args, path.dirname(norm.target));
    if (norm.cleanup) { try { fs.rmSync(norm.cleanup, { recursive: true, force: true }); } catch (e) {} }
    return result;
  });

  ipcMain.handle('compile:upload', async (_, options) => {
    const { sketchPath, fqbn, port } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    // 2026-10-17：fqbn 缺失时用 Board.guessFQBN 兜底
    let effectiveFqbn = fqbn;
    if (!effectiveFqbn) {
      effectiveFqbn = Board.guessFQBN(sketchPath);
      if (effectiveFqbn) console.log('📌 已按 sketch 推断 FQBN:', effectiveFqbn);
    }
    if (!effectiveFqbn) return { success: false, error: '缺少 fqbn' };
    if (!port) return { success: false, error: '缺少端口（port）' };
    const norm = normalizeSketchDir(sketchPath);
    const args = ['upload', '--fqbn', effectiveFqbn, '--port', port, norm.target];
    const result = await runArduinoCli(args, path.dirname(norm.target));
    if (norm.cleanup) { try { fs.rmSync(norm.cleanup, { recursive: true, force: true }); } catch (e) {} }
    return result;
  });

  ipcMain.handle('compile:list-cores', async () => {
    return await runArduinoCli(['core', 'list']);
  });

  ipcMain.handle('compile:list-boards', async () => {
    return await runArduinoCli(['board', 'listall']);
  });

  ipcMain.handle('compile:list-ports', async () => {
    return await runArduinoCli(['board', 'list']);
  });

  ipcMain.handle('compile:cli-exists', async () => {
    return { exists: fs.existsSync(ARDUINO_CLI), path: ARDUINO_CLI };
  });

  // ============ 串口监视噸============
  let serialMonitorProc = null;   // 当前打开的串口监视进程
  let serialMonitorPort = null;
  let serialMonitorBaud = 115200;

  ipcMain.handle('serial:list', async () => {
    // 用arduino-cli board list 获取串口
    if (!fs.existsSync(ARDUINO_CLI)) return { success: true, ports: [] };
    return await new Promise((resolve) => {
      execFile(ARDUINO_CLI, ['board', 'list'], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        const ports = [];
        if (!err && stdout) {
          // 解析输出行：Port  Protocol Type  Board Name  FQBN  Core
          const lines = stdout.split('\n').slice(1);
          for (const line of lines) {
            const m = line.match(/(COM\d+)/);
            if (m) {
              const boardMatch = line.match(/^\S+\s+\S+\s+\S+\s+(.+?)\s{2,}/);
              ports.push({ port: m[1], board: boardMatch ? boardMatch[1].trim() : '未知设备' });
            }
          }
        }
        resolve({ success: true, ports });
      });
    });
  });

  ipcMain.handle('serial:open', async (_, options) => {
    const { port, baud } = options || {};
    if (!port) return { success: false, error: '缺少串口' };
    if (!fs.existsSync(ARDUINO_CLI)) return { success: false, error: 'arduino-cli not installed' };
    // 关闭旧串发
    if (serialMonitorProc) {
      try { serialMonitorProc.kill(); } catch (e) {}
      serialMonitorProc = null;
    }
    serialMonitorPort = port;
    serialMonitorBaud = baud || 115200;
    try {
      serialMonitorProc = spawn(ARDUINO_CLI, ['monitor', '-p', port, '-c', 'baudrate=' + serialMonitorBaud], {
        windowsHide: true
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
    // 输出转发
    serialMonitorProc.stdout.on('data', (data) => {
      const text = data.toString('utf8');
      // 写入后台日志缓冲
      text.split(/\r?\n/).forEach(line => {
        if (line.trim()) {
          serialLogBuffer.push({ ts: Date.now(), line });
          if (serialLogBuffer.length > MAX_LOG_LINES) serialLogBuffer.shift();
        }
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:data', text);
      }
    });
    serialMonitorProc.stderr.on('data', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:data', data.toString('utf8'));
      }
    });
    serialMonitorProc.on('close', (code) => {
      serialMonitorProc = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:closed', { code });
      }
    });
    // 等待 800ms 看是否启动失败
    await new Promise(r => setTimeout(r, 800));
    if (serialMonitorProc && serialMonitorProc.killed) {
      return { success: false, error: '串口打开失败' };
    }
    return { success: true, port, baud: serialMonitorBaud };
  });

  ipcMain.handle('serial:close', async () => {
    if (serialMonitorProc) {
      try { serialMonitorProc.kill(); } catch (e) {}
      serialMonitorProc = null;
    }
    return { success: true };
  });

  ipcMain.handle('serial:write', async (_, data) => {
    if (!serialMonitorProc) return { success: false, error: '串口未打开' };
    try {
      serialMonitorProc.stdin.write(data + '\n');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ===== 后台串口日志缓冲（对齐 TrieCode serialLog）=====
  const serialLogBuffer = []; // [{ts, line}]
  const MAX_LOG_LINES = 5000;
  // 抽serial:data 的输出同时写入缓决
  // （在 serialMonitorProc.stdout.on 失 push，
  ipcMain.handle('serial:log-tail', async (_, opts) => {
    const n = Math.min((opts && opts.line) || 50, 500);
    return { success: true, lines: serialLogBuffer.slice(-n).map(e => e.line) };
  });
  ipcMain.handle('serial:log-grep', async (_, opts) => {
    if (!opts || !opts.pattern) return { success: false, error: '缺 pattern' };
    const re = new RegExp(opts.pattern, 'i');
    const max = Math.min((opts.max) || 30, 200);
    const hits = serialLogBuffer.filter(e => re.test(e.line)).slice(-max).map(e => e.line);
    return { success: true, lines: hits };
  });
  ipcMain.handle('serial:log-analyze-crash', async () => {
    const patterns = [
      /Guru Meditation|Backtrace:/, /HardFault/, /panic\s*\(/.source, /assertion failed/,
      /segfault|stack overflow|watchdog|out of memory|heap corruption/, /abort\(\)/
    ];
    const matches = serialLogBuffer.filter(e => patterns.some(p => p instanceof RegExp ? p.test(e.line) : new RegExp(p).test(e.line)));
    if (!matches.length) return { success: true, diagnosis: '未检测到崩溃签名' };
    return { success: true, lines: matches.map(m => m.line), diagnosis: '检测到 ' + matches.length + ' 行崩溃相关日志' };
  });

  // 外部链接
  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

  // ============ Web 搜索/抓取（真实联网，渲染端 WebTools 优先走这里）============
  // 模块：main/web-search.js（Bing HTML 端点，无 API Key；SSRF 防护 + 15min 缓存 + 会话上限）
  const webSearch = require('./web-search');
  ipcMain.handle('web:search', async (_, query, options = {}) => {
    try {
      const result = await webSearch.search(query, options);
      if (!result.success) {
        // 明确失败信息（含反爬提示），渲染端据此决定降级并标注
        return result;
      }
      return result;
    } catch (e) {
      return { success: false, error: `搜索模块异常: ${e.message}` };
    }
  });
  ipcMain.handle('web:fetch', async (_, url, options = {}) => {
    try {
      return await webSearch.fetchPage(url, options);
    } catch (e) {
      return { success: false, error: `抓取模块异常: ${e.message}` };
    }
  });
  ipcMain.handle('web:stats', () => webSearch.getStats());
  ipcMain.handle('web:clear-cache', () => webSearch.clearCache());


  // ============ Hermes 借鉴：FTS5 记忆搜索 + 并行子代理 + Webhook + SSH ============

  // ---- 1. FTS5 记忆全文搜索（简化版：倒排索引）----
  const MEMORY_DIR = path.join(USER_DATA_PATH, 'memory');
  ipcMain.handle('memory:search', (_, query) => {
    try {
      const f = path.join(MEMORY_DIR, 'memories.json');
      if (!fs.existsSync(f)) return { results: [] };
      const memories = JSON.parse(fs.readFileSync(f, 'utf8'));
      const q = query.toLowerCase();
      const results = memories.filter(m => {
        const text = (m.name + ' ' + m.content).toLowerCase();
        return text.includes(q);
      }).slice(0, 10);
      return { results };
    } catch (e) { return { results: [], error: e.message }; }
  });

  // ---- 2. Webhook 服务器（多平台消息接入）----
  let webhookServer = null;
  ipcMain.handle('webhook:start', (_, port) => {
    if (webhookServer) { try { webhookServer.close(); } catch (e) {} }
    const http = require('http');
    webhookServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            mainWindow.webContents.send('webhook:message', data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400); res.end('bad request');
          }
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'LabCode', status: 'running' }));
      }
    });
    webhookServer.listen(port || 9876, '127.0.0.1', () => {
      console.log('[webhook] listening on http://127.0.0.1:' + (port || 9876));
    });
    webhookServer.on('error', (e) => console.error('[webhook] error', e.message));
    return { success: true, port: port || 9876 };
  });
  ipcMain.handle('webhook:stop', () => {
    if (webhookServer) { try { webhookServer.close(); } catch (e) {} webhookServer = null; }
    return { success: true };
  });

  // ---- 3. SSH 远程执行 ----
  ipcMain.handle('ssh:exec', async (_, { host, port, username, password, command }) => {
    // 简单实现：用 sshpass 或 plink（Windows）
    // 先检查有没有 ssh 命令
    const { execFile: sshExec } = require('child_process');
    return new Promise((resolve) => {
      const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        username + '@' + host, command];
      // Windows 下用 ssh.exe（OpenSSH 客户端自带）
      sshExec('ssh', args, { timeout: 30000, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) resolve({ success: false, error: stderr || err.message });
        else resolve({ success: true, output: stdout });
      });
    });
  });

  // ============ Ollama 管理（本地模型一键安装）============
  const { execFile: ollExec } = require('child_process');
  function ollamaCheck() {
    return new Promise((resolve) => {
      ollExec('ollama', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ installed: false });
        resolve({ installed: true, version: (stdout || '').trim() });
      });
    });
  }
  ipcMain.handle('ollama:status', async () => {
    const status = await ollamaCheck();
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const data = await r.json();
        return { ...status, running: true, models: (data.models || []).map(m => m.name) };
      }
    } catch (e) {}
    return { ...status, running: false, models: [] };
  });
  ipcMain.handle('ollama:pull', (_, model) => {
    return new Promise((resolve) => {
      ollExec('ollama', ['pull', model], { timeout: 600000, maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
        if (err) return resolve({ success: false, error: stderr || err.message });
        resolve({ success: true, output: (stdout || '').slice(-500) });
      });
    });
  });
  ipcMain.handle('ollama:startServer', () => {
    return new Promise((resolve) => {
      const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      p.unref();
      setTimeout(() => resolve({ success: true }), 2000);
    });
  });
  ipcMain.handle('ollama:openDownload', () => {
    shell.openExternal('https://ollama.com/download/windows');
    return { success: true };
  });

  // 应用信息
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getPath', (_, name) => app.getPath(name));
  ipcMain.handle('app:getPlatform', () => process.platform);

  // ============ 系统配置检测（大模型推荐用）============
  ipcMain.handle('system:getInfo', async () => {
    const cpus = os.cpus();
    const cpuModel = cpus[0] ? cpus[0].model : 'Unknown';
    const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
    const freeMemGB = Math.round(os.freemem() / 1024 / 1024 / 1024);

    // 磁盘可用空间（用 PowerShell Get-PSDrive，比 wmic 可靠）
    let diskFreeGB = 0;
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        const out = execSync('powershell -NoProfile -Command "(Get-PSDrive C).Free"', { encoding: 'utf8', timeout: 5000 });
        const free = parseInt(out.trim());
        if (!isNaN(free)) diskFreeGB = Math.round(free / 1024 / 1024 / 1024);
      }
    } catch (e) { console.error('磁盘检测失败', e.message); }

    // GPU 检测（快速方式：读注册表或环境变量，避免慢的 CIM 查询）
    let gpus = [];
    let hasNvidia = false;
    let maxVramGB = 0;
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        // 用 nvidia-smi 检查 NVIDIA GPU（更快更准确）
        try {
          const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { encoding: 'utf8', timeout: 5000 });
          const lines = out.trim().split('\n').filter(l => l.trim());
          lines.forEach(line => {
            const parts = line.split(',').map(s => s.trim());
            const name = parts[0] || 'NVIDIA GPU';
            const vram = parseInt(parts[1]) || 0;
            gpus.push({ name, vramGB: Math.round(vram / 1024), driver: 'nvidia' });
            hasNvidia = true;
            maxVramGB = Math.max(maxVramGB, Math.round(vram / 1024));
          });
        } catch (e) { /* 忽略 NVIDIA GPU 检测失败 */ }
        // 如果没有 NVIDIA，用 PowerShell 快速检测其硬件 GPU
        if (gpus.length === 0) {
          try {
            const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', { encoding: 'utf8', timeout: 5000 });
            const names = out.trim().split('\n').filter(n => n.trim());
            names.forEach(name => {
              gpus.push({ name: name.trim(), vramGB: 0, driver: 'unknown' });
            });
          } catch (e) { /* GPU 检测失败*/ }
        }
      }
    } catch (e) { console.error('GPU 检测失败', e.message); }

    return {
      cpu: { model: cpuModel, cores: cpus.length },
      memory: { totalGB: totalMemGB, freeGB: freeMemGB },
      disk: { freeGB: diskFreeGB },
      gpus,
      hasNvidia,
      maxVramGB,
      platform: process.platform,
      arch: process.arch
    };
  });

  // ============ 本地大模型引擎（llama.cpp，内置，无需 Ollama）===========
  // 引擎目录：resources/llama（安装包内置）；模型目录：D:\LabCode\models（插件市场下载）
  function getEngineDir() {
    // 开发模式：D:\LabCode\runtime\llama-cpp-*；打包后：resources/llama
    const candidates = [
      path.join(process.resourcesPath, 'llama'),           // 打包后内置
      path.join(__dirname, '..', 'resources', 'llama'),    // 开发目录
      'D:\\LabCode\\runtime\\llama-cpp-vulkan',            // 本机验证目录
      'D:\\LabCode\\runtime\\llama-cpp-cpu'
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(path.join(c, 'llama-server.exe'))) return c; } catch (e) {}
    }
    return '';
  }

  // ===== 模型目录：跨平台探测可用卷 + 介质类型，自动给出推荐位置 =====
  // 商业化要求：不假设盘符、不假设平台、不让用户敲命令。
  // 冷启动慢的根因是「模型放在机械盘上」（实测 HDD 冷读 110MB/s → 4.4GB 要 40s，
  // SSD 约 3s），所以模型**下载时**就该落在 SSD 上，而不是事后让用户自己搬。
  let recommendedModelsDir = '';   // 启动时异步探测填充
  async function probeVolumes() {
    const vols = [];
    if (process.platform === 'win32') {
      try {
        const { execFile } = require('child_process');
        const ps = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { ' +
          '$letter=$_.DeviceID.TrimEnd(":"); $free=[math]::Round($_.FreeSpace/1GB,1); $size=[math]::Round($_.Size/1GB,1); ' +
          '$media="unknown"; ' +
          '$p = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue; ' +
          'if ($p) { $d = Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue; ' +
          '  if ($d) { $media = (Get-PhysicalDisk | Where-Object { $_.FriendlyName -eq $d.FriendlyName } | Select-Object -First 1).MediaType } } ' +
          '[PSCustomObject]@{ letter=$letter; freeGB=$free; sizeGB=$size; media=$media } } | ConvertTo-Json -Compress';
        const out = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) console.error('[LLM引擎] 卷探测失败:', err.message, String(stderr || '').slice(0, 200));
              resolve(String(stdout || ''));
            });
        });
        const t = out.trim();
        const parsed = t ? JSON.parse(t) : [];
        for (const v of (Array.isArray(parsed) ? parsed : [parsed])) {
          if (!v || !v.letter) continue;
          vols.push({
            path: v.letter + ':\\',
            label: v.letter + ':',
            freeGB: Number(v.freeGB) || 0,
            sizeGB: Number(v.sizeGB) || 0,
            disk: /HDD/i.test(v.media) ? 'hdd' : (/SSD/i.test(v.media) ? 'ssd' : 'unknown'),
            system: String(v.letter).toUpperCase() === String(process.env.SystemDrive || 'C:').toUpperCase().replace(':', '')
          });
        }
      } catch (e) { console.error('[LLM引擎] 卷探测异常:', e.message); }
    } else {
      // 类 Unix：df 拿剩余空间；介质类型未知（不猜，交给 free space 排序）
      try {
        const { execFile } = require('child_process');
        const out = await new Promise((resolve) => {
          execFile('df', ['-k'], { timeout: 10000 }, (err, stdout) => resolve(String(stdout || '')));
        });
        for (const ln of out.split('\n').slice(1)) {
          const p = ln.trim().split(/\s+/);
          if (p.length < 6) continue;
          const mount = p[5];
          if (!mount.startsWith('/')) continue;
          vols.push({
            path: mount, label: mount,
            freeGB: Number(p[3]) / 1024 / 1024, sizeGB: 0,
            disk: 'unknown', system: mount === '/'
          });
        }
      } catch (e) {}
    }
    return vols;
  }

  // 推荐模型目录：优先 SSD（机械盘冷读模型要 40s+），其次剩余空间大；
  // 系统盘空间紧张时优先非系统盘。模型单个 2~6GB，至少留 10GB 余量。
  function pickRecommendedDir(volumes) {
    const cands = (volumes || []).filter(v => v.freeGB >= 10);
    if (!cands.length) return '';
    const ssd = cands.filter(v => v.disk === 'ssd');
    const pool = ssd.length ? ssd : cands;
    const nonSys = pool.filter(v => !v.system);
    const finalPool = (nonSys.length && nonSys.some(v => v.freeGB >= 15)) ? nonSys : pool;
    finalPool.sort((a, b) => b.freeGB - a.freeGB);
    // 卷根下的应用子目录（不往卷根里散落文件）
    const root = String(finalPool[0].path || '').replace(/[\\/]+$/, '');
    if (!root) return '';
    return path.join(root, 'LabCode', 'models');
  }

  function getModelsDir() {
    // ① 用户显式配置（设置里改过，或一键迁移后写入）
    try {
      const custom = config && config.ai && config.ai.modelsDir;
      if (typeof custom === 'string' && custom.trim()) {
        const p = custom.trim();
        try { if (fs.existsSync(p)) return p; } catch (e) {}
      }
    } catch (e) {}
    // ② 旧默认路径：用户已有模型在这里要保持兼容（别让人的模型"消失"）
    const legacy = 'D:\\LabCode\\models';
    try {
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).some(f => f.toLowerCase().endsWith('.gguf'))) return legacy;
    } catch (e) {}
    // ③ 自动推荐（SSD + 空间够）—— 新用户零操作就落在对的地方
    if (recommendedModelsDir) return recommendedModelsDir;
    // ④ 兜底：用户主目录下的应用目录（任何平台、几乎总能写）。
    //    不能直接用 D:\LabCode\models —— 别人的机器可能根本没有 D 盘，
    //    那样模型会下载失败（商业化必须假设各种机器都有各种盘）。
    try {
      const os = require('os');
      return path.join(os.homedir(), 'LabCode', 'models');
    } catch (e) {}
    return legacy;
  }

  // 该目录里是否已有模型文件
  function dirHasModels(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return false;
      return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.gguf'));
    } catch (e) { return false; }
  }

  // 探测目录所在磁盘类型（机械盘 hdd / 固态 ssd）。
  // 机械盘冷读 4~6GB 模型要 30~60s（实测 110MB/s），SSD 只要 3s → 用来给用户提示。
  // 注意：必须异步（execFile）——同步 execSync 会阻塞主进程，把 IPC 通道拖死。
  const _diskKindCache = new Map();
  const _diskKindPending = new Set();
  function probeDiskKind(dirPath) {
    let root, letter;
    try {
      root = path.parse(path.resolve(dirPath)).root.toUpperCase();
      letter = root[0];
    } catch (e) { return 'unknown'; }
    if (_diskKindCache.has(root)) return _diskKindCache.get(root);
    if (_diskKindPending.has(letter)) return 'unknown';
    _diskKindPending.add(letter);
    try {
      const { execFile } = require('child_process');
      // Get-Disk 不带 MediaType（那是 PhysicalDisk 的属性），要再取一次
      const script = '$d = Get-Partition -DriveLetter ' + letter + ' | Get-Disk; ' +
        'if ($d) { (Get-PhysicalDisk | Where-Object { $_.FriendlyName -eq $d.FriendlyName } | ' +
        'Select-Object -First 1).MediaType }';
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, windowsHide: true },
        (err, stdout) => {
          _diskKindPending.delete(letter);
          const t = String(stdout || '').trim();
          let kind = 'unknown';
          if (/HDD/i.test(t)) kind = 'hdd';
          else if (/SSD/i.test(t)) kind = 'ssd';
          else if (t) kind = t.toLowerCase();
          _diskKindCache.set(root, kind);
          console.log('[LLM引擎] 模型目录所在磁盘 ' + letter + ' → ' + kind);
        });
    } catch (e) { _diskKindPending.delete(letter); }
    return 'unknown';
  }

  function scanLocalModels() {
    const dir = getModelsDir();
    const models = [];
    // 友好显示名映射（对扫描到的 GGUF 文件名做可读化）
    const friendlyName = (f) => {
      const base = f.replace(/\.gguf$/i, '');
      const lower = base.toLowerCase();
      if (lower.includes('qwen3.5') || lower.includes('qwen-3.5')) return 'Qwen3.5-9B (Q4_K_M)';
      if (lower.includes('qwen2.5-coder-14b')) return 'Qwen2.5-Coder 14B';
      if (lower.includes('qwen2.5-coder-7b')) return 'Qwen2.5-Coder 7B';
      if (lower.includes('qwen2.5-coder-3b')) return 'Qwen2.5-Coder 3B';
      if (lower.includes('qwen2.5-coder-1.5b')) return 'Qwen2.5-Coder 1.5B';
      // generic fallback: qwen2.5-coder-3b-instruct-q4_k_m -> Qwen2.5 Coder 3B
      const generic = base
        .replace(/[-_]instruct.*$/i, '')
        .replace(/[-_]q4_k_m$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace(/(\d)\s*b\b/gi, '$1B')
        .replace(/\s+/g, ' ')
        .trim();
      return generic || base;
    };
    try {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(f => {
          if (f.toLowerCase().endsWith('.gguf')) {
            const full = path.join(dir, f);
            const stat = fs.statSync(full);
            models.push({ file: f, name: friendlyName(f), sizeGB: (stat.size / 1024 / 1024 / 1024) });
          }
        });
      }
    } catch (e) { console.error('扫描本地模型失败:', e.message); }
    return models;
  }

  // 检查 llama 引擎是否运行（8080 OpenAI 兼容端点）
  async function isEngineRunning() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await net.fetch('http://127.0.0.1:8080/health', { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch (e) { return false; }
  }

  // 获取当前引擎加载的模型名（/props 的 model_alias）
  async function getEngineRunningModel() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await net.fetch('http://127.0.0.1:8080/props', { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return '';
      const data = await res.json().catch(() => ({}));
      const alias = (data && data.model_alias) || '';
      if (alias) return alias.split(/[\\/]/).pop();
      return '';
    } catch (e) { return ''; }
  }

  // llama-server 会忽略请求里的 model 字段：它永远用「已加载的那个模型」应答。
  // 因此若配置/工作流切了模型而引擎还在跑旧模型，用户会「以为在用 A、实际在用 B」，
  // 且完全没有提示。这里用 /v1/models（返回引擎实际加载的模型全路径）核对。
  async function getEngineLoadedModel() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await net.fetch('http://127.0.0.1:8080/v1/models', { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        const list = Array.isArray(d.models) ? d.models : (Array.isArray(d.data) ? d.data : []);
        if (list.length) {
          const m = list[0].model || list[0].name || list[0].id || '';
          if (m) return String(m).split(/[\\/]/).pop();
        }
      }
    } catch (e) { /* 引擎没起或端点不可用 */ }
    return await getEngineRunningModel();
  }

  // 确保引擎加载的正是目标模型；不一致就把引擎切过去（startEngineInternal 内部会 kill 旧进程重载）。
  // 引擎未运行时不处理：交给既有的「自动启动/自动恢复」流程。
  async function ensureEngineServesModel(modelFile) {
    if (!modelFile) return { ok: true };
    const want = String(modelFile);
    const running = await getEngineLoadedModel();
    if (!running) return { ok: true };
    if (running.toLowerCase() === want.toLowerCase()) return { ok: true };
    console.log(`[LLM引擎] 引擎当前加载 ${running}，与目标 ${want} 不一致 → 切换模型`);
    const r = await startEngineInternal(want);
    if (!r || !r.success) return { ok: false, error: (r && r.error) || '切换本地模型失败' };
    return { ok: true };
  }

  // 检测本地大模型运行时（LabCode 内置 llama 引擎）
  let currentEngineModel = null;
  ipcMain.handle('system:checkLLMRuntime', async () => {
    const result = {
      engine: false, engineVersion: null, engineRunning: false, models: [], engineDir: '', runningModel: '',
      modelsDir: '', modelsDirDisk: 'unknown', modelsOnHdd: false
    };
    try {
      const engineDir = getEngineDir();
      if (engineDir) {
        result.engine = true;
        result.engineDir = engineDir;
        try {
          const verFile = path.join(engineDir, '..', '..', 'llama-version.txt');
          if (fs.existsSync(verFile)) result.engineVersion = fs.readFileSync(verFile, 'utf8').trim();
        } catch (e) {}
        if (!result.engineVersion) result.engineVersion = '内置引擎（llama.cpp）';
      }
      result.engineRunning = await isEngineRunning();
      result.models = scanLocalModels();
      result.runningModel = currentEngineModel || '';
      // 模型目录与所在磁盘类型（机械盘 → 冷启动慢，给 UI 提示用）
      try {
        result.modelsDir = getModelsDir();
        result.modelsDirDisk = probeDiskKind(result.modelsDir);
        result.modelsOnHdd = result.modelsDirDisk === 'hdd';
      } catch (e) {}
    } catch (e) { console.error('LLM 运行时检测失败', e.message); }
    return result;
  });

  // 启动 llama 引擎（加载指定模型）
  let engineProcess = null;

  // ===== Optional LoRA adapter for local model (tool-decision fine-tune) =====
  // Mounts a GGUF LoRA on top of the base model so the local model picks tools correctly.
  // config.ai.localLora: 'off' | 'auto' (default) | 'on' | absolute path to a .gguf adapter
  // Only mounted for the matching base model (qwen2.5-coder-3b); other bases are left alone.
  function resolveLocalLora(modelFile) {
    try {
      const setting = (config.ai && config.ai.localLora) || 'auto';
      if (setting === 'off') return null;
      if (setting !== 'auto' && setting !== 'on') {
        return fs.existsSync(setting) ? setting : null;
      }
      if (!/qwen2\.5-coder-3b/i.test(modelFile || '')) return null;
      const candidates = [];
      const engineDir = getEngineDir();
      if (engineDir) candidates.push(path.join(engineDir, '..', 'lora', 'tools-lora-f16.gguf'));
      try {
        const md = getModelsDir();
        if (md) candidates.push(path.join(md, 'lora', 'tools-lora-f16.gguf'));
      } catch (e) { /* ignore */ }
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
      return null;
    } catch (e) { return null; }
  }
  async function startEngineInternal(modelFile) {
    try {
      const engineDir = getEngineDir();
      if (!engineDir) return { success: false, error: '找不到内置引擎，请重新安装 LabCode' };
      const serverExe = path.join(engineDir, 'llama-server.exe');
      if (!fs.existsSync(serverExe)) return { success: false, error: '引擎文件缺少: llama-server.exe' };

      // 选模型：优先指定，否则取 models 目录第一个
      let modelPath = '';
      const modelsDir = getModelsDir();
      if (modelFile) modelPath = path.join(modelsDir, modelFile);
      if (!fs.existsSync(modelPath)) {
        const models = scanLocalModels();
        if (models.length > 0) modelPath = path.join(modelsDir, models[0].file);
      }
      if (!fs.existsSync(modelPath)) return { success: false, error: '找不到模型，请先在插件市场安装大模型' };

      // ===== 引擎复用优化 =====（不占用 C 盘，引擎已打开同模型时直接复用，减少冷启动，
      if (await isEngineRunning()) {
        const runningModel = await getEngineRunningModel();
        if (!modelFile || runningModel === path.basename(modelPath)) {
          currentEngineModel = runningModel || path.basename(modelPath);
          return { success: true, model: currentEngineModel, url: 'http://127.0.0.1:8080/v1', reused: true };
        }
        // 模型不同才强制重启（新安装后旧实例：假占用 8080，
        // 注意用异步 execFile：同步 taskkill 会与"被杀子进程的管道关闭"互相等待，卡死主进程
        await new Promise((resolve) => {
          try {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/IM', 'llama-server.exe', '/F'], { timeout: 5000, windowsHide: true }, () => resolve());
          } catch (e) { resolve(); }
        });
        await new Promise(r => setTimeout(r, 800));
      }

      if (engineProcess) { try { engineProcess.kill(); } catch (e) {} engineProcess = null; }
      currentEngineModel = null;

      const { spawn } = require('child_process');
      const loraPath = resolveLocalLora(path.basename(modelPath));
      if (loraPath) console.log('[LLM engine] LoRA adapter mounted:', loraPath);
      // ===== 引擎参数优化 =====（-fa Flash Attention / -b -ub 增强 batch / -c 支持 config.ai.engineCtx 配置）
      const engineCtx = (config.ai && config.ai.engineCtx) || 16384;
      engineProcess = spawn(serverExe, [
        '-m', modelPath,
        ...(loraPath ? ['--lora', loraPath] : []),
        '--host', '127.0.0.1',
        '--port', '8080',
        '-ngl', '99',          // 全层 GPU（无独立显卡自动回退 CPU）
        '-np', '1',            // 单并发 slot：LabCode 是单用户单会话。默认 4 slot 会让 KV cache
                               // 变成 4×ctx（16K×4=64K token），撑爆显存导致部分层回落 CPU，
                               // 实测单 slot 推理快 17%（69 → 81 tok/s）且显存占用大降
        '-c', String(engineCtx), // 上下文：为思考流（reasoning）预留空间
        '-b', '2048',          // batch size：GPU 下 512-2048 更优
        '-ub', '512',          // 均衡 batch：与 batch 配平，显存受限时自动回退
        '--flash-attn', 'on',      // Flash Attention，GPU 加速注意力，TTFT 显著下降
        '--jinja'              // 使用 GGUF 内嵌聊天模板（Qwen 等）
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      // ===== 加载阶段上报 =====
      // 引擎冷启动要读 4~6GB 权重（机械盘 30~60s），而 llama.cpp 在这段**完全不打日志**，
      // 于是用户只看到"卡住"。这里把阶段推给渲染进程，让它显示"正在加载模型…"。
      const emitEngineProgress = (phase, extra) => {
        try {
          const payload = { phase, model: path.basename(modelPath), ts: Date.now(), ...(extra || {}) };
          for (const w of BrowserWindow.getAllWindows()) {
            if (w && !w.isDestroyed() && w.webContents) w.webContents.send('system:engineProgress', payload);
          }
        } catch (e) {}
      };
      emitEngineProgress('loading');
      engineProcess.stdout.on('data', d => { const s = String(d); if (s.includes('server is listening') || s.includes('HTTP server')) console.log('[LLM引擎] 启动成功'); });
      engineProcess.stderr.on('data', d => {
        const s = String(d);
        console.error('[LLM引擎]', s.slice(0, 300));
        // 阶段识别（llama.cpp 的日志格式）：
        //   load_model: loading model '...'   → 开始读权重
        //   init: llama threadpool init       → 权重读完，开始建计算图/上 GPU
        //   load_model: initializing, n_slots → 分配 KV cache
        //   model loaded / listening on       → 就绪
        if (s.includes('loading model')) emitEngineProgress('loading');
        else if (s.includes('threadpool init') || s.includes('offload') || s.includes('offloaded')) emitEngineProgress('gpu');
        else if (s.includes('initializing') || s.includes('KV cache') || s.includes('kv_cache')) emitEngineProgress('ctx');
        else if (s.includes('model loaded') || s.includes('listening on')) emitEngineProgress('ready');
      });
      engineProcess.on('exit', () => { engineProcess = null; currentEngineModel = null; emitEngineProgress('stopped'); });

      // 等待引擎就绪（最多 60s，大模型加载需时间）
      // Wait up to 180s: first load of a cold model (plus a LoRA adapter) can take well
      // over the old 60s window, e.g. when the disk is busy.
      for (let i = 0; i < 180; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isEngineRunning()) {
          currentEngineModel = path.basename(modelPath);
          return { success: true, model: path.basename(modelPath), url: 'http://127.0.0.1:8080/v1' };
        }
      }
      // Timeout: kill the half-started process, otherwise it keeps holding port 8080
      // and every later start attempt fails the same way.
      if (engineProcess) { try { engineProcess.kill(); } catch (e) {} engineProcess = null; }
      currentEngineModel = null;
    return { success: false, error: 'engine start timeout (model loading slow or out of memory)' };
    } catch (e) {
      return { success: false, error: '启动引擎失败: ' + redactError(e.message || String(e)) };
    }
  }
  ipcMain.handle('system:startLLMEngine', async (_, opts) => startEngineInternal((opts || {}).modelFile));

  // ===== 可用卷缓存（跨平台）+ 模型目录建议 =====
  let _volumesCache = { at: 0, list: [] };
  async function getVolumes() {
    const now = Date.now();
    // 空结果不缓存：探测失败（CIM 慢/权限）不该粘住 60s
    if (_volumesCache.list.length && now - _volumesCache.at < 60000) return _volumesCache.list;
    const list = await probeVolumes();
    if (list.length) _volumesCache = { at: now, list };
    return list.length ? list : _volumesCache.list;
  }

  // 设置面板用：当前目录 / 推荐目录 / 各卷情况
  ipcMain.handle('system:probeModelDirs', async () => {
    try {
      const vols = await getVolumes();
      const current = getModelsDir();
      const rec = pickRecommendedDir(vols);
      return {
        current,
        currentDisk: probeDiskKind(current),
        recommended: rec,
        volumes: vols
      };
    } catch (e) {
      return { current: getModelsDir(), currentDisk: 'unknown', recommended: '', volumes: [] };
    }
  });

  // 一键迁移：把已装模型复制到目标目录（跨平台，不要求用户敲命令）
  // 复制完逐个校验大小，一致才删除源文件（避免半途失败把模型搞没）
  ipcMain.handle('system:migrateModels', async (_, opts) => {
    const target = (opts && opts.target) || '';
    const keepOriginal = !!(opts && opts.keepOriginal);
    const srcDir = getModelsDir();
    if (!target) return { success: false, error: '目标目录不能为空' };
    if (path.resolve(target) === path.resolve(srcDir)) return { success: true, moved: 0, message: '已在目标目录' };
    try {
      if (!fs.existsSync(srcDir)) return { success: false, error: '源目录不存在：' + srcDir };
      fs.mkdirSync(target, { recursive: true });
      const files = fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.gguf'));
      if (!files.length) return { success: false, error: '当前目录里没有模型文件' };
      const emit = (payload) => {
        try {
          for (const w of BrowserWindow.getAllWindows()) {
            if (w && !w.isDestroyed() && w.webContents) w.webContents.send('system:migrateProgress', payload);
          }
        } catch (e) {}
      };
      let done = 0, copied = 0, totalBytes = files.reduce((s, f) => {
        try { return s + fs.statSync(path.join(srcDir, f)).size; } catch (e) { return s; }
      }, 0), movedBytes = 0;
      for (const f of files) {
        const src = path.join(srcDir, f);
        const dst = path.join(target, f);
        emit({ phase: 'copying', file: f, index: done, total: files.length, percent: totalBytes ? Math.round((movedBytes / totalBytes) * 100) : 0 });
        try {
          if (fs.existsSync(dst)) {
            const a = fs.statSync(src).size, b = fs.statSync(dst).size;
            if (a === b) { movedBytes += a; done++; copied++; continue; }  // 目标已有同尺寸文件，跳过复制
          }
          await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(src);
            const ws = fs.createWriteStream(dst);
            let written = 0;
            rs.on('data', (chunk) => {
              written += chunk.length;
              emit({ phase: 'copying', file: f, index: done, total: files.length, percent: totalBytes ? Math.round(((movedBytes + written) / totalBytes) * 100) : 0 });
            });
            rs.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', () => { movedBytes += written; resolve(); });
            rs.pipe(ws);
          });
          // 校验：大小一致才算成功
          const a = fs.statSync(src).size, b = fs.statSync(dst).size;
          if (a !== b) throw new Error('大小不一致');
          if (!keepOriginal) { try { fs.unlinkSync(src); } catch (e) {} }
          copied++; done++;
        } catch (e) {
          emit({ phase: 'error', file: f, error: e.message });
          return { success: false, error: '复制 ' + f + ' 失败：' + e.message, copied, total: files.length };
        }
      }
      // 迁移成功后：把配置切到新目录（用户已装模型不应"消失"）
      try { config.ai = config.ai || {}; config.ai.modelsDir = target; saveConfig(config); } catch (e) {}
      recommendedModelsDir = target;
      emit({ phase: 'done', copied, total: files.length, target });
      return { success: true, copied, total: files.length, target, srcDir, keepOriginal };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ===== 后台预热引擎 =====
  // 冷启动要把 4~6GB 权重读进内存（机械盘 30~60s），如果等到用户第一条消息才加载，
  // 用户就撞上 60s 静默等待。这里在应用启动后就后台预热当前配置的本地模型，
  // 用户打开聊天/工作流时引擎通常已经就绪。
  // 延后 8s：避开应用刚启动时的 IO 高峰，也不影响首屏。
  setTimeout(() => {
    try {
      const ai = config.ai || {};
      if (ai.provider === 'local' && ai.model) {
        console.log('[LLM引擎] 后台预热本地模型:', ai.model);
        startEngineInternal(ai.model)
          .then(r => { if (r && r.success) console.log('[LLM引擎] 预热完成:', r.model || ai.model); })
          .catch(e => console.error('[LLM引擎] 预热失败:', e.message));
      }
    } catch (e) { /* 预热失败不影响主流程 */ }
  }, 8000);

  // ===== 启动时探测可用卷 → 填推荐模型目录 =====
  // 新用户（还没设过目录、也没有旧模型）默认落在 SSD 上：模型下载即落在快盘，
  // 免得用户第一次用本地模型就撞上 40~60s 冷启动。
  setTimeout(() => {
    getVolumes().then(vols => {
      const rec = pickRecommendedDir(vols);
      if (rec) {
        recommendedModelsDir = rec;
        console.log('[LLM引擎] 推荐模型目录（SSD 优先）:', rec);
        // 固定下来：推荐目录若"晚到"（探测需要几秒），用户在这之前下载的模型
        // 会落在兜底目录，之后目录一变，那些模型就"消失"了。
        // 所以在还没有模型时把目录定死；已有模型的（老用户）保持原样，迁移由用户一键触发。
        try {
          if (!config.ai.modelsDir && !dirHasModels(getModelsDir())) {
            config.ai = config.ai || {};
            config.ai.modelsDir = rec;
            saveConfig(config);
            console.log('[LLM引擎] 模型目录已固定为:', rec);
          }
        } catch (e) {}
      }
    }).catch(() => {});
  }, 2500);

  // 停止 llama 引擎
  ipcMain.handle('system:stopLLMEngine', async () => {
    try {
      // 先杀自己持有的子进程句柄（不等外部命令，瞬时返回）
      if (engineProcess) { try { engineProcess.kill(); } catch (e) {} engineProcess = null; }
      currentEngineModel = null;
      // 再兜底清理可能残留的实例。
      // 注意：这里必须用**异步** execFile —— 被杀子进程的 stdout/stderr 管道由主进程持有，
      // 同步 execSync 等待 taskkill 返回会与管道关闭互相等待，把主进程（连带整个 IPC 通道）卡死。
      await new Promise((resolve) => {
        try {
          const { execFile } = require('child_process');
          execFile('taskkill', ['/IM', 'llama-server.exe', '/F'], { timeout: 5000, windowsHide: true }, () => resolve());
        } catch (e) { resolve(); }
      });
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 检测本地大模型运行时（兼容旧调用：返回 ollama 字段 + 新引擎字段）
  ipcMain.handle('system:checkLLMRuntimeLegacy', async () => {
    const result = { ollama: false, ollamaVersion: null, ollamaRunning: false, models: [] };
    try {
      const { execSync } = require('child_process');
      try {
        const ver = execSync('ollama --version', { encoding: 'utf8', timeout: 5000 });
        result.ollama = true;
        result.ollamaVersion = ver.trim();
      } catch (e) { /* ollama 未安装*/ }
      if (result.ollama) {
        try {
          const list = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
          result.ollamaRunning = true;
          const lines = list.trim().split('\n').slice(1);
          result.models = lines.map(l => {
            const parts = l.split(/\s+/);
            return { name: parts[0], id: parts[1] ? parts[1].substring(0, 12) : '', size: parts[2] || '' };
          }).filter(m => m.name);
        } catch (e) { /* ollama 未运行*/ }
      }
    } catch (e) { console.error('LLM 运行时检测失败', e.message); }
    return result;
  });

  // 代理设置
  ipcMain.handle('proxy:set', async (_, proxyConfig) => {
    try {
      if (proxyConfig.mode === 'manual' && proxyConfig.host) {
        await mainWindow.webContents.session.setProxy({
          proxyRules: `${proxyConfig.host}:${proxyConfig.port || 8080}`
        });
      } else if (proxyConfig.mode === 'system') {
        await mainWindow.webContents.session.setProxy({ mode: 'system' });
      } else {
        await mainWindow.webContents.session.setProxy({ mode: 'direct' });
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ============ fs helpers referenced by preload but never registered ============
  ipcMain.handle('fs:deleteFile', (_, filePath) => {
    try {
      if (!filePath) return { success: false, error: 'missing filePath' };
      const p = String(filePath);
      if (!fs.existsSync(p)) return { success: true, skipped: true };
      if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:mkdir', (_, dirPath) => {
    try {
      if (!dirPath) return { success: false, error: 'missing dirPath' };
      fs.mkdirSync(String(dirPath), { recursive: true });
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:readDir', (_, dirPath) => {
    try {
      if (!dirPath) return [];
      const items = fs.readdirSync(String(dirPath), { withFileTypes: true });
      return items.map(i => ({ name: i.name, isDirectory: i.isDirectory(), path: path.join(String(dirPath), i.name) }));
    } catch (e) { return []; }
  });

  // ============ one-shot AI call (non-streaming), reused by ghost + schedule ============
  async function callAiOnce(messages, opts = {}) {
    const aiCfg = config.ai || {};
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (resolveAiBaseURL(aiCfg) || provider.baseURL);
    const useModel = opts.model || aiCfg.model || provider.defaultModel;
    if (!baseURL) throw new Error('AI baseURL not configured');
    const isGateway = aiCfg.provider === 'gateway';
    const url = isGateway
      ? baseURL.replace(/\/$/, '') + '/api/chat'
      : baseURL.replace(/\/$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (isGateway) {
      const gwAuth = resolveGatewayAuth(aiCfg);
      if (!gwAuth.token) throw new Error('gateway account not logged in');
      headers['Authorization'] = 'Bearer ' + gwAuth.token;
    } else if (aiCfg.apiKey) {
      headers['Authorization'] = 'Bearer ' + aiCfg.apiKey;
    }
    const body = isGateway
      ? { model: useModel, messages, temperature: opts.temperature !== undefined ? opts.temperature : 0.3 }
      : { model: useModel, messages, temperature: opts.temperature !== undefined ? opts.temperature : 0.3, max_tokens: opts.maxTokens || 512, stream: false };
    const resp = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('AI HTTP ' + resp.status);
    const data = await resp.json();
    return isGateway
      ? ((data && data.content) || '')
      : (((data && data.choices && data.choices[0] && data.choices[0].message) || {}).content || '');
  }

  // ============ ai:getCompletion (Monaco ghost inline completion) ============
  ipcMain.handle('ai:getCompletion', async (_, opts) => {
    const { prefix = '', suffix = '', language = '' } = opts || {};
    if (!String(prefix).trim()) return { completion: '' };
    try {
      const messages = [
        { role: 'system', content: 'You are a code completion engine. Output ONLY the text that should be inserted at the cursor. No explanation, no markdown, no code fences. Match the surrounding indentation and code style. If no sensible completion exists, output nothing.' },
        { role: 'user', content: 'Language: ' + language + '\n\nBefore cursor:\n' + String(prefix).slice(-4000) + '\n\nAfter cursor:\n' + String(suffix).slice(0, 1000) + '\n\nCompletion:' }
      ];
      const out = await callAiOnce(messages, { maxTokens: 128, temperature: 0.2 });
      let text = String(out || '');
      text = text.replace(/^```[a-zA-Z0-9_+-]*\n?/, '').replace(/```\s*$/, '');
      return { completion: text };
    } catch (e) {
      return { completion: '', error: e.message };
    }
  });

  // ============ context:compactPreview ============
  ipcMain.handle('context:compactPreview', () => {
    try {
      const sessions = loadSessions();
      const kept = [], dropped = [];
      sessions.forEach((s, i) => {
        const entry = { id: s.id, title: s.title || '(untitled)', updatedAt: s.updatedAt || 0 };
        if (i < 5) kept.push(entry); else dropped.push(entry);
      });
      return {
        success: true,
        summary: 'Heuristic preview: newest 5 sessions kept, older ones dropped on compaction.',
        kept,
        dropped
      };
    } catch (e) {
      return { success: false, summary: 'preview unavailable: ' + e.message, kept: [], dropped: [] };
    }
  });

  // ============ schedule (persisted tasks + runs) ============
  const SCHEDULE_PATH = path.join(app.getPath('userData'), 'schedule.json');
  let scheduleStore = { tasks: [], runs: [] };
  function loadSchedule() {
    try {
      if (fs.existsSync(SCHEDULE_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
        scheduleStore = {
          tasks: Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [],
          runs: Array.isArray(parsed && parsed.runs) ? parsed.runs : []
        };
      }
    } catch (e) { console.error('[schedule] load failed:', e.message); }
  }
  function saveSchedule() {
    try { fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleStore, null, 2), 'utf-8'); return true; }
    catch (e) { console.error('[schedule] save failed:', e.message); return false; }
  }
  function schedNextId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function schedFindRun(runId) {
    return scheduleStore.runs.find(r => r.runId === runId || r.id === runId);
  }
  // Minimal 5-field cron matcher: "*", "*/n", "a-b", "a,b", plain numbers.
  function cronMatches(expr, date) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length < 5) return false;
    const fields = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
    for (let i = 0; i < 5; i++) {
      const f = parts[i];
      if (f === '*' || f === '?') continue;
      let ok = false;
      for (const seg of String(f).split(',')) {
        let m = /^\*\/(\d+)$/.exec(seg);
        if (m) { const step = parseInt(m[1], 10); if (step > 0 && fields[i] % step === 0) { ok = true; break; } continue; }
        m = /^(\d+)-(\d+)$/.exec(seg);
        if (m) { if (fields[i] >= parseInt(m[1], 10) && fields[i] <= parseInt(m[2], 10)) { ok = true; break; } continue; }
        if (/^\d+$/.test(seg) && parseInt(seg, 10) === fields[i]) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  }
  function schedIsDue(task, now) {
    if (!task || !task.enabled) return false;
    if (task.type === 'interval') {
      const secs = parseInt(String(task.expr).replace(/[^\d]/g, ''), 10);
      if (!secs || secs <= 0) return false;
      return (now - (task.lastRunAt || 0)) >= secs * 1000;
    }
    return cronMatches(task.expr, new Date(now));
  }
  async function schedRunTask(task) {
    const runId = schedNextId('run');
    const run = { id: runId, runId, taskId: task.id, startedAt: Date.now(), finishedAt: null, status: 'running', prompt: task.prompt, patch: null, slots: null, error: null };
    scheduleStore.runs.unshift(run);
    if (scheduleStore.runs.length > 200) scheduleStore.runs.length = 200;
    saveSchedule();
    try {
      // 工作流模式：调度触发渲染进程执行可视化工作流，结果回报入库
      if (task.mode === 'workflow') {
        const execResult = await schedExecWorkflow(task);
        run.status = execResult.ok ? 'done' : 'error';
        run.finishedAt = Date.now();
        run.patch = execResult.summary || String(execResult.error || '');
        run.slots = [{ label: 'workflow', size: String(run.patch || '').length }];
        if (!execResult.ok) run.error = execResult.error;
        task.lastRunAt = Date.now();
        saveSchedule();
        return run;
      }
      const out = await callAiOnce([
        { role: 'system', content: 'You are an autonomous coding agent running on a schedule. Produce concrete, reviewable output for the requested task.' },
        { role: 'user', content: task.prompt || '' }
      ], { maxTokens: 2048, temperature: 0.3 });
      run.status = 'done';
      run.finishedAt = Date.now();
      run.patch = String(out || '');
      run.slots = [{ label: 'output', size: String(out || '').length }];
    } catch (e) {
      run.status = 'error';
      run.finishedAt = Date.now();
      run.error = e.message;
    }
    task.lastRunAt = Date.now();
    saveSchedule();
    return run;
  }

  // 调度触发工作流：向渲染进程发送执行请求并等待结果（30s 超时）
  function schedExecWorkflow(task) {
    return new Promise((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) { resolve({ ok: false, error: '窗口未就绪' }); return; }
      const token = 'wf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      const onResult = (_ev, data) => {
        if (data && data.token === token) {
          ipcMain.removeListener('schedule:workflow-result', onResult);
          clearTimeout(timer);
          resolve({ ok: !!data.ok, summary: data.summary || '', error: data.error || '' });
        }
      };
      ipcMain.on('schedule:workflow-result', onResult);
      const timer = setTimeout(() => {
        ipcMain.removeListener('schedule:workflow-result', onResult);
        resolve({ ok: false, error: '工作流执行超时（30s）' });
      }, 30000);
      mainWindow.webContents.send('schedule:exec-workflow', { token, taskId: task.id, prompt: task.prompt, mode: task.mode });
    });
  }
  loadSchedule();
  const scheduleTimer = setInterval(() => {
    try {
      const now = Date.now();
      for (const t of scheduleStore.tasks) {
        if (schedIsDue(t, now)) schedRunTask(t).catch(e => console.error('[schedule] run failed:', e.message));
      }
    } catch (e) { console.error('[schedule] tick error:', e.message); }
  }, 30000);
  if (scheduleTimer && typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
  app.on('before-quit', () => { try { clearInterval(scheduleTimer); } catch (e) {} });

  ipcMain.handle('schedule:createTask', (_, opts) => {
    try {
      const o = opts || {};
      const t = { id: schedNextId('task'), type: o.type === 'interval' ? 'interval' : 'cron', expr: String(o.expr || ''), prompt: String(o.prompt || ''), mode: o.mode === 'workflow' ? 'workflow' : 'chat', enabled: true, createdAt: Date.now(), lastRunAt: 0 };
      scheduleStore.tasks.push(t);
      saveSchedule();
      return { success: true, id: t.id, task: t };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('schedule:listInbox', () => scheduleStore.tasks.slice());
  ipcMain.handle('schedule:listRuns', (_, opts) => {
    const taskId = opts && opts.taskId;
    return (taskId ? scheduleStore.runs.filter(r => r.taskId === taskId) : scheduleStore.runs).slice();
  });
  ipcMain.handle('schedule:runNow', async (_, opts) => {
    try {
      const t = scheduleStore.tasks.find(x => x.id === (opts && opts.taskId));
      if (!t) return { success: false, error: 'task not found: ' + (opts && opts.taskId) };
      const run = await schedRunTask(t);
      return { success: true, runId: run.runId, run };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('schedule:status', () => ({
    success: true,
    enabled: true,
    taskCount: scheduleStore.tasks.length,
    runCount: scheduleStore.runs.length,
    message: scheduleStore.tasks.filter(t => t.enabled).length + ' active / ' + scheduleStore.tasks.length + ' total'
  }));
  ipcMain.handle('schedule:getPatch', (_, opts) => {
    const r = schedFindRun(opts && opts.runId);
    return r ? (r.patch || '') : '';
  });
  ipcMain.handle('schedule:previewSlots', (_, opts) => {
    const r = schedFindRun(opts && opts.runId);
    return (r && r.slots) || [];
  });
  ipcMain.handle('schedule:applyPatch', (_, opts) => {
    const r = schedFindRun(opts && opts.runId);
    if (!r) return { success: false, error: 'run not found' };
    if (!r.patch) return { success: false, error: 'run produced no patch' };
    r.appliedAt = Date.now();
    saveSchedule();
    return { success: true, message: 'marked as applied (' + String(r.patch).length + ' chars of output)' };
  });
  ipcMain.handle('schedule:discardPatch', (_, opts) => {
    const r = schedFindRun(opts && opts.runId);
    if (!r) return { success: false, error: 'run not found' };
    r.patch = null; r.slots = null; r.discardedAt = Date.now();
    saveSchedule();
    return { success: true, message: 'patch discarded' };
  });

  // ESP32 toolchain auto-install on first launch (async, non-blocking).
  // ensureEsp32Toolchain is a nested function of setupIPC, so it MUST be called here
  // (module scope cannot see it). Deferred by one tick via setImmediate so that
  // createMainWindow() has already run and mainWindow exists -> progress events land.
  setImmediate(() => {
    ensureEsp32Toolchain().catch(e => console.error('[ESP32] auto install failed:', e && e.message));
  });
}

// ============ 自动更新 ============
function setupAutoUpdate() {
  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    const autoUpdateDisabled = process.env.AUTO_UPDATE_DISABLED === '1' || process.env.AUTO_UPDATE_DISABLED === 'true';

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', info);
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('update:progress', progress);
    });

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update:downloaded', info);
      // 强制更新：下载完 3 秒后自动重启安装
      // Hand off to UI: install only after the user confirms (renderer invokes update:install).
    });

    autoUpdater.on('error', (error) => {
      console.error('自动更新错误:', error.message);
    });

    ipcMain.handle('update:check', async () => {
      if (typeof autoUpdateDisabled !== 'undefined' && autoUpdateDisabled) return { disabled: true };
      try {
        const result = await autoUpdater.checkForUpdates();
        const info = result && (result.updateInfo || result.versionInfo);
        return {
          version: info ? info.version : null,
          releaseDate: info ? info.releaseDate : null,
          files: (result && result.files ? result.files : []).map(f => ({ url: f.url, size: f.size })),
        };
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    });
    ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
    ipcMain.handle('update:install', async () => {
      try {
        await autoUpdater.downloadUpdate();
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        dialog.showErrorBox('Update install failed', e.stack || String(e));
      }
    });

    // 自动检查更新已停用（用户要求不弹更新提示）；保留 update:check/download/install IPC 供手动触发
    // setTimeout(() => {
    //   if (!isDev && !autoUpdateDisabled) autoUpdater.checkForUpdates().catch(() => {});
    // }, 5000);

    // 每 1 小时定时检查（已停用）
    // setInterval(() => {
    //   if (!isDev && !autoUpdateDisabled) autoUpdater.checkForUpdates().catch(() => {});
    // }, 60 * 60 * 1000);

  } catch (e) {
    console.warn('自动更新模块加载失败:', e.message);
  }
}


// ============ 应用生命周期 ============
app.whenReady().then(() => {
  console.log('馃殌 LabCode 启动不..');
  console.log('馃搧 用户数据目录:', USER_DATA_PATH);
  console.log('馃敡 开发模式', isDev);

  createMenu();
  setupIPC();
  setupAutoUpdate();
  createMainWindow();

  // 首次启动自动安装 ESP32 工具链（异步，不阻塞 UI）
  // moved: ensureEsp32Toolchain() is now invoked inside setupIPC via setImmediate
  // (it is a nested function of setupIPC and was NOT visible at module scope here)

  // 启动已配置的 MCP 服务器（stdio）
  try {
    require('./mcp').getMcpService().startAll();
    console.log('[MCP] server check complete');
  } catch (e) {
    console.error('MCP 启动失败:', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveConfig(config);
  // 清理所有终端
  try {
    terminalService.destroyAll();
    console.log('所有终端已清理');
  } catch (e) {
    console.error('清理终端失败:', e);
  }
  // 清理 MCP 服务器进程
  try {
    require('./mcp').getMcpService().stopAll();
    console.log('MCP 服务器已清理');
  } catch (e) {
    console.error('清理 MCP 失败:', e);
  }
});

// 防止 GPU 进程崩溃
app.on('gpu-process-crashed', (event, killed) => {
  console.error('GPU 进程崩溃:', killed);
});

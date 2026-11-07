// ============ BubaiCode Electron 主进程 ============
// 基于业界 IDE 设计实践：窗口管理 / IPC / 自动更新 / 代理 / 会话存储

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// 终端服务
const { getTerminalService } = require('./terminal');
const terminalService = getTerminalService();

// 全局变量
let mainWindow = null;
let isDev = process.argv.includes('--dev');

// 用户数据目录
const USER_DATA_PATH = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const SESSIONS_PATH = path.join(USER_DATA_PATH, 'sessions');

// 确保目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(SESSIONS_PATH);

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
      provider: 'deepseek',
      model: 'deepseek-v4',
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
      mcpServers: [],
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
    backgroundColor: '#1e1e2e',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
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
        { label: '文档', click: () => shell.openExternal('https://www.BubaiCode.com/docs') },
        { label: '官网', click: () => shell.openExternal('https://www.BubaiCode.com') },
        { type: 'separator' },
        { label: '关于 BubaiCode', click: () => showAboutDialog() }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 BubaiCode',
    message: 'BubaiCode v1.0.0',
    detail: '通用 AI 软件开发智能体\n\n内置真正动手的 AI 智能体：读写代码、执行命令、运行测试、联网检索。\n\n© 2026 BubaiCode Team. All rights reserved.',
    buttons: ['确定']
  });
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
  ipcMain.handle('config:set', (_, key, value) => {
    const keys = key.split('.');
    let obj = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    return saveConfig(config);
  });
  ipcMain.handle('config:save', (_, newConfig) => {
    config = { ...config, ...newConfig };
    return saveConfig(config);
  });

  // ============ MCP 服务器（Model Context Protocol stdio 接入）============
  const mcpService = require('./mcp').getMcpService();
  require('./mcp').initMcp({ getConfig: () => config, saveConfig });
  ipcMain.handle('mcp:list-servers', () => mcpService.listServers());
  ipcMain.handle('mcp:add-server', (_, cfg) => mcpService.addServer(cfg || {}));
  ipcMain.handle('mcp:remove-server', (_, name) => mcpService.removeServer(name));
  ipcMain.handle('mcp:list-tools', (_, name) => mcpService.listTools(name));
  ipcMain.handle('mcp:call-tool', (_, serverName, toolName, args) => mcpService.callTool(serverName, toolName, args));
  ipcMain.handle('mcp:start-all', () => mcpService.startAll());
  ipcMain.handle('mcp:stop-all', () => { mcpService.stopAll(); return true; });

  // ============ AI 对话（OpenAI 兼容 API：DeepSeek / 本地 llama 引擎 / Ollama / 自定义）============
  const AI_PROVIDERS = {
    deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    gateway:  { baseURL: process.env.GATEWAY_URL || 'https://bluebubai.work', defaultModel: 'deepseek-flash' },
    local:    { baseURL: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf' },
    ollama:   { baseURL: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b' },
    openai:   { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
    custom:   { baseURL: '', defaultModel: '' }
  };

  ipcMain.handle('ai:chat', async (_, options) => {
    const { messages, model, temperature = 0.7, maxTokens = 4096 } = options || {};
    const aiCfg = config.ai || {};
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (aiCfg.baseURL || provider.baseURL);
    const useModel = model || aiCfg.model || provider.defaultModel;
    const apiKey = aiCfg.apiKey || '';

    if (!baseURL) {
      return { success: false, error: '未配置 API baseURL，请在设置中配置' };
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: '消息为空' };
    }

    try {
      // ===== 网关模式（登录账号 → 内置模型池 → 扣积分）=====
      if (aiCfg.provider === 'gateway') {
        const gwToken = aiCfg.gatewayToken || '';
        if (!gwToken) return { success: false, error: '未登录网关账号，请在设置中登录' };
        const gwUrl = baseURL.replace(/\/$/, '') + '/api/chat';
        const gwResp = await net.fetch(gwUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + gwToken },
          body: JSON.stringify({ model: useModel, messages, temperature })
        });
        const gwData = await gwResp.json().catch(() => ({}));
        if (!gwResp.ok) {
          if (gwResp.status === 402) {
            return { success: false, error: gwData.error || '积分不足', creditsInsufficient: true, creditsLeft: gwData.creditsLeft };
          }
          return { success: false, error: `网关返回 ${gwResp.status}: ${(gwData.error || '')}` };
        }
        return { success: true, content: gwData.content || '', creditsLeft: gwData.creditsLeft, cost: gwData.cost, totalTokens: gwData.totalTokens, model: useModel, gateway: true };
      }

      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
      const body = JSON.stringify({
        model: useModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      });

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

      const response = await net.fetch(url, {
        method: 'POST',
        headers,
        body
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { success: false, error: `API 返回 ${response.status}: ${errText.slice(0, 500)}` };
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const usage = data?.usage || {};
      return { success: true, content, usage, model: useModel };
    } catch (e) {
      return { success: false, error: 'AI 请求失败: ' + (e.message || String(e)) };
    }
  });

  // ============ AI 流式对话（SSE + 真 function calling）============
  // 通过 ai:stream 事件推送执行过程：delta / tool_calls / usage / done / error
  const activeAiStreams = new Map();

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

  // 单轮流式调用（支持 tools / function calling；失败自动回退非流式）
  async function streamChatCompletion(sender, runId, { messages, model, temperature, maxTokens, tools, aiCfg }) {
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (aiCfg.baseURL || provider.baseURL);
    const useModel = model || aiCfg.model || provider.defaultModel;
    const apiKey = aiCfg.apiKey || '';
    const isGateway = aiCfg.provider === 'gateway';
    // 网关模式：走内置模型池 + 积分扣费；请求体只发模型 id 与消息（Key 在服务端）
    const url = isGateway
      ? (baseURL || '').replace(/\/$/, '') + '/api/chat/stream'
      : (baseURL || '').replace(/\/$/, '') + '/chat/completions';
    if (!url || url === '/api/chat/stream' || url === '/chat/completions') throw new Error('未配置 API baseURL，请在设置中配置');

    const headers = { 'Content-Type': 'application/json' };
    if (isGateway) {
      const gwToken = aiCfg.gatewayToken || '';
      if (!gwToken) throw new Error('未登录网关账号，请在设置中登录');
      headers['Authorization'] = 'Bearer ' + gwToken;
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
    // 本地引擎不注入 tools：llama.cpp --jinja + tools 会用 grammar 强制模型输出工具 JSON，
    // 本地小模型（Qwen3.5-9B）在 grammar 约束下会输出空/失败（正文丢失）。
    // 本地模型的主路径是"正文代码块 → 应用层落盘 → IDE 自动编译验证"，不依赖工具调用。
    if (Array.isArray(tools) && tools.length > 0 && aiCfg.provider !== 'local' && aiCfg.provider !== 'ollama' && !isGateway) {
      bodyObj.tools = tools;
    }
    // 本地引擎（Qwen3 等思考模型）：
    // 已实测：enable_thinking=true + 流式 + max_tokens 充足时，reasoning_content 与正文会先后输出，
    // finish=stop（真实豆包式思考流）。思考过长占满 max_tokens 时正文可能为空，
    // 由 doStreamOnce 内"空正文→关闭思考重试"降级兜底，保证正文输出。
    if (aiCfg.provider === 'local') {
      // bodyObj.chat_template_kwargs 由 doStreamOnce(enableThinking) 按轮次设置
    } else if (aiCfg.provider === 'ollama') {
      bodyObj.think = false;
    }

    const send = (type, data) => {
      try { if (sender && !sender.isDestroyed()) sender.send('ai:stream', { runId, type, ...data }); } catch (e) {}
    };

    // 单次请求 + 流解析（供首次与引擎重启后重试共用）
    async function doStreamOnce(enableThinking) {
      const b = Object.assign({}, bodyObj);
      if (aiCfg.provider === 'local') b.chat_template_kwargs = { enable_thinking: enableThinking !== false };
      else if (aiCfg.provider === 'ollama') b.think = enableThinking !== false;
      const toolCalls = [];
      const response = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(b) });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const err = new Error(`API 返回 ${response.status}: ${errText.slice(0, 300)}`);
        if (response.status === 402) err.creditsInsufficient = true;
        throw Object.assign(err, { status: response.status, errText });
      }

      let fullText = '';
      for await (const evt of parseSSEStream(response.body)) {
        if (activeAiStreams.get(runId)) { activeAiStreams.delete(runId); break; }
        // 网关事件行（event: credits / event: error）透传给 renderer
        if (evt._event === 'credits') {
          send('credits', { used: evt.used, totalTokens: evt.totalTokens, remaining: evt.remaining });
          continue;
        }
        if (evt._event === 'error') {
          send('error', { error: evt.error || '网关流错误' });
          continue;
        }
        const choice = evt.choices && evt.choices[0];
        if (!choice) continue;
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
      if (aiCfg.provider === 'local' && enableThinking !== false && !String(fullText || '').trim()) {
        console.warn('[streamChat] 本地思考流未产出正文（思考占满预算），关闭思考重试');
        return doStreamOnce(false);
      }

      send('done', { content: fullText, toolCalls: parsedToolCalls });
      return { success: true, content: fullText, toolCalls: parsedToolCalls };
    }

    try {
      return await doStreamOnce(true);
    } catch (e) {
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
          const fbResp = await net.fetch(fbUrl, { method: 'POST', headers, body: JSON.stringify(fbBody) });
          if (fbResp.ok) {
            const data = await fbResp.json();
            if (isGateway) {
              // 网关非流式响应：{ content, creditsLeft, cost, totalTokens }
              const gwContent = data?.content || '';
              send('credits', { used: data?.cost || 0, totalTokens: data?.totalTokens || 0, remaining: data?.creditsLeft || 0 });
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
        } catch (fbErr) { /* 继续抛原始错误 */ }
      }
      send('error', { error: e.message || String(e), creditsInsufficient: !!e.creditsInsufficient });
      return { success: false, error: e.message || String(e), creditsInsufficient: !!e.creditsInsufficient };
    }
  }

  ipcMain.handle('ai:chatStream', async (event, options = {}) => {
    const { runId = 'run_' + Date.now(), messages, model, temperature, maxTokens, tools } = options;
    const aiCfg = config.ai || {};
    activeAiStreams.delete(runId);
    // 异步执行，立即返回 runId，结果经 ai:stream 事件推送
    (async () => {
      try {
        await streamChatCompletion(event.sender, runId, { messages, model, temperature, maxTokens, tools, aiCfg });
      } catch (e) {
        try { event.sender.send('ai:stream', { runId, type: 'error', error: e.message || String(e) }); } catch (_) {}
      }
    })();
    return { success: true, runId };
  });

  // 取消流式对话
  ipcMain.handle('ai:chatCancel', (_, runId) => {
    if (runId) activeAiStreams.set(runId, true);
    return { success: true };
  });

  ipcMain.handle('ai:checkConnection', async (_, testConfig) => {
    // 测试 AI 连接（发一条最短消息）
    const aiCfg = { ...(config.ai || {}), ...(testConfig || {}) };
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = (aiCfg.provider === 'gateway' && aiCfg.gatewayUrl) ? aiCfg.gatewayUrl : (aiCfg.baseURL || provider.baseURL);
    const useModel = aiCfg.model || provider.defaultModel;
    if (!baseURL) return { success: false, error: '未配置 baseURL' };
    try {
      // 网关模式：用 /api/me 验证 token 有效性（不消耗积分）
      if (aiCfg.provider === 'gateway') {
        const gwUrl = baseURL.replace(/\/$/, '') + '/api/me';
        const gwResp = await net.fetch(gwUrl, {
          headers: { Authorization: 'Bearer ' + (aiCfg.gatewayToken || '') }
        });
        if (!gwResp.ok) return { success: false, status: gwResp.status, error: '网关登录失效，请重新登录' };
        const data = await gwResp.json().catch(() => ({}));
        const u = data?.user || {};
        return { success: true, model: useModel, gateway: true, creditsLeft: u.totalCredits ?? (u.planCredits || 0) + (u.rechargeCredits || 0) };
      }
      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
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

  // ============ 网关账号（登录 / 注册 / 余额 / 登出）============
  ipcMain.handle('ai:gatewayAuth', async (_, { action, email, password, gatewayUrl } = {}) => {
    // 优先级：显式传入 > 已保存 config.ai.gatewayUrl > 环境变量 > 默认生产域名
    const savedGw = (config.ai || {}).gatewayUrl || '';
    const gwBase = (gatewayUrl || savedGw || process.env.GATEWAY_URL || AI_PROVIDERS.gateway.baseURL || 'https://bluebubai.work').replace(/\/$/, '');
    try {
      if (action === 'login' || action === 'register') {
        if (!email || !password) return { success: false, error: '请输入邮箱和密码' };
        const res = await net.fetch(`${gwBase}/api/auth/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { success: false, error: data.error || `网关返回 ${res.status}` };
        if (!data.token) return { success: false, error: '网关未返回 token' };
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
          user: { email: u.email, totalCredits: u.totalCredits, planCredits: u.planCredits, rechargeCredits: u.rechargeCredits }
        };
      }
      if (action === 'me') {
        const token = (config.ai || {}).gatewayToken || '';
        if (!token) return { success: false, error: '未登录' };
        const res = await net.fetch(`${gwBase}/api/me`, { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { success: false, error: data.error || `网关返回 ${res.status}` };
        const u = data.user || {};
        return { success: true, user: { email: u.email, totalCredits: u.totalCredits, planCredits: u.planCredits, rechargeCredits: u.rechargeCredits } };
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
      return { success: false, error: '网关请求失败: ' + (e.message || String(e)) };
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

  // 文件读写（带编码自动检测：UTF-8 BOM / 纯UTF-8 / GBK 回退）
  ipcMain.handle('fs:readFile', (_, filePath) => {
    try {
      const buf = fs.readFileSync(filePath);
      // 1) UTF-8 BOM 直接按 UTF-8
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return { success: true, content: buf.toString('utf-8').replace(/^\uFEFF/, ''), encoding: 'utf-8' };
      }
      // 2) 尝试严格 UTF-8 解码（TextDecoder fatal 模式）
      try {
        const td = new TextDecoder('utf-8', { fatal: true });
        const content = td.decode(buf);
        // 无 BOM 但纯 ASCII/UTF-8 时直接返回
        return { success: true, content, encoding: 'utf-8' };
      } catch (utfErr) {
        // 3) UTF-8 解码失败 → GBK（覆盖中文 Windows 常见 GB2312/GBK 编码文件）
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

  ipcMain.handle('fs:writeFile', (_, filePath, content) => {
    try {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, content, 'utf-8');
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
  
  // 获取终端缓冲区
  ipcMain.handle('terminal:getBuffer', (_, id) => {
    try {
      const buffer = terminalService.getBuffer(id);
      return { success: true, buffer };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  // 清除终端缓冲区
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
  ipcMain.handle('terminal:execute', async (_, command, cwd, timeout) => {
    try {
      const result = await terminalService.executeCommand(command, cwd, timeout);
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
  // 供 renderer run_test 获取真实路径（避免 PATH 缺失导致 'arduino-cli' 裸命令失败）
  ipcMain.handle('toolchain:getArduinoCliPath', () => {
    const p = resolveArduinoCli();
    return { path: p, exists: fs.existsSync(p) };
  });

  function runArduinoCli(args, cwd) {
    return new Promise((resolve) => {
      if (!fs.existsSync(ARDUINO_CLI)) {
        resolve({ success: false, error: 'arduino-cli 未找到，请先安装 Arduino 编译插件', code: -1 });
        return;
      }
      const child = execFile(ARDUINO_CLI, args, { cwd: cwd || process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        resolve({ success: !err, error: err ? err.message : '', output, code: err ? (err.code || 1) : 0 });
      });
    });
  }

  /**
   * Arduino sketch 目录规范化：
   * arduino-cli 要求主 .ino 文件名必须与所在目录同名（如 esp32_robot/esp32_robot.ino）。
   * 若用户的 .ino 位于不同名目录（如 PlatformIO 风格 src/esp32_robot.ino），
   * 自动创建临时同名目录并复制 sketch 源文件，编译完成后清理。
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
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bubaicode-sketch-'));
    const target = path.join(tmpRoot, base);
    fs.mkdirSync(target, { recursive: true });
    let copied = 0;
    for (const f of fs.readdirSync(dir)) {
      const src = path.join(dir, f);
      const dst = path.join(target, f);
      try {
        if (fs.statSync(src).isFile()) { fs.copyFileSync(src, dst); copied++; }
      } catch (e) { /* 跳过不可复制项 */ }
    }
    return { target, cleanup: tmpRoot, created: copied > 0 };
  }

  ipcMain.handle('compile:arduino', async (_, options) => {
    const { sketchPath, fqbn, outputDir } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    if (!fqbn) return { success: false, error: '缺少 fqbn（开发板型号）' };
    const norm = normalizeSketchDir(sketchPath);
    const args = ['compile', '--fqbn', fqbn];
    if (outputDir) args.push('--output-dir', outputDir);
    args.push(norm.target);
    const result = await runArduinoCli(args, path.dirname(norm.target));
    if (norm.cleanup) { try { fs.rmSync(norm.cleanup, { recursive: true, force: true }); } catch (e) {} }
    return result;
  });

  ipcMain.handle('compile:upload', async (_, options) => {
    const { sketchPath, fqbn, port } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    if (!fqbn) return { success: false, error: '缺少 fqbn' };
    if (!port) return { success: false, error: '缺少串口（port）' };
    const norm = normalizeSketchDir(sketchPath);
    const args = ['upload', '--fqbn', fqbn, '--port', port, norm.target];
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

  // ============ 串口监视器 ============
  let serialMonitorProc = null;   // 当前打开的串口监视进程
  let serialMonitorPort = null;
  let serialMonitorBaud = 115200;

  ipcMain.handle('serial:list', async () => {
    // 用 arduino-cli board list 获取串口
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
    if (!fs.existsSync(ARDUINO_CLI)) return { success: false, error: 'arduino-cli 未安装' };
    // 关闭旧串口
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:data', data.toString('utf8'));
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

  // 外部链接
  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

  // 应用信息
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getPath', (_, name) => app.getPath(name));
  ipcMain.handle('app:getPlatform', () => process.platform);

  // ============ 系统配置检测（大模型推荐用） ============
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
    } catch (e) { console.error('磁盘检测失败:', e.message); }

    // GPU 检测（快速方式：读注册表或环境变量，避免慢的 CIM 查询）
    let gpus = [];
    let hasNvidia = false;
    let maxVramGB = 0;
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        // 用 nvidia-smi 检测 NVIDIA GPU（更快更准确）
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
        } catch (e) { /* 无 NVIDIA GPU */ }
        // 如果没有 NVIDIA，用 PowerShell 快速检测其他 GPU
        if (gpus.length === 0) {
          try {
            const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', { encoding: 'utf8', timeout: 5000 });
            const names = out.trim().split('\n').filter(n => n.trim());
            names.forEach(name => {
              gpus.push({ name: name.trim(), vramGB: 0, driver: 'unknown' });
            });
          } catch (e) { /* GPU 检测失败 */ }
        }
      }
    } catch (e) { console.error('GPU 检测失败:', e.message); }

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

  // ============ 本地大模型引擎（llama.cpp，内置，无需 Ollama）============
  // 引擎目录：resources/llama（安装包内置）；模型目录：D:\BubaiCode\models（插件市场下载）
  function getEngineDir() {
    // 开发模式：D:\BubaiCode\runtime\llama-cpp-*；打包后：resources/llama
    const candidates = [
      path.join(process.resourcesPath, 'llama'),           // 打包后内置
      path.join(__dirname, '..', 'resources', 'llama'),    // 开发目录
      'D:\\BubaiCode\\runtime\\llama-cpp-vulkan',            // 本机验证目录
      'D:\\BubaiCode\\runtime\\llama-cpp-cpu'
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(path.join(c, 'llama-server.exe'))) return c; } catch (e) {}
    }
    return '';
  }

  function getModelsDir() {
    // 模型统一放 D:\BubaiCode\models（后续改为用户数据目录）
    return 'D:\\BubaiCode\\models';
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
      if (lower.includes('qwen2.5-coder-1.5b')) return 'Qwen2.5-Coder 1.5B';
      return base;
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

  // 检测 llama 引擎是否运行（8080 OpenAI 兼容端点）
  async function isEngineRunning() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await net.fetch('http://127.0.0.1:8080/health', { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch (e) { return false; }
  }

  // 检测本地大模型运行时（BubaiCode 内置 llama 引擎）
  let currentEngineModel = null;
  ipcMain.handle('system:checkLLMRuntime', async () => {
    const result = { engine: false, engineVersion: null, engineRunning: false, models: [], engineDir: '', runningModel: '' };
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
    } catch (e) { console.error('LLM 运行时检测失败:', e.message); }
    return result;
  });

  // 启动 llama 引擎（加载指定模型）
  let engineProcess = null;
  async function startEngineInternal(modelFile) {
    try {
      // 强杀所有残留 llama 进程：覆盖安装后旧实例（文件已被替换）会假活/占 8080，
      // 导致 health 探测成功但实际请求 ERR_CONNECTION_REFUSED。
      try { execSync('taskkill /IM llama-server.exe /F', { stdio: 'ignore' }); } catch (ke) {}
      await new Promise(r => setTimeout(r, 800));
      const engineDir = getEngineDir();
      if (!engineDir) return { success: false, error: '未找到内置引擎，请重新安装 BubaiCode' };
      const serverExe = path.join(engineDir, 'llama-server.exe');
      if (!fs.existsSync(serverExe)) return { success: false, error: '引擎文件缺失: llama-server.exe' };

      // 选模型：优先指定，否则取 models 目录第一个
      let modelPath = '';
      const modelsDir = getModelsDir();
      if (modelFile) modelPath = path.join(modelsDir, modelFile);
      if (!fs.existsSync(modelPath)) {
        const models = scanLocalModels();
        if (models.length > 0) modelPath = path.join(modelsDir, models[0].file);
      }
      if (!fs.existsSync(modelPath)) return { success: false, error: '未找到模型，请先在插件市场安装大模型' };

      if (engineProcess) { try { engineProcess.kill(); } catch (e) {} engineProcess = null; }
      currentEngineModel = null;

      const { spawn } = require('child_process');
      engineProcess = spawn(serverExe, [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', '8080',
        '-ngl', '99',          // 全层 GPU（无独显自动回退 CPU）
        '-c', '16384',         // 上下文：16K，为思考流（reasoning）+ 正文预留空间（9B 内存充足）
        '--jinja'              // 使用 GGUF 内嵌聊天模板（Qwen 等）
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      engineProcess.stdout.on('data', d => { const s = String(d); if (s.includes('server is listening') || s.includes('HTTP server')) console.log('[LLM引擎] 启动成功'); });
      engineProcess.stderr.on('data', d => console.error('[LLM引擎]', String(d).slice(0, 300)));
      engineProcess.on('exit', () => { engineProcess = null; currentEngineModel = null; });

      // 等待引擎就绪（最多 60s，大模型加载需时间）
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isEngineRunning()) {
          currentEngineModel = path.basename(modelPath);
          return { success: true, model: path.basename(modelPath), url: 'http://127.0.0.1:8080/v1' };
        }
      }
      return { success: false, error: '引擎启动超时（模型加载缓慢或显存不足）' };
    } catch (e) {
      return { success: false, error: '启动引擎失败: ' + (e.message || String(e)) };
    }
  }
  ipcMain.handle('system:startLLMEngine', async (_, opts) => startEngineInternal((opts || {}).modelFile));

  // 停止 llama 引擎
  ipcMain.handle('system:stopLLMEngine', async () => {
    try {
      try { execSync('taskkill /IM llama-server.exe /F', { stdio: 'ignore' }); } catch (ke) {}
      if (engineProcess) { engineProcess.kill(); engineProcess = null; }
      currentEngineModel = null;
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
      } catch (e) { /* ollama 未安装 */ }
      if (result.ollama) {
        try {
          const list = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
          result.ollamaRunning = true;
          const lines = list.trim().split('\n').slice(1);
          result.models = lines.map(l => {
            const parts = l.split(/\s+/);
            return { name: parts[0], id: parts[1] ? parts[1].substring(0, 12) : '', size: parts[2] || '' };
          }).filter(m => m.name);
        } catch (e) { /* ollama 未运行 */ }
      }
    } catch (e) { console.error('LLM 运行时检测失败:', e.message); }
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
}

// ============ 自动更新 ============
function setupAutoUpdate() {
  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', info);
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('update:progress', progress);
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update:downloaded');
    });

    autoUpdater.on('error', (error) => {
      console.error('自动更新错误:', error.message);
    });

    ipcMain.handle('update:check', async () => {
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
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

    // 启动后 5 秒检查更新
    setTimeout(() => {
      if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
    }, 5000);

  } catch (e) {
    console.warn('自动更新模块加载失败:', e.message);
  }
}

// ============ 应用生命周期 ============
app.whenReady().then(() => {
  console.log('🚀 BubaiCode 启动中...');
  console.log('📁 用户数据目录:', USER_DATA_PATH);
  console.log('🔧 开发模式:', isDev);

  createMenu();
  setupIPC();
  setupAutoUpdate();
  createMainWindow();

  // 启动已配置的 MCP 服务器（stdio）
  try {
    require('./mcp').getMcpService().startAll();
    console.log('🧩 MCP 服务器检查完成');
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

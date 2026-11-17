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
    theme: 'dark',
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

  // ============ AI 对话（OpenAI 兼容 API：DeepSeek / Ollama / 自定义）============
  const AI_PROVIDERS = {
    deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    ollama:   { baseURL: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b' },
    openai:   { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
    custom:   { baseURL: '', defaultModel: '' }
  };

  ipcMain.handle('ai:chat', async (_, options) => {
    const { messages, model, temperature = 0.7, maxTokens = 4096 } = options || {};
    const aiCfg = config.ai || {};
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = aiCfg.baseURL || provider.baseURL;
    const useModel = model || aiCfg.model || provider.defaultModel;
    const apiKey = aiCfg.apiKey || '';

    if (!baseURL) {
      return { success: false, error: '未配置 API baseURL，请在设置中配置' };
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: '消息为空' };
    }

    try {
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

  ipcMain.handle('ai:checkConnection', async (_, testConfig) => {
    // 测试 AI 连接（发一条最短消息）
    const aiCfg = { ...(config.ai || {}), ...(testConfig || {}) };
    const provider = AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.deepseek;
    const baseURL = aiCfg.baseURL || provider.baseURL;
    const useModel = aiCfg.model || provider.defaultModel;
    if (!baseURL) return { success: false, error: '未配置 baseURL' };
    try {
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
  const ARDUINO_CLI = path.join(app.getPath('appData'), 'codelab-desktop', 'tools', 'arduino-cli', 'arduino-cli.exe');

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

  ipcMain.handle('compile:arduino', async (_, options) => {
    const { sketchPath, fqbn, outputDir } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    if (!fqbn) return { success: false, error: '缺少 fqbn（开发板型号）' };
    const args = ['compile', '--fqbn', fqbn];
    if (outputDir) args.push('--output-dir', outputDir);
    args.push(sketchPath);
    return await runArduinoCli(args, path.dirname(sketchPath));
  });

  ipcMain.handle('compile:upload', async (_, options) => {
    const { sketchPath, fqbn, port } = options || {};
    if (!sketchPath) return { success: false, error: '缺少 sketchPath' };
    if (!fqbn) return { success: false, error: '缺少 fqbn' };
    if (!port) return { success: false, error: '缺少串口（port）' };
    const args = ['upload', '--fqbn', fqbn, '--port', port, sketchPath];
    return await runArduinoCli(args, path.dirname(sketchPath));
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

  // 检测本地大模型运行时（Ollama 等）
  ipcMain.handle('system:checkLLMRuntime', async () => {
    const result = { ollama: false, ollamaVersion: null, ollamaRunning: false, models: [] };
    try {
      const { execSync } = require('child_process');
      // 检测 ollama 是否安装
      try {
        const ver = execSync('ollama --version', { encoding: 'utf8', timeout: 5000 });
        result.ollama = true;
        result.ollamaVersion = ver.trim();
      } catch (e) { /* ollama 未安装 */ }
      // 检测 ollama 服务是否运行并列出模型
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

    ipcMain.handle('update:check', () => autoUpdater.checkForUpdates());
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
});

// 防止 GPU 进程崩溃
app.on('gpu-process-crashed', (event, killed) => {
  console.error('GPU 进程崩溃:', killed);
});

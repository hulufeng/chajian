// ============ LabCode Preload 预加载脚本 ============
// 暴露安全的 IPC 接口给渲染进程

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LabCode', {
  // 系统
  getCwd: () => ipcRenderer.invoke('app:getCwd'),

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized')
  },

  // 配置
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    save: (config) => ipcRenderer.invoke('config:save', config)
  },

  // 会话
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id)
  },

  // 对话框
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    saveFile: (defaultPath) => ipcRenderer.invoke('dialog:saveFile', defaultPath)
  },

  // 文件系统
  // Plugin transports that need OS access (child process / sockets)
  plugin: {
    stdioCall: (opts) => ipcRenderer.invoke('plugin:stdioCall', opts),
    grpcCall: (opts) => ipcRenderer.invoke('plugin:grpcCall', opts),
    mqttCall: (opts) => ipcRenderer.invoke('plugin:mqttCall', opts),
    cliCall: (opts) => ipcRenderer.invoke('plugin:cliCall', opts),
    unzip: (opts) => ipcRenderer.invoke('plugin:unzip', opts)
  },
  fs: {
    readFile: (filePath, encoding) => ipcRenderer.invoke('fs:readFile', filePath, encoding),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
    copyFile: (srcPath, destPath) => ipcRenderer.invoke('fs:copyFile', srcPath, destPath),
    deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
    mkdir: (dirPath) => ipcRenderer.invoke('fs:mkdir', dirPath),
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
    readPdf: (filePath, maxPages) => ipcRenderer.invoke('fs:readPdf', filePath, maxPages),
    analyzeImage: (filePath, prompt) => ipcRenderer.invoke('fs:analyzeImage', filePath, prompt)
  },

  // 外部链接
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // 应用信息
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPath: (name) => ipcRenderer.invoke('app:getPath', name),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform')
  },

  // 系统配置检测（大模型推荐用）
  system: {
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
    checkLLMRuntime: () => ipcRenderer.invoke('system:checkLLMRuntime'),
    startLLMEngine: (opts) => ipcRenderer.invoke('system:startLLMEngine', opts),
    stopLLMEngine: () => ipcRenderer.invoke('system:stopLLMEngine'),
    // 模型目录：当前 / 推荐（SSD 优先）/ 各卷情况
    probeModelDirs: () => ipcRenderer.invoke('system:probeModelDirs'),
    // 一键迁移已装模型到目标目录（跨平台，带进度）
    migrateModels: (opts) => ipcRenderer.invoke('system:migrateModels', opts),
    onMigrateProgress: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch (err) {} };
      ipcRenderer.on('system:migrateProgress', handler);
      return () => ipcRenderer.removeListener('system:migrateProgress', handler);
    },
    // 引擎加载阶段（loading / gpu / ctx / ready / stopped）→ 用于显示"正在加载模型…"
    onEngineProgress: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch (err) {} };
      ipcRenderer.on('system:engineProgress', handler);
      return () => ipcRenderer.removeListener('system:engineProgress', handler);
    }
  },

  // 代理
  proxy: {
    set: (config) => ipcRenderer.invoke('proxy:set', config)
  },

  // 自动更新
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install')
  },

  // 看板（对齐 Ekko 看板）
  dashboard: {
    stats: (rootPath) => ipcRenderer.invoke('dashboard:stats', rootPath)
  },

  // 区域截图（对齐 Ekko regionSelection）
  regionShot: {
    start: () => ipcRenderer.invoke('screenshot:region'),
    cancel: () => ipcRenderer.invoke('region:cancel')
  },

  // 剪贴板（朗读用）
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },

  // 终端
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    getBuffer: (id) => ipcRenderer.invoke('terminal:getBuffer', id),
    clearBuffer: (id) => ipcRenderer.invoke('terminal:clearBuffer', id),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    list: () => ipcRenderer.invoke('terminal:list'),
    execute: (command, cwd, timeout, opts) => ipcRenderer.invoke('terminal:execute', command, cwd, timeout, opts),
    onData: (id, callback) => {
      const channel = `terminal:data:${id}`;
      ipcRenderer.on(channel, (_, data) => callback(data));
      return () => ipcRenderer.removeListener(channel, callback);
    },
    onExit: (id, callback) => {
      const channel = `terminal:exit:${id}`;
      ipcRenderer.on(channel, (_, data) => callback(data));
      return () => ipcRenderer.removeListener(channel, callback);
    }
  },

  // 工具链（自研本体 P0-1：arduino-cli 路径探测）
  toolchain: {
    getArduinoCliPath: () => ipcRenderer.invoke('toolchain:getArduinoCliPath'),
    status: () => ipcRenderer.invoke('toolchain:status'),
    ensure: () => ipcRenderer.invoke('toolchain:ensure'),
    installCli: () => ipcRenderer.invoke('toolchain:installCli'),
    onProgress: (cb) => ipcRenderer.on('toolchain:progress', (_e, data) => cb(data))
  },

  // MCP 服务器（Model Context Protocol stdio 接入）
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    addServer: (cfg) => ipcRenderer.invoke('mcp:add-server', cfg),
    removeServer: (name) => ipcRenderer.invoke('mcp:remove-server', name),
    listTools: (name) => ipcRenderer.invoke('mcp:list-tools', name),
    callTool: (serverName, toolName, args) => ipcRenderer.invoke('mcp:call-tool', serverName, toolName, args),
    startAll: () => ipcRenderer.invoke('mcp:start-all'),
    stopAll: () => ipcRenderer.invoke('mcp:stop-all'),
    startServer: (name) => ipcRenderer.invoke('mcp:start-server', name),
    stopServer: (name) => ipcRenderer.invoke('mcp:stop-server', name),
    testConnection: (name) => ipcRenderer.invoke('mcp:testConnection', name),
    authorize: (name) => ipcRenderer.invoke('mcp:authorize', name)
  },

  // LSP 客户端（clangd 等）
  lsp: {
    start: (cfg) => ipcRenderer.invoke('lsp:start', cfg),
    request: (req) => ipcRenderer.invoke('lsp:request', req),
    notify: (req) => ipcRenderer.invoke('lsp:notify', req),
    stop: (cfg) => ipcRenderer.invoke('lsp:stop', cfg)
  },

  // Git
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    add: (cwd, paths) => ipcRenderer.invoke('git:add', cwd, paths),
    commit: (cwd, msg) => ipcRenderer.invoke('git:commit', cwd, msg),
    log: (cwd, n) => ipcRenderer.invoke('git:log', cwd, n),
    push: (cwd) => ipcRenderer.invoke('git:push', cwd),
    pull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
    diff: (cwd, filePath) => ipcRenderer.invoke('git:diff', cwd, filePath),
    branches: (cwd) => ipcRenderer.invoke('git:branches', cwd),
    checkout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),
    createBranch: (cwd, branch) => ipcRenderer.invoke('git:createBranch', cwd, branch),
    unstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
    discard: (cwd, paths) => ipcRenderer.invoke('git:discard', cwd, paths),
    clone: (url, destDir) => ipcRenderer.invoke('git:clone', url, destDir)
  },

  // Hermes: 记忆搜索 + Webhook + SSH
  memory: {
    search: (q) => ipcRenderer.invoke('memory:search', q)
  },
  // 真实联网搜索/抓取（Bing 端点，无 API Key；失败时渲染端降级 mock 并标注）
  web: {
    search: (query, options) => ipcRenderer.invoke('web:search', query, options),
    fetch: (url, options) => ipcRenderer.invoke('web:fetch', url, options),
    stats: () => ipcRenderer.invoke('web:stats'),
    clearCache: () => ipcRenderer.invoke('web:clear-cache')
  },
  webhook: {
    start: (port) => ipcRenderer.invoke('webhook:start', port),
    stop: () => ipcRenderer.invoke('webhook:stop'),
    onMessage: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('webhook:message', h);
      return () => ipcRenderer.removeListener('webhook:message', h);
    }
  },
  ssh: {
    exec: (opts) => ipcRenderer.invoke('ssh:exec', opts)
  },

  // 文件检查点 + 回滚
  checkpoint: {
    list: () => ipcRenderer.invoke('checkpoint:list'),
    rollback: (cpFile) => ipcRenderer.invoke('checkpoint:rollback', cpFile),
    clearOld: (keep) => ipcRenderer.invoke('checkpoint:clearOld', keep)
  },

  // Ollama 管理
  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    pull: (model) => ipcRenderer.invoke('ollama:pull', model),
    startServer: () => ipcRenderer.invoke('ollama:startServer'),
    openDownload: () => ipcRenderer.invoke('ollama:openDownload')
  },

  // DAP 调试器
  dap: {
    start: (opts) => ipcRenderer.invoke('dap:start', opts),
    request: (opts) => ipcRenderer.invoke('dap:request', opts),
    stop: (sessionId) => ipcRenderer.invoke('dap:stop', { sessionId }),
    ensureDebugpy: () => ipcRenderer.invoke('dap:ensureDebugpy'),
    toolPath: (name) => ipcRenderer.invoke('dap:toolPath', name),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('dap:event', handler);
      return () => ipcRenderer.removeListener('dap:event', handler);
    }
  },

  // 工具自动下载
  tools: {
    ensureClangd: () => ipcRenderer.invoke('tools:ensure-clangd')
  },

  // 串口日志
  serialLog: {
    tail: (opts) => ipcRenderer.invoke('serial:log-tail', opts),
    grep: (opts) => ipcRenderer.invoke('serial:log-grep', opts),
    analyzeCrash: () => ipcRenderer.invoke('serial:log-analyze-crash')
  },

  // AI 对话
  ai: {
    chat: (options) => ipcRenderer.invoke('ai:chat', options),
    chatStream: (options) => ipcRenderer.invoke('ai:chatStream', options),
    chatCancel: (runId) => ipcRenderer.invoke('ai:chatCancel', runId),
    checkConnection: (testConfig) => ipcRenderer.invoke('ai:checkConnection', testConfig),
    // 本地模型服务状态（Ollama 等）：只探测存活与已装模型，不发起推理
    localStatus: (testConfig) => ipcRenderer.invoke('ai:localStatus', testConfig),
    gatewayAuth: (opts) => ipcRenderer.invoke('ai:gatewayAuth', opts),
    // 网关可用性（是否有内置凭据 / 用户是否登录 / 额度）—— 决定要不要强制注册
    gatewayStatus: () => ipcRenderer.invoke('ai:gatewayStatus'),
    // 网关真实模型池（/api/models）——云端模型列表由服务器下发，不写死
    gatewayModels: () => ipcRenderer.invoke('ai:gatewayModels'),
    // 订阅流式事件（SSE 过程推送）
    onStream: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('ai:stream', listener);
      return listener;
    },
    offStream: (listener) => {
      if (listener) ipcRenderer.removeListener('ai:stream', listener);
    }
  },

  // Arduino 编译/烧录
  compile: {
    arduino: (options) => ipcRenderer.invoke('compile:arduino', options),
    upload: (options) => ipcRenderer.invoke('compile:upload', options),
    listCores: () => ipcRenderer.invoke('compile:list-cores'),
    listBoards: () => ipcRenderer.invoke('compile:list-boards'),
    listPorts: () => ipcRenderer.invoke('compile:list-ports'),
    cliExists: () => ipcRenderer.invoke('compile:cli-exists')
  },

  // 串口监视器
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options) => ipcRenderer.invoke('serial:open', options),
    close: () => ipcRenderer.invoke('serial:close'),
    write: (data) => ipcRenderer.invoke('serial:write', data),
    onData: (callback) => {
      const listener = (_e, data) => callback(data);
      ipcRenderer.on('serial:data', listener);
      return () => ipcRenderer.removeListener('serial:data', listener);
    },
    onClosed: (callback) => {
      const listener = (_e, info) => callback(info);
      ipcRenderer.on('serial:closed', listener);
      return () => ipcRenderer.removeListener('serial:closed', listener);
    }
  },

  // 事件监听
  // Generic IPC invoke used by renderer panels (schedule / context / ghost completion).
  // Without it, LabCodeUI.ipcInvoke falls back to require('electron'), which is NOT
  // available under contextIsolation -> every panel IPC call would reject.
  ipc: {
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload)
  },

  // Scheduled tasks (mirrors the schedule:* handlers registered in main)
  schedule: {
    createTask: (opts) => ipcRenderer.invoke('schedule:createTask', opts),
    listInbox: () => ipcRenderer.invoke('schedule:listInbox'),
    listRuns: (opts) => ipcRenderer.invoke('schedule:listRuns', opts),
    runNow: (opts) => ipcRenderer.invoke('schedule:runNow', opts),
    status: () => ipcRenderer.invoke('schedule:status'),
    getPatch: (opts) => ipcRenderer.invoke('schedule:getPatch', opts),
    previewSlots: (opts) => ipcRenderer.invoke('schedule:previewSlots', opts),
    applyPatch: (opts) => ipcRenderer.invoke('schedule:applyPatch', opts),
    discardPatch: (opts) => ipcRenderer.invoke('schedule:discardPatch', opts),
    // 调度触发工作流（主进程 → 渲染进程执行 → 回报）
    onExecWorkflow: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('schedule:exec-workflow', listener);
      return listener;
    },
    sendWorkflowResult: (data) => ipcRenderer.send('schedule:workflow-result', data)
  },
  // Coding-Agent CLI 安装/检测（对齐 Ekko Agent Manager）
  codingAgents: {
    list: () => ipcRenderer.invoke('codingAgents:list'),
    detect: (opts) => ipcRenderer.invoke('codingAgents:detect', opts),
    install: (opts) => ipcRenderer.invoke('codingAgents:install', opts),
    update: (opts) => ipcRenderer.invoke('codingAgents:update', opts),
    remove: (opts) => ipcRenderer.invoke('codingAgents:remove', opts),
    run: (opts) => ipcRenderer.invoke('codingAgents:run', opts),
    onProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('codingAgents:progress', listener);
      return listener;
    },
    offProgress: (listener) => { if (listener) ipcRenderer.removeListener('codingAgents:progress', listener); }
  },

  on: (channel, callback) => {
    const allowedChannels = [
      'update:available', 'update:not-available', 'update:progress', 'update:downloaded',
      'menu:new-project', 'menu:open-project', 'menu:save', 'menu:save-as'
    ];
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => callback(...args));
    }
  },

  // 移除事件监听
  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});

console.log('✅ LabCode preload 加载完成');

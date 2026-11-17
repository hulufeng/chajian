// ============ BubaiCode Preload 预加载脚本 ============
// 暴露安全的 IPC 接口给渲染进程

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('BubaiCode', {
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
  fs: {
    readFile: (filePath, encoding) => ipcRenderer.invoke('fs:readFile', filePath, encoding),
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath)
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
    checkLLMRuntime: () => ipcRenderer.invoke('system:checkLLMRuntime')
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

  // 终端
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    getBuffer: (id) => ipcRenderer.invoke('terminal:getBuffer', id),
    clearBuffer: (id) => ipcRenderer.invoke('terminal:clearBuffer', id),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    list: () => ipcRenderer.invoke('terminal:list'),
    execute: (command, cwd, timeout) => ipcRenderer.invoke('terminal:execute', command, cwd, timeout),
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

  // AI 对话
  ai: {
    chat: (options) => ipcRenderer.invoke('ai:chat', options),
    checkConnection: (testConfig) => ipcRenderer.invoke('ai:checkConnection', testConfig)
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

console.log('✅ BubaiCode preload 加载完成');

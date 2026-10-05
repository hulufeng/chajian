import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

export interface ToolchainStatus {
  available: boolean
  version: string
  path: string | null
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  friendlyName?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiModel {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  costPerCall: number
  desc: string
  available: boolean
}

export interface AiState {
  token: string | null
  email: string | null
  planCredits: number | null
  rechargeCredits: number | null
  totalCredits: number | null
  planMonth: string | null
  modelId: string
  byok: { baseUrl: string; apiKey: string; model: string } | null
  byokProfiles?: ByokProfile[]
  activeByokId?: string | null
}

export interface ByokProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface UserInfo {
  email: string
  planCredits: number
  rechargeCredits: number
  totalCredits: number
  planMonth: string
}

export interface ChatResult {
  content: string
  creditsLeft?: number
  cost?: number
}

export interface TaskOutput {
  id: string
  chunk: string
}

export interface TaskExit {
  id: string
  code: number
}

export interface TaskProgress {
  id: string
  percent: number
  message: string
}

export interface UpdaterStatus {
  state: 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'postponed' | 'error'
  info?: { version: string; forceUpdate?: boolean; notes?: string; url?: string }
  progress?: number
  bytes?: number
  total?: number
  message?: string
  force?: boolean
}

export interface GitFileChange {
  path: string
  originalPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'
  staged: boolean
  unstaged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
}

export interface GitLogEntry {
  sha: string
  author: string
  date: string
  subject: string
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  platform: process.platform,

  // 视图
  view: {
    zoomIn: (): Promise<boolean> => ipcRenderer.invoke('view:zoomIn'),
    zoomOut: (): Promise<boolean> => ipcRenderer.invoke('view:zoomOut'),
    zoomReset: (): Promise<boolean> => ipcRenderer.invoke('view:zoomReset'),
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('view:toggleFullscreen')
  },

  // 窗口控制（自定义标题栏用）
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<boolean> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onStateChanged: (cb: (state: { maximized: boolean }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: { maximized: boolean }): void => cb(state)
      ipcRenderer.on('window:state-changed', listener)
      return () => ipcRenderer.removeListener('window:state-changed', listener)
    }
  },

  // 项目 / 文件
  project: {
    open: (): Promise<{ root: string; tree: TreeNode } | null> => ipcRenderer.invoke('project:open'),
    tree: (root: string): Promise<TreeNode> => ipcRenderer.invoke('project:tree', root),
    create: (opts: { type: string; name: string; parentPath?: string; scaffold?: Array<{ file: string; content: string }> }): Promise<{ ok: boolean; root?: string; tree?: TreeNode; error?: string }> =>
      ipcRenderer.invoke('project:create', opts)
  },
  fs: {
    read: (path: string): Promise<string> => ipcRenderer.invoke('fs:readFile', path),
    write: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('fs:writeFile', path, content),
    readImage: (path: string): Promise<string> => ipcRenderer.invoke('fs:readImage', path),
    /** 内置示例/未保存的 .ino 暂存为真实临时工程，返回绝对路径（供编译/烧录） */
    stageTemp: (name: string, content: string): Promise<string> => ipcRenderer.invoke('fs:stageTempSketch', name, content)
  },



  // 工具链（arduino-cli）
  toolchain: {
    detect: (): Promise<ToolchainStatus> => ipcRenderer.invoke('toolchain:detect'),
    detectDirect: (): Promise<ToolchainStatus> => ipcRenderer.invoke('toolchain:detectDirect'),
    compile: (opts: { sketch: string; fqbn: string; bin: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('toolchain:compile', opts),
    upload: (opts: { sketch: string; fqbn: string; bin: string; port: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('toolchain:upload', opts),
    install: (): Promise<{ success: boolean; path: string | null; error?: string }> =>
      ipcRenderer.invoke('toolchain:install'),
    onInstallProgress: (cb: (p: { phase: string; percent: number; message: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { phase: string; percent: number; message: string }): void => cb(p)
      ipcRenderer.on('toolchain:install-progress', listener)
      return () => ipcRenderer.removeListener('toolchain:install-progress', listener)
    }
  },

  // 应用路径
  app: {
    getExamplesDir: (): Promise<string> => ipcRenderer.invoke('app:getExamplesDir'),
  },

  // 命令执行（终端）
  cmd: {
    run: (opts: { cmd: string; cwd: string; shell?: 'powershell' | 'cmd' | 'pwsh' | 'bash' }): Promise<{ id: string }> =>
      ipcRenderer.invoke('cmd:run', opts),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('task:kill', id)
  },



  // 真终端（node-pty）
  pty: {
    start: (opts: { shell?: string; cwd?: string; cols?: number; rows?: number }): Promise<{ id: string; error?: string }> =>
      ipcRenderer.invoke('pty:start', opts),
    write: (opts: { id: string; data: string }): Promise<boolean> => ipcRenderer.invoke('pty:write', opts),
    resize: (opts: { id: string; cols: number; rows: number }): Promise<boolean> => ipcRenderer.invoke('pty:resize', opts),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),
    onData: (cb: (d: { id: string; data: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { id: string; data: string }): void => cb(d)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (d: { id: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { id: string }): void => cb(d)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  },





  // 串口
  serial: {
    list: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('serial:list'),
    open: (opts: { port: string; baud: number }): Promise<{ id: string }> =>
      ipcRenderer.invoke('serial:open', opts),
    close: (id: string): Promise<boolean> => ipcRenderer.invoke('task:kill', id),
    write: (opts: { id: string; data: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('serial:write', opts),
    // 热插拔：串口列表变化（插上/拔出开发板）
    onPortsChanged: (cb: (d: { ports: Array<{ path: string; manufacturer?: string; friendlyName?: string }>; added: string[]; removed: string[] }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { ports: Array<{ path: string; manufacturer?: string; friendlyName?: string }>; added: string[]; removed: string[] }): void => cb(d)
      ipcRenderer.on('serial:ports-changed', listener)
      return () => ipcRenderer.removeListener('serial:ports-changed', listener)
    }
  },

  // AI
  ai: {
    chat: (messages: ChatMessage[]): Promise<ChatResult> => ipcRenderer.invoke('ai:chat', messages),
    models: (): Promise<AiModel[]> => ipcRenderer.invoke('ai:models'),
    state: (): Promise<AiState> => ipcRenderer.invoke('ai:state'),
    setModel: (modelId: string): Promise<AiState> => ipcRenderer.invoke('ai:setModel', modelId),
    setByok: (byok: { baseUrl: string; apiKey: string; model: string } | null): Promise<AiState> =>
      ipcRenderer.invoke('ai:setByok', byok),
    // 多 BYOK profile
    byokProfiles: (): Promise<ByokProfile[]> => ipcRenderer.invoke('ai:byokProfiles'),
    byokSave: (profile: ByokProfile): Promise<AiState> => ipcRenderer.invoke('ai:byokSave', profile),
    byokDelete: (id: string): Promise<AiState> => ipcRenderer.invoke('ai:byokDelete', id),
    byokActivate: (id: string | null): Promise<AiState> => ipcRenderer.invoke('ai:byokActivate', id)
  },



  // 本地模型（供 AiPanel 选择本地 llama 通道）
  model: {
    local: (): Promise<Array<{
      id: string; name: string; sizeGB: number; params?: string
      parameters: string; modifiedAt?: string
    }>> => ipcRenderer.invoke('model:local')
  },




  // Agent 智能体（工具调用闭环）
  agent: {
    start: (opts: {
      messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
      model?: string
      localModel?: string
      securityMode?: 'auto' | 'default' | 'plan'
      thinkingLevel?: 'light' | 'standard' | 'deep'
      projectRoot?: string | null
      maxTurns?: number
      debugMode?: boolean
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('agent:start', opts),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('agent:stop'),
    respond: (action: 'allow_once' | 'allow_session' | 'reject'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('agent:respond', action),
    planRespond: (opts: { action: 'approve' | 'reject' | 'feedback'; feedback?: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('agent:planRespond', opts),
    askRespond: (opts: { answers: string[] }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('agent:askRespond', opts),
    status: (): Promise<{ status: string; stats?: unknown }> => ipcRenderer.invoke('agent:status'),
    onEvent: (cb: (event: { type: string; data?: unknown }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, ev: { type: string; data?: unknown }): void => cb(ev)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    }
  },

  // 插件系统
  plugin: {
    list: (): Promise<Array<{ manifest: { name: string; displayName: string; version: string }; loaded: boolean; error?: string }>> =>
      ipcRenderer.invoke('plugin:list'),
    projectTypes: (): Promise<Array<{ id: string; title: string; icon?: string; scaffold: Array<{ file: string; content: string }> }>> =>
      ipcRenderer.invoke('plugin:projectTypes'),
    capabilities: (): Promise<Record<string, { transport: string; service?: string; method?: string; plugin: string }>> =>
      ipcRenderer.invoke('plugin:capabilities'),
    devicePanels: (): Promise<Array<{ plugin: string; id: string; title: string; icon?: string; selectors: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }>> =>
      ipcRenderer.invoke('plugin:devicePanels'),
    commands: (): Promise<Array<{ plugin: string; id: string; title: string; icon?: string; kind: string; view?: string; placement?: string; when?: string; transport?: string }>> =>
      ipcRenderer.invoke('plugin:commands'),
  },

  // 设备上下文（选中的开发板/端口）
  device: {
    get: (): Promise<{ board: string; port: string }> => ipcRenderer.invoke('device:get'),
    set: (opts: { board?: string; port?: string }): Promise<boolean> => ipcRenderer.invoke('device:set', opts),
    // 热插拔自动选中：插入开发板时携带识别到的端口与板卡 FQBN
    onAutoSelect: (cb: (d: { action: 'added' | 'removed'; port: string; fqbn: string; name: string; removed?: string[] }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { action: 'added' | 'removed'; port: string; fqbn: string; name: string; removed?: string[] }): void => cb(d)
      ipcRenderer.on('device:auto-select', listener)
      return () => ipcRenderer.removeListener('device:auto-select', listener)
    }
  },

  // 开发板列表
  board: {
    list: (keyword?: string): Promise<Array<{ fqbn: string; name: string; platform?: string }>> => ipcRenderer.invoke('board:list', keyword),
    details: (fqbn: string): Promise<{ fqbn: string; name: string; options: Array<{ option: string; label: string; values: Array<{ value: string; label: string }> }> }> => ipcRenderer.invoke('board:details', fqbn)
  },

  // 接线图自动生成
  wiring: {
    generate: (opts: { fqbn?: string; projectRoot?: string }): Promise<{ ok: boolean; fqbn?: string; svg?: string; components?: unknown[]; pins?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('wiring:generate', opts)
  },

  // 平台管理（Arduino core）
  core: {
    list: (): Promise<{ platforms: Array<{ id: string; version: string; name?: string; architecture?: string }> }> => ipcRenderer.invoke('platform:list'),
    search: (keyword: string): Promise<{ platforms: Array<{ id: string; name: string; latestVersion?: string }> }> => ipcRenderer.invoke('platform:search', { keyword }),
    install: (platform: string): Promise<{ id: string; error?: string }> => ipcRenderer.invoke('platform:install', { platform }),
    uninstall: (platform: string): Promise<{ id: string; error?: string }> => ipcRenderer.invoke('platform:uninstall', { platform })
  },

  // 库管理
  library: {
    list: (): Promise<{ libraries: Array<{ name: string; version: string; author?: string; sentence?: string }> }> => ipcRenderer.invoke('library:list'),
    search: (keyword: string): Promise<{ libraries: Array<{ name: string; version: string; author?: string; sentence?: string }> }> => ipcRenderer.invoke('library:search', { keyword }),
    install: (name: string): Promise<{ id: string; error?: string }> => ipcRenderer.invoke('library:install', { name }),
    uninstall: (name: string): Promise<{ id: string; error?: string }> => ipcRenderer.invoke('library:uninstall', { name })
  },

  // 工具链设置（开发板管理器附加地址等）
  settings: {
    getBoardUrls: (): Promise<{ urls: string[] }> => ipcRenderer.invoke('settings:getBoardUrls'),
    setBoardUrls: (urls: string[]): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:setBoardUrls', { urls }),
    resetBoardUrls: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:resetBoardUrls')
  },

  // gRPC daemon（arduino-cli daemon 模式）
  grpc: {
    start: (opts?: { binPath?: string }): Promise<{ connected: boolean; port: number | null; error: string | null }> =>
      ipcRenderer.invoke('grpc:start', opts),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('grpc:stop'),
    state: (): Promise<{ connected: boolean; port: number | null; error: string | null }> =>
      ipcRenderer.invoke('grpc:state'),
    compile: (opts: { sketch: string; fqbn: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('grpc:compile', opts),
    upload: (opts: { sketch: string; fqbn: string; port: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('grpc:upload', opts)
  },

  // 能力驱动（capability 能力路由模式）
  capability: {
    list: (): Promise<Record<string, { transport: string; service?: string; method?: string; plugin: string }>> =>
      ipcRenderer.invoke('plugin:capabilities'),
    run: (capability: string, args: Record<string, unknown>): Promise<{ ok: boolean; taskId?: string; error?: string; result?: unknown }> =>
      ipcRenderer.invoke('capability:run', { capability, args })
  },



  // 更新（强制更新 / 自动更新）
  updater: {
    check: (opts?: { interactive?: boolean }): Promise<void> => ipcRenderer.invoke('updater:check', opts),
    getBaseUrl: (): Promise<string> => ipcRenderer.invoke('updater:getBaseUrl'),
    onStatus: (cb: (s: UpdaterStatus) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, s: UpdaterStatus): void => cb(s)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    }
  },

  // 事件订阅（流式输出）
  onTaskOutput: (cb: (d: TaskOutput) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: TaskOutput): void => cb(d)
    ipcRenderer.on('task:output', listener)
    return () => ipcRenderer.removeListener('task:output', listener)
  },
  onTaskExit: (cb: (d: TaskExit) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: TaskExit): void => cb(d)
    ipcRenderer.on('task:exit', listener)
    return () => ipcRenderer.removeListener('task:exit', listener)
  },
  onTaskProgress: (cb: (d: TaskProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: TaskProgress): void => cb(d)
    ipcRenderer.on('task:progress', listener)
    return () => ipcRenderer.removeListener('task:progress', listener)
  },
  onSerialData: (cb: (d: { id: string; data: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: { id: string; data: string }): void => cb(d)
    ipcRenderer.on('serial:data', listener)
    return () => ipcRenderer.removeListener('serial:data', listener)
  },
  onSerialClose: (cb: (d: { id: string; msg: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: { id: string; msg: string }): void => cb(d)
    ipcRenderer.on('serial:close', listener)
    return () => ipcRenderer.removeListener('serial:close', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api

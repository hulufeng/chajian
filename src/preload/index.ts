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
    readImage: (path: string): Promise<string> => ipcRenderer.invoke('fs:readImage', path)
  },

  // Git 源代码管理
  git: {
    status: (root: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', root),
    diff: (opts: { root: string; path: string; staged: boolean }): Promise<string> => ipcRenderer.invoke('git:diff', opts),
    stage: (opts: { root: string; paths: string[] }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:stage', opts),
    stageAll: (root: string): Promise<{ ok: boolean; error?: string; skipped?: string[] }> => ipcRenderer.invoke('git:stageAll', root),
    unstage: (opts: { root: string; paths: string[] }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:unstage', opts),
    commit: (opts: { root: string; message: string }): Promise<{ ok: boolean; error?: string; sha?: string }> => ipcRenderer.invoke('git:commit', opts),
    init: (root: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:init', root),
    log: (opts: { root: string; n?: number }): Promise<GitLogEntry[]> => ipcRenderer.invoke('git:log', opts),
    pull: (root: string): Promise<{ ok: boolean; text: string }> => ipcRenderer.invoke('git:pull', root),
    push: (root: string): Promise<{ ok: boolean; text: string }> => ipcRenderer.invoke('git:push', root),
    applyPatch: (opts: { root: string; patch: string; cached?: boolean }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:applyPatch', opts)
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

  // 模拟烧录（软件内虚拟开发板）
  simBurn: {
    list: (): Promise<Array<{ id: string; name: string; revision: string; mac: string }>> =>
      ipcRenderer.invoke('simBurn:list'),
    demos: (): Promise<Array<{
      id: string
      name: string
      chip: string
      baud: number
      files: Array<{ label: string; path: string; addr: number }>
    }>> => ipcRenderer.invoke('simBurn:demos'),
    start: (opts: { chipId: string; files: Array<{ addr: number; path: string; label: string }>; baud?: number }): Promise<{ id: string }> =>
      ipcRenderer.invoke('simBurn:start', opts),
    collectBuild: (opts: { buildPath: string }): Promise<{ ok: boolean; files?: Array<{ label: string; path: string; addr: number }>; error?: string }> =>
      ipcRenderer.invoke('simBurn:collectBuild', opts),
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

  // MCP 服务器配置
  mcp: {
    list: (): Promise<Array<{ name: string; command: string; args?: string[]; transport?: string }>> => ipcRenderer.invoke('mcp:list'),
    add: (server: { name: string; command: string; args?: string[]; transport?: string }): Promise<boolean> => ipcRenderer.invoke('mcp:add', server),
    remove: (name: string): Promise<boolean> => ipcRenderer.invoke('mcp:remove', name),
    test: (server: { name: string; command: string; args?: string[] }): Promise<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string }> => ipcRenderer.invoke('mcp:test', server)
  },

  // 搜索配置
  search: {
    getConfig: (): Promise<{ provider: string; tavilyKey: string; serperKey: string; braveKey: string }> => ipcRenderer.invoke('search:getConfig'),
    setConfig: (config: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('search:setConfig', config)
  },

  // 串口
  serial: {
    list: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('serial:list'),
    open: (opts: { port: string; baud: number }): Promise<{ id: string }> =>
      ipcRenderer.invoke('serial:open', opts),
    close: (id: string): Promise<boolean> => ipcRenderer.invoke('task:kill', id),
    write: (opts: { id: string; data: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('serial:write', opts)
  },

  // AI
  ai: {
    chat: (messages: ChatMessage[]): Promise<ChatResult> => ipcRenderer.invoke('ai:chat', messages),
    models: (): Promise<AiModel[]> => ipcRenderer.invoke('ai:models'),
    state: (): Promise<AiState> => ipcRenderer.invoke('ai:state'),
    register: (email: string, password: string): Promise<UserInfo> =>
      ipcRenderer.invoke('ai:register', email, password),
    login: (email: string, password: string): Promise<UserInfo> =>
      ipcRenderer.invoke('ai:login', email, password),
    logout: (): Promise<AiState> => ipcRenderer.invoke('ai:logout'),
    setModel: (modelId: string): Promise<AiState> => ipcRenderer.invoke('ai:setModel', modelId),
    setByok: (byok: { baseUrl: string; apiKey: string; model: string } | null): Promise<AiState> =>
      ipcRenderer.invoke('ai:setByok', byok),
    // 多 BYOK profile
    byokProfiles: (): Promise<ByokProfile[]> => ipcRenderer.invoke('ai:byokProfiles'),
    byokSave: (profile: ByokProfile): Promise<AiState> => ipcRenderer.invoke('ai:byokSave', profile),
    byokDelete: (id: string): Promise<AiState> => ipcRenderer.invoke('ai:byokDelete', id),
    byokActivate: (id: string | null): Promise<AiState> => ipcRenderer.invoke('ai:byokActivate', id)
  },

  // 硬件配置检测
  hardware: {
    info: (): Promise<{
      cpu: { model: string; cores: number; threads: number; architecture: string; speedMHz: number }
      totalRAMGB: number
      gpus: Array<{ name: string; vendor: string; vramMB: number; driverVersion?: string }>
      disks: Array<{ drive: string; totalGB: number; freeGB: number }>
      os: { platform: string; release: string; arch: string }
      capability: { canRun7B: boolean; canRun13B: boolean; canRun34B: boolean; hasGPU: boolean; vramGB: number }
    }> => ipcRenderer.invoke('hardware:info')
  },

  // 本地大模型管理
  model: {
    catalog: (): Promise<Array<{
      id: string; name: string; displayName: string; description: string
      parameters: string; quantization: string; sizeGB: number
      minRAMGB: number; minVRAMGB: number; ollamaTag: string
      ggufFile: string
      category: string; icon: string
    }>> => ipcRenderer.invoke('model:catalog'),
    recommend: (): Promise<Array<{
      id: string; name: string; displayName: string; description: string
      parameters: string; quantization: string; sizeGB: number
      minRAMGB: number; minVRAMGB: number; ollamaTag: string
      ggufFile: string
      category: string; icon: string
    }>> => ipcRenderer.invoke('model:recommend'),
    ollamaStatus: (): Promise<{ installed: boolean; running: boolean; version: string; engineDir: string }> =>
      ipcRenderer.invoke('model:ollamaStatus'),
    ensureEngine: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('model:ensureEngine'),
    startOllama: (): Promise<{ started: boolean }> =>
      ipcRenderer.invoke('model:startOllama'),
    local: (): Promise<Array<{
      id: string; name: string; sizeGB: number; quantization: string
      parameters: string; modifiedAt?: string
    }>> => ipcRenderer.invoke('model:local'),
    pull: (tag: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('model:pull', { tag }),
    delete: (tag: string): Promise<boolean> =>
      ipcRenderer.invoke('model:delete', tag),
    chat: (model: string, messages: Array<{ role: string; content: string }>): Promise<{ content: string }> =>
      ipcRenderer.invoke('model:chat', { model, messages }),
    onPullProgress: (cb: (p: { tag: string; status: string; percent: number; downloadedMB: number; totalMB: number }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { tag: string; status: string; percent: number; downloadedMB: number; totalMB: number }): void => cb(p)
      ipcRenderer.on('model:pullProgress', listener)
      return () => ipcRenderer.removeListener('model:pullProgress', listener)
    },
    onChatChunk: (cb: (p: { model: string; chunk: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { model: string; chunk: string }): void => cb(p)
      ipcRenderer.on('model:chatChunk', listener)
      return () => ipcRenderer.removeListener('model:chatChunk', listener)
    }
  },

  // 教学知识库插件化更新
  kb: {
    status: (): Promise<{ version: string; source: 'user' | 'builtin'; builtin: string }> =>
      ipcRenderer.invoke('kb:status'),
    check: (): Promise<{
      current: { version: string; source: 'user' | 'builtin' }
      latest: { version: string; zipUrl: string; sha256: string; note: string; updatedAt: string } | null
      hasUpdate: boolean
    }> => ipcRenderer.invoke('kb:check'),
    update: (): Promise<{ success: boolean; version?: string; error?: string }> =>
      ipcRenderer.invoke('kb:update'),
    reset: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('kb:reset'),
    onProgress: (cb: (p: { status: string; percent: number }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { status: string; percent: number }): void => cb(p)
      ipcRenderer.on('kb:progress', listener)
      return () => ipcRenderer.removeListener('kb:progress', listener)
    }
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
    // 插件市场
    market: (): Promise<Array<{ id: string; name: string; version: string; developer: string; icon: string; description: string; installedCount: number; updatedAt: string; downloadUrl: string; installed?: boolean }>> =>
      ipcRenderer.invoke('plugin:market'),
    installed: (): Promise<Array<{ id: string; name: string; version: string; path: string; enabled: boolean }>> =>
      ipcRenderer.invoke('plugin:installed'),
    install: (pluginId: string, downloadUrl: string): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke('plugin:install', pluginId, downloadUrl),
    uninstall: (pluginId: string): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke('plugin:uninstall', pluginId)
  },

  // 设备上下文（选中的开发板/端口）
  device: {
    get: (): Promise<{ board: string; port: string }> => ipcRenderer.invoke('device:get'),
    set: (opts: { board?: string; port?: string }): Promise<boolean> => ipcRenderer.invoke('device:set', opts)
  },

  // 开发板列表
  board: {
    list: (keyword?: string): Promise<Array<{ fqbn: string; name: string; platform?: string }>> => ipcRenderer.invoke('board:list', keyword),
    details: (fqbn: string): Promise<{ fqbn: string; name: string; options: Array<{ option: string; label: string; values: Array<{ value: string; label: string }> }> }> => ipcRenderer.invoke('board:details', fqbn)
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

  // 自动更新
  updater: {
    check: (): Promise<boolean> => ipcRenderer.invoke('update:check'),
    download: (): Promise<boolean> => ipcRenderer.invoke('update:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
    getUrl: (): Promise<{ dev: boolean; url: string | null }> => ipcRenderer.invoke('update:getUrl'),
    onEvent: (cb: (type: string, payload?: unknown) => void): (() => void) => {
      const channels = [
        'update:checking',
        'update:available',
        'update:not-available',
        'update:error',
        'update:progress',
        'update:downloaded'
      ]
      const listeners = channels.map((ch) => {
        const l = (_e: IpcRendererEvent, payload?: unknown): void => cb(ch.replace('update:', ''), payload)
        ipcRenderer.on(ch, l)
        return { ch, l }
      })
      return () => {
        for (const { ch, l } of listeners) ipcRenderer.removeListener(ch, l)
      }
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

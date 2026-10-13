import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// ── LSP 结果类型 ──
// 形状必须与 main/services/lsp/lspService.ts 保持一致；preload 刻意不引主进程模块（各 entry 独立打包）。
export interface LspResult<T> { ok: boolean; data?: T; error?: string }
export interface LspDiag {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  message: string
  severity: 1 | 2 | 3 | 4 // 与 monaco.MarkerSeverity 对齐
  source?: string
  code?: string | number
}
export interface CompletionItemOut {
  label: string
  kind?: number
  detail?: string
  documentation?: string
  insertText?: string
  insertTextFormat?: 1 | 2
  sortText?: string
  filterText?: string
}
export interface LspLocation { file: string; line: number; character: number }

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

/** 崩溃签名分析结果（本地规则解析，不依赖 AI） */
export interface CrashSignatureResult {
  ok: boolean
  error?: string
  /** 是否识别出崩溃 */
  crashed?: boolean
  /** panic / abort / assert / stack-overflow / watchdog / brownout / heap / unknown */
  kind?: string
  exception?: string
  core?: number
  pc?: string
  excvaddr?: string
  backtrace?: string[]
  /** 稳定签名：同固件同位置崩溃 → 相同字符串（可去重计数） */
  signature?: string
  summary?: string
  advice?: string[]
  report?: string
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
  // 本地引擎通道：'bundled' = 自带 llama.cpp；'ollama' = 指向用户已有的 Ollama :11434/v1
  localProvider?: 'bundled' | 'ollama'
  ollamaBaseUrl?: string
}

export interface ByokProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface PinReportLike {
  chip: string
  scannedFiles: number
  issues: Array<{ level: string; pin: number; title: string; detail: string }>
  summary: string
}

/** 保存即预检（层1 即时静态校验）的结果快照：App 侧状态 + 主进程分析结果。 */
export interface PrecheckSnapshot {
  /** 预检 UI 状态：idle=未跑 / pending=跑中 / ok=通过 / conflict=有冲突或板卡无效 */
  status: 'idle' | 'pending' | 'ok' | 'conflict'
  /** 当前 FQBN 是否在板卡注册表里（无效板不参与引脚校验，但 UI 要单独提示） */
  boardValid: boolean
  issues: Array<{ level: string; pin: number; title: string; detail: string; refs?: Array<{ file: string; line: number; api: string }> }>
  summary: string
  /** 可读报告全文（点击状态栏圆点 / 输出面板查看用） */
  text: string
}

export interface SvdChipEntry {
  chip: string
  bytes: number
  mtime: number
}

export interface SvdListResult {
  dir: string
  installed: SvdChipEntry[]
  known: string[]
}

export interface SvdProgress {
  phase: 'downloading' | 'saving'
  percent: number
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
  /** 编译阶段名（prepare/sketch/libs/link/image/done）；烧录阶段用 message 文案即可 */
  stage?: string
}

// ---- 片上调试（openocd telnet）----
export interface RegisterValue {
  name: string
  value: string
  num?: number
}

export interface MemoryReadResult {
  addr: number
  bytes: number[]
}

export interface ThreadInfo {
  id: string
  name: string
  pc?: number
  state?: string
}

export type DebugStatus = 'idle' | 'starting' | 'running' | 'error'

export interface DebugState {
  status: DebugStatus
  chip: string
  boardCfg: string
  telnetPort: number
  openocdPath: string
  scriptsDir: string
  startedAt?: number
  error?: string
  adapterLog: string
  target: 'running' | 'halted' | 'unknown'
}

export interface DebugChip {
  chip: string
  cfg: string
}

export interface OpenocdInfo {
  installed: boolean
  path: string
  scripts: string
}

/** debug:info 的返回：openocd 安装状态 + 支持的板卡配置 */
export type DebugInfo = OpenocdInfo & { chips: DebugChip[] }

export interface InstallProgress {
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
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

  /** 原生确认框（主进程 dialog.showMessageBox）：渲染层不自己造模态。 */
  dialog: {
    /**
     * 三选确认。返回被点按钮的**索引**；ESC / 点 × 等于 cancelId（默认最后一项）。
     * 凡是会丢弃用户改动的动作（关标签页 / 关项目 / 关窗口）都必须先过它。
     */
    confirm: (opts: {
      title: string
      message: string
      detail?: string
      buttons: string[]
      defaultId?: number
      cancelId?: number
    }): Promise<number> => ipcRenderer.invoke('dialog:confirm', opts)
  },

  /** 关窗前主进程发来的询问：有没有未保存的改动？ */
  onConfirmClose: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:confirm-close', listener)
    return () => ipcRenderer.removeListener('app:confirm-close', listener)
  },
  /** 回应关窗询问：'close' 真关，'cancel' 取消关闭 */
  closeResult: (action: 'close' | 'cancel'): Promise<void> =>
    ipcRenderer.invoke('app:close-result', { action }),

  // 项目 / 文件
  project: {
    open: (): Promise<{ root: string; tree: TreeNode } | null> => ipcRenderer.invoke('project:open'),
    // 应用内目录选择器：按明确路径打开（原生对话框不可用时的可靠路径）
    openPath: (p: string): Promise<{ root: string; tree: TreeNode } | { error: string } | null> =>
      ipcRenderer.invoke('project:openPath', p),
    tree: (root: string): Promise<TreeNode> => ipcRenderer.invoke('project:tree', root),
    create: (opts: { type: string; name: string; parentPath?: string; scaffold?: Array<{ file: string; content: string }> }): Promise<{ ok: boolean; root?: string; tree?: TreeNode; error?: string }> =>
      ipcRenderer.invoke('project:create', opts)
  },
  fs: {
    read: (path: string): Promise<string> => ipcRenderer.invoke('fs:readFile', path),
    // 应用内目录选择器：列举目录内容
    readDir: (path: string): Promise<{ path: string; dirs: string[]; files: string[] }> =>
      ipcRenderer.invoke('fs:readDir', path),
    write: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('fs:writeFile', path, content),
    readImage: (path: string): Promise<string> => ipcRenderer.invoke('fs:readImage', path),
    /** 文件元信息（大小 + mtime），用于大文件保护和外部改动刷新 */
    stat: (path: string): Promise<{ size: number; mtimeMs: number }> =>
      ipcRenderer.invoke('fs:stat', path),
    /** 内置示例/未保存的 .ino 暂存为真实临时工程，返回绝对路径（供编译/烧录） */
    stageTemp: (name: string, content: string): Promise<string> => ipcRenderer.invoke('fs:stageTempSketch', name, content)
  },

  // 编辑器语言服务（LSP）：补全 / 悬停 / 跳转 / 实时诊断。
  // 全部返回 { ok, data?, error? } —— clangd 没装时 ok:false，渲染层据此静默降级。
  lsp: {
    sync: (p: { file: string; text: string; languageId?: string; delayMs?: number }): Promise<LspResult<LspDiag[]>> =>
      ipcRenderer.invoke('lsp:sync', p),
    completion: (p: {
      file: string; text: string; line: number; character: number
      triggerKind?: 1 | 2 | 3; triggerCharacter?: string; languageId?: string
      /** 单条请求超时（ms）。ESP32 重头文件首次建 preamble 可能 > 默认 30s，编辑器侧放大避免首补全被掐空 */
      timeoutMs?: number
    }): Promise<LspResult<CompletionItemOut[]>> => ipcRenderer.invoke('lsp:completion', p),
    hover: (p: { file: string; text: string; line: number; character: number; languageId?: string; timeoutMs?: number }): Promise<LspResult<string>> =>
      ipcRenderer.invoke('lsp:hover', p),
    definition: (p: { file: string; text: string; line: number; character: number; languageId?: string; timeoutMs?: number }): Promise<LspResult<LspLocation[]>> =>
      ipcRenderer.invoke('lsp:definition', p),
    ensureDb: (p: {
      projectRoot: string; fqbn?: string; files?: string[]
      coreRoot?: string; variant?: string; cpuFreqMHz?: number; extraIncludes?: string[]; force?: boolean
    }): Promise<LspResult<string>> => ipcRenderer.invoke('lsp:ensure-db', p),
    status: (): Promise<Array<{ key: string; ready: boolean }>> => ipcRenderer.invoke('lsp:status'),
    dispose: (): Promise<void> => ipcRenderer.invoke('lsp:dispose')
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
    /**
     * 工具链内置 Web UI（平台管理 / 库管理 / 设置）的 file:// 地址。
     * 由主进程判存后返回，文件不在就给空串让渲染层降级成一行说明 ——
     * 一个 iframe 打不开，绝不该把整个侧栏带崩。
     */
    uiUrl: (tab: string): Promise<string> => ipcRenderer.invoke('toolchain:ui-url', tab),
    // 平台管理（对齐 TrieCode 平台管理）
    listPlatforms: (): Promise<unknown> => ipcRenderer.invoke('toolchain:list-platforms'),
    searchPlatforms: (keyword: string): Promise<unknown> => ipcRenderer.invoke('toolchain:search-platforms', keyword),
    installPlatform: (platform: string): Promise<{ success: boolean; output: string }> => ipcRenderer.invoke('toolchain:install-platform', platform),
    uninstallPlatform: (platform: string): Promise<{ success: boolean; output: string }> => ipcRenderer.invoke('toolchain:uninstall-platform', platform),
    // 库管理（对齐 TrieCode 库管理）
    listLibraries: (): Promise<unknown> => ipcRenderer.invoke('toolchain:list-libraries'),
    searchLibraries: (keyword: string): Promise<unknown> => ipcRenderer.invoke('toolchain:search-libraries', keyword),
    installLibrary: (name: string): Promise<{ success: boolean; output: string }> => ipcRenderer.invoke('toolchain:install-library', name),
    uninstallLibrary: (name: string): Promise<{ success: boolean; output: string }> => ipcRenderer.invoke('toolchain:uninstall-library', name),
    onInstallProgress: (cb: (p: { phase: string; percent: number; message: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { phase: string; percent: number; message: string }): void => cb(p)
      ipcRenderer.on('toolchain:install-progress', listener)
      return () => ipcRenderer.removeListener('toolchain:install-progress', listener)
    }
  },

  // 应用路径与版本
  app: {
    getExamplesDir: (): Promise<string> => ipcRenderer.invoke('app:getExamplesDir'),
    /** 用系统默认程序打开路径（文件 / 目录），由主进程 shell.openPath 兜底错误 */
    openPath: (p: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:openPath', p),
    /**
     * 宿主资源路径。渲染层的 nodeIntegration 是关的，
     * 不许在这里碰 process / __dirname —— 打包后那些变量根本不存在。
     * 一律由主进程把「路径事实」走 IPC 送上来，渲染层只负责显示。
     */
    /** 宿主版本（package.json 里的那个，别再让 UI 写死一个数字） */
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    /** 运行时目录（开发=app.getAppPath()，打包=resources 根） */
    resourcesPath: (): Promise<string> => ipcRenderer.invoke('app:resourcesPath')
  },

  // 命令执行（终端）
  cmd: {
    run: (opts: { cmd: string; cwd: string; shell?: 'powershell' | 'cmd' | 'pwsh' | 'bash' }): Promise<{ id: string }> =>
      ipcRenderer.invoke('cmd:run', opts),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('task:kill', id)
  },



  // 真终端（node-pty）
  pty: {
    start: (opts: { shell?: string; cwd?: string; cols?: number; rows?: number; command?: string; args?: string[]; env?: Record<string, string> }): Promise<{ id: string; error?: string }> =>
      ipcRenderer.invoke('pty:start', opts),
    write: (opts: { id: string; data: string }): Promise<boolean> => ipcRenderer.invoke('pty:write', opts),
    resize: (opts: { id: string; cols: number; rows: number }): Promise<boolean> => ipcRenderer.invoke('pty:resize', opts),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),
    onData: (cb: (d: { id: string; data: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { id: string; data: string }): void => cb(d)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (d: { id: string; code?: number }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { id: string; code?: number }): void => cb(d)
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
    /** 用 AI 解读串口日志（走当前通道：BYOK / 本地引擎 / 内置） */
    explain: (opts?: { id?: string; logs?: string; maxChars?: number }): Promise<{ text: string; findings: Array<{ kind: string; line: number; text: string }>; channel: string; modelHint: string }> =>
      ipcRenderer.invoke('serial:explain', opts),
    /** 崩溃签名分析（本地规则解析，不调 AI）：串口日志 → 稳定签名 + 排查建议 */
    crashAnalyze: (opts?: { id?: string; logs?: string }): Promise<CrashSignatureResult> =>
      ipcRenderer.invoke('serial:crashAnalyze', opts),
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
    // 合并持久化部分 AiState（Ollama 通道用）
    setState: (patch: Partial<AiState>): Promise<AiState> => ipcRenderer.invoke('ai:setState', patch),
    // 直接设置当前激活的本地模型名（Ollama 模式：设为 Ollama 模型 tag，不启自带引擎）
    setLocalModel: (model: string | null): Promise<void> => ipcRenderer.invoke('ai:setLocalModel', model),
    // 多 BYOK profile
    byokProfiles: (): Promise<ByokProfile[]> => ipcRenderer.invoke('ai:byokProfiles'),
    byokSave: (profile: ByokProfile): Promise<AiState> => ipcRenderer.invoke('ai:byokSave', profile),
    byokDelete: (id: string): Promise<AiState> => ipcRenderer.invoke('ai:byokDelete', id),
    byokActivate: (id: string | null): Promise<AiState> => ipcRenderer.invoke('ai:byokActivate', id),
    // 官方通道账号
    login: (email: string, password: string): Promise<AiState> => ipcRenderer.invoke('ai:login', email, password),
    register: (email: string, password: string): Promise<AiState> => ipcRenderer.invoke('ai:register', email, password),
    sendCode: (email: string): Promise<{ ok: boolean; devMode?: boolean }> => ipcRenderer.invoke('ai:send-code', email),
    loginWithCode: (email: string, code: string): Promise<AiState> => ipcRenderer.invoke('ai:login-with-code', email, code),
    logout: (): Promise<AiState> => ipcRenderer.invoke('ai:logout'),
    refreshMe: (): Promise<AiState> => ipcRenderer.invoke('ai:refreshMe'),
    /** AI 内联补全（Ghost Text）：返回光标处要插入的代码；失败/无建议时为空串 */
    inlineComplete: (opts: {
      prefix: string; suffix: string; language: string; filePath: string
    }): Promise<{ text: string }> => ipcRenderer.invoke('ai:inlineComplete', opts)
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
    /** 按项目目录解析 active 工具链声明的 capability 键（标题栏按钮动态显隐用，P0-2） */
    projectCapabilities: (root: string): Promise<string[]> =>
      ipcRenderer.invoke('plugin:projectCapabilities', root),
    capabilities: (): Promise<Record<string, { transport: string; service?: string; method?: string; plugin: string }>> =>
      ipcRenderer.invoke('plugin:capabilities'),
    devicePanels: (): Promise<Array<{ plugin: string; id: string; title: string; icon?: string; selectors: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }>> =>
      ipcRenderer.invoke('plugin:devicePanels'),
    // P2-20：插件声明的视图（slot: sidebar | activitybar | panel）
    views: (): Promise<Array<{ plugin: string; id: string; title: string; icon?: string; slot: string; type: string; entry?: string }>> =>
      ipcRenderer.invoke('plugin:views'),
    // P2-20：webview 类型 view 的 app:// 地址（主进程算好，渲染层不能自己拼路径）
    viewUrl: (plugin: string, entry: string): Promise<string> =>
      ipcRenderer.invoke('plugin:viewUrl', plugin, entry),
    // P2-20：webview 桥接 preload 的 file:// 地址（已废弃：插件页改走 iframe + 纯 postMessage，
    // 不再依赖 webview preload，故移除 viewBridgeUrl；保留注释说明历史）。
    commands: (): Promise<Array<{ plugin: string; id: string; title: string; icon?: string; kind: string; view?: string; placement?: string; when?: string; transport?: string }>> =>
      ipcRenderer.invoke('plugin:commands'),
    skills: (): Promise<Array<{ plugin: string; name: string; description: string; prompt?: string }>> =>
      ipcRenderer.invoke('plugin:skills'),
    tools: (): Promise<Array<{ plugin: string; name: string; transport: string; category?: string; description?: string }>> =>
      ipcRenderer.invoke('plugin:tools'),
    // 插件市场（下载安装 / 卸载 / 清单 / 热重载 / 直接调插件命令）
    catalog: (): Promise<Array<{
      id: string
      name: string
      displayName: string
      version: string
      description: string
      author?: string
      source: string
      url: string
      sha256: string
      size?: number
      exposes?: string[]
      minAppVersion?: string
      installed?: boolean
      trusted?: boolean
    }>> => ipcRenderer.invoke('plugin:catalog'),
    installed: (): Promise<Array<{
      id: string
      name: string
      displayName: string
      version: string
      description: string
      entry?: string
      valid: boolean
      error?: string
    }>> => ipcRenderer.invoke('plugin:installed'),
    install: (id: string, trust?: boolean): Promise<{
      ok: boolean
      needConfirm: boolean
      summary?: { id: string; name: string; displayName: string; version: string; loaded: boolean; error?: string }
      error?: string
    }> => ipcRenderer.invoke('plugin:install', id, trust),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('plugin:uninstall', id),
    reload: (): Promise<Array<{ manifest: { name: string; displayName: string; version: string }; loaded: boolean; error?: string }>> =>
      ipcRenderer.invoke('plugin:reload'),
    getCatalogUrl: (): Promise<string> => ipcRenderer.invoke('plugin:getCatalogUrl'),
    setCatalogUrl: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('plugin:setCatalogUrl', url),
    invoke: (channel: 'internal' | 'backend' | 'cli' | 'http' | 'grpc' | 'mcp' | 'mqtt', command: string, args?: unknown): Promise<unknown> =>
      ipcRenderer.invoke('plugin:invoke', channel, command, args),
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
    },
    /**
     * 烧录时 esptool 实测到的芯片与目标板卡不符（如"选了 S3、插的是 C3"）。
     * 主进程只在 esptool 明确报出时才发，带上建议改成的 FQBN；
     * 渲染层据此把板卡改对 —— 用户不用自己猜芯片型号。
     */
    onChipMismatch: (cb: (d: { actual: string; expected: string; currentFqbn: string; suggestFqbn: string; suggestName: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: { actual: string; expected: string; currentFqbn: string; suggestFqbn: string; suggestName: string }): void => cb(d)
      ipcRenderer.on('upload:chip-mismatch', listener)
      return () => ipcRenderer.removeListener('upload:chip-mismatch', listener)
    }
  },

  // ESP-IDF 工具链
  espIdf: {
    listTargets: (): Promise<Array<{ target: string; name: string }>> => ipcRenderer.invoke('espIdf:listTargets'),
    setTarget: (target: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('espIdf:setTarget', target),
    status: (): Promise<unknown> => ipcRenderer.invoke('espIdf:status'),
    // ESP-IDF 编译/烧录（P0-2 路由）：返回 taskId，后续日志/退出码走 task:output / task:exit
    compile: (o: { projectPath: string; port?: string; target?: string }): Promise<{ ok: boolean; taskId?: string; error?: string }> =>
      ipcRenderer.invoke('espIdf:compile', o),
    flash: (o: { projectPath: string; port?: string; target?: string }): Promise<{ ok: boolean; taskId?: string; error?: string }> =>
      ipcRenderer.invoke('espIdf:flash', o),
    menuconfigCmd: (): Promise<{ args: string[]; cwd: string; env: Record<string, string> } | { error: string }> =>
      ipcRenderer.invoke('espIdf:menuconfigCmd'),
    readPartitions: (
      projectPath: string
    ): Promise<{ ok: boolean; path?: string; rows?: Array<{ name: string; type: string; subtype: string; offset: string; size: string; flags: string }>; header?: string; isNew?: boolean; error?: string }> =>
      ipcRenderer.invoke('espIdf:readPartitions', projectPath),
    writePartitions: (
      csvPath: string,
      rows: Array<{ name: string; type: string; subtype: string; offset: string; size: string; flags: string }>
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('espIdf:writePartitions', csvPath, rows),
    readSdkconfig: (
      projectPath: string
    ): Promise<{ ok: boolean; path?: string; items?: Array<{ key: string; value: string }>; error?: string }> =>
      ipcRenderer.invoke('espIdf:readSdkconfig', projectPath),
    writeSdkconfig: (
      cfgPath: string,
      items: Array<{ key: string; value: string }>
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('espIdf:writeSdkconfig', cfgPath, items),
    kconfigSchema: (
      projectPath: string
    ): Promise<{ ok: boolean; tree?: Array<{ kind: string; name?: string; prompt?: string; type?: string; help?: string; depends?: string; defaults?: string[]; ranges?: string[]; select?: string[]; visibleIf?: string; children?: unknown[] }>; covered?: string; error?: string }> =>
      ipcRenderer.invoke('espIdf:kconfigSchema', projectPath),
    kconfigVisibility: (
      projectPath: string
    ): Promise<{ ok: boolean; map?: Record<string, { visible: boolean; default?: string }>; error?: string }> =>
      ipcRenderer.invoke('espIdf:kconfigVisibility', projectPath)
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

  // 真机测试信息收集（诊断日志）：只写本机 userData；导出由用户在设置里手动触发
  diag: {
    /** 渲染层上报一条事件（UI 动作 / 未捕获异常），单向不等返回 */
    log: (event: string, data?: Record<string, unknown>): void => {
      ipcRenderer.send('diag:log', { event, data })
    },
    /** 日志目录 / 当前会话文件 */
    info: (): Promise<{ dir: string; file: string; sessionId: string; disabled: boolean }> =>
      ipcRenderer.invoke('diag:info'),
    /** 跑一遍环境自检（arduino-cli / 板卡 / 端口 / openocd / gRPC） */
    selfTest: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('diag:selfTest'),
    /** 导出测试报告（弹保存对话框），返回落盘路径；用户取消则 path=null */
    export: (): Promise<{ path: string | null; canceled?: boolean; bytes?: number; error?: string }> =>
      ipcRenderer.invoke('diag:export'),
    /** 在资源管理器里打开日志目录 */
    openDir: (): Promise<boolean> => ipcRenderer.invoke('diag:openDir')
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
    upload: (opts: { sketch: string; fqbn: string; port: string; buildPath?: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke('grpc:upload', opts)
  },

  // 能力驱动（capability 能力路由模式）
  capability: {
    list: (): Promise<Record<string, { transport: string; service?: string; method?: string; plugin: string }>> =>
      ipcRenderer.invoke('plugin:capabilities'),
    run: (capability: string, args: Record<string, unknown>): Promise<{ ok: boolean; taskId?: string; error?: string; result?: unknown }> =>
      ipcRenderer.invoke('capability:run', { capability, args })
  },



  // 引脚冲突检测
  pin: {
    check: (opts?: { projectRoot?: string; fqbn?: string }): Promise<PinReportLike & { text: string }> =>
      ipcRenderer.invoke('pin:check', opts)
  },

  // 保存即预检（层1 即时静态校验：板卡合法性 + 引脚冲突，纯前端触发、主进程纯分析无 spawn）
  sketch: {
    precheck: (opts: { projectRoot?: string; fqbn?: string; overlay?: Record<string, string> }): Promise<{
      ok: boolean
      boardValid: boolean
      chip: string
      issues: PrecheckSnapshot['issues']
      summary: string
      text: string
    }> => ipcRenderer.invoke('sketch:precheck', opts),
    // 层2 深度编译预检：真实编译校验（依赖缺失/语法错/库找不到）。
    // 与手动编译完全解耦：独立 IPC、返回 {ok,code,out}，不发射 task 事件，不碰 compileState。
    deepCompilePrecheck: (opts: { sketch: string; fqbn: string }): Promise<{ ok: boolean; code: number; out: string }> =>
      ipcRenderer.invoke('sketch:deepCompilePrecheck', opts)
  },

  // 模板 / 示例库
  template: {
    groups: (): Promise<Array<{ category: string; items: Array<{ id: string; name: string; desc: string; category: string }> }>> =>
      ipcRenderer.invoke('template:groups'),
    get: (id: string): Promise<{ id: string; name: string; desc: string; category: string; files: Array<{ path: string; content: string }> }> =>
      ipcRenderer.invoke('template:get', id),
    apply: (opts: { id: string; targetDir: string }): Promise<{ files: string[]; bytes: number }> =>
      ipcRenderer.invoke('template:apply', opts)
  },

  // 烧录历史 / 回滚
  burn: {
    list: (limit?: number): Promise<Array<{ id: string; ts: number; projectName: string; fqbn: string; port: string; ok: boolean; fileCount: number; note?: string }>> =>
      ipcRenderer.invoke('burn:list', limit),
    record: (opts: { projectRoot: string; fqbn?: string; port?: string; ok?: boolean; logTail?: string; durationMs?: number; note?: string }): Promise<{ id: string; ts: number; fileCount: number }> =>
      ipcRenderer.invoke('burn:record', opts),
    get: (id: string): Promise<{ id: string; ts: number; projectName: string; fqbn: string; port: string; ok: boolean; fileCount: number; logTail: string }> =>
      ipcRenderer.invoke('burn:get', id),
    rollback: (opts: { id: string; targetRoot?: string }): Promise<{ id: string; written: string[]; changed: string[]; missing: string[] }> =>
      ipcRenderer.invoke('burn:rollback', opts),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('burn:remove', id)
  },

  // 分享卡片（本地生成 HTML，不上传）
  share: {
    card: (input: { title: string; subtitle?: string; chip?: string; metrics?: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'err'; hint?: string }>; code?: string; footer?: string }): Promise<{ path: string; bytes: number; opened: boolean }> =>
      ipcRenderer.invoke('share:card', input),
    open: (input: { title: string; subtitle?: string; chip?: string; metrics?: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'err'; hint?: string }>; code?: string; footer?: string }): Promise<{ path: string; bytes: number; opened: boolean; error?: string }> =>
      ipcRenderer.invoke('share:open', input),
    list: (): Promise<Array<{ path: string; name: string; bytes: number; ts: number }>> => ipcRenderer.invoke('share:list')
  },

  // 本地模型引擎（llama.cpp）
  engine: {
    status: (): Promise<{ installed: boolean; running: boolean; version: string; engineDir: string }> => ipcRenderer.invoke('engine:status'),
    models: (): Promise<Array<{ id: string; name: string; sizeGB: number; quantization: string; parameters: string }>> => ipcRenderer.invoke('engine:models'),
    start: (opts?: { model?: string }): Promise<{ ok: boolean; model?: string; error?: string }> => ipcRenderer.invoke('engine:start', opts),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('engine:stop'),
    /** 确保本地通道就绪：按偏好（上次用的模型）或指定模型；云端用户调用它不会拉引擎 */
    ensure: (
      opts?: { model?: string; force?: boolean }
    ): Promise<{ ready: boolean; model: string | null; error: string | null; reason: string | null }> =>
      ipcRenderer.invoke('engine:ensure', opts),
    /** 可下载模型目录（含 3B / 7B 各档位）；downloaded 标记本地是否已有该文件 */
    catalog: (): Promise<Array<{
      id: string; displayName: string; description: string; parameters: string
      sizeGB: number; minRAMGB: number; tier: string; icon: string; ggufFile: string; downloaded: boolean
    }>> => ipcRenderer.invoke('engine:catalog'),
    /** 按 catalog id 下载 GGUF（断点续传）；进度走 onDownloadProgress 事件 */
    download: (modelId: string): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke('engine:download', { modelId }),
    onDownloadProgress: (
      cb: (p: { modelId: string; status: string; percent: number; downloadedMB: number; totalMB: number }) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        p: { modelId: string; status: string; percent: number; downloadedMB: number; totalMB: number }
      ): void => cb(p)
      ipcRenderer.on('engine:downloadProgress', listener)
      return () => ipcRenderer.removeListener('engine:downloadProgress', listener)
    }
  },

  // 寄存器数据（CMSIS-SVD，乐鑫官方）
  svd: {
    list: (): Promise<SvdListResult> => ipcRenderer.invoke('svd:list'),
    /** 按板卡 FQBN 推断芯片名；推断不出返回 null */
    suggest: (fqbn?: string): Promise<{ chip: string | null }> => ipcRenderer.invoke('svd:suggest', fqbn),
    install: (opts: { chip: string; force?: boolean }): Promise<{ ok: boolean; chip: string; path: string; bytes: number }> =>
      ipcRenderer.invoke('svd:install', opts),
    /** 用系统对话框选一个本地 .svd 并导入（离线/内网场景） */
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('svd:pickFile'),
    import: (opts: { chip: string; filePath: string }): Promise<{ ok: boolean; chip: string; path: string; bytes: number }> =>
      ipcRenderer.invoke('svd:import', opts),
    remove: (chip: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('svd:remove', chip),
    onProgress: (cb: (p: SvdProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: SvdProgress): void => cb(p)
      ipcRenderer.on('svd:progress', listener)
      return () => ipcRenderer.removeListener('svd:progress', listener)
    }
  },

  // 片上调试（openocd telnet，寄存器 / 内存 / 断点 / 单步 / 线程）
  debug: {
    info: (): Promise<DebugInfo> => ipcRenderer.invoke('debug:info'),

    install: (opts?: { force?: boolean }): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('debug:install', opts),
    chips: (): Promise<Array<{ chip: string; cfg: string }>> => ipcRenderer.invoke('debug:chips'),
    start: (opts?: { chip?: string; boardCfg?: string; telnetPort?: number }): Promise<DebugState> =>
      ipcRenderer.invoke('debug:start', opts),
    stop: (): Promise<DebugState> => ipcRenderer.invoke('debug:stop'),
    state: (): Promise<DebugState> => ipcRenderer.invoke('debug:state'),
    registers: (): Promise<Array<RegisterValue>> => ipcRenderer.invoke('debug:registers'),
    memory: (opts: { addr: string | number; count?: number }): Promise<{ addr: number; bytes: number[] }> =>
      ipcRenderer.invoke('debug:memory', opts),
    threads: (): Promise<{ raw: string; threads: ThreadInfo[] }> => ipcRenderer.invoke('debug:threads'),
    halt: (): Promise<string> => ipcRenderer.invoke('debug:halt'),
    resume: (): Promise<string> => ipcRenderer.invoke('debug:resume'),
    step: (): Promise<string> => ipcRenderer.invoke('debug:step'),
    reset: (): Promise<string> => ipcRenderer.invoke('debug:reset'),
    poll: (): Promise<string> => ipcRenderer.invoke('debug:poll'),
    setBreakpoint: (addr: string | number): Promise<string> => ipcRenderer.invoke('debug:setBreakpoint', addr),
    removeBreakpoint: (addr?: string | number): Promise<string> => ipcRenderer.invoke('debug:removeBreakpoint', addr),
    exec: (cmd: string): Promise<string> => ipcRenderer.invoke('debug:exec', cmd),
    /** 加载编译产物的调试符号（按 buildPath 缓存索引）。hasLineInfo=false 表示编译未带 -g */
  symbols: (buildPath: string): Promise<unknown> => ipcRenderer.invoke('debug:symbols', buildPath),
    /** 地址 → 源码 {file,line}（当前行高亮） */
  addrToSource: (addr: number): Promise<{ file: string; line: number; column?: number } | null> =>
      ipcRenderer.invoke('debug:addrToSource', addr),
    /** (文件,行) → 断点地址（空行会落到下一条可执行语句） */
    lineToAddr: (file: string, line: number): Promise<number | null> =>
      ipcRenderer.invoke('debug:lineToAddr', file, line),
    /** 取当前行 + 所在函数（停住后一次性拿，减少往返） */
    location: (pc: number): Promise<unknown> => ipcRenderer.invoke('debug:location', pc),
    /** 切换某行断点（下发到 openocd 硬件断点） */
    toggleBreakpoint: (file: string, line: number, enable: boolean): Promise<unknown> =>
      ipcRenderer.invoke('debug:toggleBreakpoint', file, line, enable),
    /** 回溯调用栈（帧指针法；需固件启用 -fno-omit-frame-pointer，做不了会如实说明） */
    callStack: (maxFrames?: number): Promise<unknown> => ipcRenderer.invoke('debug:callstack', maxFrames),
    /** 列出全局变量（Watch 候选） */
    globals: (): Promise<unknown> => ipcRenderer.invoke('debug:globals'),
    /** 读某全局变量当前值（hex/int/float 多解释，类型未知时如实标注） */
    watch: (name: string): Promise<unknown> => ipcRenderer.invoke('debug:watch', name),
    /** 列出当前 PC 所在函数的局部变量（含栈地址，需帧指针） */
    locals: (): Promise<unknown> => ipcRenderer.invoke('debug:locals'),
    /** 读某局部变量当前值（按类型解释） */
    watchLocal: (name: string): Promise<unknown> => ipcRenderer.invoke('debug:watchLocal', name),
    /** 读片内分区表（0x8000 起，需要已连接片上调试器） */
    partitions: (): Promise<PartitionEntry[]> => ipcRenderer.invoke('debug:partitions'),
    /** 读 NVS 条目（尽力解析，不做 CRC 校验） */
    nvs: (opts?: { addr?: number; size?: number }): Promise<{ entries: NvsEntry[]; partitions: PartitionEntry[]; note: string }> =>
      ipcRenderer.invoke('debug:nvs', opts),
    onProgress: (cb: (p: InstallProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: InstallProgress): void => cb(p)
      ipcRenderer.on('debug:progress', listener)
      return () => ipcRenderer.removeListener('debug:progress', listener)
    },
    /** 烧录等外部动作把调试会话停掉时（面板需要自动回落到「未连接」） */
    onStopped: (cb: (s: DebugState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, s: DebugState): void => cb(s)
      ipcRenderer.on('debug:stopped', listener)
      return () => ipcRenderer.removeListener('debug:stopped', listener)
    }
  },

  // MCP 服务器（配置 / 信任 / 运行时）
  mcp: {
    overview: (projectRoot?: string | null): Promise<McpOverview> => ipcRenderer.invoke('mcp:overview', { projectRoot }),
    start: (projectRoot?: string | null): Promise<McpOverview> => ipcRenderer.invoke('mcp:start', { projectRoot }),
    stop: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('mcp:stop', { name }),
    add: (opts: { name: string; command: string; args?: string[]; env?: Record<string, string>; note?: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('mcp:add', opts),
    remove: (name: string): Promise<{ ok: boolean; path: string }> => ipcRenderer.invoke('mcp:remove', { name }),
    trust: (opts: { name: string; trusted: boolean; projectRoot?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:trust', opts),
    enable: (opts: { name: string; enabled: boolean; projectRoot?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:enable', opts),
    test: (opts: { name: string; projectRoot?: string | null }): Promise<{ ok: boolean; toolCount: number; error?: string }> =>
      ipcRenderer.invoke('mcp:test', opts),
    setGlobalEnabled: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('mcp:setGlobalEnabled', { enabled })
  },

  // 编译过程：阶段与资源用量（主进程从真实输出解析，渲染层只负责显示）
  build: {
    inspect: (text: string): Promise<{ stage: BuildStageInfo; usage: UsageSummary | null }> =>
      ipcRenderer.invoke('build:inspect', text)
  },

  // AI 通道健康度（未登录 / 登录过期 / 本地就绪 / BYOK 激活）
  aiHealth: {
    get: (): Promise<ChannelHealth> => ipcRenderer.invoke('ai:health')
  },

  // 多智能体编排（协调者 + 并行 worker）
  orchestra: {
    plan: (opts: {
      tasks: TaskSpecLite[]
      projectRoot?: string | null
    }): Promise<{
      tasks: TaskSpecLite[]
      conflicts: Array<{ a: string; b: string; files: string[]; resolution: string }>
      layers: string[][]
      cyclic: string[]
      dangling: Array<{ id: string; missing: string }>
    }> => ipcRenderer.invoke('orchestra:plan', opts),
    run: (opts: {
      tasks: TaskSpecLite[]
      projectRoot?: string | null
      concurrency?: number
      approvedIds?: string[]
    }): Promise<OrchestrationReport> => ipcRenderer.invoke('orchestra:run', opts),
    onEvent: (cb: (tasks: AgentTaskRun[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, tasks: AgentTaskRun[]): void => cb(tasks)
      ipcRenderer.on('orchestra:event', listener)
      return () => ipcRenderer.removeListener('orchestra:event', listener)
    }
  },

  // Git（状态 / 暂存 / 提交 / 分支 / 远端）
  git: {
    status: (root: string): Promise<GitStatusInfo> => ipcRenderer.invoke('git:status', { root }),
    branches: (root: string): Promise<GitBranchView> => ipcRenderer.invoke('git:branches', { root }),
    diff: (root: string, path: string, staged: boolean): Promise<string> =>
      ipcRenderer.invoke('git:diff', { root, path, staged }),
    stage: (root: string, paths: string[]): Promise<GitOpResult> => ipcRenderer.invoke('git:stage', { root, paths }),
    stageOne: (root: string, path: string): Promise<GitOpResult> => ipcRenderer.invoke('git:stageOne', { root, path }),
    unstage: (root: string, paths: string[]): Promise<GitOpResult> => ipcRenderer.invoke('git:unstage', { root, paths }),
    discard: (root: string, paths: string[]): Promise<GitOpResult> => ipcRenderer.invoke('git:discard', { root, paths }),
    commit: (root: string, message: string): Promise<GitOpResult & { sha?: string }> =>
      ipcRenderer.invoke('git:commit', { root, message }),
    init: (root: string, branch?: string): Promise<GitOpResult> => ipcRenderer.invoke('git:init', { root, branch }),
    log: (root: string, n?: number): Promise<GitLogEntry[]> => ipcRenderer.invoke('git:log', { root, n }),
    push: (root: string): Promise<{ ok: boolean; text: string; error?: string }> => ipcRenderer.invoke('git:push', { root }),
    pull: (root: string): Promise<{ ok: boolean; text: string; error?: string }> => ipcRenderer.invoke('git:pull', { root }),
    fetch: (root: string): Promise<{ ok: boolean; text: string; error?: string }> => ipcRenderer.invoke('git:fetch', { root }),
    remoteAdd: (root: string, name: string, url: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:remoteAdd', { root, name, url }),
    branchCreate: (root: string, name: string, checkout = true): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:branchCreate', { root, name, checkout }),
    branchCheckout: (root: string, name: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:branchCheckout', { root, name }),
    branchDelete: (root: string, name: string, force = false): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:branchDelete', { root, name, force }),
    branchMerge: (root: string, name: string): Promise<{ ok: boolean; text: string; error?: string }> =>
      ipcRenderer.invoke('git:branchMerge', { root, name })
  },

  // 硬件目标（板卡注册表：ESP32 / STM32）
  target: {
    list: (opts?: { family?: 'esp32' | 'stm32' }): Promise<BoardTargetInfo[]> =>
      ipcRenderer.invoke('target:list', opts),
    get: (id: string): Promise<BoardTargetInfo | null> => ipcRenderer.invoke('target:get', id),
    detect: (): Promise<DetectedPort[]> => ipcRenderer.invoke('target:detect'),
    writeIni: (opts: { projectRoot: string; boardId: string; env?: string; uploadPort?: string }): Promise<{ ok: boolean; path: string }> =>
      ipcRenderer.invoke('target:write-ini', opts),
    /** 一键硬件自检：插板后先跑它，知道缺什么而不是盲试 */
    selfCheck: (): Promise<SelfCheckReport> => ipcRenderer.invoke('selfcheck:run')
  },

  // 仪器（#13）：把串口上的 ESP32-S3 仪器固件当逻辑分析仪 / 示波器 / 功率计用
  instruments: {
    /** 枚举可用串口（与串口监视器共用底层枚举） */
    listPorts: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('instruments:listPorts'),
    connect: (opts: { port: string; baud: number }): Promise<{ ok: boolean; error?: string; port?: string }> =>
      ipcRenderer.invoke('instruments:connect', opts),
    disconnect: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('instruments:disconnect'),
    /** 发送一条原始控制指令（调试 / 自定义用） */
    command: (cmd: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('instruments:command', cmd),
    armLogicAnalyzer: (cfg: LogicAnalyzerConfig): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('instruments:armLA', cfg),
    armScope: (cfg: ScopeConfig): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('instruments:armScope', cfg),
    readPower: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('instruments:readPower'),
    capabilities: (): Promise<InstrumentCaps> => ipcRenderer.invoke('instruments:capabilities'),
    onData: (cb: (d: InstrumentData) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, d: InstrumentData): void => cb(d)
      ipcRenderer.on('instruments:data', listener)
      return () => ipcRenderer.removeListener('instruments:data', listener)
    },
    onLog: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('instruments:log', listener)
      return () => ipcRenderer.removeListener('instruments:log', listener)
    },
    onStatus: (cb: (s: InstrumentStatus) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, s: InstrumentStatus): void => cb(s)
      ipcRenderer.on('instruments:status', listener)
      return () => ipcRenderer.removeListener('instruments:status', listener)
    }
  },

  // PlatformIO（pio CLI 集成：多 env 解析 / 构建 / 烧录 / 串口监视）
  platformio: {
    info: (projectRoot?: string | null): Promise<PioInfo> => ipcRenderer.invoke('platformio:info', { projectRoot }),
    install: (): Promise<{ success: boolean; command?: string; version?: string; error?: string }> =>
      ipcRenderer.invoke('platformio:install'),
    envs: (projectRoot: string | null): Promise<PioProject> => ipcRenderer.invoke('platformio:envs', { projectRoot }),
    build: (opts: { projectRoot: string; env?: string }): Promise<{ ok: boolean; output: string; hint?: string }> =>
      ipcRenderer.invoke('platformio:build', opts),
    upload: (opts: { projectRoot: string; env?: string; port?: string }): Promise<{ ok: boolean; output: string; hint?: string }> =>
      ipcRenderer.invoke('platformio:upload', opts),
    monitor: (opts: { projectRoot: string; env?: string; port?: string; baud?: number }): Promise<{ id: string }> =>
      ipcRenderer.invoke('platformio:monitor', opts),
    stopMonitor: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('platformio:stop-monitor'),
    onProgress: (cb: (p: { phase: string; percent: number; message: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: { phase: string; percent: number; message: string }): void => cb(p)
      ipcRenderer.on('pio:progress', listener)
      return () => ipcRenderer.removeListener('pio:progress', listener)
    }
  },

  // 设备端文件系统（串口 FS 行协议）
  devicefs: {
    list: (opts: { sessionId: string; path: string }): Promise<DeviceFsNode[]> => ipcRenderer.invoke('devicefs:list', opts),
    read: (opts: { sessionId: string; path: string }): Promise<string> => ipcRenderer.invoke('devicefs:read', opts),
    write: (opts: { sessionId: string; path: string; content: string }): Promise<void> =>
      ipcRenderer.invoke('devicefs:write', opts),
    mkdir: (opts: { sessionId: string; path: string }): Promise<void> => ipcRenderer.invoke('devicefs:mkdir', opts),
    remove: (opts: { sessionId: string; path: string }): Promise<void> => ipcRenderer.invoke('devicefs:remove', opts),
    stat: (opts: { sessionId: string; path: string }): Promise<DeviceFsStat> => ipcRenderer.invoke('devicefs:stat', opts),
    sync: (
      opts: { sessionId: string; localDir: string; deviceDir: string }
    ): Promise<{ ok: boolean; uploaded: string[]; skipped: string[]; error?: string }> =>
      ipcRenderer.invoke('devicefs:sync', opts),
    onProgress: (cb: (msg: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, msg: string): void => cb(msg)
      ipcRenderer.on('devicefs:progress', listener)
      return () => ipcRenderer.removeListener('devicefs:progress', listener)
    }
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

// ── PlatformIO / 设备文件系统 / 分区表 相关类型 ──
export interface PioEnvInfo {
  name: string
  board?: string
  platform?: string
  framework?: string
  monitorSpeed?: string
  uploadPort?: string
  uploadSpeed?: string
  freq?: string
}

export interface PioProject {
  found: boolean
  root: string | null
  envs: PioEnvInfo[]
  defaultEnv: string | null
  note?: string
}

export interface PioInfo {
  installed: boolean
  command: string | null
  version: string
  source: 'user-dir' | 'path' | 'project' | 'none'
  hint: string
  project: PioProject
}

export interface DeviceFsNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface DeviceFsStat {
  type: 'file' | 'dir'
  size: number
}

export interface PartitionEntry {
  address: number
  name: string
  type: number
  subtype: number
  offset: number
  size: number
  flags: number
  kind: 'app' | 'data' | 'unknown'
  subtypeName: string
}

export interface NvsEntry {
  namespace: string
  key: string
  type: string
  value: string | number | null
}

export interface DetectedPort {
  path: string
  manufacturer?: string
  friendlyName?: string
  vid?: number
  pid?: number
  pnpId?: string
  usbId: string
  targetId: string | null
  targetName: string | null
  /**
   * 同一个 VID:PID 可能对应多块板（ESP32-S3 / C3 / P4 原生 USB 都是 303a:1001）。
   * 长度 > 1 表示"只靠 USB ID 认不准"，UI 要提示用户手动选板，别拿 targetName 当定论。
   */
  candidateIds?: string[]
}

export interface BoardTargetInfo {
  id: string
  name: string
  family: 'esp32' | 'stm32'
  chip: string
  mcu: string
  flash: string
  build: Array<{ path: 'arduino-cli' | 'platformio' | 'esp-idf' | 'stm32cube'; detail: string }>
  fqbn?: string
  pioBoard?: string
  pioPlatform?: string
  upload: { kind: 'serial' | 'usb-jtag' | 'stlink' | 'dfu'; baud: number; note: string }
  debug: { link: 'builtin-usb-jtag' | 'onboard-stlink' | 'external-stlink' | 'cmsis-dap'; cfg: string[]; chip: string; note: string }
  svdChip?: string | null
  usbIds?: string[]
  notes: string
  /** 本机 openocd 是否备齐该板调试 cfg */
  debugCfgExists: boolean
}

export interface SelfCheckItem {
  id: string
  name: string
  status: 'ok' | 'warn' | 'fail' | 'unknown'
  detail: string
  fix?: string
}

export interface SelfCheckBoard {
  path: string
  vid: number
  pid: number
  usbId: string
  kind: 'esp' | 'stlink' | 'ch340' | 'other'
  label: string
  viaSerial: boolean
}

export interface SelfCheckReport {
  ts: number
  items: SelfCheckItem[]
  boards: SelfCheckBoard[]
  summary: string
  advice: string[]
}

export interface GitOpResult {
  ok: boolean
  error?: string
  skipped?: string[]
}

export interface GitFileChange {
  path: string
  originalPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'
  staged: boolean
  unstaged: boolean
}

export interface GitStatusInfo {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  /** git 可执行文件没找到（与「不是仓库」不同，UI 要分开提示） */
  unavailable?: boolean
  gitPath?: string | null
}

export interface GitBranchInfo {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  lastCommit: string
  lastTime: string
  lastSubject: string
}

export interface GitBranchView {
  current: string
  detached: boolean
  branches: GitBranchInfo[]
  remotes: Array<{ name: string; url: string; fetchUrl: string }>
}

export interface GitLogEntry {
  sha: string
  short: string
  author: string
  date: string
  subject: string
}

export interface McpRuntimeState {
  name: string
  source: 'global' | 'project'
  command: string
  args: string[]
  enabled: boolean
  trusted: boolean
  status: 'running' | 'stopped' | 'failed' | 'starting' | 'not-trusted' | 'disabled'
  error?: string
  tools: Array<{ name: string; description?: string }>
}

export interface McpOverview {
  servers: McpRuntimeState[]
  totalTools: number
  globalPath: string
  projectPath: string | null
  globalEnabled: boolean
}

/**
 * 烧录子阶段，由 esptool 真实输出解析而来（build-diagnostics.parseFlashProgress）。
 * 与编译阶段分开：编译是「准备→草图→库→链接→生成二进制」，烧录是「连接→擦除→写入→校验→复位」，
 * 两套动作不一样，阶段条自然也该是两套。
 */
export type FlashStage = 'connect' | 'erase' | 'write' | 'verify' | 'reset'

export interface BuildStageInfo {
  stage: 'prepare' | 'sketch' | 'libs' | 'link' | 'image' | 'done' | 'flashing' | 'flashed'
  label: string
  /** 烧录走到哪一步。仅烧录阶段（flashing / flashed）有值，编译阶段为 undefined。 */
  flashStage?: FlashStage
}

export interface UsageSummary {
  flashBytes: number
  flashPercent: number
  ramBytes: number
  ramPercent: number
  rawFlash: string
  rawRam: string
}

export interface ChannelHealth {
  loggedIn: boolean
  /** 登录是否还有效（最近一次云端调用没报 401）；null = 还没试过 */
  tokenHealthy: boolean | null
  byokActive: string | null
  localReady: boolean
  localModel: string | null
  modelListOk: boolean | null
  lastError: string | null
  /** 引擎本体（llama-server.exe）是否已安装 */
  engineInstalled: boolean
  /** 引擎进程是否在运行 */
  engineRunning: boolean
  /** 已下载的 gguf 模型数 */
  localModelCount: number
  /** 本地引擎可操作状态：running 已就绪 / idle 可一键启动 / not-installed 引擎缺失 / no-models 没模型 */
  engineHint: 'running' | 'idle' | 'not-installed' | 'no-models'
}

export interface TaskSpecLite {
  id: string
  title?: string
  role: 'research' | 'code' | 'review' | 'verify' | 'custom'
  task: string
  writeScope?: string[]
  dependsOn?: string[]
  requireApproval?: boolean
  maxTurns?: number
}

export interface AgentTaskRun {
  spec: TaskSpecLite
  status: 'pending' | 'awaiting-approval' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked'
  agentId: string
  startedAt?: number
  endedAt?: number
  elapsedMs?: number
  summary?: string
  error?: string
  toolCalls: Array<{ name: string; ok: boolean }>
  blockedTools: string[]
  skipReason?: string
}

export interface OrchestrationReport {
  runId: string
  startedAt: number
  endedAt: number
  elapsedMs: number
  ok: boolean
  tasks: AgentTaskRun[]
  layers: string[][]
  conflicts: Array<{ a: string; b: string; files: string[]; resolution: string }>
  summary: string
}

// ── 仪器（#13）数据类型：与主进程 instrumentsService 保持一致，preload 不引主进程模块 ──
export interface LogicAnalyzerFrame {
  kind: 'la'
  sampleRate: number
  triggerIndex: number
  channelCount: number
  channelMask: number
  sampleCount: number
  /** 每字节=各通道电平位图，bit i 置位=第 i 通道高电平 */
  samples: number[]
}
export interface ScopeFrame {
  kind: 'scope'
  sampleRate: number
  channel: number
  sampleCount: number
  /** int16 ADC 原始值 */
  values: number[]
}
export interface PowerReading {
  kind: 'power'
  busV: number
  shuntV: number
  currentA: number
  powerW: number
  present: boolean
}
export type InstrumentData = LogicAnalyzerFrame | ScopeFrame | PowerReading
export interface InstrumentCaps {
  idn?: string
  la?: { maxChannels: number; maxRateHz: number; maxSamples: number }
  scope?: { channels: number[]; maxRateHz: number; maxSamples: number }
  power?: { supported: boolean; i2cAddr?: number }
}
export interface InstrumentStatus extends Partial<InstrumentCaps> {
  connected?: boolean
  port?: string
  error?: string
}
export interface LogicAnalyzerConfig {
  channelMask: number
  sampleRate: number
  preSamples: number
  postSamples: number
  trigChannel: number
  trigEdge: 0 | 1
}
export interface ScopeConfig {
  channel: number
  sampleRate: number
  sampleCount: number
}

export type Api = typeof api

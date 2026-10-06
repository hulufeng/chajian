import { app, shell, BrowserWindow, ipcMain, dialog, session } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { listProjectTree, readTextFile, writeTextFile, readImageAsDataUrl } from './services/fsService'
// 编辑器语言服务：补全 / 悬停 / 跳转 / 实时诊断（#29 #31）+ 编译数据库保障（#30）
import {
  syncDocument, completion, hover as lspHover, definition as lspDefinition,
  ensureCompileDb, disposeAll as disposeLsp, status as lspStatus
} from './services/lspService'
import { listPorts, writeSerial, startPortWatcher, stopPortWatcher } from './services/serialService'
import { aiChat, listModels, getAiState, setAiState, getChannelHealth, getLocalModel, listByokProfiles, saveByokProfile, deleteByokProfile, setActiveByok, setLocalModel, type ChatMessage, type ByokProfile, type AiState } from './services/aiGateway'
import { runCommand } from './services/commandService'
import { pluginManager, isStreamTask, type StreamTask } from './plugins/pluginManager'
import { load as loadArduinoPlugin, manifest as arduinoManifest } from './plugins/arduino-toolchain'
import { load as loadHostAdapter, hostManifest as hostAdapterManifest } from './plugins/hostAdapter'
import {
  installPlugin,
  uninstallPlugin,
  installedPlugins,
  listPlugins,
  scanInstalledPlugins
} from './plugins/pluginInstaller'
import type { ChannelName } from './plugins/pluginManager'
import { readSettings, writeSettings } from './settings'
import { listBoards, detectToolchain, installArduinoCli, boardDetails, listPlatforms, searchPlatforms, installPlatform, uninstallPlatform, listInstalledLibraries, searchLibraries, installLibrary, uninstallLibrary, findToolchain, compileSketch, uploadSketch, normalizeSketchPath, listConnectedBoardsWithSerial, type InstallProgress } from './services/toolchain'
import { schedulerService } from './services/scheduler'
import { setUpdaterWindow, registerUpdaterIpc, checkForUpdates } from './services/updateService'
import { AgentRunner } from './engine/agent-runner'
import type { TreeNode } from './services/fsService'
import * as nodePty from 'node-pty'
import { arduinoGrpc } from './services/grpc-client'
import {
  parseBuildOutput,
  formatBuildReport,
  parseBuildStage,
  parseFlashProgress,
  parseUsageSummary,
  STAGE_LABEL
} from './services/build-diagnostics'
import { generateWiringDiagram, readSketchCode } from './services/wiringService'
import { listLocalModels } from './ai/modelRuntime'
import { checkPinConflicts, formatPinReport, type PinReport } from './services/pinConflict'
import { listTemplates, getTemplate, materializeTemplate, groupTemplates } from './services/templateLibrary'
import { explainSerialLog, type ExplainResult } from './services/logExplainer'
import { readSerialLog } from './services/serialService'
import { recordBurn, listBurnHistory, getBurn, rollbackBurn, removeBurn, ensureSnapshot, summarizeBurn } from './services/burnHistory'
import { buildShareCard, buildAndOpenShareCard, listShareCards } from './services/shareCard'
import {
  getOpenocdInfo,
  installOpenocd,
  listSupportedChips,
  startDebug,
  stopDebug,
  getDebugState,
  isDebugActive,
  readRegisters,
  readMemory,
  listThreads,
  haltDebug,
  resumeDebug,
  stepDebug,
  resetTarget,
  pollTarget,
  setBreakpoint,
  removeBreakpoint,
  debugExec,
  readRawBytes
} from './services/debugService'
import {
  findPio,
  installPio,
  detectPioProject,
  buildPio,
  uploadPio,
  monitorPio,
  type PioEnv
} from './services/platformio'
import { readPartitionTable, readNvsEntries } from './services/partitionTable'
import { createDeviceFs, createSerialFsTransport } from './services/deviceFs'
import {
  listTargets,
  findTarget,
  targetsForUsbId,
  targetForFqbn,
  buildPlatformioIni
} from './services/boardRegistry'
import { runSelfCheck } from './services/hardwareSelfCheck'
import { runTasks, detectConflicts, layerize } from './engine/orchestrator'
import { normalizeAgentTasks } from './engine/tools/multi-agent-tools'
import {
  getStatus as getGitStatus,
  listBranches as listGitBranches,
  getDiff as getGitDiff,
  stage as gitStage,
  stageOne as gitStageOne,
  unstage as gitUnstage,
  discardChanges as gitDiscard,
  commit as gitCommit,
  initRepo as gitInit,
  getLog as getGitLog,
  push as gitPush,
  pull as gitPull,
  fetchRemote as gitFetch,
  addRemote as gitAddRemote,
  createBranch as gitCreateBranch,
  checkoutBranch as gitCheckoutBranch,
  deleteBranch as gitDeleteBranch,
  mergeBranch as gitMergeBranch
} from './services/gitService'
import {
  validateServerEntry as validateMcpServer,
  saveGlobalServer as saveGlobalMcpServer,
  removeGlobalServer as removeGlobalMcpServer,
  setServerTrusted as setMcpServerTrusted,
  setServerEnabled as setMcpServerEnabled
} from './services/mcpConfig'
import {
  getOverview as getMcpOverview,
  startTrustedServers as startTrustedMcpServers,
  stopServer as stopMcpServer
} from './services/mcpManager'
import { getEngineStatus, startLlamaEngine, stopLlamaEngine } from './ai/modelRuntime'
import {
  listInstalledChips as listSvdChips,
  installSvd as installSvdFile,
  importLocalSvd as importSvdFile,
  removeSvd as removeSvdFile,
  getSvdDir as getSvdCacheDir,
  suggestChipByFqbn,
  KNOWN_SVD_CHIPS
} from './services/svdService'

/** 编译/烧录失败时补发的结构化诊断块（供输出面板与「一键 AI 诊断」使用）。 */
function buildDiagnosticChunk(log: string): string {
  try {
    const report = parseBuildOutput(log)
    const text = formatBuildReport(report)
    return text ? `\n[诊断]\n${text}\n` : ''
  } catch {
    return ''
  }
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']

// 活动任务表：id -> 清理函数（kill 子进程 / 关闭串口）
const activeTasks = new Map<string, () => void>()
// PTY 真终端表：id -> pty 实例
const ptyTerminals = new Map<string, nodePty.IPty>()
let taskSeq = 0

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: true,
    frame: false,
    autoHideMenuBar: true,
    title: 'LabCode',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  // 更新服务需要主窗口引用（用于发送状态事件 + 原生对话框父窗口）
  setUpdaterWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    console.log('[codelab] 主进程：窗口已创建，渲染进程加载完成（全部 IPC 能力就绪）')
    mainWindow.show()
  })

  // 麦克风/媒体权限直接授予（本地语音输入用，桌面应用免弹窗）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem')
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 窗口控制 IPC（自定义标题栏用）
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow.close())
  ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())

  /**
   * 原生确认框（三选）。渲染层不能自己造模态，统一走这里。
   * 主要用在一处：任何会**丢弃用户改动**的动作（关标签页 / 关项目 / 关窗口）前，
   * 必须先问一句「保存 / 不保存 / 取消」，不能静默丢掉。
   */
  ipcMain.handle(
    'dialog:confirm',
    async (
      _e,
      opts: {
        title: string
        message: string
        detail?: string
        buttons: string[]
        defaultId?: number
        cancelId?: number
      }
    ) => {
      const res = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: opts.buttons,
        defaultId: opts.defaultId ?? 0,
        // 没给 cancelId 就默认最后一项是"取消"，这样 ESC / 点 × 都等于取消，不会误丢
        cancelId: opts.cancelId ?? opts.buttons.length - 1,
        noLink: true
      })
      // 新版返回对象、旧版直接返回数字，两种都兼容
      return typeof res === 'number' ? res : res.response
    }
  )

  /**
   * 关窗前先问渲染层有没有未保存的改动。
   * close 事件里不能 await 渲染层，所以先把窗口拦住、发消息，等它回结果再定。
   */
  let closeConfirmed = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  mainWindow.on('close', (e) => {
    if (closeConfirmed) return
    e.preventDefault()
    // 已经在等结果了就别重复发（用户连点两次 ×）
    if (closeTimer) return
    mainWindow.webContents.send('app:confirm-close')
    // 兜底：渲染层万一不回应（崩溃 / 卡死 / 未加载），8 秒后强制关，
    // 免得窗口永远关不掉、用户只能杀进程
    closeTimer = setTimeout(() => {
      closeTimer = null
      closeConfirmed = true
      mainWindow.close()
    }, 8000)
  })
  ipcMain.handle('app:close-result', (_e, r: { action: 'close' | 'cancel' }) => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (r?.action === 'close') {
      closeConfirmed = true
      mainWindow.close()
    }
  })

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state-changed', { maximized: true }))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state-changed', { maximized: false }))
}

// ---------- 插件系统初始化 ----------
function initPlugins(): void {
  // 内置官方插件：Arduino CLI 工具链（ESP32 烧录硬链路）
  pluginManager.registerBuiltin(arduinoManifest, loadArduinoPlugin)
  // 宿主能力：把串口会话等宿主接口暴露成命令，供已安装插件通过通道调用
  pluginManager.registerBuiltin(hostAdapterManifest, loadHostAdapter)
  // 已装插件（userData/plugins/*）：装完即接入命令面板 / 设备面板 / Agent 工具集
  const loaded = scanInstalledPlugins()
  console.log(
    `[plugin] 插件系统就绪：${loaded.length} 个，已启用 ${loaded.filter((p) => p.loaded).length} 个（${loaded.map((p) => p.manifest.name).join(', ')}）`
  )
}

// ---------- IPC 注册 ----------
ipcMain.handle('ping', () => 'pong（来自主进程）')

// 视图：缩放 / 全屏
ipcMain.handle('view:zoomIn', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  const wc = win.webContents
  wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1))
  return true
})
ipcMain.handle('view:zoomOut', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  const wc = win.webContents
  wc.setZoomFactor(Math.max(0.5, wc.getZoomFactor() - 0.1))
  return true
})
ipcMain.handle('view:zoomReset', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  win.webContents.setZoomFactor(1)
  return true
})
ipcMain.handle('view:toggleFullscreen', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return false
  win.setFullScreen(!win.isFullScreen())
  return true
})

// ---------- 新建工程（脚手架） ----------
function scaffold(type: string, name: string): Record<string, string> {
  switch (type) {
    case 'python':
      return {
        'main.py': `# ${name}\ndef main():\n    print("Hello, ${name}!")\n\nif __name__ == "__main__":\n    main()\n`,
        'requirements.txt': '# 在此添加依赖\n',
        'README.md': `# ${name}\n\nPython 项目，由 LabCode 生成。\n\n\`\`\`bash\npython main.py\n\`\`\`\n`,
      }
    case 'node':
      return {
        'index.js': `console.log("Hello, ${name}!");\n`,
        'package.json': JSON.stringify({ name, version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2),
        'README.md': `# ${name}\n\nNode.js 项目，由 LabCode 生成。\n\n\`\`\`bash\nnpm start\n\`\`\`\n`,
      }
    case 'cpp':
      return {
        'main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "Hello, ${name}!" << std::endl;\n    return 0;\n}\n`,
        'CMakeLists.txt': `cmake_minimum_required(VERSION 3.10)\nproject(${name})\nset(CMAKE_CXX_STANDARD 17)\nadd_executable(${name} main.cpp)\n`,
        'README.md': `# ${name}\n\nC++ 项目，由 LabCode 生成。\n`,
      }
    case 'rust':
      return {
        'main.rs': `fn main() {\n    println!("Hello, ${name}!");\n}\n`,
        'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "${name}"\npath = "main.rs"\n`,
        'README.md': `# ${name}\n\nRust 项目，由 LabCode 生成。\n`,
      }
    case 'arduino':
      return {
        [`${name}.ino`]: `// ${name} - Arduino 项目\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(2, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(2, HIGH);\n  delay(500);\n  digitalWrite(2, LOW);\n  delay(500);\n}\n`,
        'README.md': `# ${name}\n\nArduino 项目，由 LabCode 生成。板卡：esp32:esp32:esp32c3\n`,
      }
    default:
      return {
        'README.md': `# ${name}\n\n通用项目，由 LabCode 生成。\n`,
        'main.txt': '',
      }
  }
}

ipcMain.handle('project:create', async (_e, opts: { type: string; name: string; parentPath?: string; scaffold?: Array<{ file: string; content: string }> }) => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return { ok: false, error: '无窗口' }
  let parent = opts.parentPath
  if (!parent) {
    const res = await dialog.showOpenDialog(win, { title: '选择工程存放位置', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: '已取消' }
    parent = res.filePaths[0]
  }
  const dir = join(parent, opts.name)
  if (existsSync(dir)) return { ok: false, error: '目录已存在' }
  try {
    mkdirSync(dir, { recursive: true })
    const files = opts.scaffold && opts.scaffold.length > 0
      ? Object.fromEntries(opts.scaffold.map((f) => [f.file.replace(/\{name\}/g, opts.name), f.content.replace(/\{name\}/g, opts.name)]))
      : scaffold(opts.type, opts.name)
    for (const [fname, content] of Object.entries(files)) {
      writeFileSync(join(dir, fname), content, 'utf-8')
    }
    lastProjectRoot = dir
    return { ok: true, root: dir, tree: await listProjectTree(dir) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('project:open', async () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: '打开项目文件夹',
    properties: ['openDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  lastProjectRoot = res.filePaths[0]
  return { root: res.filePaths[0], tree: await listProjectTree(res.filePaths[0]) }
})

ipcMain.handle('project:tree', async (_e, root: string) => {
  if (typeof root !== 'string') return null
  return (await listProjectTree(root)) as TreeNode
})

ipcMain.handle('fs:readFile', async (_e, path: string) => {
  if (typeof path !== 'string') throw new Error('无效路径')
  return readTextFile(path)
})

ipcMain.handle('fs:writeFile', async (_e, path: string, content: string) => {
  if (typeof path !== 'string') throw new Error('无效路径')
  await writeTextFile(path, String(content))
  return true
})

ipcMain.handle('fs:readImage', async (_e, path: string) => {
  if (typeof path !== 'string') throw new Error('invalid path')
  return readImageAsDataUrl(path)
})

// 文件元信息（大小 + mtime），供编辑器大文件保护与外部改动刷新使用
ipcMain.handle('fs:stat', (_e, path: string) => {
  if (typeof path !== 'string') throw new Error('invalid path')
  const st = statSync(path)
  return { size: st.size, mtimeMs: st.mtimeMs }
})

// ── 编辑器语言服务（LSP）──
// 全部返回 { ok, data?, error? }：语言服务器没装（clangd 不在 PATH）时降级为 ok:false，
// 渲染层据此静默关闭智能感知，而不是弹错误——不能因为没装 clangd 就让用户用不了编辑器。
ipcMain.handle('lsp:sync', (_e, p: { file: string; text: string; languageId?: string; delayMs?: number }) => syncDocument(p))
ipcMain.handle('lsp:completion', (_e, p: {
  file: string; text: string; line: number; character: number
  triggerKind?: 1 | 2 | 3; triggerCharacter?: string; languageId?: string
}) => completion(p))
ipcMain.handle('lsp:hover', (_e, p: { file: string; text: string; line: number; character: number; languageId?: string }) => lspHover(p))
ipcMain.handle('lsp:definition', (_e, p: { file: string; text: string; line: number; character: number; languageId?: string }) => lspDefinition(p))
ipcMain.handle('lsp:ensure-db', (_e, p: {
  projectRoot: string; fqbn?: string; files?: string[]
  coreRoot?: string; variant?: string; cpuFreqMHz?: number; extraIncludes?: string[]; force?: boolean
}) => ensureCompileDb(p))
ipcMain.handle('lsp:status', () => lspStatus())
ipcMain.handle('lsp:dispose', () => disposeLsp())

// 内置示例 / 未保存文件 → 暂存为真实临时工程（Arduino IDE 同款思路）：
// 把当前编辑的 .ino 内容写到 <临时目录>/codelab-sketch-run/<名称>/<名称>.ino，
// 返回绝对路径供 compile/upload 使用。每次覆盖写入，保证烧的是编辑器里的最新内容。
ipcMain.handle('fs:stageTempSketch', async (_e, name: string, content: string) => {
  const safe = String(name).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').replace(/^\.+/, '') || 'sketch'
  const file = join(tmpdir(), 'codelab-sketch-run', safe, `${safe}.ino`)
  await writeTextFile(file, String(content ?? ''))
  return file
})

ipcMain.handle('plugin:list', () => pluginManager.list())
// 插件市场：清单 / 安装 / 卸载 / 已装清单 / 热重载 / 调插件命令
ipcMain.handle('plugin:catalog', () => listPlugins())
ipcMain.handle('plugin:install', (_e, id: string, trust?: boolean) => installPlugin(id, { trust: trust === true }))
ipcMain.handle('plugin:installed', () => installedPlugins())
ipcMain.handle('plugin:uninstall', (_e, id: string) => uninstallPlugin(id))
ipcMain.handle('plugin:reload', () => scanInstalledPlugins())
ipcMain.handle('plugin:getCatalogUrl', () => {
  const v = readSettings().pluginCatalogUrl
  return typeof v === 'string' && v.length > 0 ? v : ''
})
ipcMain.handle('plugin:setCatalogUrl', (_e, url: string) => {
  // 空字符串 = 恢复内置清单
  const next = typeof url === 'string' ? url.trim() : ''
  writeSettings({ pluginCatalogUrl: next.length > 0 ? next : null })
  return { ok: true }
})
ipcMain.handle('plugin:invoke', (_e, channel: string, command: string, args?: unknown) =>
  pluginManager.invoke(channel as ChannelName, command, args)
)
ipcMain.handle('plugin:projectTypes', () => pluginManager.getProjectTypes())
ipcMain.handle('plugin:capabilities', () => pluginManager.getCapabilities())
ipcMain.handle('plugin:devicePanels', () => pluginManager.getDevicePanels())
ipcMain.handle('plugin:commands', () => pluginManager.getCommands())


// 能力驱动：按 capability ID 路由到插件声明的工具（capability 能力路由模式）
ipcMain.handle('capability:run', (event, opts: { capability: string; args: Record<string, unknown> }) => {
  const caps = pluginManager.getCapabilities()
  const cap = caps[opts.capability]
  if (!cap) return { ok: false, error: `能力 ${opts.capability} 未声明` }
  const taskId = `cap-${opts.capability}-${++taskSeq}`
  const sender = event.sender
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id: taskId, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id: taskId, code })
    activeTasks.delete(taskId)
  }
  try {
    const result = pluginManager.invoke(cap.transport as 'backend' | 'internal' | 'cli', `${cap.service}.${cap.method}`, opts.args, push)
    // 流式任务（StreamTask）：调用 start 启动，输出通过 push 推送
    if (isStreamTask(result)) {
      const cleanup = result.start(push, done)
      activeTasks.set(taskId, cleanup)
      return { ok: true, taskId }
    }
    // 非流式调用直接返回结果
    if (result !== undefined && typeof result !== 'function') {
      done(0)
      return { ok: true, taskId, result }
    }
    // 旧版函数式 cleanup
    if (typeof result === 'function') {
      activeTasks.set(taskId, result as () => void)
    }
    return { ok: true, taskId }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// 流式任务：把插件命令桥接到 webContents 推送
function startPluginStream(
  event: Electron.IpcMainInvokeEvent,
  kind: string,
  channel: 'backend' | 'internal',
  command: string,
  args: unknown
): { id: string } | unknown {
  const result = pluginManager.invoke(channel, command, args)
  if (!isStreamTask(result)) return result
  const id = `${kind}-${++taskSeq}`
  const sender = event.sender
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cleanup = result.start(push, done)
  activeTasks.set(id, cleanup)
  return { id }
}

ipcMain.handle('toolchain:detect', () => pluginManager.invoke('backend', 'toolchain.detect', {}))

// 一键安装 arduino-cli（新用户无需手动下载），进度通过 toolchain:install-progress 事件推送
ipcMain.handle('toolchain:install', async (event) => {
  const sender = event.sender
  const onProgress = (p: InstallProgress): void => {
    if (!sender.isDestroyed()) sender.send('toolchain:install-progress', p)
  }
  return installArduinoCli(onProgress)
})

// 直接检测工具链（不经过插件层，用于安装后立即刷新状态）
ipcMain.handle('toolchain:detectDirect', () => detectToolchain())

// ── gRPC daemon（arduino-cli daemon 模式，对齐 TrieCode）──
ipcMain.handle('grpc:start', async (_e, opts?: { binPath?: string }) => {
  return arduinoGrpc.start(opts?.binPath)
})
ipcMain.handle('grpc:stop', () => {
  arduinoGrpc.stop()
  return { ok: true }
})
ipcMain.handle('grpc:state', () => arduinoGrpc.getState())
ipcMain.handle('grpc:compile', async (event, opts: { sketch: string; fqbn: string }) => {
  const norm = normalizeSketchPath(require('node:path').resolve(process.cwd(), opts.sketch))
  const absSketch = norm.path
  const sender = event.sender
  const id = `grpc-compile-${++taskSeq}`

  // 校验工程文件真实存在：内置示例 / 未保存的虚拟文件直接报错，
  // 避免把不存在的路径丢给 daemon/CLI 后无输出挂死
  if (!existsSync(absSketch)) {
    if (!sender.isDestroyed()) {
      sender.send('task:output', { id, chunk: `[错误] 工程文件不存在：${absSketch}\n[提示] 当前编辑的可能是内置示例或未保存文件。请先「新建项目 / 打开项目」获得真实工程后再编译。\n` })
      sender.send('task:exit', { id, code: 1, buildPath: '' })
    }
    return { id }
  }

  // 优先 gRPC daemon；不可用（启动超时/未连接）时降级 CLI 直编（产物路径可控，流式格式一致）
  let grpcOk = arduinoGrpc.getState().connected
  if (!grpcOk) {
    const startResult = await arduinoGrpc.start()
    grpcOk = !!startResult.connected
    if (!grpcOk) console.log(`[gRPC] daemon 启动失败，降级 CLI 编译: ${JSON.stringify(startResult)}`)
  }

  if (grpcOk) {
    let log = ''
    let lastStage = ''
    arduinoGrpc.compile(absSketch, opts.fqbn, (line) => {
      log += line
      if (sender.isDestroyed()) return
      sender.send('task:output', { id, chunk: line })
      // 编译过程可见化：阶段只由真实输出推进（准备→编译草图→编译库→链接→生成二进制），
      // 变一次发一次，渲染层不用自己猜。之前只发开始/结束，中间几十秒界面纹丝不动。
      const stage = parseBuildStage(log)
      const label = STAGE_LABEL[stage]
      if (stage !== lastStage) {
        lastStage = stage
        sender.send('task:progress', { id, percent: 0, message: label, stage })
      }
    }, (p) => {
      if (!sender.isDestroyed()) sender.send('task:progress', { id, percent: p.percent, message: p.message })
    }).then((result) => {
      if (norm.cleanup) norm.cleanup()
      if (!sender.isDestroyed()) {
        // 失败时补发错误详情（否则 UI 只显示退出码，看不到失败原因）
        if (!result.success && result.error && !result.output?.includes(result.error)) {
          sender.send('task:output', { id, chunk: `[错误] ${result.error}\n` })
          log += `[错误] ${result.error}\n`
        }
        // 结构化错误分类（P1-8）：失败时把「分类+文件行号+修复建议」发给 UI 与「一键 AI 诊断」
        if (!result.success) sender.send('task:output', { id, chunk: buildDiagnosticChunk(log) })
        // 编译成功时把产物目录带给渲染层（模拟烧录"当前代码"用）
        sender.send('task:exit', { id, code: result.success ? 0 : 1, buildPath: result.success ? result.buildPath || '' : '', fqbn: opts.fqbn })
      }
    })
    return { id }
  }

  // ── 降级路径：arduino-cli CLI 直编（--build-path 指定产物目录）──
  const tool = findToolchain()
  if (!tool) {
    if (!sender.isDestroyed()) {
      sender.send('task:output', { id, chunk: '[错误] 未找到 arduino-cli 工具链，且 gRPC daemon 启动失败，无法编译。\n' })
      sender.send('task:exit', { id, code: 1, buildPath: '' })
    }
    return { id }
  }
  const buildPath = join(tmpdir(), 'codelab-build', `sketch-${Date.now()}`)
  mkdirSync(buildPath, { recursive: true })
  console.log(`[compile] CLI 降级编译: ${absSketch} → ${buildPath}`)
  let cliLog = ''
  let lastStage = ''
  const cp = compileSketch(
    { sketch: absSketch, fqbn: opts.fqbn, bin: tool, buildPath },
    (chunk) => {
      cliLog += chunk
      if (sender.isDestroyed()) return
      sender.send('task:output', { id, chunk })
      // CLI 降级也走同一套阶段推进（与 gRPC 分支一致）
      const stage = parseBuildStage(cliLog)
      if (stage !== lastStage) {
        lastStage = stage
        sender.send('task:progress', { id, percent: 0, message: STAGE_LABEL[stage], stage })
      }
    },
    (code) => {
      if (!sender.isDestroyed()) {
        // 结构化错误分类（P1-8）
        if (code !== 0) sender.send('task:output', { id, chunk: buildDiagnosticChunk(cliLog) })
        sender.send('task:exit', { id, code: code === 0 ? 0 : 1, buildPath: code === 0 ? buildPath : '', fqbn: opts.fqbn })
      }
    }
  )
  activeTasks.set(id, () => { try { cp.kill() } catch { /* 已退出 */ } })
  return { id }
})
ipcMain.handle('grpc:upload', async (event, opts: { sketch: string; fqbn: string; port: string }) => {
  const norm = normalizeSketchPath(require('node:path').resolve(process.cwd(), opts.sketch))
  const absSketch = norm.path
  const sender = event.sender
  const id = `grpc-upload-${++taskSeq}`
  // 烧录前先释放调试会话（openocd 与 esptool 不能同时占用目标）
  if (isDebugActive()) {
    stopDebug()
    broadcastDebugStopped()
  }

  // 校验：工程文件必须真实存在、端口必须已选，否则直接报错（防止 daemon 无输出挂起）
  if (!existsSync(absSketch)) {
    if (!sender.isDestroyed()) {
      sender.send('task:output', { id, chunk: `[错误] 工程文件不存在：${absSketch}\n[提示] 请先「新建项目 / 打开项目」获得真实工程后再烧录。\n` })
      sender.send('task:exit', { id, code: 1 })
    }
    return { id }
  }
  if (!opts.port) {
    if (!sender.isDestroyed()) {
      sender.send('task:output', { id, chunk: '[错误] 未选择串口端口，无法烧录。请在左侧「设备」面板选择端口。\n' })
      sender.send('task:exit', { id, code: 1 })
    }
    return { id }
  }

  // 优先 gRPC daemon；不可用（启动超时/未连接）时降级 CLI 直烧（与 compile 同款降级，杜绝挂死）
  let grpcOk = arduinoGrpc.getState().connected
  if (!grpcOk) {
    const startResult = await arduinoGrpc.start()
    grpcOk = !!startResult.connected
    if (!grpcOk) console.log(`[gRPC] daemon 启动失败，降级 CLI 烧录: ${JSON.stringify(startResult)}`)
  }

  if (grpcOk) {
    let upLog = ''
    arduinoGrpc.upload(absSketch, opts.fqbn, opts.port, (line) => {
      upLog += line
      if (sender.isDestroyed()) return
      sender.send('task:output', { id, chunk: line })
      // 写入过程可见化：把 esptool 的真实输出解析成「阶段 + 百分比」推给界面
      const fp = parseFlashProgress(line, opts.port)
      if (fp) sender.send('task:progress', { id, percent: fp.percent ?? 0, message: fp.label, stage: fp.stage })
    }, (p) => {
      if (!sender.isDestroyed()) sender.send('task:progress', { id, percent: p.percent, message: p.message })
    }).then((result) => {
      if (norm.cleanup) norm.cleanup()
      if (!sender.isDestroyed()) {
        // 失败时补发错误详情（否则 UI 只显示退出码，看不到失败原因）
        if (!result.success && result.error && !result.output?.includes(result.error)) {
          sender.send('task:output', { id, chunk: `[错误] ${result.error}\n` })
          upLog += `[错误] ${result.error}\n`
        }
        // 结构化错误分类（P1-8）：烧录失败也走同一套分类（端口/握手/权限等）
        if (!result.success) sender.send('task:output', { id, chunk: buildDiagnosticChunk(upLog) })
        sender.send('task:exit', { id, code: result.success ? 0 : 1 })
      }
    })
    return { id }
  }

  // ── 降级路径：arduino-cli CLI 直烧 ──
  const tool = findToolchain()
  if (!tool) {
    if (!sender.isDestroyed()) {
      sender.send('task:output', { id, chunk: '[错误] 未找到 arduino-cli 工具链，且 gRPC daemon 启动失败，无法烧录。\n' })
      sender.send('task:exit', { id, code: 1 })
    }
    return { id }
  }
  let cliLog = ''
  const cp = uploadSketch(
    { sketch: absSketch, fqbn: opts.fqbn, bin: tool, port: opts.port },
    (chunk) => {
      cliLog += chunk
      if (sender.isDestroyed()) return
      sender.send('task:output', { id, chunk })
      // CLI 直烧同样走 esptool 输出，用同一套解析给用户看写入进度
      const fp = parseFlashProgress(chunk, opts.port)
      if (fp) sender.send('task:progress', { id, percent: fp.percent ?? 0, message: fp.label, stage: fp.stage })
    },
    (code) => {
      if (norm.cleanup) norm.cleanup()
      if (!sender.isDestroyed()) {
        // 结构化错误分类（P1-8）
        if (code !== 0) sender.send('task:output', { id, chunk: buildDiagnosticChunk(cliLog) })
        sender.send('task:exit', { id, code: code === 0 ? 0 : 1 })
      }
    }
  )
  activeTasks.set(id, () => { try { cp.kill() } catch { /* 已退出 */ } })
  return { id }
})

ipcMain.handle('board:list', (_e, keyword?: string) => {
  try {
    return pluginManager.invoke('backend', 'toolchain.boardSearch', { keyword: keyword || '' }) as unknown
  } catch {
    return []
  }
})

ipcMain.handle('board:details', (_e, fqbn: string) => {
  if (typeof fqbn !== 'string' || !fqbn) return { fqbn: '', name: '', options: [] }
  return boardDetails(fqbn)
})

// ---------- 平台管理 ----------
ipcMain.handle('platform:list', () => {
  try { return { platforms: listPlatforms() } } catch { return { platforms: [] } }
})

ipcMain.handle('platform:search', (_e, opts: { keyword?: string }) => {
  try { return { platforms: searchPlatforms(opts?.keyword || '') } } catch { return { platforms: [] } }
})

ipcMain.handle('platform:install', (event, opts: { platform: string }) => {
  const id = `platform-install-${++taskSeq}`
  const sender = event.sender
  const bin = findToolchain()
  if (!bin) return { id, error: 'arduino-cli 未安装' }
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cp = installPlatform(opts.platform, bin, push, done)
  activeTasks.set(id, () => cp.kill())
  return { id }
})

ipcMain.handle('platform:uninstall', (event, opts: { platform: string }) => {
  const id = `platform-uninstall-${++taskSeq}`
  const sender = event.sender
  const bin = findToolchain()
  if (!bin) return { id, error: 'arduino-cli 未安装' }
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cp = uninstallPlatform(opts.platform, bin, push, done)
  activeTasks.set(id, () => cp.kill())
  return { id }
})

// ---------- 库管理 ----------
ipcMain.handle('library:list', () => {
  try { return { libraries: listInstalledLibraries() } } catch { return { libraries: [] } }
})

ipcMain.handle('library:search', (_e, opts: { keyword?: string }) => {
  try { return { libraries: searchLibraries(opts?.keyword || '') } } catch { return { libraries: [] } }
})

ipcMain.handle('library:install', (event, opts: { name: string }) => {
  const id = `library-install-${++taskSeq}`
  const sender = event.sender
  const bin = findToolchain()
  if (!bin) return { id, error: 'arduino-cli 未安装' }
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cp = installLibrary(opts.name, bin, push, done)
  activeTasks.set(id, () => cp.kill())
  return { id }
})

ipcMain.handle('library:uninstall', (event, opts: { name: string }) => {
  const id = `library-uninstall-${++taskSeq}`
  const sender = event.sender
  const bin = findToolchain()
  if (!bin) return { id, error: 'arduino-cli 未安装' }
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cp = uninstallLibrary(opts.name, bin, push, done)
  activeTasks.set(id, () => cp.kill())
  return { id }
})

// 接线图：根据工程主 sketch 自动生成 SVG 接线示意
ipcMain.handle('wiring:generate', async (_e, opts: { fqbn?: string; projectRoot?: string }) => {
  const Root = opts?.projectRoot || ''
  let fqbn = opts?.fqbn || ''
  if (!fqbn) {
    const bin = findToolchain()
    if (bin) {
      const boards = await listConnectedBoardsWithSerial(bin)
      if (boards[0]?.fqbn) fqbn = boards[0].fqbn
    }
  }
  if (!fqbn) fqbn = 'esp32:esp32:esp32'
  const code = readSketchCode(Root)
  if (!code) {
    return { ok: false, error: `在 ${Root || '(未提供工程路径)'} 下未找到主 sketch（.ino/.cpp），无法生成接线图。` }
  }
  const result = generateWiringDiagram(fqbn, code)
  return { ok: true, fqbn, svg: result.svg, components: result.components, pins: result.pins }
})

// 工具链设置：开发板管理器附加地址
ipcMain.handle('settings:getBoardUrls', () => {
  const s = readSettings()
  const urls = Array.isArray(s.boardUrls) ? s.boardUrls as string[] : []
  return { urls }
})
ipcMain.handle('settings:setBoardUrls', (_e, opts: { urls: string[] }) => {
  const urls = Array.isArray(opts?.urls) ? opts.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) : []
  writeSettings({ boardUrls: urls })
  return { ok: true }
})
ipcMain.handle('settings:resetBoardUrls', () => {
  writeSettings({ boardUrls: [] })
  return { ok: true }
})

// 设备上下文（选中的开发板/端口），持久化到 settings.json
ipcMain.handle('device:get', () => {
  const s = readSettings()
  return { board: (s.deviceBoard as string) || '', port: (s.devicePort as string) || '' }
})
ipcMain.handle('device:set', (_e, opts: { board?: string; port?: string }) => {
  const patch: Record<string, unknown> = {}
  if (typeof opts.board === 'string') patch.deviceBoard = opts.board
  if (typeof opts.port === 'string') patch.devicePort = opts.port
  writeSettings(patch)
  return true
})

ipcMain.handle('toolchain:compile', (event, opts: { sketch: string; fqbn: string; bin: string }) =>
  startPluginStream(event, 'compile', 'backend', 'toolchain.compile', opts)
)

ipcMain.handle('toolchain:upload', (event, opts: { sketch: string; fqbn: string; bin: string; port: string }) => {
  // 烧录会复位目标，先释放调试会话，避免 openocd 与 esptool 抢同一个 USB 设备
  if (isDebugActive()) {
    stopDebug()
    broadcastDebugStopped()
  }
  return startPluginStream(event, 'upload', 'backend', 'toolchain.upload', opts)
})

ipcMain.handle('cmd:run', (event, opts: { cmd: string; cwd: string; shell?: 'powershell' | 'cmd' | 'pwsh' | 'bash' }) => {
  const id = `cmd-${++taskSeq}`
  const sender = event.sender
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  const cp = runCommand(opts.cmd, opts.cwd || process.cwd(), push, done, opts.shell)
  activeTasks.set(id, () => {
    try {
      cp.kill()
    } catch {
      /* 忽略 */
    }
  })
  return { id }
})

ipcMain.handle('task:kill', (_e, id: string) => {
  const cleanup = activeTasks.get(id)
  if (cleanup) {
    cleanup()
    activeTasks.delete(id)
    return true
  }
  return false
})

// ---------- 真终端（node-pty） ----------
const SHELL_MAP: Record<string, string> = {
  powershell: 'powershell.exe',
  cmd: 'cmd.exe',
  pwsh: 'pwsh.exe',
  bash: 'bash.exe'
}

ipcMain.handle('pty:start', (event, opts: { shell?: string; cwd?: string; cols?: number; rows?: number }) => {
  const id = `pty-${++taskSeq}`
  const sender = event.sender
  const shell = SHELL_MAP[opts.shell || 'powershell'] || 'powershell.exe'
  const cwd = opts.cwd || process.cwd()
  try {
    const term = nodePty.spawn(shell, [], {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-color' } as Record<string, string>
    })
    term.onData((data: string) => {
      if (!sender.isDestroyed()) sender.send('pty:data', { id, data })
    })
    term.onExit(() => {
      if (!sender.isDestroyed()) sender.send('pty:exit', { id })
      ptyTerminals.delete(id)
    })
    ptyTerminals.set(id, term)
    return { id }
  } catch (e) {
    return { id: '', error: (e as Error).message }
  }
})

ipcMain.handle('pty:write', (_e, opts: { id: string; data: string }) => {
  const term = ptyTerminals.get(opts.id)
  if (term) {
    term.write(opts.data)
    return true
  }
  return false
})

ipcMain.handle('pty:resize', (_e, opts: { id: string; cols: number; rows: number }) => {
  const term = ptyTerminals.get(opts.id)
  if (term) {
    try { term.resize(opts.cols, opts.rows) } catch { /* 忽略 */ }
    return true
  }
  return false
})

ipcMain.handle('pty:kill', (_e, id: string) => {
  const term = ptyTerminals.get(id)
  if (term) {
    try { term.kill() } catch { /* 忽略 */ }
    ptyTerminals.delete(id)
    return true
  }
  return false
})

ipcMain.handle('serial:list', () => listPorts())

ipcMain.handle('serial:write', (_e, opts: { id: string; data: string }) => {
  return writeSerial(opts.id, opts.data)
})

ipcMain.handle('serial:open', (event, opts: { port: string; baud: number }) => {
  const id = `serial-${opts.port}`
  const sender = event.sender
  const result = pluginManager.invoke('backend', 'serial.open', opts) as StreamTask
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('serial:data', { id, data: chunk })
  }
  const done = (): void => {
    if (!sender.isDestroyed()) sender.send('serial:close', { id, msg: `[${opts.port}] 串口已关闭` })
    activeTasks.delete(id)
  }
  const cleanup = result.start(push, done)
  activeTasks.set(id, cleanup)
  return { id }
})

ipcMain.handle('ai:chat', async (_e, messages: ChatMessage[]) => {
  return aiChat(messages)
})

ipcMain.handle('ai:models', async () => {
  return listModels()
})

ipcMain.handle('ai:state', () => getAiState())

// 渲染层 AiPanel 切换模型 / 保存 BYOK 时直接 invoke，主进程此前漏注册 handler，
// 导致 changeModel / saveByok 的 await 必然 reject（功能静默失败）。补上。
ipcMain.handle('ai:setModel', (_e, modelId: string): AiState => {
  const s = { ...getAiState(), modelId }
  setAiState(s)
  return s
})
ipcMain.handle('ai:setByok', (_e, byok: { baseUrl: string; apiKey: string; model: string } | null): AiState => {
  const s = { ...getAiState(), byok }
  setAiState(s)
  return s
})

// ---------- 多 BYOK profile ----------
ipcMain.handle('ai:byokProfiles', () => listByokProfiles())
ipcMain.handle('ai:byokSave', (_e, profile: ByokProfile) => saveByokProfile(profile))
ipcMain.handle('ai:byokDelete', (_e, id: string) => deleteByokProfile(id))
ipcMain.handle('ai:byokActivate', (_e, id: string | null) => setActiveByok(id))

// ---------- 本地模型列表（供 AiPanel 选择本地 llama 通道） ----------
ipcMain.handle('model:local', async () => {
  // 本地模型：直接扫描已安装 GGUF（无需 Ollama；llama-server 内置引擎同样识别）
  return listLocalModels()
})

// ---------- Agent 引擎（AI 智能体，工具调用闭环） ----------
let agentRunner: AgentRunner | null = null

ipcMain.handle('agent:start', (event, opts: {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  model?: string
  localModel?: string
  securityMode?: 'auto' | 'default' | 'plan'
  thinkingLevel?: 'light' | 'standard' | 'deep'
  projectRoot?: string | null
  maxTurns?: number
  debugMode?: boolean
}) => {
  const sender = event.sender
  // 停止上一个 agent
  if (agentRunner) {
    agentRunner.stop()
    agentRunner = null
  }
  agentRunner = new AgentRunner((ev) => {
    if (!sender.isDestroyed()) sender.send('agent:event', ev)
  })
  // 异步运行，不阻塞 IPC 返回
  void agentRunner.run({ ...opts, debugMode: opts.debugMode ?? false }).catch((e) => {
    if (!sender.isDestroyed()) sender.send('agent:event', { type: 'error', data: { message: (e as Error).message } })
  })
  return { ok: true }
})

ipcMain.handle('agent:stop', () => {
  if (agentRunner) {
    agentRunner.stop()
    agentRunner = null
  }
  return { ok: true }
})

ipcMain.handle('agent:respond', (_e, action: 'allow_once' | 'allow_session' | 'reject') => {
  if (agentRunner) {
    agentRunner.respondConfirm(action)
    return { ok: true }
  }
  return { ok: false, error: '无运行中的 Agent' }
})

ipcMain.handle('agent:planRespond', (_e, opts: { action: 'approve' | 'reject' | 'feedback'; feedback?: string }) => {
  if (agentRunner) {
    agentRunner.respondPlan(opts.action, opts.feedback)
    return { ok: true }
  }
  return { ok: false, error: '无运行中的 Agent' }
})

ipcMain.handle('agent:askRespond', (_e, opts: { answers: string[] }) => {
  if (agentRunner) {
    agentRunner.respondAsk(Array.isArray(opts?.answers) ? opts.answers : [])
    return { ok: true }
  }
  return { ok: false, error: '无运行中的 Agent' }
})

ipcMain.handle('agent:status', () => {
  return agentRunner ? { status: agentRunner.getStatus(), stats: agentRunner.getStats() } : { status: 'idle' }
})


// examples 目录（开发时在项目根，打包后在 resources 下；不存在时回退源码路径供开发机调试）
/** 最近一次打开/创建的工程根（无上下文的 UI 入口用，如设置页生成分享卡片）。 */
let lastProjectRoot = ''

function resolveExamplesDir(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'examples')
    : join(app.getAppPath(), 'examples')
  return existsSync(dir) ? dir : join(app.getAppPath(), 'examples')
}

// examples 目录（开发时在项目根，打包后在 resources 下）
ipcMain.handle('app:getExamplesDir', () => {
  return resolveExamplesDir()
})

/** 用系统默认程序打开一个路径（文件 → 关联程序；目录 → 资源管理器）。
 *  用于「分享卡片历史 / 烧录快照」等产物需要手动定位到磁盘的场景。 */
ipcMain.handle('app:openPath', async (_e, p?: string) => {
  const target = String(p || '').trim()
  if (!target) throw new Error('路径为空')
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`)
  const res = await shell.openPath(target)
  if (res) throw new Error(await res)
  return { ok: true }
})

// ---------- SVD 寄存器数据管理（设置页「寄存器数据」使用）----------
ipcMain.handle('svd:list', () => {
  return {
    dir: getSvdCacheDir(),
    installed: listSvdChips(),
    known: [...KNOWN_SVD_CHIPS]
  }
})

/** 按板卡 FQBN 推断应安装的芯片名（esp32:esp32:esp32s3 → esp32s3） */
ipcMain.handle('svd:suggest', (_e, fqbn?: string) => ({
  chip: suggestChipByFqbn(fqbn)
}))

/** 从乐鑫官方仓库下载安装（gh-proxy 优先，直连兜底） */
ipcMain.handle('svd:install', async (event, opts: { chip?: string; force?: boolean }) => {
  const chip = String(opts.chip || '').trim()
  if (!chip) throw new Error('请填写芯片名（如 esp32s3 / esp32c3）')
  const sender = event.sender
  const result = await installSvdFile(chip, {
    force: !!opts.force,
    onProgress: (p) => {
      if (!sender.isDestroyed()) sender.send('svd:progress', p)
    }
  })
  return { ok: true, chip: result.chip, path: result.path, bytes: result.bytes }
})

/** 导入本地 .svd（离线/内网场景） */
ipcMain.handle('svd:import', (_e, opts: { chip?: string; filePath?: string }) => {
  const chip = String(opts.chip || '').trim()
  if (!chip) throw new Error('请填写芯片名（如 esp32s3）')
  const result = importSvdFile(chip, String(opts.filePath || ''))
  return { ok: true, chip: result.chip, path: result.path, bytes: result.bytes }
})

/** 选择本地 .svd 文件（走系统对话框） */
ipcMain.handle('svd:pickFile', async () => {
  const res = await dialog.showOpenDialog({
    title: '选择 CMSIS-SVD 文件',
    filters: [{ name: 'SVD 文件', extensions: ['svd'] }],
    properties: ['openFile']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('svd:remove', (_e, chip: string) => {
  return { ok: removeSvdFile(String(chip || '')) }
})

// ---------- 引脚冲突检测 ----------
ipcMain.handle('pin:check', (_e, opts: { projectRoot?: string; fqbn?: string }) => {
  const root = String(opts.projectRoot || lastProjectRoot || '')
  if (!root || !existsSync(root)) {
    throw new Error('没有可用的工程目录：请先打开或新建一个项目再检查引脚。')
  }
  const report = checkPinConflicts(root, { fqbn: opts.fqbn })
  // 带上可读文本，便于 UI 直接展示 / Agent 直接吃
  return { ...report, text: formatPinReport(report) }
})

// ---------- 保存即预检（层1 即时静态校验）----------
// 纯分析、零 spawn：板卡合法性（boardRegistry 反查 FQBN）+ 引脚冲突（pinConflict 纯函数）。
// 与手动「引脚检查」的区别：支持 overlay（编辑器实时内容，未必落盘），给「停输 1s / 保存即预检」用。
ipcMain.handle('sketch:precheck', (_e, opts: { projectRoot?: string; fqbn?: string; overlay?: Record<string, string> }) => {
  const root = String(opts.projectRoot || lastProjectRoot || '')
  const fqbn = String(opts.fqbn || '')
  const boardValid = !!targetForFqbn(fqbn)
  if (!root || !existsSync(root)) {
    return { ok: false, boardValid, chip: '', issues: [], summary: '未打开项目，无法预检。', text: '未打开项目，无法预检。' }
  }
  if (!fqbn) {
    return { ok: false, boardValid, chip: '', issues: [], summary: '未选择开发板，无法预检。', text: '未选择开发板，无法预检。' }
  }
  const report = checkPinConflicts(root, { fqbn, overlay: opts.overlay })
  return {
    ok: boardValid && report.issues.filter((i) => i.level === 'error').length === 0,
    boardValid,
    chip: report.chip,
    issues: report.issues,
    summary: report.summary,
    text: formatPinReport(report)
  }
})

// ---------- 模板 / 示例库 ----------
ipcMain.handle('template:groups', () => groupTemplates().map((g) => ({
  category: g.category,
  items: g.items.map((t) => ({ id: t.id, name: t.name, desc: t.desc, category: t.category }))
})))

ipcMain.handle('template:get', (_e, id: string) => {
  const t = getTemplate(String(id || ''))
  if (!t) throw new Error(`模板不存在：${id}`)
  return t
})

ipcMain.handle('template:apply', (_e, opts: { id: string; targetDir: string }) => {
  const dir = String(opts.targetDir || '')
  if (!dir) throw new Error('请指定要生成到的目录')
  return materializeTemplate(String(opts.id || ''), dir)
})

// ---------- 串口日志 AI 解读 ----------
ipcMain.handle('serial:explain', async (_e, opts: { id?: string; logs?: string; maxChars?: number }) => {
  let logs = String(opts?.logs || '')
  if (!logs && opts?.id) {
    const r = readSerialLog(String(opts.id))
    if (!r.ok) throw new Error(r.error || '取串口日志失败')
    logs = r.data || ''
  }
  const result: ExplainResult = await explainSerialLog(logs, { maxChars: opts?.maxChars })
  return result
})

// ---------- 烧录历史 / 回滚 ----------
ipcMain.handle('burn:list', (_e, limit?: number) => {
  return listBurnHistory(limit).map(summarizeBurn)
})

ipcMain.handle('burn:record', (_e, opts: { projectRoot: string; fqbn?: string; port?: string; ok?: boolean; logTail?: string; durationMs?: number; note?: string }) => {
  const rec = recordBurn({ ...opts, ok: opts.ok !== false })
  const n = ensureSnapshot(rec)
  return { ...summarizeBurn(rec), files: n }
})

ipcMain.handle('burn:get', (_e, id: string) => {
  const rec = getBurn(String(id || ''))
  if (!rec) throw new Error(`烧录记录不存在：${id}`)
  return { ...summarizeBurn(rec), logTail: rec.logTail, files: rec.files }
})

ipcMain.handle('burn:rollback', (_e, opts: { id: string; targetRoot?: string }) => {
  return rollbackBurn(String(opts?.id || ''), opts?.targetRoot)
})

ipcMain.handle('burn:remove', (_e, id: string) => ({ ok: removeBurn(String(id || '')) }))

// ---------- 分享卡片 ----------
ipcMain.handle('share:card', (_e, input: Parameters<typeof buildShareCard>[0]) => {
  return buildShareCard(input)
})

ipcMain.handle('share:open', (_e, input: Parameters<typeof buildShareCard>[0]) =>
  buildAndOpenShareCard(input)
)

ipcMain.handle('share:list', () => listShareCards())

// ---------- 本地模型引擎（llama.cpp）管理 ----------
ipcMain.handle('engine:status', () => getEngineStatus())
ipcMain.handle('engine:models', () => listLocalModels())
ipcMain.handle('engine:start', async (_e, opts?: { model?: string }) => {
  const r = await startLlamaEngine(opts?.model)
  if (!r.success) return { ok: false, error: r.error || '启动失败' }
  const model = r.model || opts?.model || ''
  // 关键：引擎起来了但通道没标记本地就绪，界面就仍显示「已登录」而不是「本地就绪」。
  // 之前引擎能跑、状态栏却说云端，用户会以为走的是云端（上一轮静默降级的同源问题）。
  setLocalModel(model)
  return { ok: true, model }
})
ipcMain.handle('engine:stop', () => {
  stopLlamaEngine()
  setLocalModel(null)
  return { ok: true }
})
/**
 * 确保本地通道就绪：只有「上次就在用本地模型」或显式指定时才拉起引擎，
 * 平时（用云端/BYOK）不会无谓占内存。
 * 存在的理由：state.modelId 记的是 local:xxx，但主进程的 activeLocalModel 没同步 →
 * aiChat/aiChatStream 取不到本地模型就静默降级回云端（上次选了本地、重启后照样吃云端 401 或耗积分）。
 */
ipcMain.handle('engine:ensure', async (_e, opts?: { model?: string; force?: boolean }) => {
  const st = getAiState()
  const preferred = opts?.model || (st.modelId?.startsWith('local:') ? st.modelId.slice('local:'.length) : '')
  if (!preferred && !opts?.force) {
    return { ready: false, model: null, error: null, reason: '当前用的是云端/自定义模型，未拉起本地引擎' as string }
  }
  const r = await startLlamaEngine(preferred || undefined)
  if (!r.success) return { ready: false, model: null, error: r.error || '启动失败', reason: null as string | null }
  const model = r.model || preferred
  setLocalModel(model)
  return { ready: true, model, error: null, reason: null as string | null }
})

// ---------- 片上调试（openocd + telnet）----------
// 同一块 ESP32 的「USB JTAG/serial debug unit」与 USB 串口可以共存，
// 但烧录(esptool/arduino upload)会拉复位、重置调试会话，因此烧录前必须先停调试。
ipcMain.handle('debug:info', () => ({
  ...getOpenocdInfo(),
  chips: listSupportedChips()
}))

ipcMain.handle('debug:install', async (event, opts?: { force?: boolean }) => {
  const sender = event.sender
  const r = await installOpenocd(
    { force: !!opts?.force },
    (p) => {
      if (!sender.isDestroyed()) sender.send('debug:progress', p)
    }
  )
  return r
})

ipcMain.handle('debug:chips', () => listSupportedChips())

// ── 硬件目标（板卡注册表：ESP32 / STM32 统一视图）──
ipcMain.handle('target:list', (_e, opts?: { family?: 'esp32' | 'stm32' }) =>
  listTargets(opts?.family).map((t) => ({
    ...t,
    // 调试 cfg 落到本机 openocd 是否存在，UI 直接标可用/缺失
    debugCfgExists: t.debug.cfg.every((c) => existsSync(join(getOpenocdInfo().scripts, c)))
  }))
)

ipcMain.handle('target:get', (_e, id: string) => findTarget(id) || null)

// 一键硬件自检：插板后点一下就知道缺什么（工具链 / 调试器 / 驱动 / 占用）
ipcMain.handle('selfcheck:run', () => runSelfCheck())

// ── MCP 服务器（第四批④）：配置 + 信任 + 运行时 ──
ipcMain.handle('mcp:overview', (_e, opts?: { projectRoot?: string | null }) => getMcpOverview(opts?.projectRoot ?? null))

ipcMain.handle('mcp:start', (_e, opts?: { projectRoot?: string | null }) =>
  startTrustedMcpServers(opts?.projectRoot ?? null)
)

ipcMain.handle('mcp:stop', (_e, opts: { name: string }) => {
  stopMcpServer(opts.name)
  return { ok: true }
})

ipcMain.handle(
  'mcp:add',
  async (
    _e,
    opts: { name: string; command: string; args?: string[]; env?: Record<string, string>; note?: string }
  ) => {
    const err = validateMcpServer(opts)
    if (err) return { ok: false, error: err }
    const r = saveGlobalMcpServer(opts.name, {
      command: opts.command,
      args: opts.args ?? [],
      env: opts.env,
      enabled: true,
      // 信任不写进配置：新增后默认「未信任」，用户要在设置里点一次
      note: opts.note
    })
    return { ok: true, path: r.path }
  }
)

ipcMain.handle('mcp:remove', (_e, opts: { name: string }) => removeGlobalMcpServer(opts.name))

ipcMain.handle('mcp:trust', (_e, opts: { name: string; trusted: boolean; projectRoot?: string | null }) =>
  setMcpServerTrusted(opts.name, opts.trusted, opts.projectRoot ?? null)
)

ipcMain.handle('mcp:enable', (_e, opts: { name: string; enabled: boolean; projectRoot?: string | null }) =>
  setMcpServerEnabled(opts.name, opts.enabled, opts.projectRoot ?? null)
)

// 编译过程：把输出文本解析成「阶段 + 资源用量」，渲染层只显示不猜
ipcMain.handle('build:inspect', (_e, text: string) => {
  const stage = parseBuildStage(String(text || ''))
  return {
    stage: { stage, label: STAGE_LABEL[stage] },
    usage: parseUsageSummary(String(text || ''))
  }
})

// AI 通道健康度：让「能不能用」在界面上可见（未登录/登录过期/本地就绪/BYOK 激活）
ipcMain.handle('ai:health', () => getChannelHealth())

// ── 多智能体编排（协调者 + 并行 worker）──
ipcMain.handle('orchestra:plan', (_e, opts: { tasks: unknown[]; projectRoot?: string | null }) => {
  const specs = normalizeAgentTasks(opts.tasks, opts.projectRoot || process.cwd()).tasks
  const conflicts = detectConflicts(specs)
  const { layers, cyclic, dangling } = layerize(specs)
  return { tasks: specs, conflicts, layers, cyclic, dangling }
})

ipcMain.handle(
  'orchestra:run',
  async (event, opts: { tasks: unknown[]; projectRoot?: string | null; concurrency?: number; approvedIds?: string[] }) => {
    const { tasks: specs, warnings } = normalizeAgentTasks(opts.tasks, opts.projectRoot || process.cwd())
    if (!specs.length) {
      throw new Error(warnings[0] || '没有可执行的任务（每个任务至少要有 task 描述）')
    }
    const sender = event.sender
    return runTasks(specs, {
      projectRoot: opts.projectRoot || process.cwd(),
      concurrency: opts.concurrency,
      approvedIds: opts.approvedIds,
      // 实时把任务状态推给渲染层，看板才能滚动更新
      onEvent: (tasks) => {
        if (!sender.isDestroyed()) sender.send('orchestra:event', tasks)
      }
    })
  }
)

// ── Git 面板（第四批③）：状态 / 暂存 / 提交 / 分支 / 远端 ──
ipcMain.handle('git:status', (_e, opts: { root: string }) => getGitStatus(opts.root))
ipcMain.handle('git:branches', (_e, opts: { root: string }) => listGitBranches(opts.root))
ipcMain.handle('git:diff', (_e, opts: { root: string; path: string; staged: boolean }) =>
  getGitDiff(opts.root, opts.path, opts.staged)
)
ipcMain.handle('git:stage', (_e, opts: { root: string; paths: string[] }) => gitStage(opts.root, opts.paths))
ipcMain.handle('git:stageOne', (_e, opts: { root: string; path: string }) => gitStageOne(opts.root, opts.path))
ipcMain.handle('git:unstage', (_e, opts: { root: string; paths: string[] }) => gitUnstage(opts.root, opts.paths))
ipcMain.handle('git:discard', (_e, opts: { root: string; paths: string[] }) => gitDiscard(opts.root, opts.paths))
ipcMain.handle('git:commit', (_e, opts: { root: string; message: string }) => gitCommit(opts.root, opts.message))
ipcMain.handle('git:init', (_e, opts: { root: string; branch?: string }) => gitInit(opts.root, opts.branch || 'main'))
ipcMain.handle('git:log', (_e, opts: { root: string; n?: number }) => getGitLog(opts.root, opts.n ?? 30))
ipcMain.handle('git:push', (_e, opts: { root: string }) => gitPush(opts.root))
ipcMain.handle('git:pull', (_e, opts: { root: string }) => gitPull(opts.root))
ipcMain.handle('git:fetch', (_e, opts: { root: string }) => gitFetch(opts.root))
ipcMain.handle('git:remoteAdd', (_e, opts: { root: string; name: string; url: string }) =>
  gitAddRemote(opts.root, opts.name, opts.url)
)
ipcMain.handle('git:branchCreate', (_e, opts: { root: string; name: string; checkout?: boolean }) =>
  gitCreateBranch(opts.root, opts.name, opts.checkout !== false)
)
ipcMain.handle('git:branchCheckout', (_e, opts: { root: string; name: string }) =>
  gitCheckoutBranch(opts.root, opts.name)
)
ipcMain.handle('git:branchDelete', (_e, opts: { root: string; name: string; force?: boolean }) =>
  gitDeleteBranch(opts.root, opts.name, !!opts.force)
)
ipcMain.handle('git:branchMerge', (_e, opts: { root: string; name: string }) => gitMergeBranch(opts.root, opts.name))

ipcMain.handle('target:detect', async () => {
  const ports = await listPorts()
  return ports.map((p) => {
    const usbId = p.vid != null && p.pid != null ? `0x${p.vid.toString(16)}:0x${p.pid.toString(16)}` : ''
    // 同一个 VID:PID 可能对应多块板（ESP32-S3/C3/P4 的原生 USB 都是 303a:1001），
    // 光看 USB ID 分不出来 —— 候选摊给 UI，别把 targetName 撑成"已经认准了"的假象。
    const hits = usbId ? targetsForUsbId(usbId) : []
    const hit = hits[0]
    return {
      ...p,
      usbId,
      targetId: hit?.id ?? null,
      targetName: hit?.name ?? null,
      candidateIds: hits.map((t) => t.id)
    }
  })
})

/**
 * 宿主版本：UI 的「设置 · 关于」处必须显示真实版本号。
 * 之前 SettingsModal 写死了 v0.1.9，跟实际发出的包（1.1.3）对不上。
 */
ipcMain.handle('app:version', () => app.getVersion())

/** 运行时目录：开发是 app.getAppPath()，打包是 resources 根（process.resourcesPath）。给渲染层当"路径事实"用。 */
ipcMain.handle('app:resourcesPath', () => {
  if (app.isPackaged) return process.resourcesPath
  return app.getAppPath()
})

/**
 * 工具链内置 Web UI 的 file:// 地址。
 *
 * 踩过的坑（一次打包必崩-site）：
 *   1. 渲染层拿不到 `process`（nodeIntegration:false + contextIsolation:true），
 *      ToolchainSidebar 里写 `process.resourcesPath` 会在 render 阶段 ReferenceError，
 *      左侧栏整体白屏 —— 所以路径一律由主进程算好送上来；
 *   2. 开发期目录是 `arduino-toolchain`，打包路径被写成了 `arduino-cli-toolchain`（不存在）；
 *   3. dev / prod 的 resources 根也不一样，必须让 app.isPackaged 决定。
 * 因此这里**判存**：文件不存在就返回空串，渲染层降级成一行说明，
 * 一个页面缺失不该把整个侧栏带崩。
 */
ipcMain.handle('toolchain:ui-url', (_e, tab: string): string => {
  const safe = /^[a-z0-9-]+$/i.test(tab || '') ? tab : ''
  if (!safe) return ''
  const rel = join('plugins', 'arduino-toolchain', 'ui', `${safe}.html`)
  // 逐个判存，取第一个真的在磁盘上的。踩过的坑（顺序即真实情况）：
  //   1) apps 里配了 asarUnpack('**/plugins/**')，plugins 根本不进 asar，
  //      而是解到 resources/app.asar.unpacked/out/main/... 落盘 —— 打包后唯一判存成功的根，
  //      file:// iframe 也只认磁盘真实文件，asr 内部路径一定加载不了。
  //   2) asar 未解包时 UI 在 resources/app.asar/out/main/... 内，existsSync 看不见 asar 内部，
  //      判存必然落空，保留只是为了让配置失效时报错信息能指出根因。
  //   3) 直接拼 resources/plugins/... 是错的（UI 不在 resources 根下）。
  //   开发态 app.getAppPath() 是项目根，真实文件在 out/main/plugins/... 下。
  const roots = app.isPackaged
    ? [
        join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main'),
        join(process.resourcesPath, 'app.asar', 'out', 'main'),
        join(process.resourcesPath, 'out', 'main'),
      ]
    : [join(app.getAppPath(), 'out', 'main')]
  for (const root of roots) {
    const file = join(root, rel)
    if (existsSync(file)) return `file:///${file.replace(/\\/g, '/')}`
  }
  return ''
})

ipcMain.handle(
  'target:write-ini',
  async (_e, opts: { projectRoot: string; boardId: string; env?: string; uploadPort?: string }) => {
    const t = findTarget(opts.boardId)
    if (!t) throw new Error(`未知板卡：${opts.boardId}`)
    const root = resolve(opts.projectRoot)
    if (!existsSync(root)) throw new Error(`工程目录不存在：${root}`)
    const iniPath = join(root, 'platformio.ini')
    if (existsSync(iniPath)) throw new Error('工程里已有 platformio.ini，请手工合并（面板不覆盖已有文件）')
    const body = buildPlatformioIni(t, { env: opts.env }).replace(
      '; upload_port 需要按实际端口改（面板可自动探测后回填）',
      opts.uploadPort ? `upload_port = ${opts.uploadPort}` : '; upload_port 待填'
    )
    writeFileSync(iniPath, body, 'utf-8')
    return { ok: true, path: iniPath }
  }
)

ipcMain.handle('debug:start', (_e, opts?: { chip?: string; boardCfg?: string; telnetPort?: number }) =>
  startDebug(opts || {})
)

ipcMain.handle('debug:stop', () => stopDebug())

ipcMain.handle('debug:state', () => getDebugState())

ipcMain.handle('debug:registers', () => readRegisters())

ipcMain.handle('debug:memory', (_e, opts: { addr: string | number; count?: number }) =>
  readMemory(opts.addr, opts.count ?? 64)
)

ipcMain.handle('debug:threads', () => listThreads())

ipcMain.handle('debug:halt', () => haltDebug())

ipcMain.handle('debug:resume', () => resumeDebug())

ipcMain.handle('debug:step', () => stepDebug())

ipcMain.handle('debug:reset', () => resetTarget())

ipcMain.handle('debug:poll', () => pollTarget())

ipcMain.handle('debug:setBreakpoint', (_e, addr: string | number) => setBreakpoint(addr))

ipcMain.handle('debug:removeBreakpoint', (_e, addr?: string | number) => removeBreakpoint(addr))

ipcMain.handle('debug:exec', (_e, cmd: string) => debugExec(cmd))

// ── 分区表 / NVS（复用 openocd 读内存，不额外拉 esptool）──
ipcMain.handle('debug:partitions', async () => {
  if (!isDebugActive()) {
    throw new Error('先连接片上调试器（工具栏「片上调试器」→ 连接调试器），再读分区表')
  }
  return readPartitionTable(readRawBytes)
})

ipcMain.handle(
  'debug:nvs',
  async (_e, opts?: { addr?: number; size?: number }) => {
    if (!isDebugActive()) {
      throw new Error('先连接片上调试器（工具栏「片上调试器」→ 连接调试器），再读 NVS')
    }
    const partitions = await readPartitionTable(readRawBytes)
    const nvsPart = opts?.addr
      ? {
          address: opts.addr,
          tablePos: 0,
          name: 'nvs',
          type: 1,
          subtype: 2,
          offset: 0,
          size: opts.size ?? 0x4000,
          flags: 0,
          kind: 'data' as const,
          subtypeName: 'nvs'
        }
      : partitions.find((p) => p.kind === 'data' && p.subtypeName === 'nvs')
    if (!nvsPart) {
      return { entries: [], partitions, note: '分区表里没找到 nvs 分区（自定义分区表？）' }
    }
    const entries = await readNvsEntries(readRawBytes, nvsPart, opts?.size ?? 0x4000)
    return { entries, partitions, note: '' }
  }
)

// ── PlatformIO（对标 Embedist / Espressif-IDE 的 pio 链路）──
let pioMonitorStopper: { stop: () => void } | null = null

ipcMain.handle('platformio:info', (_e, opts?: { projectRoot?: string | null }) => {
  const root = opts?.projectRoot ?? null
  return { ...findPio(root), project: detectPioProject(root) }
})

ipcMain.handle('platformio:install', (event) => {
  const sender = event.sender
  return installPio((p) => {
    if (!sender.isDestroyed()) sender.send('pio:progress', p)
  })
})

ipcMain.handle('platformio:envs', (_e, opts: { projectRoot: string | null }) =>
  detectPioProject(opts?.projectRoot ?? null)
)

ipcMain.handle('platformio:build', (event, opts: { projectRoot: string; env?: string }) => {
  const id = `pio-build-${++taskSeq}`
  const sender = event.sender
  activeTasks.set(id, () => undefined)
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  return buildPio(opts.projectRoot, opts.env, push).then((r) => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code: r.ok ? 0 : 1 })
    activeTasks.delete(id)
    return r
  })
})

ipcMain.handle('platformio:upload', (event, opts: { projectRoot: string; env?: string; port?: string }) => {
  const id = `pio-upload-${++taskSeq}`
  const sender = event.sender
  activeTasks.set(id, () => undefined)
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  return uploadPio(opts.projectRoot, { env: opts.env, port: opts.port }, push).then((r) => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code: r.ok ? 0 : 1 })
    activeTasks.delete(id)
    return r
  })
})

ipcMain.handle(
  'platformio:monitor',
  (event, opts: { projectRoot: string; env?: string; port?: string; baud?: number }) => {
    const id = `pio-monitor-${++taskSeq}`
    const sender = event.sender
    activeTasks.set(id, () => undefined)
    pioMonitorStopper?.stop()
    const push = (chunk: string): void => {
      if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
    }
    const finish = (msg: string): void => {
      if (!sender.isDestroyed()) sender.send('task:exit', { id, code: 0, message: msg })
      activeTasks.delete(id)
      pioMonitorStopper = null
    }
    pioMonitorStopper = monitorPio(opts.projectRoot, opts, push, finish)
    return { id }
  }
)

ipcMain.handle('platformio:stop-monitor', () => {
  pioMonitorStopper?.stop()
  pioMonitorStopper = null
  return { ok: true }
})

// ── 设备端文件系统（串口 FS 行协议：浏览 / 读写 / 文件夹同步）──
function deviceFsFor(sessionId: string): ReturnType<typeof createDeviceFs> {
  return createDeviceFs(createSerialFsTransport(sessionId))
}

ipcMain.handle('devicefs:list', (_e, opts: { sessionId: string; path: string }) =>
  deviceFsFor(opts.sessionId).list(opts.path)
)

ipcMain.handle('devicefs:read', (_e, opts: { sessionId: string; path: string }) =>
  deviceFsFor(opts.sessionId).read(opts.path)
)

ipcMain.handle('devicefs:write', (_e, opts: { sessionId: string; path: string; content: string }) =>
  deviceFsFor(opts.sessionId).write(opts.path, opts.content)
)

ipcMain.handle('devicefs:mkdir', (_e, opts: { sessionId: string; path: string }) =>
  deviceFsFor(opts.sessionId).mkdir(opts.path)
)

ipcMain.handle('devicefs:remove', (_e, opts: { sessionId: string; path: string }) =>
  deviceFsFor(opts.sessionId).remove(opts.path)
)

ipcMain.handle('devicefs:stat', (_e, opts: { sessionId: string; path: string }) =>
  deviceFsFor(opts.sessionId).stat(opts.path)
)

ipcMain.handle(
  'devicefs:sync',
  (event, opts: { sessionId: string; localDir: string; deviceDir: string }) => {
    const sender = event.sender
    return deviceFsFor(opts.sessionId)
      .syncUp(opts.localDir, opts.deviceDir, (msg) => {
        if (!sender.isDestroyed()) sender.send('devicefs:progress', msg)
      })
      .then((r) => ({ ...r, ok: true }))
      .catch((e: Error) => ({ ok: false, uploaded: [], skipped: [], error: e.message }))
  }
)

/** 调试会话被外部动作（如烧录）终止时通知渲染层刷新面板 */
function broadcastDebugStopped(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('debug:stopped', getDebugState())
  }
}

app.whenReady().then(() => {
  initPlugins()
  createWindow()

  // ── 记住上次用的本地模型，开机后台接上 ──
  // 不这么做的话：下拉框里明明选着「Qwen2.5 Coder 3B」，重启发消息却走云端
  // （state.modelId 是 local:，但主进程的 activeLocalModel 没同步，aiChat 取不到就降级）。
  // 不 await：引擎起得十几秒，等它只会拖慢窗口；失败就打日志，界面照常显示「一键启动」入口。
  {
    const modelId = getAiState().modelId ?? ''
    if (modelId.startsWith('local:')) {
      const file = modelId.slice('local:'.length)
      startLlamaEngine(file)
        .then((r) => {
          if (r.success) setLocalModel(r.model || file)
          else console.warn('[ai] 上次用的本地模型启动失败：', r.error)
        })
        .catch((e) => console.warn('[ai] 本地引擎自动接上失败：', e))
    }
  }

  // ── 串口热插拔检测：插上开发板自动刷新端口 + 自动识别板卡并选中 ──
  startPortWatcher(({ ports, added, removed }) => {
    const broadcast = (channel: string, payload: unknown): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload)
      }
    }
    // 1) 端口列表变化 → 刷新界面下拉
    broadcast('serial:ports-changed', { ports, added, removed })

    // 2) 新端口插入 → 识别板卡（arduino-cli board list + serialport 兜底，识别 ESP32 等），并自动选中
    if (added.length > 0) {
      const port = added[added.length - 1]
      void (async () => {
        let fqbn = ''
        let name = ''
        try {
          const bin = findToolchain()
          if (bin) {
            const boards = (await listConnectedBoardsWithSerial(bin)) as Array<{ fqbn?: string; name?: string; port?: string }>
            const hit = boards.find((b) => b.port === port) || boards[0]
            if (hit) {
              fqbn = hit.fqbn || ''
              name = hit.name || ''
            }
          }
        } catch {
          /* 板卡识别失败时仍自动选中端口 */
        }
        console.log(`[hotplug] 检测到新端口 ${port}${fqbn ? `，识别板卡 ${name || fqbn}` : '（未识别到板卡型号）'}`)
        broadcast('device:auto-select', { action: 'added', port, fqbn, name })
      })()
    }

    // 3) 端口拔出 → 通知界面清除选中
    if (removed.length > 0) {
      broadcast('device:auto-select', { action: 'removed', port: '', fqbn: '', name: '', removed })
    }
  })

  // ── 强制更新 / 自动更新：注册 IPC + 启动后延迟自检（仅打包态）──
  registerUpdaterIpc()
  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdates()
    }, 4000)
  }

  // ── 定时任务服务：注入触发器（开独立 Agent 会话跑 prompt）+ 启动常驻扫描 ──
  schedulerService.setTriggerHandler(async (projectRoot, prompt) => {
    const tail: string[] = []
    // 每次调度独立开一个 AgentRunner，避免影响用户正在交互的会话
    const runner = new AgentRunner((ev) => {
      if (ev.type === 'message') {
        const d = ev.data as { role?: string; content?: string }
        if (d && d.role === 'assistant' && d.content) tail.push(d.content)
      }
    })
    await runner.run({
      messages: [{ role: 'user', content: prompt }],
      projectRoot,
      securityMode: 'auto',
      thinkingLevel: 'standard',
      localModel: getLocalModel() ?? undefined,
      maxTurns: 12
    })
    const last = tail[tail.length - 1] || '(无文本输出)'
    return last.slice(0, 1500)
  })
  schedulerService.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopPortWatcher()
  arduinoGrpc.stop()
  if (process.platform !== 'darwin') app.quit()
})

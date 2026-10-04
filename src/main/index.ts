import { app, shell, BrowserWindow, ipcMain, dialog, session } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { listProjectTree, readTextFile, writeTextFile, readImageAsDataUrl } from './services/fsService'
import { listPorts, writeSerial } from './services/serialService'
import { aiChat, listModels, getAiState, setAiState, clearAiState, getLocalModel, authRegister, authLogin, refreshMe, listByokProfiles, saveByokProfile, deleteByokProfile, setActiveByok, type ChatMessage, type UserInfo, type ByokProfile } from './services/aiGateway'
import { runCommand } from './services/commandService'
import { runSimBurn, type SimBurnFile } from './services/simBurnService'
import { FAKE_CHIPS } from './services/fakeBoardService'
import * as gitSvc from './services/gitService'
import { pluginManager, isStreamTask, type StreamTask } from './plugins/pluginManager'
import { fetchMarketPlugins, installPlugin, uninstallPlugin, getInstalledPlugins, loadUserPlugins } from './plugins/pluginMarket'
import { load as loadArduinoPlugin, manifest as arduinoManifest } from './plugins/arduino-toolchain'
import { load as loadEspIdfPlugin, manifest as espIdfManifest } from './plugins/esp-idf-toolchain'
import { load as loadStm32Plugin, manifest as stm32Manifest } from './plugins/stm32-cube-toolchain'
import { initUpdater, readSettings, writeSettings } from './updater'
import { listBoards, detectToolchain, installArduinoCli, boardDetails, listPlatforms, searchPlatforms, installPlatform, uninstallPlatform, listInstalledLibraries, searchLibraries, installLibrary, uninstallLibrary, findToolchain, compileSketch, normalizeSketchPath, type InstallProgress } from './services/toolchain'
import { AgentRunner } from './engine/agent-runner'
import { schedulerService } from './services/scheduler'
import type { TreeNode } from './services/fsService'
import * as nodePty from 'node-pty'
import { startMcpClient, stopMcpClient, getMcpClient } from './services/mcp-client'
import { arduinoGrpc } from './services/grpc-client'
import { getHardwareInfo } from './system/hardwareInfo'
import {
  MODEL_CATALOG,
  isOllamaInstalled,
  isOllamaRunning,
  startOllama,
  listLocalModels,
  pullModel,
  deleteModel,
  recommendModels,
  chatWithLocalModel,
  ensureEngine,
  getEngineStatus,
  type ModelDefinition,
} from './ai/modelRuntime'
import {
  getCurrentKbVersion,
  KB_BUILTIN_VERSION,
  checkKnowledgeUpdate,
  updateKnowledge,
  resetKnowledge,
} from './ai/knowledgeUpdater'

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

  // 自动更新（仅打包后生效）
  initUpdater(mainWindow)

  // 窗口控制 IPC（自定义标题栏用）
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow.close())
  ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state-changed', { maximized: true }))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state-changed', { maximized: false }))
}

// ---------- 插件系统初始化 ----------
function initPlugins(): void {
  // 内置官方插件：Arduino CLI / ESP-IDF / STM32Cube 工具链
  pluginManager.registerBuiltin(arduinoManifest, loadArduinoPlugin)
  pluginManager.registerBuiltin(espIdfManifest, loadEspIdfPlugin)
  pluginManager.registerBuiltin(stm32Manifest, loadStm32Plugin)
  // 磁盘插件发现（未来第三方插件目录）
  const pluginDir = app.isPackaged
    ? join(process.resourcesPath, 'plugins')
    : join(process.cwd(), 'src', 'main', 'plugins')
  pluginManager.loadFromDir(pluginDir)
  // 加载用户已安装的插件（%APPDATA%/LabCode/plugins）
  loadUserPlugins()
  const loaded = pluginManager.init()
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

ipcMain.handle('plugin:list', () => pluginManager.list())
ipcMain.handle('plugin:projectTypes', () => pluginManager.getProjectTypes())
ipcMain.handle('plugin:capabilities', () => pluginManager.getCapabilities())
ipcMain.handle('plugin:devicePanels', () => pluginManager.getDevicePanels())
ipcMain.handle('plugin:commands', () => pluginManager.getCommands())

// ========== 插件市场（真实下载/安装/卸载） ==========
ipcMain.handle('plugin:market', async () => {
  try {
    return await fetchMarketPlugins()
  } catch (e) {
    console.warn('[plugin-market] 获取市场列表失败:', (e as Error).message)
    return []
  }
})
ipcMain.handle('plugin:installed', () => getInstalledPlugins())
ipcMain.handle('plugin:install', async (_event, pluginId: string, downloadUrl: string) => {
  return installPlugin(pluginId, downloadUrl)
})
ipcMain.handle('plugin:uninstall', (_event, pluginId: string) => {
  return uninstallPlugin(pluginId)
})

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

  // 优先 gRPC daemon；不可用（启动超时/未连接）时降级 CLI 直编（产物路径可控，流式格式一致）
  let grpcOk = arduinoGrpc.getState().connected
  if (!grpcOk) {
    const startResult = await arduinoGrpc.start()
    grpcOk = !!startResult.connected
    if (!grpcOk) console.log(`[gRPC] daemon 启动失败，降级 CLI 编译: ${JSON.stringify(startResult)}`)
  }

  if (grpcOk) {
    arduinoGrpc.compile(absSketch, opts.fqbn, (line) => {
      if (!sender.isDestroyed()) sender.send('task:output', { id, chunk: line })
    }, (p) => {
      if (!sender.isDestroyed()) sender.send('task:progress', { id, percent: p.percent, message: p.message })
    }).then((result) => {
      if (norm.cleanup) norm.cleanup()
      if (!sender.isDestroyed()) {
        // 失败时补发错误详情（否则 UI 只显示退出码，看不到失败原因）
        if (!result.success && result.error && !result.output?.includes(result.error)) {
          sender.send('task:output', { id, chunk: `[错误] ${result.error}\n` })
        }
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
  const cp = compileSketch(
    { sketch: absSketch, fqbn: opts.fqbn, bin: tool, buildPath },
    (chunk) => { if (!sender.isDestroyed()) sender.send('task:output', { id, chunk }) },
    (code) => {
      if (!sender.isDestroyed()) {
        sender.send('task:exit', { id, code: code === 0 ? 0 : 1, buildPath: code === 0 ? buildPath : '', fqbn: opts.fqbn })
      }
    }
  )
  activeTasks.set(id, () => { try { cp.kill() } catch { /* 已退出 */ } })
  return { id }
})
ipcMain.handle('grpc:upload', async (event, opts: { sketch: string; fqbn: string; port: string }) => {
  const state = arduinoGrpc.getState()
  if (!state.connected) {
    await arduinoGrpc.start()
  }
  const sender = event.sender
  const id = `grpc-upload-${++taskSeq}`
  arduinoGrpc.upload(opts.sketch, opts.fqbn, opts.port, (line) => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk: line })
  }, (p) => {
    if (!sender.isDestroyed()) sender.send('task:progress', { id, percent: p.percent, message: p.message })
  }).then((result) => {
    if (!sender.isDestroyed()) {
      // 失败时补发错误详情（否则 UI 只显示退出码，看不到失败原因）
      if (!result.success && result.error && !result.output?.includes(result.error)) {
        sender.send('task:output', { id, chunk: `[错误] ${result.error}\n` })
      }
      sender.send('task:exit', { id, code: result.success ? 0 : 1 })
    }
  })
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

ipcMain.handle('toolchain:upload', (event, opts: { sketch: string; fqbn: string; bin: string; port: string }) =>
  startPluginStream(event, 'upload', 'backend', 'toolchain.upload', opts)
)

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

// ---------- 模拟烧录（软件内虚拟开发板，RFC2217 协议） ----------
ipcMain.handle('simBurn:list', () =>
  FAKE_CHIPS.map((c) => ({ id: c.id, name: c.name, revision: c.revision, mac: c.mac }))
)

ipcMain.handle('simBurn:start', (event, opts: { chipId: string; files: SimBurnFile[]; baud?: number }) => {
  const id = `simburn-${++taskSeq}`
  const sender = event.sender
  const cancelFlag = { cancelled: false }
  const push = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('task:output', { id, chunk })
  }
  const prog = (percent: number, message: string): void => {
    if (!sender.isDestroyed()) sender.send('task:progress', { id, percent, message })
  }
  const done = (code: number): void => {
    if (!sender.isDestroyed()) sender.send('task:exit', { id, code })
    activeTasks.delete(id)
  }
  runSimBurn({ ...opts, cancelFlag }, push, prog).then(
    (r) => done(r.ok ? 0 : 1),
    (err) => {
      push(`${err?.message || err}\n`)
      done(1)
    }
  )
  activeTasks.set(id, () => {
    cancelFlag.cancelled = true
  })
  return { id }
})

// ---------- Git 源代码管理 ----------
ipcMain.handle('git:status', (_e, root: string) => gitSvc.getStatus(root))
ipcMain.handle('git:diff', (_e, opts: { root: string; path: string; staged: boolean }) =>
  gitSvc.getDiff(opts.root, opts.path, opts.staged))
ipcMain.handle('git:stage', (_e, opts: { root: string; paths: string[] }) => gitSvc.stage(opts.root, opts.paths))
ipcMain.handle('git:stageAll', (_e, root: string) => gitSvc.stageAll(root))
ipcMain.handle('git:unstage', (_e, opts: { root: string; paths: string[] }) => gitSvc.unstage(opts.root, opts.paths))
ipcMain.handle('git:commit', (_e, opts: { root: string; message: string }) => gitSvc.commit(opts.root, opts.message))
ipcMain.handle('git:init', (_e, root: string) => gitSvc.initRepo(root))
ipcMain.handle('git:log', (_e, opts: { root: string; n?: number }) => gitSvc.getLog(opts.root, opts.n))
ipcMain.handle('git:pull', (_e, root: string) => gitSvc.pull(root))
ipcMain.handle('git:push', (_e, root: string) => gitSvc.push(root))
ipcMain.handle('git:applyPatch', (_e, opts: { root: string; patch: string; cached?: boolean }) =>
  gitSvc.applyPatch(opts.root, opts.patch, opts.cached !== false))

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

// ---------- MCP 服务器配置 ----------
ipcMain.handle('mcp:list', () => {
  const s = readSettings()
  return (s.mcpServers as Array<Record<string, unknown>>) || []
})
ipcMain.handle('mcp:add', (_e, server: { name: string; command: string; args?: string[]; transport?: string }) => {
  const s = readSettings()
  const list = ((s.mcpServers as Array<Record<string, unknown>>) || []).filter((x) => x.name !== server.name)
  list.push({ ...server, args: server.args || [], transport: server.transport || 'stdio' })
  writeSettings({ mcpServers: list })
  return true
})
ipcMain.handle('mcp:remove', (_e, name: string) => {
  const s = readSettings()
  const list = ((s.mcpServers as Array<Record<string, unknown>>) || []).filter((x) => x.name !== name)
  writeSettings({ mcpServers: list })
  stopMcpClient(name)
  return true
})

ipcMain.handle('mcp:test', async (_e, server: { name: string; command: string; args?: string[] }) => {
  try {
    const client = await startMcpClient(server.name, server.command, server.args || [])
    const tools = await client.listTools()
    return { ok: true, toolCount: tools.length, tools: tools.map((t) => t.name) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

// ---------- 搜索配置 ----------
ipcMain.handle('search:getConfig', () => {
  const s = readSettings()
  return (s.searchConfig as Record<string, unknown>) || { provider: 'auto', tavilyKey: '', serperKey: '', braveKey: '' }
})
ipcMain.handle('search:setConfig', (_e, config: Record<string, unknown>) => {
  writeSettings({ searchConfig: config })
  return true
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

ipcMain.handle('ai:register', async (_e, email: string, password: string) => {
  const { token, user } = await authRegister(email, password)
  applyUserState(token, user)
  return user
})

ipcMain.handle('ai:login', async (_e, email: string, password: string) => {
  const { token, user } = await authLogin(email, password)
  applyUserState(token, user)
  return user
})

ipcMain.handle('ai:logout', () => clearAiState())

ipcMain.handle('ai:setModel', (_e, modelId: string) => {
  const s = getAiState()
  s.modelId = modelId
  setAiState(s)
  return s
})

ipcMain.handle('ai:setByok', (_e, byok: { baseUrl: string; apiKey: string; model: string } | null) => {
  const s = getAiState()
  s.byok = byok
  setAiState(s)
  return s
})

// ---------- 多 BYOK profile ----------
ipcMain.handle('ai:byokProfiles', () => listByokProfiles())
ipcMain.handle('ai:byokSave', (_e, profile: ByokProfile) => saveByokProfile(profile))
ipcMain.handle('ai:byokDelete', (_e, id: string) => deleteByokProfile(id))
ipcMain.handle('ai:byokActivate', (_e, id: string | null) => setActiveByok(id))

// ---------- 硬件检测与本地大模型管理 ----------
ipcMain.handle('hardware:info', async () => {
  return getHardwareInfo()
})

ipcMain.handle('model:catalog', () => {
  return MODEL_CATALOG
})

ipcMain.handle('model:recommend', async () => {
  const hw = await getHardwareInfo()
  return recommendModels({
    totalRAMGB: hw.totalRAMGB,
    hasGPU: hw.capability.hasGPU,
    vramGB: hw.capability.vramGB,
  })
})

ipcMain.handle('model:ollamaStatus', async () => {
  const st = await getEngineStatus()
  return { installed: st.installed, running: st.running, version: st.version, engineDir: st.engineDir }
})

ipcMain.handle('model:ensureEngine', async (event) => {
  const sender = event.sender
  return ensureEngine((p) => {
    sender.send('model:pullProgress', { tag: '__engine__', ...p })
  })
})

ipcMain.handle('model:startOllama', () => {
  // 内置引擎无需"启动"——下载即用；此处仅触发一次引擎下载
  const cp = startOllama()
  return { started: !!cp }
})

ipcMain.handle('model:local', async () => {
  // 本地模型：直接扫描已安装 GGUF（无需 Ollama；llama-server 内置引擎同样识别）
  return listLocalModels()
})

// ---------- 教学知识库插件化更新 ----------
ipcMain.handle('kb:status', async () => {
  const { version, source } = getCurrentKbVersion()
  return { version, source, builtin: KB_BUILTIN_VERSION }
})
ipcMain.handle('kb:check', async () => checkKnowledgeUpdate())
ipcMain.handle('kb:update', async (event) => {
  const sender = event.sender
  return updateKnowledge((p) => {
    sender.send('kb:progress', p)
  })
})
ipcMain.handle('kb:reset', async () => resetKnowledge())

ipcMain.handle('model:pull', async (event, opts: { tag: string }) => {
  const sender = event.sender
  // 无需 Ollama：先确保内置引擎，再直接下载 GGUF
  const eng = await ensureEngine((p) => {
    sender.send('model:pullProgress', { tag: '__engine__', ...p })
  })
  if (!eng.success) return { success: false, error: eng.error || '引擎下载失败' }
  await pullModel(opts.tag, (progress) => {
    sender.send('model:pullProgress', { tag: opts.tag, ...progress })
  })
  return { success: true }
})

ipcMain.handle('model:delete', async (_e, tag: string) => {
  return deleteModel(tag)
})

ipcMain.handle('model:chat', async (event, opts: {
  model: string
  messages: Array<{ role: string; content: string }>
}) => {
  const sender = event.sender
  const fullText = await chatWithLocalModel(opts.model, opts.messages, (chunk) => {
    sender.send('model:chatChunk', { model: opts.model, chunk })
  })
  return { content: fullText }
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
  void agentRunner.run(opts).catch((e) => {
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

// 模拟烧录：内置演示固件清单（扫描 examples/sim-firmware* 目录）
ipcMain.handle('simBurn:demos', () => {
  const examplesDir = resolveExamplesDir()
  const out: Array<{ id: string; name: string; chip: string; baud: number; files: Array<{ label: string; path: string; addr: number }> }> = []
  if (!existsSync(examplesDir)) return out
  try {
    for (const sub of readdirSync(examplesDir)) {
      if (!sub.startsWith('sim-firmware')) continue
      const fwDir = join(examplesDir, sub)
      if (!statSync(fwDir).isDirectory()) continue
      const manifestPath = join(fwDir, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      out.push({
        id: sub,
        name: manifest.name ?? sub,
        chip: manifest.chip ?? 'esp32c3',
        baud: Number(manifest.baud) || 921600,
        files: (manifest.files ?? []).map((f: { label: string; path: string; addr: string }) => ({
          label: f.label,
          path: join(fwDir, f.path),
          addr: typeof f.addr === 'string' ? parseInt(f.addr, 16) : Number(f.addr),
        })),
      })
    }
  } catch {
    return out
  }
  return out
})

// 模拟烧录：收集当前编译产物（arduino-cli build_path → 4 个可烧录 bin）
ipcMain.handle('simBurn:collectBuild', async (_e, opts: { buildPath: string }) => {
  const dir = opts?.buildPath || ''
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, error: '编译产物目录不存在，请先在下方点「编译」生成固件' }
  }
  try {
    const files = readdirSync(dir)
    // 主固件：最大的非系统 .bin（排除 bootloader/partitions/boot_app0/merged）
    const mainBin = files
      .filter((f) => f.endsWith('.bin') && !/bootloader|partitions|boot_app0|merged/i.test(f))
      .map((f) => ({ name: f, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.size - a.size)[0]
    // arduino-cli 产物命名：<sketch>.ino.bootloader.bin / <sketch>.ino.partitions.bin
    const bootloader = files.find((f) => /bootloader\.bin$/i.test(f))
    const partitions = files.find((f) => /partitions\.bin$/i.test(f))
    // boot_app0.bin：优先产物目录，其次 Arduino15 esp32 工具包（按版本号取最高）
    let bootApp0 = files.find((f) => /boot_app0\.bin$/i.test(f)) || ''
    if (!bootApp0) {
      const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      const arduino15Esp32 = join(localAppData, 'Arduino15', 'packages', 'esp32', 'hardware', 'esp32')
      if (existsSync(arduino15Esp32)) {
        for (const v of readdirSync(arduino15Esp32).sort().reverse()) {
          const cand = join(arduino15Esp32, v, 'tools', 'partitions', 'boot_app0.bin')
          if (existsSync(cand)) { bootApp0 = cand; break }
        }
      }
    }
    const out: Array<{ label: string; path: string; addr: number }> = []
    if (bootloader) out.push({ label: bootloader, path: join(dir, bootloader), addr: 0x1000 })
    if (partitions) out.push({ label: partitions, path: join(dir, partitions), addr: 0x8000 })
    // boot_app0：可能命中产物目录文件名，也可能是 Arduino15 的绝对路径
    const bootApp0Path = bootApp0 && (bootApp0.includes('\\') || bootApp0.includes('/') || bootApp0.includes(':'))
      ? bootApp0
      : bootApp0 ? join(dir, bootApp0) : ''
    if (bootApp0Path) out.push({ label: 'boot_app0.bin', path: bootApp0Path, addr: 0xe000 })
    if (mainBin) out.push({ label: mainBin.name, path: join(dir, mainBin.name), addr: 0x10000 })
    if (out.length === 0) return { ok: false, error: `产物目录 ${dir} 中未找到可烧录 bin 文件` }
    return { ok: true, files: out }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
})

function applyUserState(token: string, user: UserInfo): void {
  const s = getAiState()
  s.token = token
  s.email = user.email
  s.planCredits = user.planCredits
  s.rechargeCredits = user.rechargeCredits
  s.totalCredits = user.totalCredits
  s.planMonth = user.planMonth
  setAiState(s)
  // 后台刷新一次最新积分
  void refreshMe(token)
    .then((u) => {
      const cur = getAiState()
      cur.planCredits = u.planCredits
      cur.rechargeCredits = u.rechargeCredits
      cur.totalCredits = u.totalCredits
      cur.planMonth = u.planMonth
      setAiState(cur)
    })
    .catch(() => {
      /* 静默 */
    })
}

app.whenReady().then(() => {
  initPlugins()
  createWindow()

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
  arduinoGrpc.stop()
  if (process.platform !== 'darwin') app.quit()
})

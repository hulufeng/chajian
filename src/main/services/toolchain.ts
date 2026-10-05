import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, createWriteStream, unlinkSync, copyFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { get } from 'node:https'
import type { ChildProcess } from 'node:child_process'
// 复用已加载的 serialport 原生模块（serialService 负责安全 require，避免重复加载原生模块）
import { serialportModule } from './serialService'

const WIN = process.platform === 'win32'
const EXE = WIN ? 'arduino-cli.exe' : 'arduino-cli'

/** 用户目录下的工具链安装路径（新用户一键安装到此） */
export function userToolDir(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'codelab-desktop', 'tools', 'arduino-cli')
}

export interface ToolchainStatus {
  available: boolean
  version: string
  path: string | null
}

function candidates(): string[] {
  const home = homedir()
  const list = [EXE] // 先走 PATH
  const extra: string[] = [
    join(userToolDir(), EXE), // 用户一键安装目录（优先级最高）
    join('C:', 'Program Files', 'Arduino CLI', EXE),
    join('C:', 'Program Files (x86)', 'Arduino', EXE),
    join('C:', 'Program Files', 'Arduino', EXE),
    join(process.env.LOCALAPPDATA || '', 'Arduino15', EXE),
    join(home, 'AppData', 'Local', 'Arduino15', EXE),
    join(home, '.arduino15', EXE),
    '/usr/local/bin/arduino-cli',
    '/usr/bin/arduino-cli',
    join(home, 'bin', 'arduino-cli'),
    join(home, '.local', 'bin', 'arduino-cli'),
  ]
  for (const p of extra) list.push(p)
  return list
}

export function findToolchain(): string | null {
  for (const cand of candidates()) {
    if (cand === EXE) {
      try {
        const r = spawnSync(EXE, ['version'], { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return EXE
      } catch {
        /* 继续下一个候选 */
      }
    } else if (existsSync(cand)) {
      try {
        const r = spawnSync(cand, ['version'], { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return cand
      } catch {
        /* 继续 */
      }
    }
  }
  return null
}

export async function detectToolchain(): Promise<ToolchainStatus> {
  const bin = findToolchain()
  if (!bin) return { available: false, version: '', path: null }
  try {
    const r = spawnSync(bin, ['version'], { encoding: 'utf-8', timeout: 5000 })
    const version = (r.stdout || r.stderr || '').toString().trim()
    return { available: true, version, path: bin }
  } catch {
    return { available: true, version: '', path: bin }
  }
}

export function runArduino(
  args: string[],
  opts: { bin: string; cwd?: string },
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  const cp = spawn(opts.bin, args, { cwd: opts.cwd })
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[工具链错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

export interface CompileOptions {
  sketch: string
  fqbn: string
  bin: string
  port?: string
  buildPath?: string
}

/**
 * arduino-cli 要求 sketch 目录名与主文件同名（sketch/xxx.ino）。
 * 扁平结构的 .ino（如内置示例 examples/01-blink.ino）直接编译会报 "main file missing"，
 * 复制到临时同名目录再编译（Arduino IDE 同款做法）。
 */
export function normalizeSketchPath(sketch: string): { path: string; cleanup?: () => void } {
  const dir = dirname(sketch)
  const base = basename(sketch)
  const name = base.replace(/\.ino$/i, '')
  if (basename(dir) === name) return { path: sketch }
  const tmp = join(tmpdir(), 'codelab-sketch', `${name}-${Date.now()}`)
  try {
    mkdirSync(tmp, { recursive: true })
    copyFileSync(sketch, join(tmp, base))
    return { path: join(tmp, base), cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ } } }
  } catch {
    return { path: sketch }
  }
}

export function compileSketch(o: CompileOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess {
  const args = ['compile', '--fqbn', o.fqbn, '--warnings', 'all']
  if (o.buildPath) args.push('--build-path', o.buildPath)
  const norm = normalizeSketchPath(o.sketch)
  args.push(norm.path)
  const proc = runArduino(args, { bin: o.bin }, onData, (code) => {
    if (norm.cleanup) norm.cleanup()
    onExit(code)
  })
  return proc
}

export function uploadSketch(o: CompileOptions & { port: string }, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess {
  const args = ['upload', '--fqbn', o.fqbn, '--port', o.port]
  const norm = normalizeSketchPath(o.sketch)
  args.push(norm.path)
  const proc = runArduino(args, { bin: o.bin }, onData, (code) => {
    if (norm.cleanup) norm.cleanup()
    onExit(code)
  })
  return proc
}

/** 通用 arduino-cli 流式命令执行器（lib install / core install / core uninstall 等） */
export function runArduinoCliCommand(
  args: string[],
  opts: { bin: string },
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  return runArduino(args, { bin: opts.bin }, onData, onExit)
}

export interface BoardInfo {
  fqbn: string
  name: string
  platform?: string
}

/** 列出所有已安装平台的开发板（arduino-cli board listall --format json） */
export function listBoards(bin?: string): BoardInfo[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    // maxBuffer 必须足够大：ESP32 全平台板卡列表 JSON 超过 1MB，默认 1MB 截断会导致解析失败返回空列表
    const r = spawnSync(toolBin, ['board', 'listall', '--format', 'json'], { encoding: 'utf-8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '[]')
    // arduino-cli 输出结构随版本变化：旧版顶层数组，新版 { boards: [...] }，两种都兼容
    const boards = Array.isArray(data) ? data : (data && Array.isArray(data.boards) ? data.boards : [])
    if (boards.length === 0) return []
    return boards.map((b: { id?: string; name?: string; fqbn?: string; platform?: { id?: string; name?: string } }) => ({
      fqbn: b.fqbn || b.id || '',
      name: b.name || b.id || '',
      platform: b.platform?.name || b.platform?.id
    })).filter((b: BoardInfo) => b.fqbn)
  } catch {
    return []
  }
}

/** 搜索开发板（board search），支持关键词过滤 */
export function searchBoards(keyword: string, bin?: string): BoardInfo[] {
  const boards = listBoards(bin)
  if (!keyword) return boards
  const kw = keyword.toLowerCase()
  return boards.filter(
    (b) => b.name.toLowerCase().includes(kw) || b.fqbn.toLowerCase().includes(kw) || (b.platform || '').toLowerCase().includes(kw)
  )
}

export interface ConnectedBoard {
  fqbn: string
  name: string
  port: string
}

/** 列出当前连接的开发板（arduino-cli board list --format json） */
export function listConnectedBoards(bin?: string): ConnectedBoard[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    const r = spawnSync(toolBin, ['board', 'list', '--format', 'json'], { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '[]')
    if (Array.isArray(data)) {
      return data.map((b: {
        fqbn?: string
        name?: string
        port?: { address?: string; label?: string }
      }) => ({
        fqbn: b.fqbn || '',
        name: b.name || '',
        port: b.port?.address || b.port?.label || ''
      })).filter((b: ConnectedBoard) => b.port)
    }
    return []
  } catch {
    return []
  }
}

/**
 * Espressif 原生 USB（VID 303A）常见 PID → 启发式 FQBN 映射。
 * 实测缺口：arduino-cli `board list` 在 Windows 上枚举不到 ESP32-S3 原生 USB
 *（303A:1001 / COM27），但 serialport 能识别。这里用 VID:PID 兜底推导 FQBN，
 *使 board_detect / compile / upload 在自动识别失败时仍能拿到正确目标。
 */
const ESP32_USB_HEURISTIC: Record<string, { fqbn: string; name: string }> = {
  '303a:1001': { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32-S3 (native USB CDC/JTAG)' },
  '303a:0002': { fqbn: 'esp32:esp32', name: 'ESP32 (native USB)' }
}

function esp32Heuristic(vendorId?: string, productId?: string): { fqbn: string; name: string } | null {
  if (!vendorId) return null
  const vid = vendorId.toLowerCase().replace(/^0x/, '')
  if (vid !== '303a') return null
  const pid = (productId || '').toLowerCase().replace(/^0x/, '')
  // 已知 PID 精确匹配
  const exact = ESP32_USB_HEURISTIC[`${vid}:${pid}`]
  if (exact) return exact
  // 其他 303A:* 一律视为 Espressif 原生 USB 设备，默认按最常见的 ESP32-S3 启发式推导
  return { fqbn: 'esp32:esp32:esp32s3', name: 'Espressif 设备 (USB 303A，启发式 esp32s3)' }
}

/**
 * 增强版「已连接板卡」枚举：先走 arduino-cli `board list`，再用 serialport 兜底。
 * 仅补充 arduino-cli 漏掉的端口（如 Windows 上 ESP32-S3 原生 USB），不覆盖其已识别结果。
 * 返回 Promise，调用方需 await（Agent 工具侧 handler 均为 async）。
 */
export async function listConnectedBoardsWithSerial(bin?: string): Promise<ConnectedBoard[]> {
  const cli = listConnectedBoards(bin)
  const seen = new Set(cli.map((b) => b.port.toLowerCase()))
  const result: ConnectedBoard[] = [...cli]
  try {
    if (serialportModule) {
      const ports = await serialportModule.SerialPort.list()
      for (const p of ports) {
        const addr = (p.path || '').toLowerCase()
        if (!addr || seen.has(addr)) continue
        const h = esp32Heuristic((p as { vendorId?: string }).vendorId, (p as { productId?: string }).productId)
        if (h) {
          result.push({
            fqbn: h.fqbn,
            name: h.name + (p.manufacturer ? ` [${p.manufacturer}]` : ''),
            port: p.path
          })
          seen.add(addr)
        }
      }
    }
  } catch {
    /* serialport 兜底失败则保留 arduino-cli 结果 */
  }
  return result
}

export interface LibraryInfo {
  name: string
  version: string
  author?: string
  sentence?: string
}

/** 搜索库（arduino-cli lib search --format json），支持关键词 */
export function searchLibraries(keyword: string, bin?: string): LibraryInfo[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    const args = ['lib', 'search', '--format', 'json']
    if (keyword) args.push(keyword)
    const r = spawnSync(toolBin, args, { encoding: 'utf-8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '{}')
    // arduino-cli 返回 { libraries: [...] }
    const libs = Array.isArray(data) ? data : data.libraries
    if (Array.isArray(libs)) {
      return libs.map((l: { name?: string; version?: string; author?: string; sentence?: string }) => ({
        name: l.name || '',
        version: l.version || '',
        author: l.author || '',
        sentence: l.sentence || ''
      })).filter((l: LibraryInfo) => l.name)
    }
    return []
  } catch {
    return []
  }
}

/** 列出已安装的库（arduino-cli lib list --format json） */
export function listInstalledLibraries(bin?: string): LibraryInfo[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    const r = spawnSync(toolBin, ['lib', 'list', '--format', 'json'], { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '[]')
    if (Array.isArray(data)) {
      return data.map((l: { library?: { name?: string; version?: string; author?: string; sentence?: string } }) => ({
        name: l.library?.name || '',
        version: l.library?.version || '',
        author: l.library?.author || '',
        sentence: l.library?.sentence || ''
      })).filter((l: LibraryInfo) => l.name)
    }
    return []
  } catch {
    return []
  }
}

export interface InstalledPlatform {
  id: string
  version: string
  name?: string
  architecture?: string
}

/** 列出已安装的平台（arduino-cli core list --format json） */
export function listPlatforms(bin?: string): InstalledPlatform[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    const r = spawnSync(toolBin, ['core', 'list', '--format', 'json'], { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '[]')
    if (Array.isArray(data)) {
      return data.map((p: { id?: string; version?: string; name?: string; architecture?: string }) => ({
        id: p.id || '',
        version: p.version || '',
        name: p.name || '',
        architecture: p.architecture || ''
      })).filter((p: InstalledPlatform) => p.id)
    }
    return []
  } catch {
    return []
  }
}

export interface SearchablePlatform {
  id: string
  name: string
  latestVersion?: string
}

/** 搜索可安装的平台（arduino-cli core search --format json） */
export function searchPlatforms(keyword: string, bin?: string): SearchablePlatform[] {
  const toolBin = bin || findToolchain() || EXE
  try {
    const args = ['core', 'search', '--format', 'json']
    if (keyword) args.push(keyword)
    const r = spawnSync(toolBin, args, { encoding: 'utf-8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return []
    const data = JSON.parse(r.stdout || '[]')
    if (Array.isArray(data)) {
      return data.map((p: { id?: string; name?: string; latest_version?: string; latestVersion?: string }) => ({
        id: p.id || '',
        name: p.name || p.id || '',
        latestVersion: p.latest_version || p.latestVersion || ''
      })).filter((p: SearchablePlatform) => p.id)
    }
    return []
  } catch {
    return []
  }
}

/** 安装平台（arduino-cli core install <platform>），流式输出 */
export function installPlatform(
  platform: string,
  bin: string,
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  return runArduino(['core', 'install', platform], { bin }, onData, onExit)
}

/** 卸载平台（arduino-cli core uninstall <platform>），流式输出 */
export function uninstallPlatform(
  platform: string,
  bin: string,
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  return runArduino(['core', 'uninstall', platform], { bin }, onData, onExit)
}

/** 安装库（arduino-cli lib install <name>），流式输出 */
export function installLibrary(
  name: string,
  bin: string,
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  return runArduino(['lib', 'install', name], { bin }, onData, onExit)
}

/** 卸载库（arduino-cli lib uninstall <name>），流式输出 */
export function uninstallLibrary(
  name: string,
  bin: string,
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ChildProcess {
  return runArduino(['lib', 'uninstall', name], { bin }, onData, onExit)
}

export interface BoardOptionValue {
  value: string
  label: string
}

export interface BoardOption {
  option: string
  label: string
  values: BoardOptionValue[]
}

export interface BoardDetails {
  fqbn: string
  name: string
  options: BoardOption[]
}

/** 查询开发板配置选项（arduino-cli board details -b <fqbn> --format json） */
export function boardDetails(fqbn: string, bin?: string): BoardDetails {
  const toolBin = bin || findToolchain() || EXE
  try {
    const r = spawnSync(toolBin, ['board', 'details', '-b', fqbn, '--format', 'json'], { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) return { fqbn, name: fqbn, options: [] }
    const data = JSON.parse(r.stdout || '{}')
    const opts: BoardOption[] = Array.isArray(data.config_options)
      ? data.config_options.map((o: { option?: string; option_label?: string; values?: Array<{ value?: string; value_label?: string }> }) => ({
          option: o.option || '',
          label: o.option_label || o.option || '',
          values: Array.isArray(o.values)
            ? o.values.map((v) => ({ value: v.value || '', label: v.value_label || v.value || '' }))
            : []
        }))
      : []
    return { fqbn: data.fqbn || fqbn, name: data.name || fqbn, options: opts }
  } catch {
    return { fqbn, name: fqbn, options: [] }
  }
}

// ============================================================
// 一键自动安装 arduino-cli（新用户无需手动下载）
// ============================================================

const ARDUINO_CLI_DOWNLOAD_URL =
  'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip'

export interface InstallProgress {
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  percent: number // 0-100
  message: string
}

/** 下载文件（支持进度回调） */
function downloadFile(url: string, dest: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (total > 0) onProgress(Math.round((downloaded / total) * 100))
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    }).on('error', reject)
  })
}

/** 用 PowerShell 解压 zip（Windows 原生，无需额外依赖） */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ])
    ps.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败，退出码 ${code}`))
    })
    ps.on('error', reject)
  })
}

/**
 * 一键安装 arduino-cli 到用户目录
 * 下载 → 解压 → 验证 → 返回安装路径
 */
export async function installArduinoCli(
  onProgress?: (p: InstallProgress) => void
): Promise<{ success: boolean; path: string | null; error?: string }> {
  const dir = userToolDir()
  const exePath = join(dir, EXE)
  const zipPath = join(dir, 'arduino-cli.zip')

  try {
    // 已安装则直接返回
    if (existsSync(exePath)) {
      onProgress?.({ phase: 'done', percent: 100, message: '已安装' })
      return { success: true, path: exePath }
    }

    // 创建目录
    mkdirSync(dir, { recursive: true })

    // 1. 下载
    onProgress?.({ phase: 'downloading', percent: 0, message: '正在下载 Arduino CLI…' })
    await downloadFile(ARDUINO_CLI_DOWNLOAD_URL, zipPath, (percent) => {
      onProgress?.({ phase: 'downloading', percent, message: `正在下载 Arduino CLI… ${percent}%` })
    })

    // 2. 解压
    onProgress?.({ phase: 'extracting', percent: 95, message: '正在解压…' })
    await extractZip(zipPath, dir)

    // 3. 清理 zip
    try { unlinkSync(zipPath) } catch { /* 忽略 */ }

    // 4. 验证
    onProgress?.({ phase: 'verifying', percent: 98, message: '正在验证安装…' })
    if (!existsSync(exePath)) {
      return { success: false, path: null, error: '解压后未找到 arduino-cli.exe' }
    }
    const verify = spawnSync(exePath, ['version'], { encoding: 'utf-8', timeout: 8000 })
    if (verify.status !== 0) {
      return { success: false, path: null, error: `验证失败: ${verify.stderr || verify.stdout}` }
    }

    onProgress?.({ phase: 'done', percent: 100, message: `安装成功: ${verify.stdout.trim()}` })
    return { success: true, path: exePath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ phase: 'error', percent: 0, message: `安装失败: ${msg}` })
    return { success: false, path: null, error: msg }
  }
}

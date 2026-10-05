import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, unlinkSync, cpSync } from 'node:fs'
import { get } from 'node:https'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import net, { type Socket } from 'node:net'

// ============================================================
// 片上调试（DAP/JTAG）：openocd-esp32 + telnet(4444)
// ============================================================
// 走 openocd 的 telnet 而不是 gdb：寄存器 / 内存 / 断点 / 单步 / 线程
// 全部由 openocd 自己实现，省掉 riscv-gdb 那 ~40MB 依赖。
//
// 硬件链路：ESP32 原生 USB 口 → USB JTAG/serial debug unit 接口(MI_02)
//   → 绑 WinUSB → libusb（openocd 静态链接）→ openocd → telnet:4444
//
// 注意：ESP32 的串口(JTAG 与 CDC 共用同一个 USB 设备)与调试可以同时存在，
// 但烧录(esptool)与调试不能同时进行 —— 烧录前必须先释放调试会话。

const OPENOCD_DOWNLOAD_URL =
  'https://github.com/espressif/openocd-esp32/releases/download/v0.12.0-esp32-20260831/openocd-esp32-win64-0.12.0-esp32-20260831.zip'

/** 支持的芯片 → openocd board cfg（ESP32 全系内置 USB-JTAG 都有对应配置） */
const CHIP_CFGS: Record<string, string> = {
  esp32s3: 'board/esp32s3-builtin.cfg',
  esp32s31: 'board/esp32s31-builtin.cfg',
  esp32c3: 'board/esp32c3-builtin.cfg',
  esp32c5: 'board/esp32c5-builtin.cfg',
  esp32c6: 'board/esp32c6-builtin.cfg',
  esp32c61: 'board/esp32c61-builtin.cfg',
  esp32h2: 'board/esp32h2-builtin.cfg',
  esp32h21: 'board/esp32h21-builtin.cfg',
  esp32h4: 'board/esp32h4-builtin.cfg',
  esp32p4: 'board/esp32p4-builtin.cfg'
}

/** 从 FQBN（esp32:esp32:esp32s3）或芯片名里摘出芯片标识 */
export function chipOf(fqbnOrChip?: string): string {
  const s = String(fqbnOrChip || '').trim().toLowerCase()
  if (!s) return ''
  const seg = s.split(':').pop() || s
  // esp32s3 / esp32-s3 / esp32s3-usb 之类都归一
  const norm = seg.replace(/[^a-z0-9]/g, '')
  for (const key of Object.keys(CHIP_CFGS)) {
    if (norm === key.replace(/-/g, '') || norm.startsWith(key.replace(/-/g, ''))) return key
  }
  return ''
}

export function listSupportedChips(): Array<{ chip: string; cfg: string }> {
  return Object.entries(CHIP_CFGS).map(([chip, cfg]) => ({ chip, cfg }))
}

function userToolDir(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'codelab-desktop', 'tools', 'openocd-esp32')
}

export interface OpenocdInfo {
  installed: boolean
  path: string
  scripts: string
}

function winExe(rel: string): string {
  return process.platform === 'win32' ? `${rel}.exe` : rel
}

/** 定位 openocd：环境变量 → 用户目录 → PATH */
export function getOpenocdInfo(): OpenocdInfo {
  const dir = userToolDir()
  const exe = join(dir, 'bin', winExe('openocd'))
  const scripts = join(dir, 'share', 'openocd', 'scripts')
  if (existsSync(exe)) return { installed: true, path: exe, scripts }

  const envPath = process.env.OPENOCD_PATH
  if (envPath && existsSync(envPath)) {
    const sd = join(dirname(envPath), '..', 'share', 'openocd', 'scripts')
    return { installed: true, path: envPath, scripts: existsSync(sd) ? sd : join(dirname(envPath), 'scripts') }
  }

  const onPath = spawnSync('openocd', ['--version'], { encoding: 'utf-8', timeout: 5000 })
  if (onPath.status === 0 && onPath.stdout) {
    // PATH 上的 openocd 通常不带完整 script 目录，退回 arduino-cli 同级的官方脚本
    return { installed: true, path: 'openocd', scripts: join(dir, 'share', 'openocd', 'scripts') }
  }
  return { installed: false, path: exe, scripts }
}

export interface InstallProgress {
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  percent: number
  message: string
}

function downloadFile(url: string, dest: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'user-agent': 'codelab-desktop' } }, (res) => {
      const code = res.statusCode ?? 0
      const loc = res.headers.location
      if (code >= 300 && code < 400 && loc) {
        res.resume()
        downloadFile(loc, dest, onProgress).then(resolve, reject)
        return
      }
      if (code !== 200) {
        res.resume()
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      const file = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (total > 0) onProgress(Math.min(99, Math.round((downloaded / total) * 100)))
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    }).on('error', reject)
  })
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ])
    let err = ''
    ps.stderr.on('data', (d) => { err += d })
    ps.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败（退出码 ${code}）${err}`))
    })
    ps.on('error', reject)
  })
}

/** 一键安装 openocd-esp32（约 3MB，解压后 ~20MB）
 *  兼容两种调用：installOpenocd(cb) / installOpenocd({ force: true }, cb)
 */
export async function installOpenocd(
  onProgressOrOpts?: ((p: InstallProgress) => void) | { force?: boolean },
  maybeOnProgress?: (p: InstallProgress) => void
): Promise<{ success: boolean; path?: string; error?: string }> {
  const force = typeof onProgressOrOpts === 'object' && !!onProgressOrOpts.force
  const onProgress = typeof onProgressOrOpts === 'function'
    ? onProgressOrOpts
    : (maybeOnProgress || undefined)

  const info = getOpenocdInfo()
  if (!force && info.installed && existsSync(info.scripts)) {
    onProgress?.({ phase: 'done', percent: 100, message: '已安装' })
    return { success: true, path: info.path }
  }
  const dir = userToolDir()
  const exePath = join(dir, 'bin', winExe('openocd'))
  const zipPath = join(dir, 'openocd-esp32.zip')
  try {
    mkdirSync(dir, { recursive: true })
    onProgress?.({ phase: 'downloading', percent: 0, message: '正在下载 openocd-esp32…' })
    await downloadFile(OPENOCD_DOWNLOAD_URL, zipPath, (p) => {
      onProgress?.({ phase: 'downloading', percent: p, message: `正在下载 openocd-esp32… ${p}%` })
    })
    onProgress?.({ phase: 'extracting', percent: 95, message: '正在解压…' })
    await extractZip(zipPath, dir)
    try { unlinkSync(zipPath) } catch { /* 忽略 */ }
    if (!existsSync(exePath)) return { success: false, error: '解压后未找到 openocd.exe' }
    onProgress?.({ phase: 'verifying', percent: 98, message: '正在验证…' })
    const v = spawnSync(exePath, ['--version'], { encoding: 'utf-8', timeout: 8000 })
    if (v.status !== 0) return { success: false, error: `验证失败: ${(v.stderr || v.stdout || '').trim()}` }
    onProgress?.({ phase: 'done', percent: 100, message: (v.stdout || '').trim() })
    return { success: true, path: exePath }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ---------------- telnet 客户端 ----------------

/** openocd telnet 的最小实现：发一行命令，等回显结束（行末是 "> " 提示符） */
class OpenOcdTelnet {
  private sock: Socket | null = null
  private buf = ''
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null

  connect(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port })
      this.sock = sock
      sock.setEncoding('utf8')
      sock.setTimeout(15000, () => this.fail(new Error('telnet 连接超时')))
      sock.on('connect', () => resolve())
      sock.on('error', (e) => {
        this.sock = null
        reject(new Error(`无法连接 openocd telnet:${port} —— ${e.message}`))
      })
      sock.on('data', (chunk: string) => this.onData(chunk))
      sock.on('close', () => this.fail(new Error('openocd telnet 连接已断开')))
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    if (!this.pending) return
    const lines = this.buf.split('\n')
    // 提示符出现在行首或行尾，形如 ">" / "> "
    const done = lines.some((l) => /^\s*>\s*$/.test(l.replace(/\r/, '')))
    if (done) this.settle('prompt')
  }

  private fail(e: Error): void {
    if (this.pending) {
      const p = this.pending
      this.pending = null
      clearTimeout(p.timer)
      p.reject(e)
    }
  }

  private settle(kind: 'prompt' | 'timeout'): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    clearTimeout(p.timer)
    const raw = this.buf
    this.buf = ''
    if (kind === 'timeout') p.reject(new Error(`命令无响应（超时）\n${raw.slice(-400)}`))
    else p.resolve(raw)
  }

  send(cmd: string, timeoutMs = 10000): Promise<string> {
    if (!this.sock) return Promise.reject(new Error('telnet 未连接'))
    this.buf = ''
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle('timeout'), timeoutMs)
      this.pending = { resolve, reject, timer }
      this.sock?.write(`${cmd}\n`)
    })
  }

  close(): void {
    try { this.sock?.destroy() } catch { /* 忽略 */ }
    this.sock = null
    this.fail(new Error('调试会话已关闭'))
  }
}

// ---------------- 会话状态 ----------------

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
  /** openocd 启动与 init 期间的关键输出（用于排障） */
  adapterLog: string
  /** 目标当前状态：running / halted / unknown */
  target: 'running' | 'halted' | 'unknown'
}

const DEFAULT_PORT = 4444

let state: DebugState = {
  status: 'idle',
  chip: '',
  boardCfg: '',
  telnetPort: DEFAULT_PORT,
  openocdPath: '',
  scriptsDir: '',
  target: 'unknown',
  adapterLog: ''
}

let proc: ChildProcess | null = null
let telnet: OpenOcdTelnet | null = null

export function getDebugState(): DebugState {
  return { ...state }
}

function setStatus(patch: Partial<DebugState>): DebugState {
  state = { ...state, ...patch }
  return { ...state }
}

function resetErrorLog(): void {
  state = { ...state, adapterLog: '' }
}

/** 无板 / 驱动不对时的中文可操作指引（实测 openocd 那句 could not find or open device 的对应场景） */
const USB_JTAG_HINT = [
  '未检测到板的 USB-JTAG：',
  '① 板子要插「原生 USB 口」（ESP32-S3/C3 的 USB 口），不是 USB-UART 转接线；',
  '② 该 USB 设备里的「USB JTAG/serial debug unit」接口要绑 WinUSB 驱动（用 Zadig 选中该接口绑 WinUSB，别用 USB Serial 驱动）；',
  '③ 确认板子已上电、USB 直连电脑，且没有别的程序（串口监视器/另一个 openocd）占用同一个 USB 设备。'
].join('\n')

/** 把 openocd 的英文报错翻成能直接照着做的中文 */
function humanizeOpenocdError(text: string): string {
  if (/could not find or open device/i.test(text)) return USB_JTAG_HINT
  if (/no device matches the serial/i.test(text)) {
    return '设备存在但序列号不匹配：核对板子 USB 序列号，或用 `adapter serial <id>` 指定。'
  }
  if (/scan[- ]?chain interrogation failed|all ones/i.test(text)) {
    return 'JTAG 扫描链读不到 IDCODE（全 1）：检查 USB-JTAG 是否已上电、JTAG 引脚没有被自己代码占用（GPIO 0/3/45/46 之类）、必要时先按 EN/BOOT 复位再试。'
  }
  // 没有精确匹配时：优先挑出真正的 Error 行，别拿 banner 糊弄用户
  const errLines = text
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trim())
    .filter((l) => l && /error|cannot|failed|could not|unexpected/i.test(l))
    .slice(0, 4)
  if (errLines.length) {
    const tail = errLines.join('\n')
    const hwish = /usb|jtag|dap|adapter|device|scan/i.test(tail)
    return hwish ? `${USB_JTAG_HINT}\n\n${tail}` : tail
  }
  return text.split('\n').slice(0, 4).join('\n').trim() || text
}

function resolveBoardCfg(chip: string, scriptsDir: string, explicit?: string): string {
  if (explicit) {
    // 相对路径（board/esp32s3-builtin.cfg 或 esp32s3-builtin.cfg）都按脚本目录解析，
    // 绝对路径直接用
    const isAbs = explicit.includes('/') || explicit.includes('\\')
    const p = isAbs && !existsSync(explicit) ? join(scriptsDir, explicit) : explicit
    if (existsSync(p)) return p
    throw new Error(`指定的调试配置不存在：${explicit}`)
  }
  const cfg = CHIP_CFGS[chip]
  if (!cfg) throw new Error(`暂不支持的芯片：${chip}（支持：${Object.keys(CHIP_CFGS).join(', ')}）`)
  const full = join(scriptsDir, cfg)
  if (!existsSync(full)) {
    throw new Error(`缺少调试脚本 ${cfg}，请 reinstall openocd-esp32（脚本目录：${scriptsDir}）`)
  }
  return full
}

function nextFreePort(from = DEFAULT_PORT): number {
  for (let p = from; p < from + 20; p++) {
    const tester = net.createServer()
    let ok = false
    try {
      tester.listen({ host: '127.0.0.1', port: p })
      ok = true
    } catch {
      ok = false
    } finally {
      tester.close()
    }
    if (ok) return p
  }
  return from
}

export interface StartDebugOptions {
  /** 芯片（esp32s3 等）或从 FQBN 推断；留空则用当前板 */
  chip?: string
  /** 显式指定 openocd 配置（相对 board/ 或绝对路径） */
  boardCfg?: string
  /** 指定 telnet 端口，默认找一个 4444 起的空闲口 */
  telnetPort?: number
  /** 自定义 openocd 可执行文件（高级用户 / 自编译版本） */
  openocdPath?: string
  /** 自定义启动参数（覆盖默认的 -s / -f / -c telnet_port / -c tcl_port / -d） */
  openocdArgs?: string[]
}

/** 启动 openocd 并建立 telnet 会话；完成后目标已停在 halted */
export async function startDebug(opts: StartDebugOptions = {}): Promise<DebugState> {
  stopDebug()
  resetErrorLog()

  const info = getOpenocdInfo()
  if (!info.installed || !existsSync(info.scripts)) {
    throw new Error('openocd-esp32 未安装，请先在设置里安装（或设置 OPENOCD_PATH 环境变量）')
  }

  const chip = chipOf(opts.chip) || 'esp32s3'
  let cfgPath: string
  try {
    cfgPath = resolveBoardCfg(chip, info.scripts, opts.boardCfg)
  } catch (e) {
    throw e
  }
  const ocdBin = opts.openocdPath || info.path
  const port = opts.telnetPort || nextFreePort()

  setStatus({
    status: 'starting',
    chip,
    boardCfg: cfgPath,
    telnetPort: port,
    openocdPath: ocdBin,
    scriptsDir: info.scripts,
    error: undefined
  })

  const logs: string[] = []
  const push = (s: string): void => {
    if (s) logs.push(s.trim())
    if (logs.length > 60) logs.shift()
  }
  // openocd 的输出是按块到达的：必须按 \n 切行再入库，
  // 否则一行会被撕成两半（"…: cou" + "ld not find or open device!"），
  // humanizeOpenocdError 的精确匹配就永远命不中。
  const lineBuf = { out: '', err: '' }
  const feed = (which: 'out' | 'err', chunk: string): void => {
    lineBuf[which] += chunk
    let nl = lineBuf[which].indexOf('\n')
    while (nl >= 0) {
      push(lineBuf[which].slice(0, nl))
      lineBuf[which] = lineBuf[which].slice(nl + 1)
      nl = lineBuf[which].indexOf('\n')
    }
    // 末尾残留（不完整的行）留在缓冲区，等下一个 chunk 拼完整
  }

  // 注意：openocd-esp32 0.12 不接受 `-d 0`（会被当成多余的位置参数直接退出），
  // 必须写成 `-d1` / `-d0`；`telnet_port` / `tcl_port` 也已废弃，改用 `telnet port` / `tcl port`。
  const args = opts.openocdArgs && opts.openocdArgs.length
    ? opts.openocdArgs
    : ['-s', info.scripts, '-f', cfgPath, '-c', `telnet port ${port}`, '-c', 'tcl port 0', '-d1']

  return new Promise<DebugState>((resolve, reject) => {
    const cp = spawn(ocdBin, args)
    proc = cp

    // openocd 启动时会自己跑一次 init（startup.tcl），我们连上 telnet 时目标已初始化完毕，
    // 因此这里只发 halt/poll，绝不能再发一遍 init。
    let ready = false
    let exited = false

    cp.stdout?.on('data', (d: Buffer) => feed('out', d.toString('utf8')))
    cp.stderr?.on('data', (d: Buffer) => feed('err', d.toString('utf8')))
    cp.on('exit', (code) => {
      exited = true
      if (ready) return
      stopDebug()
      const text = logs.join('\n') || `openocd 退出码 ${String(code)}`
      setStatus({ status: 'error', adapterLog: text, error: humanizeOpenocdError(text) })
      reject(new Error(humanizeOpenocdError(text)))
    })
    cp.on('error', (e) => {
      exited = true
      if (ready) return
      stopDebug()
      reject(new Error(`无法启动 openocd：${e.message}`))
    })

    void (async () => {
      try {
        await waitForTelnet(port, 20000)
        if (exited) return
        ready = true

        const tn = new OpenOcdTelnet()
        telnet = tn
        await tn.connect(port)

        const haltOut = await tn.send('halt')
        if (/Error:/.test(haltOut)) throw new Error(openocdRaw(haltOut))
        const pollOut = await tn.send('poll')
        setStatus({
          status: 'running',
          startedAt: Date.now(),
          target: /running/i.test(pollOut) ? 'running' : /halted/i.test(pollOut) ? 'halted' : 'unknown',
          adapterLog: logs.join('\n')
        })
        resolve(getDebugState())
      } catch (err) {
        const msg = (err as Error).message
        const text = logs.join('\n')
        // 先收进程再记 error：stopDebug() 会把状态重置为 idle，顺序反了 error 会被冲掉
        stopDebug()
        const hint = humanizeOpenocdError(exited && text ? text : msg)
        setStatus({ status: 'error', adapterLog: text, error: hint })
        reject(new Error(hint))
      }
    })()
  })
}

/** 轮询 telnet 端口，直到能连上（openocd 完成 init 后才会 listen） */
function waitForTelnet(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const sock = net.connect({ host: '127.0.0.1', port })
      sock.setTimeout(1000)
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`等待 openocd 监听 ${port} 超时`))
          return
        }
        setTimeout(tick, 200)
      })
    }
    tick()
  })
}

function openocdRaw(text: string): string {
  const lines = text.split('\n').filter((l) => /Error|error/i.test(l))
  return lines.slice(0, 3).join('\n') || text.slice(0, 300)
}

/** 结束调试会话（烧录前必须先调用） */
export function stopDebug(): DebugState {
  if (telnet) {
    try { void telnet.send('shutdown', 3000) } catch { /* 忽略 */ }
    telnet.close()
    telnet = null
  }
  if (proc) {
    try { proc.kill() } catch { /* 忽略 */ }
    try { proc.kill('SIGKILL') } catch { /* 忽略 */ }
    proc = null
  }
  return setStatus({ status: 'idle', target: 'unknown', error: undefined })
}

/** 当前是否有活跃会话 */
export function isDebugActive(): boolean {
  return state.status === 'running' && !!proc
}

function requireSession(): OpenOcdTelnet {
  if (!telnet || state.status !== 'running') {
    throw new Error('调试会话未启动，请先点击「连接调试器」')
  }
  return telnet
}

/** 直接发送一条 openocd 命令（把 telnet 输出原样返回） */
export async function debugExec(cmd: string): Promise<string> {
  const out = await requireSession().send(String(cmd || '').trim())
  return stripPrompt(out)
}

function stripPrompt(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*>\s*$/.test(l.replace(/\r/, '')))
    .join('\n')
    .trim()
}

export interface RegisterValue {
  name: string
  value: string
  num?: number
}

/** 把 openocd `reg` 的输出解析成寄存器表（riscv: pc / mepc / x1…；xtensa: pc / a0…） */
export function parseRegisters(text: string): RegisterValue[] {
  const rows: RegisterValue[] = []
  for (const raw of stripPrompt(text).split('\n')) {
    const line = raw.replace(/\r/, '').trim()
    if (!line) continue
    const m = line.match(/^(\S+)\s+\/?\d*\s*(0x[0-9a-fA-F]+|\d+)\s*$/) ||
      line.match(/^(\S+)\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*$/)
    if (!m) continue
    const v = m[2]
    rows.push({ name: m[1], value: v, num: v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10) })
  }
  return rows
}

/** 读全部寄存器 */
export async function readRegisters(): Promise<RegisterValue[]> {
  const out = await requireSession().send('reg')
  return parseRegisters(out)
}

export interface MemoryRead {
  addr: number
  bytes: number[]
}

/** 解析 openocd `mdb <addr> <count>` 的输出 */
export function parseMemory(text: string): MemoryRead {
  const bytes: number[] = []
  let base = 0
  let baseSet = false
  for (const raw of stripPrompt(text).split('\n')) {
    const line = raw.replace(/\r/, '').trim()
    // 行内 1~8 位十六进制字节，允许最后一个字节后面没有空格
    const m = line.match(/^(0x[0-9a-fA-F]+):\s*((?:[0-9a-fA-F]{2,8}\s+)*[0-9a-fA-F]{2,8})\s*$/i)
    if (!m) continue
    // 基址取第一行（多行走 MDB 时后续行是递增地址，不能覆盖成最后一行）
    if (!baseSet) {
      base = parseInt(m[1], 16)
      baseSet = true
    }
    for (const h of m[2].trim().split(/\s+/)) {
      const v = parseInt(h, 16)
      if (!Number.isNaN(v)) bytes.push(v & 0xff)
    }
  }
  return { addr: base, bytes }
}

/** 读内存：mdb <addr> <count> */
export async function readMemory(addr: string | number, count = 64): Promise<MemoryRead> {
  const a = typeof addr === 'number' ? `0x${addr.toString(16)}` : addr
  const out = await requireSession().send(`mdb ${a} ${count}`)
  return parseMemory(out)
}

/** 读原始字节的统一入口（分区表 / NVS 等解析器都注入这个函数，不直接依赖 openocd） */
export type RawReader = (addr: number, count: number) => Promise<Buffer>

/** 读指定地址的原始字节（走 mdb，解析成 Buffer） */
export async function readRawBytes(addr: number, count: number): Promise<Buffer> {
  const mem = await readMemory(addr, count)
  if (!mem.bytes.length) throw new Error(`读 0x${addr.toString(16)} 未返回字节（openocd 是否有输出？）`)
  return Buffer.from(mem.bytes)
}

export interface ThreadInfo {
  id: string
  name: string
  pc?: number
  state?: string
}

/** 线程/调用栈：openocd rtos(esp) 的 threads 输出 */
export async function listThreads(): Promise<{ raw: string; threads: ThreadInfo[] }> {
  const out = await requireSession().send('threads')
  const text = stripPrompt(out)
  const threads: ThreadInfo[] = []
  for (const line of text.split('\n')) {
    const s = line.replace(/\r/, '').trim()
    if (!s) continue
    const pcM = s.match(/(?:pc|PC|lookups?)[\s=:]+(0x[0-9a-fA-F]+)/)
    const idM = s.match(/thread[:\s#]+(\S+)/i)
    const stateM = s.match(/\b(Running|Running|Blocked|Suspended|Ready)\b/)
    threads.push({
      id: idM ? idM[1] : s.slice(0, 24),
      name: s,
      pc: pcM ? parseInt(pcM[1], 16) : undefined,
      state: stateM ? stateM[1] : undefined
    })
  }
  return { raw: text, threads }
}

export async function haltDebug(): Promise<string> {
  const out = await requireSession().send('halt')
  setStatus({ target: 'halted' })
  return stripPrompt(out)
}

export async function resumeDebug(): Promise<string> {
  const out = await requireSession().send('resume')
  setStatus({ target: 'running' })
  return stripPrompt(out)
}

export async function stepDebug(): Promise<string> {
  const out = await requireSession().send('step')
  setStatus({ target: 'halted' })
  return stripPrompt(out)
}

/** 复位目标（保持在 halted） */
export async function resetTarget(): Promise<string> {
  const out = await requireSession().send('reset halt')
  return stripPrompt(out)
}

export async function pollTarget(): Promise<string> {
  const out = await requireSession().send('poll')
  const t = /running/i.test(out) ? 'running' : /halted/i.test(out) ? 'halted' : 'unknown'
  setStatus({ target: t })
  return stripPrompt(out)
}

/** 硬件断点（riscv 用 rbp，失败退回普通断点 bp） */
export async function setBreakpoint(addr: string | number): Promise<string> {
  const a = typeof addr === 'number' ? `0x${addr.toString(16)}` : addr
  const out = await requireSession().send(`rbp ${a}`)
  if (/Error:/.test(out)) {
    const fb = await requireSession().send(`bp ${a}`)
    return stripPrompt(fb)
  }
  return stripPrompt(out)
}

export async function removeBreakpoint(addr?: string | number): Promise<string> {
  if (addr === undefined) return stripPrompt(await requireSession().send('rbp'))
  const a = typeof addr === 'number' ? `0x${addr.toString(16)}` : addr
  return stripPrompt(await requireSession().send(`rbp ${a}`))
}

/** 开发期/离线把已下载的 openocd 搬到用户目录（本仓库调试用，方便不联网也能跑） */
export function adoptDevOpenocd(): { ok: boolean; path?: string; error?: string } {
  const devRoot = join(tmpdir(), 'openocd', 'openocd-esp32')
  if (!existsSync(devRoot)) return { ok: false, error: '未找到 C:/Users/.../Temp/openocd/openocd-esp32' }
  const target = userToolDir()
  try {
    mkdirSync(target, { recursive: true })
    cpSync(devRoot, target, { recursive: true, force: true, dereference: true })
    const exe = join(target, 'bin', winExe('openocd'))
    if (!existsSync(exe)) return { ok: false, error: '拷贝后未找到 openocd.exe' }
    const v = spawnSync(exe, ['--version'], { encoding: 'utf-8', timeout: 8000 })
    return { ok: true, path: exe, error: v.status === 0 ? (v.stdout || '').trim() : '版本校验失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

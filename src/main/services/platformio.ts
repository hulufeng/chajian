// PlatformIO 集成（补齐竞品 Embedist / Espressif-IDE 的 PlatformIO 链路）
//
// 设计原则：
//  1. 不假设环境里必须有 pio —— 找不到就给出可执行的安装动作（pip install platformio），
//     安装成功后自动重探测，UI 与 Agent 工具都不需要关心它是从哪来的。
//  2. build / upload / monitor 全部走 pio CLI 原生子命令，不做二次封装，
//     输出原样透传（pio 的错误信息比我们自己拼的准）。
//  3. platformio.ini 的 env 解析自己写（不引 ini 解析库），保证「读得到就用得上」。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { userToolDir } from './toolchain'

export interface PioStatus {
  installed: boolean
  /** 可直接 spawn 的命令（pio 或 platformio） */
  command: string | null
  version: string
  /** 来源，便于 UI 提示 */
  source: 'user-dir' | 'path' | 'project' | 'none'
  /** 未安装时的安装提示 */
  hint: string
}

export interface PioEnv {
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
  envs: PioEnv[]
  defaultEnv: string | null
  /** 未找到 platformio.ini 时给 Agent/UI 的一句话说明 */
  note?: string
}

// ────────────────────── 探测 ──────────────────────

const WIN = process.platform === 'win32'

/** 用户一键安装目录：%APPDATA%/codelab-desktop/tools/pio */
function pioInstallDir(): string {
  return join(userToolDir(), 'pio')
}

/** pio 可执行文件的候选绝对路径 */
function pioCandidates(): Array<{ cmd: string; source: PioStatus['source'] }> {
  const dir = pioInstallDir()
  const out: Array<{ cmd: string; source: PioStatus['source'] }> = []
  // ① 用户一键安装（pip install --prefix=<dir> platformio 的产物）
  const scriptsDir = WIN ? join(dir, 'Scripts') : join(dir, 'bin')
  const exes = WIN ? ['pio.exe', 'platformio.exe', 'pio.cmd'] : ['pio', 'platformio']
  for (const e of exes) {
    const p = join(scriptsDir, e)
    if (existsSync(p)) out.push({ cmd: p, source: 'user-dir' })
  }
  // ② PATH 里的全局 pio
  out.push({ cmd: 'pio', source: 'path' })
  out.push({ cmd: 'platformio', source: 'path' })
  // ③ 项目本地（npx / pnpm 装过的工程）
  out.push({ cmd: 'node_modules/.bin/pio', source: 'project' })
  return out
}

function versionOf(cmd: string): { version: string; ok: boolean } {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 15000, windowsHide: true })
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
    // 形如 "PlatformIO Core, version 6.1.5"
    const m = text.match(/(\d+\.\d+\.\d+[\w.-]*)/)
    return { version: m ? m[1] : text.split('\n')[0] || '', ok: r.status === 0 }
  } catch {
    return { version: '', ok: false }
  }
}

/**
 * 探测可用的 pio。
 * 注意：'pio' 这种裸命令在没有 pio 的机器上 spawnSync 会抛 ENOENT，
 * 必须 try/catch 兜住，不能让整个探测崩掉。
 */
export function findPio(projectRoot?: string | null): PioStatus {
  const cands = pioCandidates()
  if (projectRoot) cands.push({ cmd: join(projectRoot, 'node_modules', '.bin', 'pio'), source: 'project' })

  for (const c of cands) {
    if (c.source === 'project' && !existsSync(c.cmd)) continue // 项目本地的先看文件是否存在
    const v = versionOf(c.cmd)
    if (v.ok && v.version) return { installed: true, command: c.cmd, version: v.version, source: c.source, hint: '' }
    if (v.ok) {
      // 命令能跑但拿不到版本号（罕见），仍视为可用
      return { installed: true, command: c.cmd, version: v.version || 'unknown', source: c.source, hint: '' }
    }
  }

  const dir = pioInstallDir()
  return {
    installed: false,
    command: null,
    version: '',
    source: 'none',
    hint: `未检测到 PlatformIO Core。可执行 \`pip install -U platformio\`（或点界面上的「安装 PlatformIO」按钮，会依次尝试 python / python3）。安装目录：${dir}`
  }
}

// ────────────────────── 安装 ──────────────────────

/** python 候选：系统 python → python3 → py -3 → 受管 python */
function pythonCandidates(): string[] {
  const managed =
    'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe'
  const list = ['python', 'python3', managed, join(homedir(), '.workbuddy/binaries/python/versions/3.13.12/python.exe')]
  if (WIN) list.push('py')
  return list.filter((p, i, arr) => arr.indexOf(p) === i)
}

/**
 * 一键安装 PlatformIO Core（pip）。
 * 进度回调复用 InstallProgress 语义：phase=installing，percent=退出码/1 的粗略表达。
 * 成功后自动重探测一次，把 command 带出来。
 */
export function installPio(
  onProgress?: (p: { phase: 'installing' | 'done' | 'error'; percent: number; message: string }) => void
): { success: boolean; command?: string; version?: string; error?: string; errorOut?: string } {
  mkdirSync(pioInstallDir(), { recursive: true })

  let lastErr = ''
  let lastOut = ''
  for (const py of pythonCandidates()) {
    const probe = spawnSync(py, ['--version'], { encoding: 'utf-8', timeout: 15000, windowsHide: true })
    if (probe.error) {
      lastErr = `${py}: ${probe.error.message}`
      continue
    }
    lastErr = ''
    onProgress?.({ phase: 'installing', percent: 20, message: `用 ${py} 安装 PlatformIO Core…` })
    const r = spawnSync(py, ['-m', 'pip', 'install', '-U', 'platformio'], {
      encoding: 'utf-8',
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }
    })
    lastOut = `${r.stdout || ''}${r.stderr || ''}`.slice(-4000)
    if (r.status === 0) {
      const st = findPio()
      onProgress?.({ phase: 'done', percent: 100, message: st.installed ? `安装成功：PlatformIO Core ${st.version}` : 'pip 已退出成功，但仍未找到 pio 命令' })
      return { success: st.installed, command: st.command ?? undefined, version: st.version || undefined, errorOut: lastOut }
    }
    lastErr = `安装失败（${py} 退出码 ${r.status}）：${lastOut.split('\n').filter((l) => /error|ERROR|Failed|failed/.test(l)).slice(0, 3).join(' | ')}`
  }

  onProgress?.({ phase: 'error', percent: 0, message: lastErr || '安装失败' })
  return { success: false, error: lastErr || '未找到可用的 python（尝试过 python / python3）', errorOut: lastOut }
}

// ────────────────────── platformio.ini 解析 ──────────────────────

/**
 * 极简 INI 解析：只认 [section] / key = value / # 或 ; 注释。
 * 不追求通用 INI 语义（多行值、展开变量都不支持），够读 platformio.ini 用。
 */
function parseIni(text: string): { sections: Record<string, Record<string, string>>; order: string[] } {
  const sections: Record<string, Record<string, string>> = {}
  const order: string[] = []
  let cur = ''
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      cur = sec[1].trim()
      if (!sections[cur]) {
        sections[cur] = {}
        order.push(cur)
      }
      continue
    }
    const kv = line.match(/^([^=:]+)\s*[=:]\s*(.*)$/)
    if (kv && cur) sections[cur][kv[1].trim()] = kv[2].trim()
  }
  return { sections, order }
}

/** 解析 platformio.ini，列出所有 [env:*] */
export function readPlatformIni(root: string): PioProject {
  const iniPath = join(root, 'platformio.ini')
  if (!existsSync(iniPath)) {
    return { found: false, root, envs: [], defaultEnv: null, note: `${root} 下没有 platformio.ini，当前工程不是 PlatformIO 工程` }
  }
  const { sections, order } = parseIni(readFileSync(iniPath, 'utf-8'))
  const envs: PioEnv[] = []
  let defaultEnv: string | null = null
  for (const name of order) {
    if (!name.startsWith('env:')) continue
    const s = sections[name]
    const envName = name.slice(4).trim()
    if (!envName) continue
    envs.push({
      name: envName,
      board: s.board,
      platform: s.platform,
      framework: s.framework,
      monitorSpeed: s.monitor_speed,
      uploadPort: s.upload_port,
      uploadSpeed: s.upload_speed,
      freq: s.freq
    })
    // 没有显式 default_envs 时，取第一个 env 兜底
    if (!defaultEnv) defaultEnv = envName
  }
  const explicitDefault = order.find((n) => !n.startsWith('env:')) && sections[order.find((n) => !n.startsWith('env:'))!]
    ? sections[order.find((n) => !n.startsWith('env:'))!].default_envs
    : undefined
  if (explicitDefault) {
    const first = explicitDefault.split(/(?:\s*,\s*|\s+)/).filter(Boolean)[0]
    if (first) defaultEnv = first
  }
  return { found: true, root, envs, defaultEnv }
}

/** 探测当前打开的工程是不是 PlatformIO 工程（找 platformio.ini / .pio） */
export function detectPioProject(root?: string | null): PioProject {
  if (!root) return { found: false, root: null, envs: [], defaultEnv: null, note: '还没有打开工程' }
  const direct = readPlatformIni(root)
  if (direct.found) return direct
  // 往上一层找（工程根目录可能是 src/ 下的子目录）
  let cur = dirname(resolve(root))
  for (let i = 0; i < 3; i++) {
    if (existsSync(join(cur, 'platformio.ini'))) return readPlatformIni(cur)
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return { found: false, root, envs: [], defaultEnv: null, note: '当前工程没有 platformio.ini（PlatformIO 工程的标志文件）' }
}

// ────────────────────── 执行 ──────────────────────

export interface PioRunResult {
  ok: boolean
  exitCode: number | null
  output: string
}

/** 通用 pio 调用（同步等待完成，输出全量收集） */
export function runPio(
  root: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): PioRunResult {
  const st = findPio()
  if (!st.installed || !st.command) return { ok: false, exitCode: null, output: st.hint }
  try {
    const r = spawnSync(st.command, args, {
      cwd: root,
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    const output = `${r.stdout || ''}${r.stderr || ''}`
    return { ok: r.status === 0, exitCode: r.status, output }
  } catch (e) {
    return { ok: false, exitCode: null, output: `启动 pio 失败：${(e as Error).message}` }
  }
}

export async function buildPio(
  root: string,
  env?: string,
  onData?: (chunk: string) => void
): Promise<{ ok: boolean; output: string; hint?: string }> {
  const st = findPio()
  if (!st.installed || !st.command) return { ok: false, output: '', hint: st.hint }
  const cmd = st.command
  const args = ['run']
  if (env) args.push('-e', env)
  return new Promise((resolve) => {
    let out = ''
    const cp: ChildProcess = spawn(cmd, args, { cwd: root, windowsHide: true })
    cp.stdout?.on('data', (d: Buffer) => { const s = d.toString(); out += s; onData?.(s) })
    cp.stderr?.on('data', (d: Buffer) => { const s = d.toString(); out += s; onData?.(s) })
    cp.on('close', (code) => resolve({ ok: code === 0, output: out, hint: code === 0 ? undefined : st.hint }))
    cp.on('error', (e) => resolve({ ok: false, output: `启动 pio 失败：${e.message}`, hint: st.hint }))
  })
}

export async function uploadPio(
  root: string,
  opts: { env?: string; port?: string },
  onData?: (chunk: string) => void
): Promise<{ ok: boolean; output: string; hint?: string }> {
  const st = findPio()
  if (!st.installed || !st.command) return { ok: false, output: '', hint: st.hint }
  const cmd = st.command
  const args = ['run', '-t', 'upload']
  if (opts.env) args.push('-e', opts.env)
  if (opts.port) args.push('--upload-port', opts.port)
  return new Promise((resolve) => {
    let out = ''
    const cp: ChildProcess = spawn(cmd, args, { cwd: root, windowsHide: true })
    cp.stdout?.on('data', (d: Buffer) => { const s = d.toString(); out += s; onData?.(s) })
    cp.stderr?.on('data', (d: Buffer) => { const s = d.toString(); out += s; onData?.(s) })
    cp.on('close', (code) => resolve({ ok: code === 0, output: out, hint: code === 0 ? undefined : st.hint }))
    cp.on('error', (e) => resolve({ ok: false, output: `启动 pio 失败：${e.message}`, hint: st.hint }))
  })
}

/** 串口监视器（长驻进程）；返回句柄以便 stopPioMonitor */
export function monitorPio(
  root: string,
  opts: { env?: string; port?: string; baud?: number },
  onData: (chunk: string) => void,
  onExit: (msg: string) => void
): { stop: () => void } {
  const st = findPio()
  if (!st.installed || !st.command) {
    onExit(st.hint)
    return { stop: () => undefined }
  }
  const args = ['device', 'monitor']
  if (opts.env) args.push('-e', opts.env)
  if (opts.port) args.push('-p', opts.port)
  if (opts.baud) args.push('-b', String(opts.baud))
  const cp: ChildProcess = spawn(st.command, args, { cwd: root, windowsHide: true })
  cp.stdout?.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr?.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('close', (code) => onExit(`监视器已退出（${code ?? '信号'}）`))
  cp.on('error', (e) => onExit(`启动监视器失败：${e.message}`))
  return {
    stop: () => {
      try {
        cp.kill('SIGTERM')
      } catch {
        /* 忽略 */
      }
    }
  }
}

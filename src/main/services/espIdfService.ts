import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface EspIdfStatus {
  available: boolean
  version: string
  path: string | null
}

const WIN = process.platform === 'win32'

function candidates(): string[] {
  const home = homedir()
  return [
    'idf.py',
    join('C:', 'Espressif', 'idf.py'),
    join('C:', 'Espressif', 'frameworks', 'esp-idf', 'tools', 'idf.py'),
    join('C:', 'Espressif', 'frameworks', 'esp-idf-v5.3.2', 'tools', 'idf.py'),
    join(home, 'esp', 'esp-idf', 'tools', 'idf.py'),
    join(home, 'esp', 'esp-idf', 'export.bat'),
    '/opt/esp-idf/tools/idf.py',
    join(home, 'esp', 'esp-idf', 'export.sh')
  ]
}

export function findIdfPy(): string | null {
  // IDF_PATH 环境变量优先
  const idfPath = process.env.IDF_PATH
  if (idfPath) {
    const p = WIN ? join(idfPath, 'tools', 'idf.py') : join(idfPath, 'tools', 'idf.py')
    if (existsSync(p)) return p
  }
  for (const cand of candidates()) {
    if (cand === 'idf.py') {
      try {
        const r = spawnSync(cand, ['--version'], { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return cand
      } catch {
        /* 继续 */
      }
    } else if (existsSync(cand)) {
      try {
        const r = spawnSync(cand, ['--version'], { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return cand
      } catch {
        /* 继续 */
      }
    }
  }
  return null
}

export async function detectEspIdf(): Promise<EspIdfStatus> {
  const bin = findIdfPy()
  if (!bin) return { available: false, version: '', path: null }
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
    return { available: true, version: (r.stdout || r.stderr || '').toString().trim(), path: bin }
  } catch {
    return { available: true, version: '', path: bin }
  }
}

/** 由 idf.py 路径推导 IDF_PATH：<...>/esp-idf/tools/idf.py -> <...>/esp-idf */
function deriveIdfPath(bin: string): string {
  if (process.env.IDF_PATH) return process.env.IDF_PATH
  const toolsIdx = bin.replace(/\\/g, '/').lastIndexOf('/tools/idf.py')
  if (toolsIdx > 0) return bin.slice(0, toolsIdx)
  return join(homedir(), 'esp', 'esp-idf')
}

/** 扫描 ~/.espressif/python_env 下的 IDF venv（如 idf5.4_py3.11_env） */
function findIdfPythonEnv(): string | null {
  try {
    const base = join(homedir(), '.espressif', 'python_env')
    const dirs = readdirSync(base).filter((d) => d.startsWith('idf'))
    if (dirs.length === 0) return null
    dirs.sort()
    return join(base, dirs[dirs.length - 1])
  } catch {
    return null
  }
}

/** 扫描 ~/.espressif/tools 下所有含 exe 的目录 + esp-idf/tools，构造构建用 PATH */
function idfToolPath(idfPath: string): string {
  const parts: string[] = []
  const toolsBase = join(homedir(), '.espressif', 'tools')
  const scan = (dir: string, depth: number): void => {
    if (depth > 4) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          scan(p, depth + 1)
        } else if (entry.name.toLowerCase().endsWith('.exe')) {
          if (!parts.includes(dir)) parts.push(dir)
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  scan(toolsBase, 0)
  parts.push(join(idfPath, 'tools'))
  return parts.join(';')
}

/** 构建/烧录时注入 ESP-IDF 所需环境（IDF_PATH / venv / 工具链 PATH） */
function idfEnv(bin: string): NodeJS.ProcessEnv {
  const idfPath = deriveIdfPath(bin)
  const pyEnv = findIdfPythonEnv()
  const env: NodeJS.ProcessEnv = { ...process.env, IDF_PATH: idfPath }
  if (pyEnv) env.IDF_PYTHON_ENV_PATH = pyEnv
  env.PATH = idfToolPath(idfPath) + ';' + (process.env.PATH || '')
  return env
}

/** Windows 上 idf.py 不能直接 spawn（EFTYPE），改用 venv python 执行 */
function resolveBuildCommand(bin: string): { cmd: string; prefixArgs: string[] } {
  if (WIN && bin.endsWith('.py')) {
    const pyEnv = findIdfPythonEnv()
    const py = pyEnv ? join(pyEnv, 'Scripts', 'python.exe') : 'python'
    return { cmd: py, prefixArgs: [bin] }
  }
  return { cmd: bin, prefixArgs: [] }
}

export interface EspIdfBuildOptions {
  project: string
  bin: string
  target?: string
}

export function espIdfBuild(
  o: EspIdfBuildOptions,
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ReturnType<typeof spawn> {
  const args = ['build']
  if (o.target) args.push('-DIDF_TARGET=' + o.target)
  const { cmd, prefixArgs } = resolveBuildCommand(o.bin)
  const cp = spawn(cmd, [...prefixArgs, ...args], { cwd: o.project, env: idfEnv(o.bin) })
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[ESP-IDF 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

export function espIdfFlash(
  o: EspIdfBuildOptions & { port: string },
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ReturnType<typeof spawn> {
  const args = ['flash', '-p', o.port]
  if (o.target) args.push('-DIDF_TARGET=' + o.target)
  const { cmd, prefixArgs } = resolveBuildCommand(o.bin)
  const cp = spawn(cmd, [...prefixArgs, ...args], { cwd: o.project, env: idfEnv(o.bin) })
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[ESP-IDF 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

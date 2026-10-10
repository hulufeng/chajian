import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, readdirSync, mkdirSync, createWriteStream, writeFileSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { get } from 'node:https'
import { openSerialMonitor } from './serialService'
import { parseKconfig, type KNode } from './kconfigParse'
import type { ChildProcess } from 'node:child_process'

const WIN = process.platform === 'win32'

/**
 * ESP-IDF 工具链检测与执行服务。
 *
 * 设计要点（修复原 espressif-idf-toolchain v0.1.11 的三个 bug）：
 *  1. 兼容官方 `idf-env.json` 字典格式（idfInstalled 为 dict 或 array 都支持），
 *     不要求用户改造配置文件。
 *  2. 所有工具（compile/flash/setTarget/monitor…）统一从一次 detect 结果取值，
 *     不存在「各工具各自缓存/派生路径」导致的不一致。
 *  3. 所有路径在 detect 阶段就经过 realpathSync 规范化（解析 junction / 符号链接），
 *     消除「同址不同串」误报。
 */

export interface EspIdfStatus {
  available: boolean
  version: string
  /** esp-idf 根目录（已 realpath 规范化） */
  path: string | null
  /** IDF_TOOLS_PATH（工具链目录，已 realpath 规范化） */
  toolsPath: string | null
  /** IDF_PYTHON_ENV_PATH（venv 目录，已 realpath 规范化） */
  pythonEnvPath: string | null
  /** 解释器完整路径 */
  pythonExe: string | null
  /** 拼接好的工具 PATH（venv Scripts + 各工具 bin） */
  exportPath: string | null
}

// ============================================================
// 路径规范化（统一解决 junction/真实路径串不一致）
// ============================================================
function norm(p: string | null | undefined): string | null {
  if (!p) return null
  try {
    const r = realpathSync(p)
    return r
  } catch {
    return p
  }
}

// ============================================================
// idf-env.json 解析（兼容官方字典格式 + 数组格式）
// ============================================================
interface IdfEnvEntry {
  path?: string
  python?: string
  espressif?: { idfToolsPath?: string }
}

function parseIdfEnvJson(): { selectedId: string | null; entries: IdfEnvEntry[] } {
  const candidates = [
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.espressif', 'idf-env.json'),
    join(homedir(), '.espressif', 'idf-env.json'),
    'C:/Espressif/idf-env.json',
    'D:/Espressif/idf-env.json'
  ]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    try {
      const data = JSON.parse(readFileSync(f, 'utf-8'))
      const selectedId: string | null = data.idfSelectedId ?? null
      let entries: IdfEnvEntry[] = []
      if (Array.isArray(data.idfInstalled)) {
        entries = data.idfInstalled as IdfEnvEntry[]
      } else if (data.idfInstalled && typeof data.idfInstalled === 'object') {
        // 官方字典格式：{ "path": { python, espressif: { idfToolsPath } } }
        entries = Object.entries(data.idfInstalled as Record<string, IdfEnvEntry>).map(([p, v]) => ({
          path: v.path ?? p,
          python: v.python,
          espressif: v.espressif
        }))
      }
      if (entries.length > 0 || selectedId) return { selectedId, entries }
    } catch {
      /* 解析失败试下一个 */
    }
  }
  return { selectedId: null, entries: [] }
}

// ============================================================
// 路径候选（pathGlobs 等效）
// ============================================================
function pathCandidates(): string[] {
  const home = homedir()
  const list: string[] = []
  if (process.env.IDF_PATH) list.push(process.env.IDF_PATH)
  // idf-env.json 提供的路径
  const { selectedId, entries } = parseIdfEnvJson()
  if (selectedId) list.push(selectedId)
  for (const e of entries) if (e.path) list.push(e.path)
  // 常见布局
  list.push(join('C:', 'Espressif', 'frameworks', 'esp-idf-v5.4'))
  list.push(join('C:', 'Espressif', 'frameworks', 'esp-idf-v5.3'))
  list.push(join('D:', 'Espressif', 'frameworks', 'esp-idf-v5.4'))
  list.push(join(home, 'esp', 'esp-idf'))
  list.push(join(home, '.espressif', 'esp-idf'))
  list.push(join(home, 'esp-idf'))
  list.push(join('C:', 'esp-idf'))
  list.push(join('C:', 'Espressif', 'esp-idf'))
  return list
}

function hasIdfPy(root: string): boolean {
  return existsSync(join(root, 'tools', 'idf.py'))
}

// 派生 toolsPath：frameworks/esp-idf-v* 的父目录；否则回退 .espressif/tools
function deriveToolsPath(root: string): string | null {
  const frameworksMatch = root.replace(/\\/g, '/').match(/^(.*)\/frameworks\/esp-idf-v[0-9.]+$/i)
  if (frameworksMatch) return norm(frameworksMatch[1]) ?? frameworksMatch[1]
  // 回退：root 同级或上级的 .espressif/tools
  const cands = [
    join(dirname(root), '.espressif', 'tools'),
    join(root, '.espressif', 'tools'),
    join(homedir(), '.espressif', 'tools'),
    join('C:', 'Espressif', 'tools')
  ]
  for (const c of cands) if (existsSync(c)) return norm(c)
  return null
}

// 派生 pythonEnvPath：优先 idf-env.json 的 python 字段，否则 glob
function derivePythonEnv(root: string, toolsPath: string | null, pythonFromEnv?: string): { pythonEnvPath: string | null; pythonExe: string | null } {
  if (pythonFromEnv) {
    const env = norm(dirname(dirname(pythonFromEnv)))
    return { pythonEnvPath: env, pythonExe: norm(pythonFromEnv) }
  }
  const roots = [toolsPath, join(homedir(), '.espressif'), join('C:', 'Espressif')].filter(Boolean) as string[]
  for (const r of roots) {
    const base = join(r, 'python_env')
    if (!existsSync(base)) continue
    let dirs: string[] = []
    try { dirs = readdirSync(base) } catch { continue }
    const match = dirs.find((d) => /^idf.*_py.*_env$/i.test(d))
    if (match) {
      const envPath = join(base, match)
      const exe = join(envPath, 'Scripts', WIN ? 'python.exe' : 'python')
      return { pythonEnvPath: norm(envPath), pythonExe: existsSync(exe) ? norm(exe) : norm(exe) }
    }
  }
  return { pythonEnvPath: null, pythonExe: null }
}

// 扫描 toolsPath/tools 下各工具 bin，拼成 export PATH
function deriveExportPath(toolsPath: string | null): string {
  const dirs: string[] = []
  if (toolsPath) {
    const toolsRoot = join(toolsPath, 'tools')
    if (existsSync(toolsRoot)) {
      try {
        for (const tool of readdirSync(toolsRoot)) {
          const t = join(toolsRoot, tool)
          // xtensa-esp-elf/esp-xx/bin、cmake/x.x/bin、ninja/x.x
          let sub: string[] = []
          try { sub = readdirSync(t) } catch { continue }
          for (const s of sub) {
            const bin = join(t, s, 'bin')
            if (existsSync(bin)) dirs.push(bin)
            // ninja 直接是 tools/ninja/x.x/ninja.exe
            if (existsSync(join(t, s, 'ninja.exe'))) dirs.push(join(t, s))
            // xtensa bin 在 tools/xtensa-esp-elf/esp-xx/xtensa-esp-elf/bin
            const xtBin = join(t, s, 'xtensa-esp-elf', 'bin')
            if (existsSync(xtBin)) dirs.push(xtBin)
          }
        }
      } catch { /* 忽略 */ }
    }
  }
  return dirs.join(WIN ? ';' : ':')
}

// ============================================================
// 检测
// ============================================================
export function findEspIdf(): EspIdfStatus {
  const { entries } = parseIdfEnvJson()
  const pythonFromEnv = entries[0]?.python
  const toolsPathHint = entries[0]?.espressif?.idfToolsPath
  for (const cand of pathCandidates()) {
    const root = norm(cand)
    if (!root || !hasIdfPy(root)) continue
    let toolsPath = toolsPathHint ? norm(toolsPathHint) : deriveToolsPath(root)
    const { pythonEnvPath, pythonExe } = derivePythonEnv(root, toolsPath, pythonFromEnv)
    const exportPath = deriveExportPath(toolsPath)
    return {
      available: true,
      version: readIdfVersion(root),
      path: root,
      toolsPath,
      pythonEnvPath,
      pythonExe,
      exportPath
    }
  }
  return { available: false, version: '', path: null, toolsPath: null, pythonEnvPath: null, pythonExe: null, exportPath: null }
}

export function detectEspIdf(): EspIdfStatus {
  return findEspIdf()
}

function readIdfVersion(root: string): string {
  try {
    const r = spawnSync('git', ['-C', root, 'describe', '--tags'], { encoding: 'utf-8', timeout: 5000 })
    const v = (r.stdout || '').trim()
    if (v) return v
  } catch { /* 忽略 */ }
  // 回退：读 tools/cmake/version 之类或直接 v5.x 推断
  return 'unknown'
}

// ============================================================
// 构造 env（统一、修复路径不一致）
// ============================================================
export function buildEnv(st: EspIdfStatus): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (st.path) env.IDF_PATH = st.path
  if (st.toolsPath) env.IDF_TOOLS_PATH = st.toolsPath
  if (st.pythonEnvPath) env.IDF_PYTHON_ENV_PATH = st.pythonEnvPath
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  const prefix: string[] = []
  if (st.pythonEnvPath) prefix.push(join(st.pythonEnvPath, 'Scripts'))
  if (st.exportPath) prefix.push(st.exportPath)
  env.PATH = [...prefix, env.PATH || ''].join(WIN ? ';' : ':')
  return env
}

// ============================================================
// 流式执行：compile / flash / set-target / clean / list-targets
// ============================================================
export interface EspIdfRunOptions {
  projectPath: string
  port?: string
  target?: string
}

function runIdf(
  args: string[],
  o: EspIdfRunOptions,
  onData: (c: string) => void,
  onExit: (c: number) => void
): ChildProcess | null {
  const st = findEspIdf()
  if (!st.available || !st.pythonExe || !st.path) {
    onData('[ESP-IDF] 未检测到 ESP-IDF，请先安装或用 IDF_PATH 指定。\n')
    onExit(1)
    return null
  }
  const cp = spawn(st.pythonExe, [join(st.path, 'tools', 'idf.py'), ...args], {
    cwd: o.projectPath,
    env: buildEnv(st),
    windowsHide: true
  })
  cp.stdout?.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr?.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[ESP-IDF 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

export function compileProject(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  return runIdf(['build'], o, onData, onExit)
}

export function flashProject(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  const args = o.port ? ['-p', o.port, 'flash'] : ['flash']
  return runIdf(args, o, onData, onExit)
}

export function setTargetProject(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  if (!o.target) {
    onData('[ESP-IDF] 未指定目标芯片。\n')
    onExit(1)
    return null
  }
  return runIdf(['set-target', o.target], o, onData, onExit)
}

export function cleanProject(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  return runIdf(['fullclean'], o, onData, onExit)
}

export function listTargets(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  return runIdf(['--list-targets'], o, onData, onExit)
}

/** 同步列出支持的芯片（供 DevicePanel target 选择器直接渲染，无需流式） */
export function listTargetsSync(projectPath?: string): Array<{ target: string; name: string }> {
  const st = findEspIdf()
  if (st.available && st.pythonExe && st.path) {
    try {
      const r = spawnSync(st.pythonExe, [join(st.path, 'tools', 'idf.py'), '--list-targets'], {
        cwd: projectPath,
        env: buildEnv(st),
        encoding: 'utf-8',
        timeout: 20000
      })
      const out = `${r.stdout || ''}${r.stderr || ''}`
      const targets = out
        .split('\n')
        .map((l) => l.match(/^Target:\s*(\S+)/i))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ target: m[1], name: m[1] }))
      if (targets.length > 0) return targets
    } catch {
      /* 回退静态列表 */
    }
  }
  // 静态兜底（ESP32 全系列）
  return [
    'esp32', 'esp32s2', 'esp32s3', 'esp32c2', 'esp32c3',
    'esp32c6', 'esp32h2', 'esp32p4', 'esp32c5', 'esp32c61'
  ].map((t) => ({ target: t, name: t }))
}

/** 设置目标芯片（同步等待完成） */
export function setTargetSync(projectPath: string, target: string): { ok: boolean; error?: string } {
  const st = findEspIdf()
  if (!st.available || !st.pythonExe || !st.path) return { ok: false, error: '未检测到 ESP-IDF' }
  try {
    const r = spawnSync(st.pythonExe, [join(st.path, 'tools', 'idf.py'), 'set-target', target], {
      cwd: projectPath,
      env: buildEnv(st),
      encoding: 'utf-8',
      timeout: 60000
    })
    if (r.status === 0) return { ok: true }
    return { ok: false, error: `${r.stdout || ''}${r.stderr || ''}`.slice(0, 500) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function eraseFlash(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  const args = o.port ? ['-p', o.port, 'erase-flash'] : ['erase-flash']
  return runIdf(args, o, onData, onExit)
}

/** 打开串口监视器（复用 serialService） */
export function openMonitor(
  opts: { port: string; baud: number },
  onData: (c: string) => void,
  onClose: (msg: string) => void
): () => void {
  return openSerialMonitor({ port: opts.port, baud: Number(opts.baud) || 115200 }, onData, onClose)
}

// ============================================================
// Kconfig confserver（图形化配置后端）
// ============================================================
export function startConfServer(o: EspIdfRunOptions, onData: (c: string) => void, onExit: (c: number) => void): ChildProcess | null {
  return runIdf(['confserver'], o, onData, onExit)
}

/**
 * 交互式 menuconfig 的启动参数：直接以 pty 方式运行 `idf.py menuconfig`。
 * 返回 node-pty 可直接消费的 args/cwd/env，由宿主 pty 通道驱动（获得 TTY 交互）。
 */
export function menuconfigCmd(
  projectPath?: string
): { args: string[]; cwd: string; env: Record<string, string> } | { error: string } {
  const st = detectEspIdf()
  if (!st.available || !st.pythonExe || !st.path) {
    return { error: '未检测到 ESP-IDF，无法打开 menuconfig' }
  }
  const cwd = projectPath || ''
  if (!cwd) return { error: '请先打开一个 ESP-IDF 工程' }
  const idfPy = join(st.path, 'tools', 'idf.py')
  return { args: [st.pythonExe, idfPy, 'menuconfig'], cwd, env: { ...buildEnv(st) } as Record<string, string> }
}

/** 读取 Kconfig 符号当前值（通过 idf.py confserver 不可直接 GET，这里用 sdkconfig 解析） */
export function configGet(projectPath: string, symbol: string): { ok: boolean; value?: string; error?: string } {
  const name = symbol.startsWith('CONFIG_') ? symbol : `CONFIG_${symbol}`
  try {
    const cfg = join(projectPath, 'sdkconfig')
    if (!existsSync(cfg)) return { ok: false, error: '未找到 sdkconfig' }
    const lines = readFileSync(cfg, 'utf-8').split('\n')
    for (const l of lines) {
      if (l.startsWith(name + '=')) {
        return { ok: true, value: l.slice(name.length + 1).replace(/^"|"$/g, '') }
      }
    }
    return { ok: true, value: undefined }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function configSet(projectPath: string, symbol: string, value: string): { ok: boolean; error?: string } {
  const name = symbol.startsWith('CONFIG_') ? symbol : `CONFIG_${symbol}`
  try {
    const cfg = join(projectPath, 'sdkconfig')
    const exists = existsSync(cfg)
    const lines = exists ? readFileSync(cfg, 'utf-8').split('\n') : []
    const idx = lines.findIndex((l) => l.startsWith(name + '='))
    const newLine = `${name}=${/^\d+$/.test(value) ? value : `"${value}"`}`
    if (idx >= 0) lines[idx] = newLine
    else lines.push(newLine)
    mkdirSync(dirname(cfg), { recursive: true })
    writeFileSync(cfg, lines.join('\n'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ============================================================
// 分区表 / sdkconfig 图形化编辑（webview 读写后端）
// ============================================================
export interface PartitionRow {
  name: string
  type: string
  subtype: string
  offset: string
  size: string
  flags: string
}

function defaultPartitions(): PartitionRow[] {
  return [
    { name: 'nvs', type: 'data', subtype: 'nvs', offset: '0x9000', size: '0x6000', flags: '' },
    { name: 'phy_init', type: 'data', subtype: 'phy', offset: '0xf000', size: '0x1000', flags: '' },
    { name: 'factory', type: 'app', subtype: 'factory', offset: '0x10000', size: '1M', flags: '' }
  ]
}

function parsePartitions(text: string): PartitionRow[] {
  const rows: PartitionRow[] = []
  for (const l of text.split('\n')) {
    const t = l.trim()
    if (!t || t.startsWith('#')) continue
    const parts = t.split(',').map((s) => s.trim())
    if (parts.length < 5) continue
    rows.push({
      name: parts[0],
      type: parts[1],
      subtype: parts[2],
      offset: parts[3],
      size: parts[4],
      flags: parts[5] || ''
    })
  }
  return rows
}

/** 读取工程分区表（partitions.csv）。文件不存在时返回默认单 app 模板，便于新建。 */
export function readPartitions(
  projectPath: string
): { ok: boolean; path?: string; rows?: PartitionRow[]; header?: string; isNew?: boolean; error?: string } {
  try {
    const cfg = join(projectPath, 'sdkconfig')
    let csvName = 'partitions.csv'
    if (existsSync(cfg)) {
      const custom = readFileSync(cfg, 'utf-8')
        .split('\n')
        .find((l) => l.startsWith('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME='))
      if (custom) {
        csvName = custom.slice('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME='.length).replace(/^"|"$/g, '').trim()
      }
    }
    const csvPath = join(projectPath, csvName)
    if (!existsSync(csvPath)) {
      return {
        ok: true,
        path: csvPath,
        rows: defaultPartitions(),
        header: '# Name,   Type, SubType, Offset,   Size,    Flags',
        isNew: true
      }
    }
    const text = readFileSync(csvPath, 'utf-8')
    const headerLine =
      text.split('\n').find((l) => l.trim().startsWith('#')) || '# Name,   Type, SubType, Offset,   Size,    Flags'
    return { ok: true, path: csvPath, rows: parsePartitions(text), header: headerLine }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function writePartitions(
  csvPath: string,
  rows: PartitionRow[]
): { ok: boolean; error?: string } {
  try {
    const header = '# Name,   Type, SubType, Offset,   Size,    Flags'
    const body = rows.map((r) => [r.name, r.type, r.subtype, r.offset, r.size, r.flags].map((s) => s.trim()).join(', '))
    mkdirSync(dirname(csvPath), { recursive: true })
    writeFileSync(csvPath, [header, ...body].join('\n') + '\n')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function formatSdkValue(v: string): string {
  if (/^["'].*["']$/.test(v)) return v
  if (/^[-+0-9A-Za-z0-9_./]+$/.test(v)) return v
  return `"${v}"`
}

/** 读取 sdkconfig 中的 CONFIG_* 符号（供图形化 Kconfig 编辑器使用）。 */
export function readSdkconfig(
  projectPath: string
): { ok: boolean; path?: string; items?: Array<{ key: string; value: string }>; error?: string } {
  try {
    const cfg = join(projectPath, 'sdkconfig')
    if (!existsSync(cfg)) return { ok: false, error: '未找到 sdkconfig（请先编译一次以生成）' }
    const items: Array<{ key: string; value: string }> = []
    for (const l of readFileSync(cfg, 'utf-8').split('\n')) {
      const t = l.trim()
      if (!t.startsWith('CONFIG_') || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      items.push({ key: t.slice(0, eq), value: t.slice(eq + 1).replace(/^"|"$/g, '') })
    }
    return { ok: true, path: cfg, items }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 写回 sdkconfig：保留原注释/顺序，仅更新已有 CONFIG_*，新符号追加到末尾。 */
export function writeSdkconfig(
  cfgPath: string,
  items: Array<{ key: string; value: string }>
): { ok: boolean; error?: string } {
  try {
    const map = new Map(items.map((i) => [i.key, i.value]))
    const lines = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8').split('\n') : []
    const out: string[] = []
    const seen = new Set<string>()
    for (const l of lines) {
      const t = l.trim()
      const eq = t.indexOf('=')
      if (t.startsWith('CONFIG_') && eq > 0 && !t.startsWith('#')) {
        const key = t.slice(0, eq)
        if (map.has(key)) {
          out.push(`${key}=${formatSdkValue(map.get(key)!)}`)
          seen.add(key)
          continue
        }
      }
      out.push(l)
    }
    for (const [k, v] of map) {
      if (!seen.has(k)) out.push(`${k}=${formatSdkValue(v)}`)
    }
    writeFileSync(cfgPath, out.join('\n'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * T3-a：定位「构建系统生成的聚合 Kconfig」作为额外解析源，覆盖工程 Kconfig 之外
 * 未被直接 source 的全量组件符号。
 *  - 优先用 ESP-IDF 在 build 目录生成的聚合文件（build/kconfigs.in），它逐条
 *    `source` 了所有被注册组件的 Kconfig，是构建期 menuconfig 用的完整集合；
 *  - 若不存在（工程尚未 configure），回退扫描 idfPath/components 与 project/components
 *    下的每个 Kconfig，尽量逼近全量组件符号。
 * 返回的绝对路径集合会被 parseKconfig 经 visited 去重，不会重复。
 */
function findExtraKconfigSources(projectPath: string, idfPath: string): string[] {
  const out: string[] = []
  const buildAggregate = join(projectPath, 'build', 'kconfigs.in')
  if (existsSync(buildAggregate)) return [buildAggregate]

  const scanDir = (dir: string): void => {
    if (!existsSync(dir)) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const d = join(dir, name)
      let st
      try {
        st = statSync(d)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        const k = join(d, 'Kconfig')
        if (existsSync(k)) out.push(k)
      }
    }
  }
  if (idfPath) scanDir(join(idfPath, 'components'))
  scanDir(join(projectPath, 'components'))
  const mainK = join(projectPath, 'main', 'Kconfig')
  if (existsSync(mainK)) out.push(mainK)
  return out
}

/** 解析工程的 Kconfig schema（菜单树 + 符号元信息），供完整 Kconfig 图形编辑器使用。 */
export function kconfigSchema(projectPath: string): { ok: boolean; tree?: KNode[]; error?: string; covered?: 'build-aggregate' | 'component-scan' | 'project-only' } {
  try {
    const st = detectEspIdf()
    const idfPath = st.path || ''
    let target = ''
    const cfg = join(projectPath, 'sdkconfig')
    if (existsSync(cfg)) {
      const t = readFileSync(cfg, 'utf-8')
        .split('\n')
        .find((l) => l.startsWith('CONFIG_IDF_TARGET='))
      if (t) target = t.split('=')[1].replace(/"/g, '').trim()
    }
    const extra = findExtraKconfigSources(projectPath, idfPath)
    const covered: 'build-aggregate' | 'component-scan' | 'project-only' = existsSync(join(projectPath, 'build', 'kconfigs.in'))
      ? 'build-aggregate'
      : extra.length
        ? 'component-scan'
        : 'project-only'
    const { tree } = parseKconfig(
      projectPath,
      {
        IDF_PATH: idfPath,
        COMPONENT_PATH: projectPath,
        COMPONENT_DIR: projectPath,
        IDF_TARGET: target
      },
      extra
    )
    return { ok: true, tree, covered }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * T3-b：用 ESP-IDF 自带的 kconfiglib（Python）对完整 Kconfig 做运行时求值，
 * 得到每个符号在「当前 sdkconfig」下的真实可见性（depends on + visible if）与生效默认值。
 * 前端据此做精确灰显，替代静态 best-effort 求值。
 * 若 kconfiglib 不可用（未安装/解析异常），返回 ok:false，前端回退到静态求值，不阻断。
 */
export function kconfigVisibility(projectPath: string): {
  ok: boolean
  map?: Record<string, { visible: boolean; default?: string }>
  error?: string
} {
  const st = detectEspIdf()
  if (!st.available || !st.pythonExe) return { ok: false, error: '未检测到 ESP-IDF' }
  const entry = join(projectPath, 'Kconfig')
  if (!existsSync(entry)) return { ok: false, error: '工程缺少 Kconfig' }
  const cfg = join(projectPath, 'sdkconfig')
  if (!existsSync(cfg)) return { ok: false, error: '未找到 sdkconfig（请先编译一次以生成）' }

  const script = [
    'import os, sys, json',
    "klp = os.environ.get('KCONFIGLIB_PATH', '')",
    "if klp and klp not in sys.path: sys.path.insert(0, klp)",
    'try:',
    '    import kconfiglib',
    'except Exception as e:',
    "    print(json.dumps({'error': 'no_kconfiglib:' + str(e)})); sys.exit(0)",
    "k = kconfiglib.Kconfig(os.environ['ENTRY'])",
    "k.load_config(os.environ['CFG'])",
    'out = {n: {\'visible\': bool(s.visibility), \'default\': (s.str_value if s.str_value is not None else \'\')} for n, s in k.syms.items()}',
    'print(json.dumps(out))'
  ].join('\n')

  try {
    const env: NodeJS.ProcessEnv = {
      ...buildEnv(st),
      KCONFIGLIB_PATH: join(st.path || '', 'tools', 'kconfig'),
      ENTRY: entry,
      CFG: cfg
    }
    const r = spawnSync(st.pythonExe, ['-c', script], {
      cwd: projectPath,
      env,
      encoding: 'utf-8',
      timeout: 60000
    })
    const out = `${r.stdout || ''}`.trim()
    if (!out) return { ok: false, error: `${r.stderr || ''}`.slice(0, 300) || 'kconfiglib 无输出' }
    const obj = JSON.parse(out) as Record<string, unknown>
    if (obj && typeof obj === 'object' && 'error' in obj && typeof obj.error === 'string') {
      return { ok: false, error: obj.error }
    }
    return { ok: true, map: obj as Record<string, { visible: boolean; default?: string }> }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ============================================================
// 一键安装器（下载官方安装器并启动，用户交互完成）
// ============================================================
const IDF_INSTALLER_URL = 'https://dl.espressif.cn/dl/idf-installer/esp-idf-tools-setup-online-2.4.1.exe'

export interface InstallProgress {
  phase: 'downloading' | 'ready' | 'error'
  percent: number
  message: string
}

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

/**
 * 下载官方 ESP-IDF 安装器到临时目录（不自动静默安装，交还给用户交互安装）。
 * 返回 exe 路径后由调用方 spawn 打开。
 */
export async function prepareInstaller(onProgress?: (p: InstallProgress) => void): Promise<{ success: boolean; exePath?: string; error?: string }> {
  const dir = join(tmpdir(), 'codelab-esp-idf-installer')
  try {
    mkdirSync(dir, { recursive: true })
    const exePath = join(dir, 'esp-idf-installer.exe')
    if (existsSync(exePath)) {
      onProgress?.({ phase: 'ready', percent: 100, message: '安装器已就绪' })
      return { success: true, exePath }
    }
    onProgress?.({ phase: 'downloading', percent: 0, message: '正在下载 ESP-IDF 安装器…' })
    await downloadFile(IDF_INSTALLER_URL, exePath, (percent) => {
      onProgress?.({ phase: 'downloading', percent, message: `正在下载 ESP-IDF 安装器… ${percent}%` })
    })
    onProgress?.({ phase: 'ready', percent: 100, message: '安装器已下载，请运行完成安装' })
    return { success: true, exePath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ phase: 'error', percent: 0, message: `下载失败: ${msg}` })
    return { success: false, error: msg }
  }
}

/** 启动安装器（用户交互） */
export function launchInstaller(exePath: string): { ok: boolean; error?: string } {
  try {
    const cp = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    cp.unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

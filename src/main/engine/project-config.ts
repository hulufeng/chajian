// 项目级配置能力（P0）：
//  1) labcode.md 项目配置自动注入系统提示（最高优先级）
//  2) .labignore 写保护（gitignore 语法，命中文件 agent 不可改、仍可读）
//  3) 固件会话检测（PlatformIO / ESP-IDF / Arduino / STM32CubeMX / Zephyr）
//  4) 检查点快照（create / list / rewind / fork，不依赖 git）
//
// 仅本地文件能力，不联网。大文件/数据不在此模块托管。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

// ────────────────────────────────────────────────────────────
// 1) labcode.md
// ────────────────────────────────────────────────────────────

export const LABCODE_MD_NAME = 'labcode.md'

/** 查找项目根下的 labcode.md，返回绝对路径或 null。 */
export function findProjectConfig(root: string | null | undefined): string | null {
  if (!root) return null
  const p = join(root, LABCODE_MD_NAME)
  return existsSync(p) ? p : null
}

/** 加载 labcode.md 为可注入系统提示的段落；不存在则返回空串。 */
export function loadProjectConfigBlock(root: string | null | undefined): string {
  const p = findProjectConfig(root)
  if (!p) return ''
  try {
    const content = readFileSync(p, 'utf-8').trim()
    if (!content) return ''
    return `## 项目配置（来自项目根目录 ${LABCODE_MD_NAME}，优先级最高，其中的命令/板卡/规则必须严格遵守）
${content}`
  } catch {
    return ''
  }
}

/** 默认 labcode.md 模板（面向 ESP32 / 单片机项目，删除某行即不约束）。 */
export function defaultLabcodeMd(): string {
  return `# LabCode 项目配置
# 本文件向 AI 描述项目，每次对话自动加载，优先级最高。以 # 开头为注释。

## 目标硬件
- 芯片/型号: ESP32-S3
- 开发板:
- 框架: Arduino        # 可选：Arduino / ESP-IDF / PlatformIO

## 构建与烧录
- 构建命令: pio run
- 烧录命令: pio run -t upload
- 串口监视器: pio device monitor
- 串口波特率: 115200
- 上传端口:           # 如 COM3，留空则自动探测

## 项目规则
-

## 关键红线
-
`
}

/** 在项目根生成 labcode.md（已存在则不覆盖）。返回路径与是否新建。 */
export function generateProjectConfig(root: string): { path: string; created: boolean } {
  const p = join(root, LABCODE_MD_NAME)
  if (existsSync(p)) return { path: p, created: false }
  mkdirSync(root, { recursive: true })
  writeFileSync(p, defaultLabcodeMd(), 'utf-8')
  return { path: p, created: true }
}

// ────────────────────────────────────────────────────────────
// 2) .labignore 写保护
// ────────────────────────────────────────────────────────────

export const LABIGNORE_NAME = '.labignore'

interface CompiledRule {
  negated: boolean
  dirOnly: boolean
  regex: RegExp
  raw: string
}

/** 把 glob 片段（已处理定界）转成正则主体。 */
function globToRegex(glob: string): string {
  // 先处理跨目录的 **/ 与 /**，用占位符
  let s = glob
  s = s.replace(/\*\*\//g, '\u0001') // **/ -> 零或多层目录
  s = s.replace(/\/\*\*/g, '\u0002') // /** -> 目录内任意内容
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '*' && s[i + 1] === '*') {
      out += '.*'
      i++
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '\u0001') {
      out += '(?:.*/)?'
    } else if (c === '\u0002') {
      out += '(?:/.*)?'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return out
}

function compileRule(raw: string): CompiledRule | null {
  let p = raw.trim()
  if (!p || p.startsWith('#')) return null
  let negated = false
  if (p.startsWith('!')) {
    negated = true
    p = p.slice(1)
  }
  let dirOnly = false
  if (p.endsWith('/')) {
    dirOnly = true
    p = p.slice(0, -1)
  }
  if (p.startsWith('/')) p = p.slice(1)
  const anchored = p.includes('/')
  const body = globToRegex(p)
  const prefix = anchored ? '^' : '(?:^|.*/)'
  const regex = new RegExp(prefix + body + '$')
  return { negated, dirOnly, regex, raw: raw.trim() }
}

export class Labignore {
  private rules: CompiledRule[] = []
  private root = ''
  private loaded = false

  load(root: string): void {
    this.root = resolve(root)
    this.rules = []
    this.loaded = false
    const p = join(this.root, LABIGNORE_NAME)
    if (existsSync(p)) {
      try {
        const lines = readFileSync(p, 'utf-8').split(/\r?\n/)
        for (const line of lines) {
          const r = compileRule(line)
          if (r) this.rules.push(r)
        }
      } catch {
        this.rules = []
      }
    }
    this.loaded = true
  }

  getRules(): string[] {
    return this.rules.map((r) => r.raw)
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** 判定某绝对路径是否被禁止写入。会同时检查祖先目录（目录被保护则其内文件一并保护）。 */
  isBlocked(absPath: string): boolean {
    if (!this.loaded || this.rules.length === 0) return false
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..')) return false
    let blocked = false
    const check = (cand: string, isDir: boolean): void => {
      for (const r of this.rules) {
        if (r.dirOnly && !isDir) continue
        if (r.regex.test(cand)) blocked = !r.negated
      }
    }
    // 祖先目录
    const parts = rel.split('/')
    let pre = ''
    for (let i = 0; i < parts.length - 1; i++) {
      pre += (i === 0 ? '' : '/') + parts[i]
      check(pre, true)
    }
    // 目标自身
    check(rel, false)
    return blocked
  }
}

// 按项目根缓存 Labignore（避免每次写文件都重新读盘编译）
const labignoreCache = new Map<string, { mtime: number; inst: Labignore }>()

function getLabignore(root: string): Labignore {
  const p = join(root, LABIGNORE_NAME)
  let mtime = 0
  try {
    if (existsSync(p)) mtime = statSync(p).mtimeMs
  } catch {
    mtime = 0
  }
  const cached = labignoreCache.get(root)
  if (cached && cached.mtime === mtime) return cached.inst
  const inst = new Labignore()
  inst.load(root)
  labignoreCache.set(root, { mtime, inst })
  return inst
}

/** 写保护闸门：某项目下的目标路径是否被禁止写入。root 为空时不拦截。 */
export function isWriteBlocked(root: string | null | undefined, absPath: string): boolean {
  if (!root) return false
  return getLabignore(root).isBlocked(resolve(absPath))
}

/** 列出某目录下当前被写保护的文件（用于工具反馈）。 */
export function listProtectedFiles(root: string, dir?: string): { rules: string[]; blocked: string[] } {
  const inst = getLabignore(root)
  const target = dir ? resolve(root, dir) : root
  const blocked: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 8) return
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (inst.isBlocked(full)) {
        blocked.push(relative(root, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(target, 0)
  return { rules: inst.getRules(), blocked }
}

// ────────────────────────────────────────────────────────────
// 3) 固件会话检测
// ────────────────────────────────────────────────────────────

export interface FirmwareDetection {
  firmware: boolean
  framework?: string
  buildSystem?: string
  mcu?: string
  confidence: number
  indicators: string[]
}

function readIfExists(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : null
  } catch {
    return null
  }
}

function matchIniValue(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([^\\n;#]+)`, 'i'))
  return m ? m[1].trim() : undefined
}

/** 检测项目是否为固件/单片机工程，并推断框架与构建系统。 */
export function detectFirmwareProject(root: string | null | undefined): FirmwareDetection {
  const indicators: string[] = []
  if (!root || !existsSync(root)) {
    return { firmware: false, confidence: 0, indicators }
  }

  let framework: string | undefined
  let buildSystem: string | undefined
  let mcu: string | undefined
  let score = 0

  const pio = readIfExists(join(root, 'platformio.ini'))
  if (pio) {
    indicators.push('platformio.ini')
    framework = matchIniValue(pio, 'framework') || 'PlatformIO'
    mcu = matchIniValue(pio, 'board') || matchIniValue(pio, 'platform')
    buildSystem = 'PlatformIO'
    score += 3
  }

  if (existsSync(join(root, 'sdkconfig')) || existsSync(join(root, 'sdkconfig.defaults'))) {
    indicators.push('sdkconfig')
    framework = framework || 'ESP-IDF'
    buildSystem = buildSystem || 'ESP-IDF (CMake)'
    score += 3
  }

  if (existsSync(join(root, 'prj.conf'))) {
    indicators.push('prj.conf')
    framework = framework || 'Zephyr'
    buildSystem = buildSystem || 'Zephyr (CMake)'
    score += 3
  }

  const ioc = readdirSync(root).find((f) => f.endsWith('.ioc'))
  if (ioc) {
    indicators.push(ioc)
    framework = framework || 'STM32Cube'
    buildSystem = buildSystem || 'STM32CubeMX (Make/CMake)'
    score += 2
  }

  // src 下存在 .ino（Arduino 工程强信号）
  try {
    const srcDir = join(root, 'src')
    if (existsSync(srcDir) && readdirSync(srcDir).some((f) => f.endsWith('.ino'))) {
      indicators.push('src/*.ino')
      framework = framework || 'Arduino'
      buildSystem = buildSystem || 'Arduino/PlatformIO'
      score += 2
    }
  } catch {
    /* ignore */
  }
  // 根目录 .ino（非 PlatformIO 布局的 Arduino 工程）
  if (readdirSync(root).some((f) => f.endsWith('.ino') && !indicators.includes('src/*.ino'))) {
    indicators.push('*.ino')
    framework = framework || 'Arduino'
    buildSystem = buildSystem || 'Arduino'
    score += 1
  }

  // 嵌入式 CMake（含 idf.py / components 目录 / include(xxx CMake)）
  const cmake = readIfExists(join(root, 'CMakeLists.txt'))
  if (cmake && /idf_component_register|project\s*\(|cmake_minimum_required/i.test(cmake) && score === 0) {
    if (existsSync(join(root, 'components')) || /idf_component_register/.test(cmake)) {
      indicators.push('CMakeLists.txt(embedded)')
      framework = framework || 'ESP-IDF'
      buildSystem = buildSystem || 'CMake'
      score += 1
    }
  }

  const confidence = Math.min(1, score >= 3 ? 0.9 : score === 2 ? 0.7 : score === 1 ? 0.45 : 0)
  return {
    firmware: score > 0,
    framework,
    buildSystem,
    mcu,
    confidence,
    indicators
  }
}

// 固件会话专用规则（独立编写，面向 ESP32/单片机；可被 agent-runner 引用）
export const FIRMWARE_RULES_BLOCK = `## 角色
你是一名资深嵌入式固件工程师，正在为本项目编写/调试可在真实芯片上运行的固件。你不是"给建议的顾问"——你直接用工具完成 编写→构建→烧录→监视→调试 的完整闭环。

## 绝对规则
1. 需要构建/烧录/读寄存器/跑工具时，**直接调用对应工具**；严禁用 terminal 的 echo/printf 去"描述"或替代一次真实工具调用。
2. 先读系统提示中已注入的项目配置与硬件上下文（labcode.md、目标芯片、构建/烧录命令），上下文已给出的信息不要再向用户追问。
3. 行动优先：能立即调用工具确认的，不要只在文字里假设。

## 外设配置流程（每次配置外设都按此顺序）
1. 先确认该外设/芯片是否有已知勘误（errata）需要规避；
2. 用公式核对关键时序（波特率、时钟分频、PWM 周期/占空比、定时器重装载值）；
3. 取得目标外设的精确寄存器/位域信息后再写代码——**用 svd_query 工具从乐鑫官方 SVD 查**（绝对地址/偏移/位域/位宽），禁止凭记忆写寄存器地址或位域；查不到就先安装该芯片 SVD 或改用框架提供的 HAL 接口，不要猜。
4. 用精确的寄存器名与位位置，按"先清位、再设位"的方式配置，并在注释中标注寄存器名/位/取值依据；
5. 若存在勘误，在代码中附上 workaround 并注释说明。

## 编码规则
- 内存映射寄存器访问必须 volatile；使用 stdint 定宽类型（uint32_t 等），不依赖 int/long 的隐式宽度。
- 显式位操作：配置多比特字段先清掩码位再设新值；不要对"只写寄存器"做读-改-写。
- 中断服务程序尽量短：只清标志/置信号，阻塞性操作放到主循环；共享变量加 volatile。
- 谨慎使用动态内存，嵌入式优先静态分配；循环必须有明确上界。
- 每次改完先构建，消除编译/链接错误后再烧录；烧录后用串口/RTT 等观察实际行为，异常则定位并修复，如此闭环直到满足目标。

## 验证分工（谁改谁验，不自说自话）
- 改完代码，优先用 **verify** 工具派「验证子智能体」独立验证（它没有任何写权限，只编译/跑测试/读串口，返回 通过|不通过 + 失败分类 + 文件:行 + 修复建议）。拿到"不通过"就按建议修复，再调一次 verify，直到通过。
- 需要"让代码真的在板子上跑起来"这种多轮试错，用 **closed_loop** 工具：给目标 + 通过标准，它自动 编译→烧录→串口观察→诊断→改代码 循环（默认 3 轮，到标准即停，超限会如实报未通过）。
- 单次确认能否编译，用 compile 即可，不必动用子智能体。

## ESP32 平台提示
- 中断或高频调用、且必须在 Flash cache 关闭期间运行的代码/常量需加 IRAM_ATTR/DRAM_ATTR。
- ADC2 与 Wi-Fi 不能同时使用；需要 Wi-Fi 时模拟采样走 ADC1。
- Arduino 与 ESP-IDF 工程的入口/构建命令不同：以 labcode.md 中记录的命令为准，不要张冠李戴。
- FreeRTOS 任务中不要长时间阻塞协议栈所在核心；延时用 vTaskDelay，忙等要有界。`

// ────────────────────────────────────────────────────────────
// 4) 检查点快照
// ────────────────────────────────────────────────────────────

export const SNAPSHOT_SKIP_DIRS = new Set([
  '.git', '.labcode', '.pio', 'node_modules', 'dist', 'out', 'build', '.venv', 'venv',
  '.cache', '__pycache__', '.next', '.nuxt', 'target', '.idea', '.vscode', '.vs'
])
const SNAPSHOT_TEXT_EXTS = new Set([
  '.ino', '.cpp', '.c', '.h', '.hpp', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt',
  '.html', '.css', '.scss', '.py', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.csv', '.xml',
  '.sh', '.bat', '.ps1', '.vue', '.java', '.go', '.rs', '.proto', '.conf', '.defaults'
])
const SNAPSHOT_SPECIAL_FILES = new Set([
  '.labignore', 'Makefile', 'CMakeLists.txt', 'platformio.ini', 'sdkconfig', 'sdkconfig.defaults', 'prj.conf'
])
const SNAPSHOT_MAX_FILES = 3000
const SNAPSHOT_MAX_BYTES = 1024 * 1024 // 单文件 1MB

function isSnapshotText(name: string): boolean {
  if (SNAPSHOT_SPECIAL_FILES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot >= 0) return SNAPSHOT_TEXT_EXTS.has(name.slice(dot))
  return false
}

export interface Checkpoint {
  id: string
  label: string
  timestamp: number
  root: string
  files: string[]
}

function collectSnapshotFiles(root: string): string[] {
  const files: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 12 || files.length >= SNAPSHOT_MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (isSnapshotText(e.name)) {
        try {
          if (statSync(full).size <= SNAPSHOT_MAX_BYTES) {
            files.push(relative(root, full).replace(/\\/g, '/'))
          }
        } catch {
          /* skip */
        }
      }
      if (files.length >= SNAPSHOT_MAX_FILES) break
    }
  }
  walk(root, 0)
  return files
}

function checkpointRootFor(root: string): string {
  return join(root, '.labcode', 'checkpoints')
}

function readCheckpointMeta(root: string, id: string): Checkpoint | null {
  const p = join(checkpointRootFor(root), id, 'meta.json')
  const data = readIfExists(p)
  if (!data) return null
  try {
    return JSON.parse(data) as Checkpoint
  } catch {
    return null
  }
}

/** 创建检查点：把当前受管文本文件快照到 .labcode/checkpoints/<id>/。 */
export function createCheckpoint(root: string, label?: string): Checkpoint {
  if (!existsSync(root)) throw new Error(`项目根不存在: ${root}`)
  const now = Date.now()
  const id = `cp${now.toString(36)}`
  const files = collectSnapshotFiles(root)
  const dest = join(checkpointRootFor(root), id)
  mkdirSync(dest, { recursive: true })
  for (const rel of files) {
    const src = join(root, rel)
    const out = join(dest, rel)
    mkdirSync(dirname(out), { recursive: true })
    const content = readIfExists(src)
    if (content !== null) writeFileSync(out, content, 'utf-8')
  }
  const meta: Checkpoint = {
    id,
    label: label || `检查点 ${new Date(now).toISOString().slice(0, 16)}`,
    timestamp: now,
    root,
    files
  }
  writeFileSync(join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
  return meta
}

/** 列出项目全部检查点（新→旧）。 */
export function listCheckpoints(root: string): Checkpoint[] {
  const base = checkpointRootFor(root)
  if (!existsSync(base)) return []
  const out: Checkpoint[] = []
  for (const id of readdirSync(base)) {
    const meta = readCheckpointMeta(root, id)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.timestamp - a.timestamp)
}

export interface RewindResult {
  checkpoint: Checkpoint
  restored: number
  deleted: string[]
}

/** 回退到检查点：恢复快照文件，并删除快照之后新增的受管文件。 */
export function rewindCheckpoint(root: string, id: string): RewindResult {
  const meta = readCheckpointMeta(root, id)
  if (!meta) throw new Error(`检查点不存在: ${id}`)
  const src = join(checkpointRootFor(root), id)
  const snapshotFiles = new Set(meta.files)

  // 恢复快照内文件
  for (const rel of meta.files) {
    const content = readIfExists(join(src, rel))
    if (content === null) continue
    const out = join(root, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, content, 'utf-8')
  }

  // 删除快照之后新增、且属于受管范围的文件（精确回退）
  const current = collectSnapshotFiles(root)
  const deleted: string[] = []
  for (const rel of current) {
    if (!snapshotFiles.has(rel)) {
      const abs = join(root, rel)
      try {
        rmSync(abs, { force: true })
        deleted.push(rel)
      } catch {
        /* 忽略删除失败 */
      }
    }
  }
  return { checkpoint: meta, restored: meta.files.length, deleted }
}

export interface ForkResult {
  checkpoint: Checkpoint
  newPath: string
}

/** 从检查点分叉：把快照恢复到一个兄弟新目录（不影响当前项目，不依赖 git）。 */
export function forkCheckpoint(root: string, id: string, branchName?: string): ForkResult {
  const meta = readCheckpointMeta(root, id)
  if (!meta) throw new Error(`检查点不存在: ${id}`)
  const src = join(checkpointRootFor(root), id)
  const safeName = (branchName || `${basename(root)}-${id}`).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
  const newPath = join(dirname(root), safeName)
  if (existsSync(newPath)) throw new Error(`目标目录已存在: ${newPath}`)
  mkdirSync(newPath, { recursive: true })
  for (const rel of meta.files) {
    const content = readIfExists(join(src, rel))
    if (content === null) continue
    const out = join(newPath, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, content, 'utf-8')
  }
  return { checkpoint: meta, newPath }
}

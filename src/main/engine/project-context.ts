/**
 * 确定性项目上下文预打包（P1-6）
 *
 * 目的：任务首轮就把「项目结构 + 关键源码 + 头文件依赖 + 引脚/外设使用 + 构建配置」喂给模型，
 * 用**零 token 的确定性扫描**（文件树 + 正则）替代模型自己一轮轮 list_files/read_file 探索，
 * 既减少探索性工具调用，也省 token，并降低小模型"猜项目结构"导致的幻觉。
 *
 * 对齐 Neural Inverse 的 nanoAgents 思路（AST/LSP 确定性采集），但只做零依赖的轻量版。
 * 纯本地、不联网、不启动 LSP，扫描失败一律降级为空串（绝不阻塞会话）。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set([
  '.labcode', '.pio', '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', 'build',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.idea', '.vscode', '.vs', 'coverage', '.turbo', 'storybook-static'
])
const SKIP_DIR_PATTERN = /\.(pio|git|next|nuxt|cache|venv|idea|vscode)$/i

/** 参与扫描的源码扩展名 */
const SOURCE_EXT = new Set([
  '.ino', '.pde', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java'
])
/** 工程/构建配置文件 */
const CONFIG_FILES = [
  'platformio.ini', 'CMakeLists.txt', 'Makefile', 'sdkconfig', 'sdkconfig.defaults',
  'sketch.yaml', 'sketch.json', 'library.properties', 'Kconfig', 'prj.conf',
  'partitions.csv', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'
]
const MAX_SCAN_FILES = 400
const MAX_SOURCE_READ = 24
const MAX_FILE_BYTES = 256 * 1024

export interface ProjectContextOptions {
  /** 输出上限字符数（默认 3600） */
  maxChars?: number
  /** 目录树深度（默认 3） */
  depth?: number
}

interface FileEntry {
  rel: string
  abs: string
  size: number
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || SKIP_DIR_PATTERN.test(name)
}

function walk(root: string, base: string, depth: number, maxDepth: number, out: FileEntry[], counter: { n: number }): void {
  if (depth > maxDepth || counter.n >= MAX_SCAN_FILES) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (counter.n >= MAX_SCAN_FILES) return
    const abs = path.join(root, e.name)
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue
      counter.n++
      walk(abs, base, depth + 1, maxDepth, out, counter)
    } else if (e.isFile()) {
      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch {
        continue
      }
      counter.n++
      out.push({ rel: path.relative(base, abs).replace(/\\/g, '/'), abs, size })
    }
  }
}

function readText(abs: string): string {
  try {
    const st = fs.statSync(abs)
    if (st.size > MAX_FILE_BYTES) return ''
    const buf = fs.readFileSync(abs, 'utf-8')
    if (buf.includes('\u0000')) return ''
    return buf
  } catch {
    return ''
  }
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0
}

/** 渲染目录树（只展示到指定深度，目录按名排序）。 */
function renderTree(root: string, maxDepth: number, limit = 60): string[] {
  const lines: string[] = []
  let count = 0
  const walkDir = (dir: string, prefix: string, depth: number): void => {
    if (depth > maxDepth || count >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries.filter((e) => e.isDirectory() && !shouldSkipDir(e.name)).sort((a, b) => a.name.localeCompare(b.name))
    const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))
    const items = [...dirs, ...files]
    items.forEach((e, i) => {
      if (count >= limit) return
      count++
      const last = i === items.length - 1
      const branch = last ? '└─ ' : '├─ '
      if (e.isDirectory()) {
        lines.push(`${prefix}${branch}${e.name}/`)
        walkDir(path.join(dir, e.name), prefix + (last ? '   ' : '│  '), depth + 1)
      } else {
        let size = 0
        try {
          size = fs.statSync(path.join(dir, e.name)).size
        } catch {
          /* ignore */
        }
        lines.push(`${prefix}${branch}${e.name} ${size >= 1024 ? `(${(size / 1024).toFixed(1)}KB)` : `(${size}B)`}`)
      }
    })
  }
  walkDir(root, '', 1)
  if (count >= limit) lines.push(`…（目录较大，仅展示前 ${limit} 项）`)
  return lines
}

interface SourceFacts {
  includes: Set<string>
  defines: Map<string, string>
  functions: Set<string>
  pinCalls: Map<string, number>
  baud: string | null
  delayMs: number | null
}

function analyzeSource(text: string): SourceFacts {
  const includes = new Set<string>()
  const defines = new Map<string, string>()
  const functions = new Set<string>()
  const pinCalls = new Map<string, number>()
  let baud: string | null = null
  let delayMs = null as number | null

  for (const m of text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) includes.add(m[1])
  for (const m of text.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+([^\n/]+)/gm)) {
    const name = m[1]
    const val = m[2].trim()
    if (defines.size < 40) defines.set(name, val)
  }
  for (const m of text.matchAll(/^\s*(?:static\s+|inline\s+|extern\s+)*(?:void|int|float|double|bool|char|long|short|unsigned|uint\d+_t|int\d+_t|size_t|String|IRAM_ATTR\s+\w+)\s+([A-Za-z_]\w*)\s*\(/gm)) {
    if (functions.size < 60) functions.add(m[1])
  }
  for (const m of text.matchAll(/\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcSetup|ledcAttach\w*|ledcWrite|touchRead|dacWrite)\s*\(/g)) {
    pinCalls.set(m[1], (pinCalls.get(m[1]) || 0) + 1)
  }
  const bm = /Serial\s*\.\s*begin\s*\(\s*(\d+)/.exec(text)
  if (bm) baud = bm[1]
  const dm = /delay\s*\(\s*(\d+)\s*\)/.exec(text)
  if (dm) delayMs = parseInt(dm[1], 10)

  return { includes, defines, functions, pinCalls, baud, delayMs }
}

/**
 * 生成项目上下文块。root 为空/不存在/扫描异常时返回空串（调用方按"无上下文"处理）。
 */
export function buildProjectContext(root: string | null | undefined, opts: ProjectContextOptions = {}): string {
  const maxChars = opts.maxChars ?? 3600
  const maxDepth = opts.depth ?? 3
  if (!root || !fs.existsSync(root)) return ''

  try {
    const files: FileEntry[] = []
    walk(root, root, 1, maxDepth, files, { n: 0 })

    // ── 目录树 ──
    const treeLines = renderTree(root, Math.max(1, maxDepth - 1), 50)

    // ── 源码文件（按"像入口文件"排序，优先主程序） ──
    const sources = files
      .filter((f) => SOURCE_EXT.has(path.extname(f.rel).toLowerCase()))
      .sort((a, b) => entryScore(b.rel) - entryScore(a.rel) || b.size - a.size)
    const picked = sources.slice(0, MAX_SOURCE_READ)

    const merged: SourceFacts = { includes: new Set(), defines: new Map(), functions: new Set(), pinCalls: new Map(), baud: null, delayMs: null }
    const perFile: string[] = []
    for (const f of picked) {
      const text = readText(f.abs)
      if (!text) continue
      const facts = analyzeSource(text)
      facts.includes.forEach((i) => merged.includes.add(i))
      facts.defines.forEach((v, k) => {
        if (!merged.defines.has(k) && merged.defines.size < 40) merged.defines.set(k, v)
      })
      facts.functions.forEach((fn) => {
        if (merged.functions.size < 60) merged.functions.add(fn)
      })
      facts.pinCalls.forEach((n, k) => merged.pinCalls.set(k, (merged.pinCalls.get(k) || 0) + n))
      if (!merged.baud && facts.baud) merged.baud = facts.baud
      if (merged.delayMs == null && facts.delayMs != null) merged.delayMs = facts.delayMs
      perFile.push(`- ${f.rel}（${countLines(text)} 行）`)
    }

    // ── 工程配置摘要 ──
    const configLines: string[] = []
    for (const name of CONFIG_FILES) {
      const abs = path.join(root, name)
      if (!fs.existsSync(abs)) continue
      const text = readText(abs)
      if (!text) {
        configLines.push(`- ${name}（存在，未解析）`)
        continue
      }
      const summary = summarizeConfig(name, text)
      configLines.push(`- ${name}${summary ? '\n  ' + summary : ''}`)
      if (configLines.length >= 6) break
    }

    // ── 项目配置/写保护 ──
    const extra: string[] = []
    if (fs.existsSync(path.join(root, 'labcode.md'))) extra.push('- labcode.md 存在（内容已作为最高优先级注入在上方）')
    if (fs.existsSync(path.join(root, '.labignore'))) extra.push('- .labignore 存在（部分文件对 AI 只读，写入前会被拦截）')

    const out: string[] = []
    out.push('## 项目上下文（启动时确定性扫描：文件树 + 源码正则，非推测）')
    out.push(`根目录: ${root}`)
    out.push(`扫描到 ${files.length} 个条目，其中源码 ${sources.length} 个（已分析 ${perFile.length} 个）`)
    if (treeLines.length) out.push('\n### 目录结构\n```\n' + treeLines.join('\n') + '\n```')
    if (perFile.length) out.push('\n### 关键源码文件\n' + perFile.join('\n'))
    if (merged.includes.size) out.push('\n### 头文件/库依赖（#include 扫描）\n' + Array.from(merged.includes).slice(0, 30).join(', '))
    const pinDefs = Array.from(merged.defines.entries()).filter(([k, v]) => /PIN|LED|BTN|BUTTON|SDA|SCL|SCK|MOSI|MISO|CS|RELAY|BUZZER|TRIG|ECHO/i.test(k) && /^[\dxXa-fA-F]/.test(v.trim()))
    const macroDefs = Array.from(merged.defines.entries()).filter(([k]) => !pinDefs.some(([pk]) => pk === k)).slice(0, 12)
    if (pinDefs.length || merged.pinCalls.size || merged.baud) {
      const pinLines: string[] = []
      if (pinDefs.length) pinLines.push('引脚/常量宏: ' + pinDefs.map(([k, v]) => `${k}=${v.trim()}`).join(', '))
      if (merged.pinCalls.size) pinLines.push('外设调用计数: ' + Array.from(merged.pinCalls.entries()).map(([k, n]) => `${k}×${n}`).join(', '))
      if (merged.baud) pinLines.push(`串口: Serial.begin(${merged.baud})`)
      if (macroDefs.length) pinLines.push('其他宏: ' + macroDefs.map(([k, v]) => `${k}=${v.trim().slice(0, 20)}`).join(', '))
      out.push('\n### 引脚/外设使用（源码扫描）\n' + pinLines.join('\n'))
    }
    if (merged.functions.size) out.push('\n### 已定义函数（节选）\n' + Array.from(merged.functions).slice(0, 30).join(', '))
    if (configLines.length) out.push('\n### 构建/工程配置\n' + configLines.join('\n'))
    if (extra.length) out.push('\n### 项目配置\n' + extra.join('\n'))
    out.push('\n> 以上为本地确定性扫描结果，可直接采信；如需更多细节再用 list_files / read_file / search_content 精准查看，不要重复遍历整个项目。')

    const text = out.join('\n')
    return text.length > maxChars ? text.slice(0, maxChars) + `\n…（项目上下文超长，已截断至 ${maxChars} 字符）` : text
  } catch {
    return ''
  }
}

/** 入口文件打分：主程序/主配置优先。 */
function entryScore(rel: string): number {
  let s = 0
  const base = path.basename(rel).toLowerCase()
  if (/^(main|app|sketch)\.(ino|pde|c|cpp|py|js|ts|go|rs)$/.test(base)) s += 40
  if (/\.(ino|pde)$/.test(base)) s += 30
  if (base === 'platformio.ini' || base === 'cmakelists.txt') s += 20
  if (/(^|\/)src\//.test(rel)) s += 12
  if (/(^|\/)(lib|components|drivers)\//.test(rel)) s += 6
  if (/(^|\/)(examples?|test|tests|docs?)\//.test(rel)) s -= 10
  if (base.startsWith('readme')) s -= 20
  return s
}

function summarizeConfig(name: string, text: string): string {
  const parts: string[] = []
  if (name === 'platformio.ini') {
    for (const m of text.matchAll(/^\s*\[env:([^\]]+)\]/gm)) parts.push(`env: ${m[1]}`)
    for (const key of ['platform', 'board', 'framework', 'monitor_speed', 'upload_speed']) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(text)
      if (m) parts.push(`${key}=${m[1].trim()}`)
    }
    const libs: string[] = []
    for (const m of text.matchAll(/^\s*lib_deps\s*=\s*([\s\S]*?)(?=^\S|\Z)/gm)) {
      m[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith(';'))
        .forEach((l) => libs.push(l))
    }
    if (libs.length) parts.push(`lib_deps: ${libs.slice(0, 10).join(' | ')}`)
    return parts.join('；')
  }
  if (name === 'sdkconfig' || name === 'sdkconfig.defaults') {
    const keys = [
      'CONFIG_IDF_TARGET', 'CONFIG_FREERTOS_HZ',
      'CONFIG_ESPTOOLPY_FLASHSIZE', 'CONFIG_ESP32S3_DEFAULT_CPU_FREQ_MHZ', 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ'
    ]
    for (const k of keys) {
      const m = new RegExp(`^${k}=(.+)$`, 'm').exec(text)
      if (m) parts.push(`${k.replace('CONFIG_', '')}=${m[1].trim()}`)
    }
    return parts.join('；')
  }
  if (name === 'package.json') {
    try {
      const j = JSON.parse(text) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string> }
      if (j.name) parts.push(`name=${j.name}`)
      if (j.scripts) parts.push(`scripts: ${Object.keys(j.scripts).slice(0, 8).join(', ')}`)
      if (j.dependencies) parts.push(`deps: ${Object.keys(j.dependencies).slice(0, 10).join(', ')}`)
    } catch {
      /* ignore */
    }
    return parts.join('；')
  }
  if (name === 'CMakeLists.txt') {
    const m = /project\s*\(\s*([^\s)]+)/i.exec(text)
    if (m) parts.push(`project=${m[1]}`)
    if (/idf_component_register/i.test(text)) parts.push('ESP-IDF 组件')
    return parts.join('；')
  }
  if (name === 'Cargo.toml' || name === 'go.mod' || name === 'pyproject.toml') {
    const first = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))
    return first ? first.trim() : ''
  }
  if (name === 'library.properties') {
    const nm = /^name=(.+)$/m.exec(text)
    const ver = /^version=(.+)$/m.exec(text)
    return [nm ? `name=${nm[1].trim()}` : '', ver ? `version=${ver[1].trim()}` : ''].filter(Boolean).join('；')
  }
  if (name === 'Makefile') {
    const t = /^[A-Za-z_]*TARGET\w*\s*[:?]?=\s*(\S+)/m.exec(text)
    return t ? `target=${t[1]}` : ''
  }
  return parts.join('；')
}

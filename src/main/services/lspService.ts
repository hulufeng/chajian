/**
 * LSP 会话服务：给「编辑器」用的一层会话管理。
 *
 * 与 Agent 工具（lsp-tools.ts）的区别：那是一次性查询、用完即弃；
 * 编辑器是**长会话**——同一个文件的文档要持续同步（didChange），
 * 客户端按「语言@项目根」复用，并提供编译数据库保障（clangd 需要 compile_commands.json
 * 才能解析 Arduino.h，否则满屏 file not found）。
 *
 * 两个消费方共用同一份语言/服务器映射，避免两处配置漂移。
 */
import { dirname, extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { LspClient } from './lsp-client'
import {
  candidateIncludePaths, libraryIncludePaths, arduinoDefines, makeCppEntry,
  existingPaths, writeCompileCommands, parseFqbn,
} from './lsp-compile-db'

/** 扩展名 -> 语言 id（单一数据源，Agent 工具与编辑器共用） */
export const EXT_LANGUAGE: Record<string, string> = {
  '.ino': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.c': 'c',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java'
}

/** 语言 id -> 语言服务器启动命令（要求在 PATH 中） */
export const LANG_SERVERS: Record<string, { command: string; args?: string[] }> = {
  cpp: { command: 'clangd', args: ['--background-index', '--clang-tidy=false'] },
  c: { command: 'clangd', args: ['--background-index', '--clang-tidy=false'] },
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  javascript: { command: 'typescript-language-server', args: ['--stdio'] },
  python: { command: 'pylsp' },
  go: { command: 'gopls' },
  rust: { command: 'rust-analyzer' },
  java: { command: 'jdtls' }
}

/** 上行：Monaco 诊断严重级别映射（与 monaco.MarkerSeverity 对齐） */
export const SEVERITY_MAP: Record<number, 1 | 2 | 3 | 4> = { 1: 2, 2: 4, 3: 3, 4: 4 }

export interface LspDiag {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  message: string
  severity: 1 | 2 | 3 | 4
  source?: string
  code?: string | number
}

export interface CompletionItemOut {
  label: string
  kind?: number
  detail?: string
  documentation?: string
  insertText?: string
  /** 1=纯文本 2=snippet（需要编辑器按片段插入） */
  insertTextFormat?: 1 | 2
  sortText?: string
  filterText?: string
}

export interface LspResult<T> {
  ok: boolean
  data?: T
  error?: string
}

function langOf(file: string): string | null {
  return EXT_LANGUAGE[extname(file).toLowerCase()] || null
}

/** 向上寻找项目根（含标记文件的目录） */
export function findProjectRoot(file: string): string {
  const markers = ['.git', 'package.json', 'platformio.ini', 'compile_commands.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'tsconfig.json']
  let cur = dirname(file)
  for (let i = 0; i < 12; i++) {
    for (const m of markers) {
      if (existsSync(join(cur, m))) return cur
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirname(file)
}

// 按 语言@项目根 缓存客户端
const clients = new Map<string, LspClient>()
/** 启动失败的 key -> 错误原因。避免 clangd 没装时每次都重试 spawn（慢且刷日志） */
const failed = new Map<string, string>()

function fileToUri(file: string): string {
  return pathToFileURL(file).href
}

async function getClient(languageId: string, file: string): Promise<LspClient> {
  const root = findProjectRoot(file)
  const key = `${languageId}@${root}`
  const cached = clients.get(key)
  if (cached) return cached
  const err = failed.get(key)
  if (err) throw new Error(err)

  const srv = LANG_SERVERS[languageId]
  if (!srv) throw new Error(`该语言没有配置语言服务器：${languageId}`)
  const client = new LspClient(srv.command, srv.args || [], pathToFileURL(root).href)
  try {
    await client.start()
  } catch (e) {
    // 语言服务器没装是最常见情况：记下来，之后直接降级，不反复 spawn
    const msg = `${srv.command} 启动失败（未安装或不在 PATH）：${(e as Error).message}`
    failed.set(key, msg)
    throw new Error(msg)
  }
  clients.set(key, client)
  return client
}

/**
 * 文档同步（didOpen / didChange）并取回当前诊断 —— #31 实时诊断的入口。
 * 编辑器里「没保存的改动」必须靠这条链推给语言服务器，否则看到的永远是上一次打开的内容。
 */
export async function syncDocument(p: {
  file: string
  text: string
  languageId?: string
  delayMs?: number
}): Promise<LspResult<LspDiag[]>> {
  const languageId = p.languageId || langOf(p.file)
  if (!languageId) return { ok: false, error: '不支持的语言' }
  try {
    const client = await getClient(languageId, p.file)
    const uri = fileToUri(p.file)
    await client.openDocument(uri, languageId, p.text, 0)
    await client.updateDocument(uri, p.text, p.delayMs ?? 250)
    const raw = client.getDiagnostics(uri) as Array<Record<string, unknown>>
    const diags: LspDiag[] = raw.map((d) => {
      const r = (d.range ?? {}) as Record<string, Record<string, number>>
      const start = r.start ?? {}
      const end = r.end ?? {}
      return {
        startLine: start.line ?? 0,
        startCharacter: start.character ?? 0,
        endLine: end.line ?? 0,
        endCharacter: end.character ?? 0,
        message: String(d.message ?? ''),
        severity: SEVERITY_MAP[Number(d.severity ?? 1)] ?? 3,
        source: d.source ? String(d.source) : undefined,
        code: d.code !== undefined ? (d.code as string | number) : undefined
      }
    })
    return { ok: true, data: diags }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 自动补全（#29） */
export async function completion(p: {
  file: string
  text: string
  line: number
  character: number
  triggerKind?: 1 | 2 | 3
  triggerCharacter?: string
  languageId?: string
}): Promise<LspResult<CompletionItemOut[]>> {
  const languageId = p.languageId || langOf(p.file)
  if (!languageId) return { ok: false, error: '不支持的语言' }
  try {
    const client = await getClient(languageId, p.file)
    const uri = fileToUri(p.file)
    // 补全前先把当前内容同步过去，保证服务端看到的和编辑器一致
    await client.openDocument(uri, languageId, p.text, 0)
    await client.updateDocument(uri, p.text, 0)
    const res = await client.completion(uri, p.line, p.character, p.triggerKind ?? 1, p.triggerCharacter)
    return { ok: true, data: normalizeCompletion(res) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** LSP 的补全结果可能是 CompletionItem[] 或 CompletionList，统一成数组 */
function normalizeCompletion(res: unknown): CompletionItemOut[] {
  const list = Array.isArray(res) ? res : ((res as Record<string, unknown>)?.items as unknown[]) ?? []
  const out: CompletionItemOut[] = []
  for (const raw of list) {
    const it = raw as Record<string, unknown>
    const label = String(it.label ?? it.insertText ?? '')
    if (!label) continue
    let documentation: string | undefined
    const doc = it.documentation
    if (typeof doc === 'string') documentation = doc
    else if (doc && typeof doc === 'object') documentation = String((doc as Record<string, unknown>).value ?? '')
    out.push({
      label,
      kind: typeof it.kind === 'number' ? it.kind : undefined,
      detail: it.detail ? String(it.detail) : undefined,
      documentation,
      insertText: it.insertText !== undefined ? String(it.insertText) : undefined,
      insertTextFormat: (it.insertTextFormat as 1 | 2) ?? undefined,
      sortText: it.sortText ? String(it.sortText) : undefined,
      filterText: it.filterText ? String(it.filterText) : undefined
    })
  }
  return out
}

/** 悬停（#29 / #33 硬件辅助也走这里的结果再包装） */
export async function hover(p: {
  file: string
  text: string
  line: number
  character: number
  languageId?: string
}): Promise<LspResult<string>> {
  const languageId = p.languageId || langOf(p.file)
  if (!languageId) return { ok: false, error: '不支持的语言' }
  try {
    const client = await getClient(languageId, p.file)
    const uri = fileToUri(p.file)
    await client.openDocument(uri, languageId, p.text, 0)
    await client.updateDocument(uri, p.text, 0)
    const res = await client.hover(uri, p.line, p.character) as Record<string, unknown> | null
    return { ok: true, data: res ? stringifyHover(res.contents) : '' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** hover.contents 可能是 string | MarkedString | 数组，统一成 Markdown 文本 */
function stringifyHover(contents: unknown): string {
  if (!contents) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(stringifyHover).filter(Boolean).join('\n\n')
  if (typeof contents === 'object') {
    return String((contents as Record<string, unknown>).value ?? '')
  }
  return ''
}

/** 跳转到定义（#29） */
export async function definition(p: {
  file: string
  text: string
  line: number
  character: number
  languageId?: string
}): Promise<LspResult<{ file: string; line: number; character: number }[]>> {
  const languageId = p.languageId || langOf(p.file)
  if (!languageId) return { ok: false, error: '不支持的语言' }
  try {
    const client = await getClient(languageId, p.file)
    const uri = fileToUri(p.file)
    await client.openDocument(uri, languageId, p.text, 0)
    await client.updateDocument(uri, p.text, 0)
    const res = await client.definition(uri, p.line, p.character)
    const arr = Array.isArray(res) ? res : [res]
    const locations: Array<{ file: string; line: number; character: number }> = []
    for (const item of arr) {
      const it = item as Record<string, unknown>
      const targetUri = String(it.targetUri ?? it.uri ?? '')
      if (!targetUri) continue
      const range = (it.targetRange ?? it.range ?? {}) as Record<string, Record<string, number>>
      const start = range.start ?? {}
      try {
        locations.push({ file: fileURLToPath(targetUri), line: start.line ?? 0, character: start.character ?? 0 })
      } catch {
        // 非 file:// 的 uri（如 untitled:）无法转本地路径，跳过
        continue
      }
    }
    return { ok: true, data: locations }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 保障编译数据库存在（#30）。
 * clangd 没这份文件就找不到 Arduino.h —— 所以这条比任何补全优化都关键。
 * coreRoot 由调用方从实际安装位置给（arduino-cli data dir / PlatformIO packages），缺失时跳过而不是编造路径。
 */
export function ensureCompileDb(p: {
  projectRoot: string
  fqbn?: string
  files: string[]
  coreRoot?: string
  variant?: string
  cpuFreqMHz?: number
  extraIncludes?: string[]
}): LspResult<string> {
  try {
    const root = p.projectRoot
    const existing = join(root, 'compile_commands.json')
    if (existsSync(existing)) return { ok: true, data: existing }

    const parts = p.fqbn ? parseFqbn(p.fqbn) : null
    const includes: string[] = []
    const defines: string[] = []

    if (parts && p.coreRoot && existsSync(p.coreRoot)) {
      includes.push(...candidateIncludePaths({
        coreRoot: p.coreRoot,
        arch: parts.arch,
        variant: p.variant ?? parts.board,
        sdk: parts.arch === 'esp32'
      }))
      includes.push(...libraryIncludePaths(p.coreRoot, ['WiFi', 'Wire', 'SPI', 'EEPROM', 'Preferences']))
      defines.push(...arduinoDefines(parts, {
        fqbn: p.fqbn!,
        cpuFreqMHz: p.cpuFreqMHz ?? 240,
        variant: p.variant
      }))
    }
    if (p.extraIncludes) includes.push(...p.extraIncludes)

    const inc = existingPaths(includes)
    const entries = (p.files.length > 0 ? p.files : ['main.ino']).map((f) =>
      makeCppEntry({ file: f, directory: root, includes: inc, defines })
    )
    const file = writeCompileCommands(root, entries)
    return { ok: true, data: file }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 关仓/切项目时释放资源 */
export async function disposeAll(): Promise<void> {
  for (const [, c] of clients) {
    try { await c.shutdown() } catch { /* 忽略 */ }
  }
  clients.clear()
  failed.clear()
}

/** 编辑器侧展示「语言服务器是否可用」用 */
export function status(): Array<{ key: string; ready: boolean }> {
  return Array.from(clients.keys()).map((k) => ({ key: k, ready: true }))
}

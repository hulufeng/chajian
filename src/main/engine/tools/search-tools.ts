// 内容搜索工具（grep）：只读，供主 agent 与 research 只读子智能体跨文件检索代码。
// 零依赖：递归遍历 + 正则匹配，跳过依赖/构建目录与二进制文件。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, basename, extname, resolve } from 'node:path'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

// 递归时跳过的目录（与 list_files 保持一致，避免扫 node_modules/.git/.pio 等噪音）
const SKIP_DIRS = new Set([
  '.pio', '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', 'build',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.idea', '.vscode', '.vs', 'coverage', '.turbo', 'storybook-static',
  '.workbuddy', 'release', '.pio'
])

// 不读取的二进制/资源扩展名
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.hex', '.elf',
  '.wav', '.mp3', '.mp4', '.mov', '.avi', '.mkv',
  '.ttf', '.woff', '.woff2', '.eot', '.otf'
])

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 单文件 2MB 上限
const MAX_FILES = 30000 // 防止极端仓库遍历爆炸

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name)
}

/** 极简 glob（仅文件名，支持 * 与 ?）转正则 */
function globToRegex(glob?: string): RegExp | null {
  if (!glob) return null
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + esc + '$', 'i')
}

function resolveSearchPath(ctx: ToolContext, p: string): string {
  const s = String(p || '').trim()
  if (!s) return ctx.projectRoot || ctx.cwd
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return s
  return resolve(ctx.cwd, s)
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 16 || out.length >= MAX_FILES) return
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    const full = join(dir, e)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (shouldSkipDir(e)) continue
      walk(full, out, depth + 1)
    } else if (st.isFile()) {
      const ext = extname(e).toLowerCase()
      if (SKIP_EXT.has(ext)) continue
      out.push(full)
    }
  }
}

/** 在单文件内按正则匹配，返回 文件:行号:内容 列表（最多 maxPerFile 条） */
function searchInFile(file: string, re: RegExp, maxPerFile: number): string[] {
  let buf: Buffer
  try { buf = readFileSync(file) } catch { return [] }
  if (buf.length > MAX_FILE_BYTES) return []
  if (buf.includes(0)) return [] // 含 NUL 视为二进制
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  const res: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (res.length >= maxPerFile) break
    if (re.test(lines[i])) {
      const lineNo = i + 1
      const snippet = lines[i].replace(/\t/g, ' ').trim().slice(0, 400)
      res.push(`${file}:${lineNo}: ${snippet}`)
    }
  }
  return res
}

// ── 工具: search_content ──
const searchContent: ToolDefinition = {
  name: 'search_content',
  description: '在项目里跨文件搜索匹配某正则/文本的行（类似 grep/rg）。给定 pattern（当作 JS 正则；普通文本直接写也可，特殊字符按正则语义），返回 文件:行号:匹配内容 列表。只读、不修改任何文件。这是只读研究子智能体做"跨文件分析"的核心工具：定位某函数/API/字符串在哪些地方被使用、做安全审计（找 eval/SQL 拼接/system 调用）、重构影响分析（找所有 digitalWrite 调用）、死代码/依赖分析等。可用 glob 限定文件类型，ignoreCase 忽略大小写。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本或正则（如 "digitalWrite"、".map\\\\("、"(eval|system)\\\\("）' },
      path: { type: 'string', description: '搜索根目录（默认项目根）；可给子目录' },
      glob: { type: 'string', description: '文件名过滤，如 "*.py"、"*.ts"（可选）' },
      ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      maxResults: { type: 'number', description: '最多返回多少条匹配，默认 200，上限 500' }
    },
    required: ['pattern']
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const root = resolveSearchPath(ctx, String(args.path || ''))
      if (!existsSync(root)) return { ok: false, content: '', error: `路径不存在：${root}` }
      let re: RegExp
      try {
        re = new RegExp(String(args.pattern), args.ignoreCase ? 'i' : '')
      } catch (e) {
        return { ok: false, content: '', error: `正则无效：${(e as Error).message}` }
      }
      const gre = globToRegex(args.glob ? String(args.glob) : undefined)
      const max = Math.min(Math.max(Number(args.maxResults) || 200, 1), 500)
      const maxPerFile = Math.min(max, 100)
      const files: string[] = []
      walk(root, files, 0)
      const matches: string[] = []
      for (const f of files) {
        if (matches.length >= max) break
        if (gre && !gre.test(basename(f))) continue
        const m = searchInFile(f, re, maxPerFile)
        matches.push(...m)
      }
      if (matches.length === 0) {
        return { ok: true, content: `未在 ${root} 下找到匹配 "${args.pattern}" 的内容（已扫描 ${files.length} 个文件）。` }
      }
      const capped = matches.length >= max
      return {
        ok: true,
        content: `匹配 ${matches.length} 处（扫描 ${files.length} 文件）${capped ? `，已截断到前 ${max} 条` : ''}：\n` + matches.join('\n')
      }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const searchTools: ToolDefinition[] = [searchContent]

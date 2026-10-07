// 8 个核心工具实现
import { join, resolve, relative } from 'node:path'
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { readTextFile, writeTextFile } from '../../services/fsService'
import { runCommand } from '../../services/commandService'
import { startBackgroundTask } from '../../services/backgroundTask'
import { runTests } from './run-tests'
import { memoryTools } from './memory-tools'
import { researchTool } from './research'
import { embeddedTools } from './embedded-tools'
import { lspTools } from './lsp-tools'
import { browserTools } from './browser-tools'
import { searchTools } from './search-tools'
import { arduinoLibTools } from './arduino-lib-tools'
import { boardTools } from './board-tools'
import { backgroundTaskTools } from './background-task-tools'
import { scheduleTools } from './schedule-tools'
import { skillTools } from './skill-tools'
import { todoTools } from './todo-tools'
import { gitTools } from './git-tools'
import { askUserTools } from './ask-user-tool'
import { projectTools } from './project-tools'
import { verifyTools } from './verify-tool'
import { closedLoopTools } from './closed-loop-tool'
import { svdTools } from './svd-tools'
import { platformioTools } from './platformio-tools'
import { targetTools } from './target-tools'
import { multiAgentTools } from './multi-agent-tools'
import { mcpExternalTools } from './mcp-tools'
import { pluginTools } from './plugin-tools'
import { isWriteBlocked } from '../project-config'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

// 构建产物/依赖目录：agent 浏览项目时应跳过（避免读 .pio/.git/node_modules 等噪音与二进制）
const SKIP_DIRS = new Set([
  '.labcode', '.pio', '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', 'build',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.idea', '.vscode', '.vs', 'coverage', '.turbo', 'storybook-static'
])
const SKIP_DIR_PATTERN = /\.(pio|git|next|nuxt|cache|venv|idea|vscode)$/i
const MAX_READ_FILE_BYTES = 1024 * 1024 // 1MB 上限，防读大文件/构建产物

// ── 文件冲突保护基线（对齐 TrieCode file-change-tracker 的用户改动保护）──
// 记录 AI 最后一次读取/写入某文件后的内容（会话级，主进程共享）。
// write_file/edit_file 写入前：若磁盘当前内容 ≠ 基线，说明文件被外部（用户/其他程序）改动，
// 拒绝覆盖并提示——防止 AI 基于过期快照覆盖用户的新改动。
const aiFileBaselines = new Map<string, string>()

function normPath(p: string): string {
  return resolve(p).replace(/\\/g, '/')
}

/** 记录 AI 读取/写入后的基线。 */
function setFileBaseline(p: string, content: string): void {
  aiFileBaselines.set(normPath(p), content)
}

/** 写入前冲突检测：返回冲突描述或 null（无冲突）。allow=false 时冲突即拒绝。 */
async function checkFileConflict(p: string, opts: { allowOverwriteExternal?: boolean } = {}): Promise<string | null> {
  const n = normPath(p)
  if (!aiFileBaselines.has(n)) return null // AI 从未读过该文件：无基线可比较（首次写靠权限确认把关）
  if (!existsSync(p)) return null // 文件已被删除：不算覆盖冲突
  const disk = await readTextFile(p) // readTextFile 是 async，必须 await（否则比较 Promise 恒不等）
  const baseline = aiFileBaselines.get(n)
  if (disk === baseline) return null // 磁盘与 AI 读到时一致，无冲突
  if (opts.allowOverwriteExternal) return null
  return `文件在 AI 操作期间被外部修改（AI 读取后磁盘内容发生变化——可能你或其他程序改过该文件）。为避免覆盖你的改动，本次写入已拒绝。\n请先调用 read_file 重新读取最新内容（读取后会刷新基线），确认后再写入。`
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || SKIP_DIR_PATTERN.test(name)
}

// ---------- 工具1: list_files ----------
const listFiles: ToolDefinition = {
  name: 'list_files',
  description: '列出指定目录下的文件和子目录。自动跳过构建产物与依赖目录（.pio/.git/node_modules/dist/build 等）。用于浏览项目源码结构。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列出的目录路径，默认为项目根目录' }
    },
    required: []
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const target = args.path ? resolve(ctx.cwd, String(args.path)) : (ctx.projectRoot || ctx.cwd)
    try {
      const entries = readdirSync(target, { withFileTypes: true })
      const dirs: string[] = []
      const files: string[] = []
      let skipped = 0
      for (const e of entries) {
        if (e.isDirectory()) {
          if (shouldSkipDir(e.name)) { skipped++; continue }
          dirs.push(`📁 ${e.name}/`)
        } else {
          const full = join(target, e.name)
          let size = 0
          try { size = statSync(full).size } catch { /* 文件可能被占用 */ }
          files.push(`📄 ${e.name} (${size}B)`)
        }
      }
      const lines = [...dirs, ...files]
      const skipNote = skipped > 0 ? `\n(已隐藏 ${skipped} 个构建/依赖目录)` : ''
      return { ok: true, content: `目录: ${target}\n${lines.join('\n') || '(空目录)'}${skipNote}` }
    } catch (e) {
      return { ok: false, content: '', error: `列出目录失败: ${(e as Error).message}` }
    }
  }
}

// ---------- 工具2: read_file ----------
const readFile: ToolDefinition = {
  name: 'read_file',
  description: '读取文件内容（限文本，≤1MB）。用于查看源码文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对项目根目录或绝对路径）' }
    },
    required: ['path']
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolve(ctx.projectRoot || ctx.cwd, String(args.path))
    try {
      // 大小限制：防读大文件/构建产物
      let size = 0
      try { size = statSync(target).size } catch { /* 下方 readTextFile 会报不存在 */ }
      if (size > MAX_READ_FILE_BYTES) {
        return { ok: false, content: '', error: `文件过大（${size}B > 1MB），已拒绝读取。请改用 list_files 查看目录，或读取源码文件而非构建产物/数据文件。` }
      }
      const content = await readTextFile(target)
      // 二进制检测：内容含 NUL 字节则视为非文本
      if (content.includes('\u0000')) {
        return { ok: false, content: '', error: `文件疑似二进制（${target}），无法以文本读取。请只读取源码/文本文件。` }
      }
      // 记录 AI 读取基线（供后续写入冲突检测）
      setFileBaseline(target, content)
      const lines = content.split('\n').length
      // 长文件截断：超过 4000 字符只返回前 4000 并提示
      const body = content.length > 4000 ? content.slice(0, 4000) + `\n...(已截断，共 ${content.length} 字符，如需全文请分段读取)` : content
      return { ok: true, content: `文件: ${target} (${lines}行)\n\n${body}` }
    } catch (e) {
      return { ok: false, content: '', error: `读取文件失败: ${(e as Error).message}` }
    }
  }
}

// ---------- 工具3: write_file ----------
const writeFile: ToolDefinition = {
  name: 'write_file',
  description: '写入文件内容。如果文件不存在则创建，存在则覆盖。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' }
    },
    required: ['path', 'content']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolve(ctx.projectRoot || ctx.cwd, String(args.path))
    try {
      // 写保护：.labignore 命中的文件禁止写入（仍可读）
      if (isWriteBlocked(ctx.projectRoot, target)) {
        return { ok: false, content: '', error: `该文件被 .labignore 写保护，AI 不可修改（仍可读取）。如需修改请调整 .labignore 规则。目标：${target}` }
      }
      // 冲突检测：AI 读过该文件后若被外部改动，拒绝覆盖（保护用户工作）
      const conflict = await checkFileConflict(target)
      if (conflict) return { ok: false, content: '', error: conflict }
      // 确保目录存在
      const dir = target.substring(0, target.lastIndexOf(/[\\/]/.exec(target)?.[0] || '/'))
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await writeTextFile(target, String(args.content))
      setFileBaseline(target, String(args.content))
      return { ok: true, content: `已写入文件: ${target} (${String(args.content).length}字符)` }
    } catch (e) {
      return { ok: false, content: '', error: `写入文件失败: ${(e as Error).message}` }
    }
  }
}

// ---------- 工具4: edit_file ----------
// 对齐 TrieCode edit_file：先精确匹配；失败则行级模糊匹配（忽略行首尾空白/空行）定位唯一候选；
// 成功后返回行号与 diff 预览
function matchLines(content: string, oldStr: string): { start: number; end: number; actual: string } | 'multi' | null {
  const contentLines = content.split('\n')
  const targetLines = oldStr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (targetLines.length === 0) return null
  const cands: Array<{ start: number; end: number }> = []
  for (let i = 0; i + targetLines.length <= contentLines.length; i++) {
    let match = true
    let t = 0
    for (let j = i; j < contentLines.length && t < targetLines.length; j++) {
      const cl = contentLines[j].trim()
      if (cl.length === 0) continue // 跳过原文空行
      if (cl !== targetLines[t]) { match = false; break }
      t++
    }
    if (match && t === targetLines.length) {
      // 记录实际跨度（含空行）：从 i 到最后一个非空匹配行
      let end = i
      let found = 0
      for (let j = i; j < contentLines.length && found < targetLines.length; j++) {
        end = j
        if (contentLines[j].trim().length > 0) found++
      }
      cands.push({ start: i, end })
    }
  }
  if (cands.length === 0) return null
  if (cands.length > 1) return 'multi'
  const c = cands[0]
  return { start: c.start, end: c.end, actual: contentLines.slice(c.start, c.end + 1).join('\n') }
}

function buildDiffPreview(content: string, startLine: number, oldActual: string, newStr: string): string {
  const lines = content.split('\n')
  const from = Math.max(0, startLine - 1)
  const to = Math.min(lines.length, startLine + oldActual.split('\n').length + 1)
  const out: string[] = []
  for (let i = from; i < to; i++) {
    if (i >= startLine && i < startLine + oldActual.split('\n').length) {
      out.push(`- ${lines[i]}`)
    } else {
      out.push(`  ${lines[i]}`)
    }
  }
  const newLines = newStr.split('\n').slice(0, 6)
  out.push('+ ' + newLines.join('\n+ '))
  if (newStr.split('\n').length > 6) out.push(`+ …（共 ${newStr.split('\n').length} 行）`)
  return out.join('\n')
}

const editFile: ToolDefinition = {
  name: 'edit_file',
  description:
    '编辑文件：用 new_string 替换 old_string。支持两种匹配：①精确匹配（含空格换行）；②精确匹配失败时自动尝试行级模糊匹配（忽略行首尾空白与空行），找到唯一位置即可替换。' +
    'old_string 应包含足够上下文（如函数签名+首行），避免匹配到多处。成功后返回替换行号与 diff 预览。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要替换的旧内容（精确匹配优先，失败后自动模糊匹配）' },
      new_string: { type: 'string', description: '替换后的新内容' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const target = resolve(ctx.projectRoot || ctx.cwd, String(args.path))
    try {
      // 写保护：.labignore 命中的文件禁止编辑（仍可读）
      if (isWriteBlocked(ctx.projectRoot, target)) {
        return { ok: false, content: '', error: `该文件被 .labignore 写保护，AI 不可修改（仍可读取）。如需修改请调整 .labignore 规则。目标：${target}` }
      }
      // 冲突检测：AI 读过该文件后若被外部改动，拒绝编辑（防止基于过期快照覆盖用户改动）
      const conflict = await checkFileConflict(target)
      if (conflict) return { ok: false, content: '', error: conflict }
      const content = await readTextFile(target)
      const oldStr = String(args.old_string)
      const newStr = String(args.new_string)
      if (!oldStr) return { ok: false, content: '', error: 'old_string 不能为空' }
      if (!content.includes(oldStr)) {
        // 精确失败 → 行级模糊匹配
        const fuzzy = matchLines(content, oldStr)
        if (fuzzy === null) {
          return { ok: false, content: '', error: `未找到匹配内容。已尝试精确匹配与行级模糊匹配（忽略空白），均无结果。请用 read_file 读取文件确认内容后重试，old_string 需包含足够上下文。` }
        }
        if (fuzzy === 'multi') {
          return { ok: false, content: '', error: `old_string 模糊匹配到多处位置，请扩大上下文使其唯一，或用 write_file 重写整个文件。` }
        }
        // 唯一模糊命中：用原文行重建实际片段替换
        const updated = content.replace(fuzzy.actual, newStr)
        await writeTextFile(target, updated)
        setFileBaseline(target, updated)
        const diff = buildDiffPreview(content, fuzzy.start, fuzzy.actual, newStr)
        return {
          ok: true,
          content: `已替换 1 处（模糊匹配，第 ${fuzzy.start + 1}-${fuzzy.end + 1} 行）→ 新内容 ${newStr.split('\n').length} 行。文件: ${target}\n\`\`\`diff\n${diff}\n\`\`\``,
          data: { mode: 'fuzzy', startLine: fuzzy.start + 1, endLine: fuzzy.end + 1 }
        }
      }
      const count = content.split(oldStr).length - 1
      const startLine = content.slice(0, content.indexOf(oldStr)).split('\n').length
      const updated = content.replace(oldStr, newStr)
      await writeTextFile(target, updated)
      setFileBaseline(target, updated)
      const diff = buildDiffPreview(content, startLine - 1, oldStr, newStr)
      return {
        ok: true,
        content: `已替换 ${count} 处（精确匹配，第 ${startLine} 行起）→ 新内容 ${newStr.split('\n').length} 行。文件: ${target}\n\`\`\`diff\n${diff}\n\`\`\``,
        data: { mode: 'exact', count, startLine }
      }
    } catch (e) {
      return { ok: false, content: '', error: `编辑文件失败: ${(e as Error).message}` }
    }
  }
}

// ---------- 工具5: terminal ----------
const terminal: ToolDefinition = {
  name: 'terminal',
  description: '在终端执行命令。默认超时30秒，长命令请拆分。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录，默认为项目根目录' },
      timeout: { type: 'number', description: '前台模式超时时间（毫秒），默认30000' },
      background: { type: 'boolean', description: '是否后台运行。true 时立即返回 taskId，命令在后台持续执行；用 task_output 读取输出、task_stop 终止。适合长命令（编译/起服务/监视）' }
    },
    required: ['command']
  },
  category: 'execute',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const cmd = String(args.command)
    const cwd = args.cwd ? resolve(ctx.cwd, String(args.cwd)) : (ctx.projectRoot || ctx.cwd)
    const timeout = Number(args.timeout) || 30000
    // 后台模式：立即返回 taskId，不阻塞
    if (args.background === true || args.background === 'true') {
      const id = startBackgroundTask(cmd, cwd)
      return {
        ok: true,
        content: `已在后台启动任务 ${id}（命令：${cmd}）。\n用 task_output 读取实时输出，task_stop 终止该任务。`,
        data: { taskId: id, background: true }
      }
    }
    return new Promise((resolve) => {
      let output = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        resolve({ ok: false, content: output, error: `命令超时（${timeout}ms）` })
      }, timeout)
      const push = (chunk: string): void => {
        output += chunk
        ctx.onOutput?.(chunk)
      }
      const done = (code: number): void => {
        clearTimeout(timer)
        if (timedOut) return
        resolve({ ok: code === 0, content: output || '(无输出)', data: { exitCode: code } })
      }
      try {
        runCommand(cmd, cwd, push, done)
      } catch (e) {
        clearTimeout(timer)
        resolve({ ok: false, content: '', error: `命令执行失败: ${(e as Error).message}` })
      }
    })
  }
}

// ---------- 工具6: web_search ----------
const webSearch: ToolDefinition = {
  name: 'web_search',
  description: '搜索网页。使用 DuckDuckGo 免密钥搜索。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '最大结果数，默认5' }
    },
    required: ['query']
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const query = encodeURIComponent(String(args.query))
    const max = Number(args.max_results) || 5
    try {
      // DuckDuckGo HTML 版搜索
      const url = `https://html.duckduckgo.com/html/?q=${query}`
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LabCode/1.0' }
      })
      const html = await resp.text()
      // 简单解析结果链接和标题
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g
      let match
      while ((match = resultRegex.exec(html)) !== null && results.length < max) {
        const title = match[2].replace(/<[^>]+>/g, '').trim()
        let url = match[1]
        // DuckDuckGo 链接可能是重定向
        if (url.startsWith('//')) url = 'https:' + url
        const snippet = match[3].replace(/<[^>]+>/g, '').trim()
        results.push({ title, url, snippet })
      }
      if (results.length === 0) {
        return { ok: true, content: `搜索"${args.query}"未找到结果。尝试用 web_fetch 直接访问已知URL。` }
      }
      const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
      return { ok: true, content: `搜索"${args.query}"结果（${results.length}条）：\n\n${text}` }
    } catch (e) {
      return { ok: false, content: '', error: `搜索失败: ${(e as Error).message}。可尝试用 web_fetch 直接访问已知URL。` }
    }
  }
}

// ---------- 工具7: web_fetch ----------
const webFetch: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取网页内容并提取文本。用于读取文档、文章等。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的URL' },
      max_length: { type: 'number', description: '最大字符数，默认5000' }
    },
    required: ['url']
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const url = String(args.url)
    const maxLen = Number(args.max_length) || 5000
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LabCode/1.0' }
      })
      if (!resp.ok) {
        return { ok: false, content: '', error: `HTTP ${resp.status} ${resp.statusText}` }
      }
      const html = await resp.text()
      // 简单提取文本：去标签、去脚本样式
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length > maxLen) text = text.substring(0, maxLen) + '\n...(已截断)'
      return { ok: true, content: `URL: ${url}\n\n${text}` }
    } catch (e) {
      return { ok: false, content: '', error: `抓取失败: ${(e as Error).message}` }
    }
  }
}

// ---------- 工具8: open_project ----------
const openProject: ToolDefinition = {
  name: 'open_project',
  description: '创建新项目（含脚手架文件）或切换工作目录。注意：list_files/read_file/write_file 已支持绝对路径直接操作，用户给出具体路径时无需调用本工具；仅在需要创建新项目脚手架或切换工作目录时调用。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '操作类型', enum: ['create', 'open'] },
      name: { type: 'string', description: '项目名称（create时必填）' },
      type: { type: 'string', description: '项目类型', enum: ['python', 'node', 'cpp', 'rust', 'go', 'java', 'arduino', 'generic'] },
      path: { type: 'string', description: '项目父目录或要打开的目录路径' }
    },
    required: ['action']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const action = String(args.action)
    console.error('[open_project] action:', action, 'args:', JSON.stringify(args))
    if (action === 'create') {
      const name = String(args.name || 'my-project')
      const type = String(args.type || 'generic')
      const parent = args.path ? resolve(ctx.cwd, String(args.path)) : join(ctx.cwd, 'LabCodeProjects')
      const dir = join(parent, name)
      console.error('[open_project] dir:', dir, 'exists:', existsSync(dir))
      if (existsSync(dir)) {
        return { ok: false, content: '', error: `目录已存在: ${dir}` }
      }
      try {
        mkdirSync(dir, { recursive: true })
        console.error('[open_project] mkdir ok')
        // 生成脚手架
        const scaffold = generateScaffold(type, name)
        console.error('[open_project] scaffold files:', Object.keys(scaffold))
        for (const [fname, content] of Object.entries(scaffold)) {
          await writeTextFile(join(dir, fname), content)
        }
        console.error('[open_project] write files ok')
        ctx.projectRoot = dir
        return { ok: true, content: `已创建项目: ${dir}\n类型: ${type}\n文件: ${Object.keys(scaffold).join(', ')}\n\n项目根目录已设为工作目录。`, data: { projectRoot: dir } }
      } catch (e) {
        console.error('[open_project] error:', (e as Error).message, (e as Error).stack)
        return { ok: false, content: '', error: `创建项目失败: ${(e as Error).message}` }
      }
    } else {
      const target = args.path ? resolve(ctx.cwd, String(args.path)) : ctx.projectRoot
      if (!target || !existsSync(target)) {
        return { ok: false, content: '', error: `目录不存在: ${target}` }
      }
      ctx.projectRoot = target
      return { ok: true, content: `已打开项目: ${target}`, data: { projectRoot: target } }
    }
  }
}

function generateScaffold(type: string, name: string): Record<string, string> {
  switch (type) {
    case 'python':
      return {
        'main.py': `# ${name}\ndef main():\n    print("Hello, ${name}!")\n\nif __name__ == "__main__":\n    main()\n`,
        'requirements.txt': '# 在此添加依赖\n',
        'README.md': `# ${name}\n\nPython 项目，由 LabCode 生成。\n\n\`\`\`bash\npython main.py\n\`\`\`\n`
      }
    case 'node':
      return {
        'index.js': `console.log("Hello, ${name}!");\n`,
        'package.json': JSON.stringify({ name, version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2),
        'README.md': `# ${name}\n\nNode.js 项目，由 LabCode 生成。\n\n\`\`\`bash\nnpm start\n\`\`\`\n`
      }
    case 'cpp':
      return {
        'src/main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "Hello, ${name}!" << std::endl;\n    return 0;\n}\n`,
        'CMakeLists.txt': `cmake_minimum_required(VERSION 3.10)\nproject(${name})\nadd_executable(${name} src/main.cpp)\n`,
        'README.md': `# ${name}\n\nC++ 项目，由 LabCode 生成。\n`
      }
    case 'arduino':
      return {
        'platformio.ini': `; PlatformIO Project Configuration File\n\n[env:${name}]\nplatform = espressif32\nboard = esp32-c3-devkitm-1\nframework = arduino\nmonitor_speed = 115200\n`,
        'src/main.ino': `#include <Arduino.h>\n\nvoid setup() {\n    Serial.begin(115200);\n    pinMode(2, OUTPUT);\n}\n\nvoid loop() {\n    digitalWrite(2, HIGH);\n    delay(500);\n    digitalWrite(2, LOW);\n    delay(500);\n}\n`,
        'README.md': `# ${name}\n\nArduino/ESP32 项目，由 LabCode 生成。\n\n\`\`\`bash\npio run -t upload\n\`\`\`\n`
      }
    case 'rust':
      return {
        'Cargo.toml': `[package]\nname = "${name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
        'src/main.rs': 'fn main() {\n    println!("Hello, LabCode!");\n}\n',
        'tests/basic.rs': '#[test]\nfn smoke() {\n    assert_eq!(1 + 1, 2);\n}\n',
        'README.md': `# ${name}\n\nRust 项目（Cargo），由 LabCode 生成。\n\n\`\`\`bash\ncargo run\ncargo test\n\`\`\`\n`
      }
    case 'go':
      return {
        'go.mod': `module ${name.toLowerCase().replace(/[^a-z0-9_/-]/g, '')}\n\ngo 1.21\n`,
        'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, LabCode!")\n}\n',
        'main_test.go': 'package main\n\nimport "testing"\n\nfunc TestSmoke(t *testing.T) {\n\tif 1+1 != 2 {\n\t\tt.Fatal("smoke test failed")\n\t}\n}\n',
        'README.md': `# ${name}\n\nGo 项目，由 LabCode 生成。\n\n\`\`\`bash\ngo run .\ngo test ./...\n\`\`\`\n`
      }
    case 'java':
      return {
        'src/main/java/App.java': 'public class App {\n    public static void main(String[] args) {\n        System.out.println("Hello, LabCode!");\n    }\n}\n',
        'src/test/java/AppTest.java': 'public class AppTest {\n    @org.junit.jupiter.api.Test\n    void smoke() {\n        org.junit.jupiter.api.Assertions.assertEquals(2, 1 + 1);\n    }\n}\n',
        'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.labcode</groupId>\n  <artifactId>${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}</artifactId>\n  <version>0.1.0</version>\n  <properties>\n    <maven.compiler.source>17</maven.compiler.source>\n    <maven.compiler.target>17</maven.compiler.target>\n    <junit.version>5.10.2</junit.version>\n  </properties>\n  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter</artifactId>\n      <version>\${junit.version}</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>\n`,
        'README.md': `# ${name}\n\nJava 项目（Maven + JUnit 5），由 LabCode 生成。\n\n\`\`\`bash\nmvn test\nmvn package\n\`\`\`\n`
      }
    default:
      return {
        'README.md': `# ${name}\n\n通用项目，由 LabCode 生成。\n`,
        'main.txt': ''
      }
  }
}

export const coreTools: ToolDefinition[] = [
  listFiles,
  readFile,
  writeFile,
  editFile,
  terminal,
  runTests,
  webSearch,
  webFetch,
  openProject,
  researchTool,
  ...memoryTools,
  ...embeddedTools,
  ...lspTools,
  ...browserTools,
  ...searchTools,
  ...arduinoLibTools,
  ...boardTools,
  ...backgroundTaskTools,
  ...scheduleTools,
  ...skillTools,
  ...todoTools,
  ...gitTools,
  ...askUserTools,
  ...projectTools,
  ...verifyTools,
  ...closedLoopTools,
  ...svdTools,
  ...platformioTools,
  ...targetTools,
  ...mcpExternalTools,
  ...pluginTools,
  ...multiAgentTools
]

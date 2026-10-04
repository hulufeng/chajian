// LSP 代码智能工具：定义跳转 / 引用 / 悬停 / 诊断 / 符号结构
// 对齐 TrieCode 截图里 agent 调 lsp_definition / lsp_references / lsp_hover / read_diagnostics / code_symbols 的能力。
// 语言服务器由系统提供（C/C++: clangd, TS/JS: typescript-language-server, Python: pylsp, Go: gopls）。
import { dirname, extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { LspClient } from '../../services/lsp-client'
import { readTextFile } from '../../services/fsService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

// 扩展名 -> 语言 id
const EXT_LANG: Record<string, string> = {
  '.ino': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.c': 'c',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java'
}

// 语言 id -> 语言服务器启动命令
const SERVERS: Record<string, { command: string; args?: string[] }> = {
  cpp: { command: 'clangd' },
  c: { command: 'clangd' },
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  javascript: { command: 'typescript-language-server', args: ['--stdio'] },
  python: { command: 'pylsp' },
  go: { command: 'gopls' },
  rust: { command: 'rust-analyzer' },
  java: { command: 'jdtls' }
}

// 按 语言@项目根 缓存 client，跨项目隔离 + 多次调用复用
const clients = new Map<string, LspClient>()

function langOf(file: string): string | null {
  return EXT_LANG[extname(file).toLowerCase()] || null
}

function resolvePath(ctx: ToolContext, file: string): string {
  const p = String(file)
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p
  return join(ctx.projectRoot || ctx.cwd, p)
}

/** 向上寻找项目根（含标记文件的目录），找不到则返回文件所在目录 */
function findProjectRoot(file: string): string {
  const markers = ['.git', 'package.json', 'platformio.ini', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'tsconfig.json']
  let cur = dirname(file)
  // 上限 12 层，避免极端路径死循环
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

async function getClient(languageId: string, file: string): Promise<LspClient> {
  const root = findProjectRoot(file)
  const key = `${languageId}@${root}`
  const cached = clients.get(key)
  if (cached) return cached
  const srv = SERVERS[languageId]
  if (!srv) throw new Error(`不支持的语言：${languageId}（无对应语言服务器配置）`)
  const client = new LspClient(srv.command, srv.args || [], pathToFileURL(root).href)
  await client.start()
  clients.set(key, client)
  return client
}

// ── 结果格式化 ──
function formatLocations(res: unknown, label: string): string {
  if (!res) return ''
  const arr = Array.isArray(res) ? res : [res]
  if (arr.length === 0) return ''
  const lines = arr.map((loc: Record<string, unknown>) => {
    const uri = (loc.uri || (loc as { targetUri?: string }).targetUri) as string | undefined
    const range = ((loc.range || (loc as { targetSelectionRange?: { start: { line: number; character: number } } }).targetSelectionRange) as { start: { line: number; character: number } } | undefined)
    const start = range?.start
    const path = uri ? fileURLToPath(uri) : '?'
    return `  ${label}: ${path}:${start ? start.line + 1 : '?'}:${start ? start.character + 1 : '?'}`
  })
  return `${label}位置（${arr.length} 处）：\n${lines.join('\n')}`
}

function formatSymbols(symbols: Record<string, unknown>[], indent: string): string {
  if (!symbols || symbols.length === 0) return ''
  return symbols
    .map((s) => {
      const name = String(s.name || '')
      const kind = String(s.kind || '')
      const rng = (s.range || s.location) as { start?: { line: number; character: number } } | undefined
      const loc = rng?.start ? ` (${rng.start.line + 1}:${rng.start.character + 1})` : ''
      const children = formatSymbols((s.children as Record<string, unknown>[]) || [], indent + '  ')
      return `${indent}- ${name} [${kind}]${loc}${children ? '\n' + children : ''}`
    })
    .join('\n')
}

// ── 工具1: lsp_definition ──
const lspDefinition: ToolDefinition = {
  name: 'lsp_definition',
  description: '查询符号的定义位置（LSP textDocument/definition）。给定文件与行列（1-based，即从 1 开始计），返回定义所在的文件与行列。用于理解代码、跳转到函数/变量/类型的定义。需系统已安装对应语言服务器（C/C++: clangd，TS/JS: typescript-language-server，Python: pylsp，Go: gopls）。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '源码文件路径（绝对或相对项目根）' },
      line: { type: 'number', description: '行号（从 1 开始）' },
      character: { type: 'number', description: '列号（从 1 开始）' }
    },
    required: ['file', 'line', 'character']
  },
  category: 'read',
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const file = resolvePath(ctx, String(args.file))
      const lang = langOf(file)
      if (!lang) return { ok: false, content: '', error: `无法根据扩展名判断语言：${extname(file)}` }
      const text = await readTextFile(file)
      const client = await getClient(lang, file)
      const uri = pathToFileURL(file).href
      await client.openDocument(uri, lang, text)
      const res = await client.definition(uri, Number(args.line) - 1, Number(args.character) - 1)
      const out = formatLocations(res, '定义')
      return { ok: out.length > 0, content: out || '未找到定义（语言服务器可能尚未索引该符号，或项目依赖未安装）' }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具2: lsp_references ──
const lspReferences: ToolDefinition = {
  name: 'lsp_references',
  description: '查询符号的全部引用位置（LSP textDocument/references）。给定文件与行列（1-based），返回所有引用该符号的位置列表。用于重构/改名前评估影响范围。需系统已安装对应语言服务器。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '源码文件路径' },
      line: { type: 'number', description: '行号（从 1 开始）' },
      character: { type: 'number', description: '列号（从 1 开始）' }
    },
    required: ['file', 'line', 'character']
  },
  category: 'read',
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const file = resolvePath(ctx, String(args.file))
      const lang = langOf(file)
      if (!lang) return { ok: false, content: '', error: `无法根据扩展名判断语言：${extname(file)}` }
      const text = await readTextFile(file)
      const client = await getClient(lang, file)
      const uri = pathToFileURL(file).href
      await client.openDocument(uri, lang, text)
      const res = await client.references(uri, Number(args.line) - 1, Number(args.character) - 1)
      const out = formatLocations(res, '引用')
      return { ok: out.length > 0, content: out || '未找到引用' }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具: lsp_hover ──
const lspHover: ToolDefinition = {
  name: 'lsp_hover',
  description: '获取光标处符号的悬停信息（LSP textDocument/hover）：类型签名、文档注释、快速帮助。给定文件与行列（1-based），返回该符号的类型与说明，等价于 IDE 里鼠标悬停提示。用于在不跳转的情况下快速了解一个函数/变量/类型的含义。需系统已安装对应语言服务器（C/C++: clangd，TS/JS: typescript-language-server，Python: pylsp，Go: gopls）。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '源码文件路径（绝对或相对项目根）' },
      line: { type: 'number', description: '行号（从 1 开始）' },
      character: { type: 'number', description: '列号（从 1 开始）' }
    },
    required: ['file', 'line', 'character']
  },
  category: 'read',
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const file = resolvePath(ctx, String(args.file))
      const lang = langOf(file)
      if (!lang) return { ok: false, content: '', error: `无法根据扩展名判断语言：${extname(file)}` }
      const text = await readTextFile(file)
      const client = await getClient(lang, file)
      const uri = pathToFileURL(file).href
      await client.openDocument(uri, lang, text)
      const res = (await client.hover(uri, Number(args.line) - 1, Number(args.character) - 1)) as { contents?: unknown } | null
      if (!res || !res.contents) return { ok: true, content: '该位置无悬停信息（可能不是符号，或语言服务器尚未索引）' }
      const c = res.contents
      let out: string
      if (typeof c === 'string') out = c
      else if (Array.isArray(c)) out = c.map((x) => (typeof x === 'string' ? x : (x && (x as { value?: string }).value) || '')).filter(Boolean).join('\n')
      else if (c && typeof c === 'object' && 'value' in (c as object)) out = String((c as { value: string }).value)
      else out = JSON.stringify(c)
      return { ok: true, content: out || '（悬停内容为空）' }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具3: lsp_diagnostics ──
const lspDiagnostics: ToolDefinition = {
  name: 'lsp_diagnostics',
  description: '获取文件的诊断信息（错误/警告，LSP publishDiagnostics）。给定文件路径，返回编译/类型检查结果（含行号与消息）。用于验证代码是否有错误，等价于 IDE 里的红线提示。需系统已安装对应语言服务器。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '源码文件路径' }
    },
    required: ['file']
  },
  category: 'read',
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const file = resolvePath(ctx, String(args.file))
      const lang = langOf(file)
      if (!lang) return { ok: false, content: '', error: `无法根据扩展名判断语言：${extname(file)}` }
      const text = await readTextFile(file)
      const client = await getClient(lang, file)
      const uri = pathToFileURL(file).href
      // 诊断为服务器异步推送，稍作等待让其到达
      await client.openDocument(uri, lang, text, 1500)
      const diags = client.getDiagnostics(uri) as Array<{ severity?: number; message?: string; range?: { start: { line: number; character: number } } }>
      if (!diags || diags.length === 0) return { ok: true, content: '该文件无诊断错误（0 错误 0 警告）。' }
      const sevLabel = ['', '错误', '警告', '信息', '提示']
      const lines = diags.map((d) => {
        const p = d.range?.start
        const pos = p ? ` ${p.line + 1}:${p.character + 1}` : ''
        return `  [${sevLabel[d.severity || 1] || d.severity}]${pos} ${d.message || ''}`
      })
      return { ok: true, content: `诊断（${diags.length} 条）：\n${lines.join('\n')}` }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具4: code_symbols（文件大纲 + 全局符号搜索） ──
const codeSymbols: ToolDefinition = {
  name: 'code_symbols',
  description: '代码符号查询，两种用法：①给定 file，列出该文件的符号结构大纲（LSP documentSymbol）：函数/类/方法/变量层级与位置，快速理解单文件组织；②给定 query（关键词），在全工作区做全局符号搜索（LSP workspace/symbol），跨文件定位某函数/类/变量的所有定义点，等价于 IDE 的"在项目中查找符号"。两者均需系统已安装对应语言服务器（C/C++: clangd，TS/JS: typescript-language-server，Python: pylsp，Go: gopls）。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '源码文件路径（与 query 二选一；指定则列出该文件大纲）' },
      query: { type: 'string', description: '符号关键词（与 file 二选一；指定则全工作区搜索该符号定义，如 "setup"、"MyClass"）' }
    },
    required: []
  },
  category: 'read',
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const query = args.query ? String(args.query) : ''
      if (query) {
        // 全局符号搜索：需要项目根确定语言服务器（用首个可定位的语言服务器配置）
        const rootFile = args.file ? resolvePath(ctx, String(args.file)) : (ctx.projectRoot || ctx.cwd)
        const lang = langOf(rootFile) || 'typescript'
        const client = await getClient(lang, rootFile)
        const res = (await client.workspaceSymbol(query)) as Array<Record<string, unknown>> | null
        if (!res || res.length === 0) return { ok: true, content: `全工作区未找到符号匹配 "${query}"。` }
        const lines = res.slice(0, 60).map((s) => {
          const name = String(s.name || '')
          const kind = String(s.kind || '')
          const loc = (s.location || s) as { uri?: string; range?: { start: { line: number; character: number } } }
          const uri = loc.uri as string | undefined
          const start = loc.range?.start
          const path = uri ? fileURLToPath(uri) : '?'
          return `  ${name} [${kind}]  ${path}:${start ? start.line + 1 : '?'}:${start ? start.character + 1 : '?'}`
        })
        return { ok: true, content: `全局符号 "${query}"（${res.length} 处，显示前 ${lines.length}）：\n${lines.join('\n')}` }
      }
      // 文件大纲模式
      const file = resolvePath(ctx, String(args.file))
      const lang = langOf(file)
      if (!lang) return { ok: false, content: '', error: `无法根据扩展名判断语言：${extname(file)}` }
      const text = await readTextFile(file)
      const client = await getClient(lang, file)
      const uri = pathToFileURL(file).href
      await client.openDocument(uri, lang, text)
      const res = (await client.documentSymbol(uri)) as Record<string, unknown>[] | null
      const out = formatSymbols(res || [], '')
      return { ok: true, content: out || '（未返回符号，可能语言服务器不支持该文件或文件为空）' }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const lspTools: ToolDefinition[] = [lspDefinition, lspReferences, lspHover, lspDiagnostics, codeSymbols]

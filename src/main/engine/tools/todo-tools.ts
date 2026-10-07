// todo 工具面（对齐 TrieCode todo 系统）
// todo_write：全量写入任务清单（模型每轮把最新 todo 状态写回，自动保持 id 稳定）
// todo_list：列出当前清单
// todo_done：勾选完成（按 id 或文本）
// 状态持久化：项目根 .codelab/todos.json（跨会话保留）
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

export interface TodoItem {
  id: string
  text: string
  done: boolean
}

const DEFAULT_TODOS: TodoItem[] = []

function todosPath(projectRoot: string | null): string | null {
  if (!projectRoot) return null
  return join(projectRoot, '.codelab', 'todos.json')
}

export function loadTodos(projectRoot: string | null): TodoItem[] {
  const p = todosPath(projectRoot)
  if (!p || !existsSync(p)) return [...DEFAULT_TODOS]
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { tasks?: TodoItem[] }
    if (!Array.isArray(raw.tasks)) return [...DEFAULT_TODOS]
    return raw.tasks.map((t) => ({ id: String(t.id || ''), text: String(t.text || ''), done: !!t.done }))
  } catch {
    return [...DEFAULT_TODOS]
  }
}

function saveTodos(projectRoot: string | null, tasks: TodoItem[]): void {
  const p = todosPath(projectRoot)
  if (!p) return
  try {
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2), 'utf-8')
  } catch (e) {
    console.warn(`[Todo] 保存失败: ${(e as Error).message}`)
  }
}

function formatTodos(tasks: TodoItem[]): string {
  if (tasks.length === 0) return '（暂无任务清单）'
  return tasks
    .map((t) => `- [${t.done ? 'x' : ' '}] ${t.id} ${t.text}`)
    .join('\n')
}

/** 供 agent-runner 注入系统提示：当前任务状态 */
export function buildTodosSection(projectRoot: string | null): string {
  const tasks = loadTodos(projectRoot)
  if (tasks.length === 0) return ''
  const done = tasks.filter((t) => t.done).length
  return `\n## 当前任务清单（todo，跨轮次跟踪，${done}/${tasks.length} 已完成）
${formatTodos(tasks)}
- 多步任务请先 todo_write 建立清单；每完成一步用 todo_done 勾选；清单变化时用 todo_write 同步最新状态。`
}

// 保持 id 稳定：按 text 匹配旧 id；新任务按 1..N 分配
function mergeStableIds(prev: TodoItem[], incoming: Array<{ id?: string; text: string; done?: boolean }>): TodoItem[] {
  const prevById = new Map(prev.map((t) => [t.id, t]))
  const prevByText = new Map(prev.map((t) => [t.text, t]))
  let seq = prev.length
  return incoming.map((raw, idx) => {
    const text = String(raw.text || '').trim()
    const id = raw.id && String(raw.id).trim() ? String(raw.id).trim() : undefined
    // 显式 id 且之前存在 → 保留
    if (id && prevById.has(id)) {
      return { id, text: text || prevById.get(id)!.text, done: raw.done !== undefined ? !!raw.done : prevById.get(id)!.done }
    }
    // 文本匹配 → 沿用旧 id 与完成态
    if (!id && prevByText.has(text)) {
      const old = prevByText.get(text)!
      return { id: old.id, text, done: raw.done !== undefined ? !!raw.done : old.done }
    }
    // 新任务 → 分配 id
    seq += 1
    return { id: id || `t${seq}`, text, done: !!raw.done }
  })
}

const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description:
    '写入/更新当前任务清单（全量覆盖）。多步任务开始时用 todo_write 建立分步清单（每步一行 text），' +
    '之后每当清单发生变化（新增步骤/完成状态变化/调整顺序）都把最新完整清单再 todo_write 一次。' +
    'id 可省略（自动按文本保持稳定）；要重置全部任务传 tasks=[]。',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'string',
        description: '任务数组的 JSON 字符串，如 [{"text":"创建项目结构","done":true},{"text":"写主程序"},{"text":"编译验证"}]；每项可带 id'
      }
    },
    required: ['tasks']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    let incoming: Array<{ id?: string; text: string; done?: boolean }> = []
    try {
      const parsed = typeof args.tasks === 'string' ? JSON.parse(args.tasks) : args.tasks
      incoming = Array.isArray(parsed) ? parsed : []
    } catch {
      return { ok: false, content: '', error: 'tasks 必须是合法 JSON 数组字符串' }
    }
    const prev = loadTodos(ctx.projectRoot)
    const merged = mergeStableIds(prev, incoming)
    saveTodos(ctx.projectRoot, merged)
    return { ok: true, content: `任务清单已更新（${merged.filter((t) => !t.done).length} 待办 / ${merged.filter((t) => t.done).length} 完成）：\n${formatTodos(merged)}` }
  }
}

const todoListTool: ToolDefinition = {
  name: 'todo_list',
  description: '列出当前任务清单（含完成状态）。需要回顾还有哪些步骤没做时调用。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'query',
  execute: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    const tasks = loadTodos(ctx.projectRoot)
    return { ok: true, content: `当前任务清单（${tasks.filter((t) => !t.done).length} 待办 / ${tasks.filter((t) => t.done).length} 完成）：\n${formatTodos(tasks)}` }
  }
}

const todoDoneTool: ToolDefinition = {
  name: 'todo_done',
  description: '把某一步任务标记为完成（按 id 或 text 匹配；id 优先）。完成任务步骤后调用，让清单保持最新。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（如 t1），来自 todo_write/todo_list 的清单' },
      text: { type: 'string', description: '任务文本（id 缺失时按文本匹配）' }
    },
    required: []
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const tasks = loadTodos(ctx.projectRoot)
    const id = String(args.id || '').trim()
    const text = String(args.text || '').trim()
    if (!id && !text) return { ok: false, content: '', error: '请提供 id 或 text' }
    const hit = tasks.find((t) => (id && t.id === id) || (!id && t.text.includes(text)))
    if (!hit) {
      return { ok: false, content: '', error: `未找到匹配任务${id ? `（id=${id}）` : `（文本含“${text}”）`}。先 todo_list 查看当前清单。` }
    }
    hit.done = true
    saveTodos(ctx.projectRoot, tasks)
    return { ok: true, content: `已完成：${hit.id} ${hit.text}\n剩余待办：${tasks.filter((t) => !t.done).map((t) => t.text).join('；') || '全部完成'}` }
  }
}

/**
 * 提交执行计划，等待用户批准后才动手。
 *
 * 这个工具的 execute 几乎不会真正跑：AgentRunner 在主循环里**先于通用工具执行**
 * 拦截 submit_plan（见 agent-runner.ts 的「计划提交」分支），把计划文本推给渲染层
 * 展示 PlanCard，等用户 approve/reject/feedback 决策后才继续。
 * 所以这里只做参数兜底，正常情况下不会走到。
 */
const submitPlanTool: ToolDefinition = {
  name: 'submit_plan',
  description:
    '提交一份执行计划，等用户批准后再动手。改动较大、步骤较多时先用它把步骤摊开给用户过目，' +
    '不要直接开干。plan 用编号列表写清每一步做什么；用户批准后你才能调用写类/执行类工具。',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: '计划正文，建议用「1. … 2. … 3. …」编号列出可执行步骤' }
    },
    required: ['plan']
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const plan = String(args.plan || '').trim()
    if (!plan) return { ok: false, content: '', error: 'plan 不能为空' }
    // 走到这里说明 AgentRunner 的拦截没生效（不该发生），如实回报而不是假装已提交
    return {
      ok: false,
      content: '',
      error: 'submit_plan 计划提交通道未生效，请直接输出计划文本给用户确认。'
    }
  }
}

export const todoTools: ToolDefinition[] = [todoWriteTool, todoListTool, todoDoneTool, submitPlanTool]

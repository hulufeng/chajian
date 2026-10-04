// 终端后台任务控制工具：读取输出 / 终止 / 列出。
// 配合 terminal 工具的 background:true 使用。命令实际由 backgroundTask 服务管理。
import { getTaskOutput, stopTask, listTasks } from '../../services/backgroundTask'
import type { ToolDefinition, ToolResult } from '../types'

// ── task_output ──
const taskOutput: ToolDefinition = {
  name: 'task_output',
  description: '读取后台任务的实时输出。给定 taskId（由 terminal background:true 返回），返回截至目前的 stdout/stderr 累积内容，并标注任务是否已结束、退出码。适合在后台编译/起服务后轮询进度。',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '后台任务 ID，如 task-1' },
      tail: { type: 'number', description: '仅返回末尾 N 个字符（输出很长时有用），默认返回全部' }
    },
    required: ['task_id']
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    const id = String(args.task_id)
    const tail = args.tail ? Number(args.tail) : undefined
    const r = getTaskOutput(id, tail)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    const status = r.done ? `已结束（退出码 ${r.exitCode}）` : '运行中'
    return {
      ok: true,
      content: `[${id}] 状态：${status}\n\n${r.content || '(暂无输出)'}`,
      data: { done: r.done, exitCode: r.exitCode }
    }
  }
}

// ── task_stop ──
const taskStop: ToolDefinition = {
  name: 'task_stop',
  description: '终止一个后台任务（SIGTERM）。给定 taskId，停止对应的后台命令。用于停止后台起的服务/监视进程。',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '要终止的后台任务 ID' }
    },
    required: ['task_id']
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const r = stopTask(String(args.task_id))
    if (!r.ok) return { ok: false, content: '', error: r.error }
    return { ok: true, content: `已请求终止任务 ${args.task_id}。` }
  }
}

// ── task_list ──
const taskList: ToolDefinition = {
  name: 'task_list',
  description: '列出当前所有后台任务（ID/命令/状态/退出码）。用于查看有哪些后台进程在跑。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  },
  category: 'read',
  execute: async (): Promise<ToolResult> => {
    const list = listTasks()
    if (list.length === 0) return { ok: true, content: '（当前无后台任务）' }
    const lines = list.map((t) => {
      const st = t.done ? `结束(码 ${t.exitCode})` : '运行中'
      return `  ${t.id}: [${st}] ${t.command}`
    })
    return { ok: true, content: `后台任务（${list.length}）：\n${lines.join('\n')}` }
  }
}

export const backgroundTaskTools: ToolDefinition[] = [taskOutput, taskStop, taskList]

// 定时任务工具：schedule_create / schedule_list / schedule_cancel
// 依赖 schedulerService（主进程常驻服务）。create/list/cancel 仅做持久化登记，
// 真正触发由 scheduler 周期性扫描后调用注入的 Agent 触发器执行 prompt。
import { schedulerService } from '../../services/scheduler'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

// ── schedule_create ──
const scheduleCreate: ToolDefinition = {
  name: 'schedule_create',
  description:
    '创建定时任务（到点自动开一个独立 Agent 会话执行 prompt，默认 auto 权限无需逐条确认）。' +
    'mode="once" 在 onceAt(ISO 时间) 触发一次，如 "2026-10-01T09:00:00"；' +
    'mode="recurring" 按 cron(5段: 分 时 日 月 周, 周0-6) 周期触发，如 "0 9 * * 1-5" 表示工作日早9点。' +
    '适合"每天早上跑测试""每周生成周报""每晚格式化代码"等。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '任务名称，便于识别' },
      mode: { type: 'string', enum: ['once', 'recurring'], description: '触发模式' },
      prompt: { type: 'string', description: '到时间时让 AI 执行的任务描述（自然语言）' },
      projectRoot: { type: 'string', description: '执行项目根目录（默认当前项目）' },
      cron: { type: 'string', description: 'recurring 模式必填：5段 cron，如 "0 9 * * 1-5"' },
      onceAt: { type: 'string', description: 'once 模式必填：ISO 时间，如 "2026-10-01T09:00:00"' }
    },
    required: ['name', 'mode', 'prompt']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const mode = String(args.mode)
    if (mode !== 'once' && mode !== 'recurring') {
      return { ok: false, content: '', error: 'mode 必须是 once 或 recurring' }
    }
    if (mode === 'recurring' && !String(args.cron || '').trim()) {
      return { ok: false, content: '', error: 'recurring 模式必须提供 cron（5段）' }
    }
    if (mode === 'once') {
      const atStr = String(args.onceAt || '').trim()
      if (!atStr) return { ok: false, content: '', error: 'once 模式必须提供 onceAt(ISO 时间)' }
      const at = new Date(atStr)
      if (isNaN(at.getTime())) return { ok: false, content: '', error: 'onceAt 不是合法 ISO 时间' }
      if (at.getTime() <= Date.now()) return { ok: false, content: '', error: 'onceAt 必须晚于当前时间' }
    }
    const sched = schedulerService.create({
      name: String(args.name),
      mode: mode,
      prompt: String(args.prompt),
      projectRoot: args.projectRoot ? String(args.projectRoot) : (ctx.projectRoot || null),
      cron: mode === 'recurring' ? String(args.cron) : undefined,
      onceAt: mode === 'once' ? String(args.onceAt) : undefined
    })
    const when = sched.mode === 'recurring' ? `cron: ${sched.cron}` : `触发时间: ${sched.onceAt}`
    return {
      ok: true,
      content: `已创建定时任务 ${sched.id}：\n- 名称：${sched.name}\n- 模式：${sched.mode}\n- ${when}\n- 项目：${sched.projectRoot || '(未指定)'}\n- 到点将自动执行：${sched.prompt}\n\n用 schedule_list 查看，schedule_cancel 取消。`,
      data: { id: sched.id }
    }
  }
}

// ── schedule_list ──
const scheduleList: ToolDefinition = {
  name: 'schedule_list',
  description: '列出所有定时任务（含 id / 名称 / 模式 / 触发时间 / 是否启用 / 最近运行结果）。用返回的 id 配合 schedule_cancel 取消。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read',
  execute: async (): Promise<ToolResult> => {
    const list = schedulerService.list()
    if (list.length === 0) return { ok: true, content: '（当前没有定时任务。用 schedule_create 创建一个。）' }
    const lines = list.map((s) => {
      const when = s.mode === 'recurring' ? `cron ${s.cron}` : s.fired ? '已触发(完成)' : `于 ${s.onceAt}`
      const last = s.lastRunAt ? `，最近运行 ${s.lastRunAt}` : ''
      const res = s.lastResult ? `，结果: ${s.lastResult.slice(0, 120)}` : ''
      return `- [${s.enabled ? '启用' : '停用'}] ${s.id}：${s.name}（${s.mode}，${when}${last}${res}）`
    })
    return { ok: true, content: `定时任务（${list.length}）：\n${lines.join('\n')}` }
  }
}

// ── schedule_cancel ──
const scheduleCancel: ToolDefinition = {
  name: 'schedule_cancel',
  description: '取消/删除一个定时任务（按 schedule_list 给出的 id）。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '要取消的定时任务 id' } },
    required: ['id']
  },
  category: 'write',
  execute: async (args): Promise<ToolResult> => {
    const ok = schedulerService.cancel(String(args.id))
    if (!ok) return { ok: false, content: '', error: `未找到定时任务 ${args.id}` }
    return { ok: true, content: `已取消定时任务 ${args.id}。` }
  }
}

export const scheduleTools: ToolDefinition[] = [scheduleCreate, scheduleList, scheduleCancel]

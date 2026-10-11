/**
 * 子智能体派发工具（#11）：把子任务派发给注册中心的子智能体。
 * list_subagents 让主 agent 先看清有哪些可用；dispatch_subagent 在独立上下文、白名单受限下运行。
 */
import type { ToolDefinition, ToolResult, ToolContext } from '../types'
import { runSubAgent } from '../subagent'
import { getSubAgent, listSubAgents, resolveSubAgent } from '../subagentRegistry'
import { ROLE_TOOLS, type AgentRole } from '../orchestrator'

const listTool: ToolDefinition = {
  name: 'list_subagents',
  description:
    '列出子智能体注册中心里所有可派发的子智能体（id / 名称 / 描述 / 角色 / 工具数）。派发子任务前先调用本工具选定目标，再把 id 传给 dispatch_subagent。',
  category: 'read',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<ToolResult> => {
    try {
      const list = listSubAgents().map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        role: d.role ?? null,
        tools: d.allowTools?.length ?? (d.role && d.role !== 'custom' ? (ROLE_TOOLS[d.role] || []).length : 0)
      }))
      return { ok: true, content: JSON.stringify(list, null, 2) }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

const dispatchTool: ToolDefinition = {
  name: 'dispatch_subagent',
  description:
    '把一个子任务派发给注册中心里的某个子智能体（先 list_subagents 选 id）。子智能体在独立上下文运行、工具白名单受限、无主 agent 的写权限，返回其结论文本/工具调用/被拦截项。适合把研究/验证/审查/编码等子任务隔离出去并发执行。',
  category: 'execute',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '子智能体 id（来自 list_subagents）' },
      task: { type: 'string', description: '派给该子智能体的任务描述（首条 user 消息）' },
      maxTurns: { type: 'number', description: '最大轮次，默认 10' },
      writeScope: { type: 'array', items: { type: 'string' }, description: '可选，覆盖该次派发的允许写文件范围（相对工程根）' }
    },
    required: ['id', 'task']
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const id = String(args.id || '')
    const def = getSubAgent(id)
    if (!def) {
      return { ok: false, content: '', error: `未注册子智能体 ${id}（先调用 list_subagents 看可用列表）` }
    }
    const overrideScope = Array.isArray(args.writeScope) ? (args.writeScope as string[]) : def.writeScope
    const { system, allowTools } = resolveSubAgent({ ...def, writeScope: overrideScope })
    try {
      const r = await runSubAgent({
        system,
        task: String(args.task || ''),
        allowTools,
        ctx: { projectRoot: ctx.projectRoot, cwd: ctx.cwd || (ctx.projectRoot ?? ''), onOutput: ctx.onOutput },
        maxTurns: Number(args.maxTurns) || def.maxTurns || 10
      })
      return {
        ok: r.ok,
        content: JSON.stringify(
          { text: r.text, turns: r.turns, calls: r.calls, blocked: r.blocked, error: r.error },
          null,
          2
        )
      }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const subagentDispatchTools: ToolDefinition[] = [listTool, dispatchTool]

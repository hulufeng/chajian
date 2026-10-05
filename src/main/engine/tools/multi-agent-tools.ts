// 多智能体编排工具（协调者视角）
//
// 主 agent 面对大任务时不再一口气自己干，而是：拆成任务 → 交给编排器并行执行 → 汇总。
// 关键约束写进工具描述，让模型自己就会分配写范围（编排器据此避免并发写冲突）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition, ToolResult } from '../types'
import { runTasks, detectConflicts, layerize, ROLE_TOOLS, type AgentTaskSpec } from '../orchestrator'
import { formatReport } from './orchestratorFormat'

const ROLES = ['research', 'code', 'review', 'verify', 'custom'] as const

export function normalizeAgentTasks(raw: unknown, root = ""): { tasks: AgentTaskSpec[]; warnings: string[] } {
  const warnings: string[] = []
  const list = Array.isArray(raw) ? raw : []
  const tasks: AgentTaskSpec[] = []
  const seen = new Set<string>()
  list.forEach((t, i) => {
    const o = (t || {}) as Record<string, unknown>
    const id = String(o.id || `t${i + 1}`).trim()
    const title = String(o.title || o.id || `任务 ${i + 1}`).trim()
    const task = String(o.task || o.description || o.title || '').trim()
    if (!task) {
      warnings.push(`任务 ${id} 缺少描述（task 字段），已跳过`)
      return
    }
    if (seen.has(id)) {
      warnings.push(`任务 id 重复：${id}，已重命名为 ${id}-2`)
    }
    const finalId = seen.has(id) ? `${id}-2` : id
    seen.add(finalId)
    const roleRaw = String(o.role || 'research')
    const role = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as AgentTaskSpec['role']) : 'research'
    if (role !== roleRaw) warnings.push(`任务 ${finalId} 的 role「${roleRaw}」不认识，按 research 处理`)
    // 写范围必须是工程内的相对路径：绝对路径/越界路径直接丢弃，防止模型写到工程外
    const writeScope = (Array.isArray(o.writeScope) ? o.writeScope : [])
      .map((w) => String(w).replace(/\\/g, '/').trim())
      .filter((w) => {
        if (!w) return false
        if (w.startsWith('/') || /^[A-Za-z]:/.test(w)) {
          warnings.push(`写范围 ${w} 是绝对路径，已忽略（只允许工程内相对路径）`)
          return false
        }
        if (w.includes('..')) {
          warnings.push(`写范围 ${w} 含 ..，已忽略（不允许越出工程）`)
          return false
        }
        return true
      })
    if (!writeScope.length && role === 'code') {
      warnings.push(`任务 ${finalId} 角色是 code 但没给 writeScope，将按只读处理（避免它改到别人的文件）`)
    }
    tasks.push({
      id: finalId,
      title,
      role,
      task,
      writeScope,
      dependsOn: (Array.isArray(o.dependsOn) ? o.dependsOn : []).map((d) => String(d)),
      requireApproval: o.requireApproval === true,
      maxTurns: typeof o.maxTurns === 'number' ? o.maxTurns : undefined
    })
  })
  if (!existsSync(root)) warnings.push(`工程目录不存在：${root}`)
  return { tasks, warnings }
}

const multiAgentRun: ToolDefinition = {
  name: 'multi_agent_run',
  description:
    '把一个复杂任务拆给多个子智能体**并行**执行，并返回汇总报告（协调者模式）。\n' +
    '何时用：任务能拆成互不依赖的几块时（多文件同时改、调研+实现+评审并行）。单步任务不要用。\n' +
    '规则：\n' +
    '1. 每个任务必须写明 role：research(只读调研) / code(写代码) / review(代码评审) / verify(编译烧录验证)。\n' +
    '2. **code 角色必须给 writeScope**（它能写的文件，相对工程根）。编排器会保证写范围相交的任务不并发，' +
    '所以把文件分配清楚就能真正并行；不写 writeScope 的 code 任务会被降级为只读。\n' +
    '3. 有先后依赖时用 dependsOn（会分层，依赖失败则后继自动跳过）。\n' +
    '4. 需要人工确认的关键步骤设 requireApproval，它会挂起等你或用户放行。',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '任务列表',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id（短标识，如 t1 / ui-fix）' },
            title: { type: 'string', description: '一句话标题（看板显示）' },
            role: { type: 'string', description: 'research / code / review / verify / custom', enum: [...ROLES] },
            task: { type: 'string', description: '给该 agent 的完整任务描述（它看到的唯一上下文）' },
            writeScope: { type: 'array', description: '允许写的文件（相对工程根），仅 code 角色需要', items: { type: 'string' } },
            dependsOn: { type: 'array', description: '前置任务 id', items: { type: 'string' } },
            requireApproval: { type: 'boolean', description: '需要人工放行才执行' },
            maxTurns: { type: 'number', description: '该 agent 最多轮次，默认 10' }
          },
          required: ['id', 'task']
        }
      },
      project: { type: 'string', description: '工程根目录，默认当前工作区' },
      concurrency: { type: 'number', description: '并发上限，默认 3' },
      approvedIds: { type: 'array', description: '已放行的任务 id（用于放行审批门）', items: { type: 'string' } }
    },
    required: ['tasks']
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const root = String(args.project || '') || process.cwd()
    const { tasks, warnings } = normalizeAgentTasks(args.tasks, root)
    if (tasks.length === 0) {
      return { ok: false, content: '没有可执行的任务（每个任务至少要有 task 描述）。' }
    }

    // 先做静态检查，把问题在跑之前就说清楚
    const conflicts = detectConflicts(tasks)
    const { cyclic, dangling } = layerize(tasks)
    const pre = [
      `任务 ${tasks.length} 个：${tasks.map((t) => `${t.id}(${t.role})`).join(', ')}`,
      conflicts.length ? `写冲突 ${conflicts.length} 对（将串行）：${conflicts.map((c) => `${c.a}↔${c.b}[${c.files.join(',')}]`).join('；')}` : '无写冲突',
      cyclic.length ? `循环依赖：${cyclic.join(', ')}` : '',
      dangling.length ? `依赖缺失：${dangling.map((d) => `${d.id}→${d.missing}`).join(', ')}` : '',
      warnings.length ? `注意：${warnings.join('；')}` : ''
    ].filter(Boolean)

    const report = await runTasks(tasks, {
      projectRoot: root,
      concurrency: typeof args.concurrency === 'number' ? args.concurrency : 3,
      approvedIds: Array.isArray(args.approvedIds) ? args.approvedIds.map(String) : undefined
    })

    return {
      ok: report.ok,
      content: `${pre.join('\n')}\n\n── 执行结果 ──\n${formatReport(report)}`,
      data: report
    }
  }
}

const multiAgentPlan: ToolDefinition = {
  name: 'multi_agent_plan',
  description:
    '只做规划不执行：把任务列表按依赖分层、检测写冲突，告诉你哪些能并行、哪些必须串行。' +
    '在真正让多个 agent 动手前先跑一次，能避免「两个 agent 改同一个文件」这种返工。',
  parameters: {
    type: 'object',
    properties: {
      tasks: { type: 'array', description: '任务列表（结构同 multi_agent_run）', items: { type: 'object' } },
      project: { type: 'string', description: '工程根目录' }
    },
    required: ['tasks']
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const root = String(args.project || '') || process.cwd()
    const { tasks, warnings } = normalizeAgentTasks(args.tasks, root)
    if (!tasks.length) return { ok: false, content: '任务列表为空或缺少 task 描述。' }
    const conflicts = detectConflicts(tasks)
    const { layers, cyclic, dangling } = layerize(tasks)
    const lines = [
      `共 ${tasks.length} 个任务，可分 ${layers.length} 层执行：`,
      ...layers.map((l, i) => `  第 ${i + 1} 层（可并发 ${l.length} 个）：${l.join(', ')}`),
      '',
      conflicts.length
        ? `写冲突（这些会强制串行）：\n${conflicts.map((c) => `  ${c.a} ↔ ${c.b}：${c.files.join(', ')}`).join('\n')}`
        : '无写冲突：可以放心并行。',
      cyclic.length ? `循环依赖（无法执行）：${cyclic.join(', ')}` : '',
      dangling.length ? `依赖缺失：${dangling.map((d) => `${d.id} → ${d.missing}`).join(', ')}` : '',
      warnings.length ? `\n注意：\n${warnings.map((w) => `  - ${w}`).join('\n')}` : '',
      '',
      '各角色可用工具：',
      ...(Object.keys(ROLE_TOOLS) as Array<keyof typeof ROLE_TOOLS>).map(
        (r) => `  ${r}：${ROLE_TOOLS[r].length} 个工具（${ROLE_TOOLS[r].slice(0, 6).join(', ')}…）`
      )
    ].filter(Boolean)
    return { ok: cyclic.length === 0 && dangling.length === 0, content: lines.join('\n') }
  }
}

export const multiAgentTools: ToolDefinition[] = [multiAgentRun, multiAgentPlan]

/** 供 UI 复用：工程默认根目录下的建议任务模板 */
export function suggestTaskShape(root: string): string {
  return JSON.stringify(
    [
      { id: 't1', title: '摸清现状', role: 'research', task: '读代码搞清楚当前实现与问题点，给出文件:行号 依据' },
      {
        id: 't2',
        title: '实现修改',
        role: 'code',
        task: '按 t1 的结论实现修改，只改指定文件',
        writeScope: ['src/example.ts'],
        dependsOn: ['t1']
      },
      {
        id: 't3',
        title: '验证',
        role: 'verify',
        task: '编译并在真机/模拟上验证改动',
        dependsOn: ['t2']
      }
    ],
    null,
    2
  ) + `\n// 工程根：${join(root)}`
}

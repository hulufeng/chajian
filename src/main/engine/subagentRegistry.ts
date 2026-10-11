/**
 * 子智能体注册中心（#11 对标 remoteCodingAgents，MIT，可借鉴架构）。
 *
 * 现状：runSubAgent / orchestrator 已能跑子智能体，但角色是硬编码的。
 * 本中心把"可被主 agent 动态发现并派发的子智能体"集中注册：
 *  - 内置预注册 verify / research / review / code（对齐 orchestrator 的 ROLE_TOOLS 与 subagentPrompts）
 *  - 插件可在 load() 里通过 ctx.registerSubAgent(def) 运行时注册自己的子智能体（动态可用）
 *  - 主 agent 通过 list_subagents / dispatch_subagent 两个工具发现并派发
 */
import { buildSubAgentPrompt } from './subagentPrompts'
import { ROLE_TOOLS, type AgentRole } from './orchestrator'

export interface SubAgentDef {
  id: string
  name: string
  description: string
  /** 角色：用于推导 system 提示与工具白名单（对齐 ROLE_TOOLS）。与 allowTools 二选一，allowTools 优先 */
  role?: AgentRole
  /** 工具白名单（显式给出则覆盖 role 推导） */
  allowTools?: string[]
  /** 自定义系统提示（显式给出则覆盖 role 生成） */
  system?: string
  /** 允许写的文件范围（仅用于提示，调度层负责不并发） */
  writeScope?: string[]
  maxTurns?: number
}

const registry = new Map<string, SubAgentDef>()

export function registerSubAgent(def: SubAgentDef): void {
  if (!def || !def.id) throw new Error('registerSubAgent 需要非空的 id')
  registry.set(def.id, def)
}

export function unregisterSubAgent(id: string): boolean {
  return registry.delete(id)
}

export function getSubAgent(id: string): SubAgentDef | undefined {
  return registry.get(id)
}

export function hasSubAgent(id: string): boolean {
  return registry.has(id)
}

export function listSubAgents(): SubAgentDef[] {
  return [...registry.values()]
}

/** 把注册定义解析成 runSubAgent 所需的 { system, allowTools } */
export function resolveSubAgent(def: SubAgentDef): { system: string; allowTools: string[] } {
  const allowTools =
    def.allowTools && def.allowTools.length
      ? def.allowTools
      : def.role
        ? ROLE_TOOLS[def.role] || []
        : []
  const system = def.system ?? (def.role ? buildSubAgentPrompt(def.role, def.writeScope || []) : '')
  return { system, allowTools }
}

// ── 内置子智能体（启动即注册，对齐 orchestrator 角色） ──
registerSubAgent({
  id: 'sa-verify',
  name: '验证子智能体',
  description: '只读/可跑命令验证：编译、烧录、读串口、读寄存器，用事实说话，不凭阅读下结论',
  role: 'verify'
})
registerSubAgent({
  id: 'sa-research',
  name: '研究子智能体',
  description: '读代码、查文档、查寄存器定义，给出有依据的结论，禁止改代码',
  role: 'research'
})
registerSubAgent({
  id: 'sa-review',
  name: '审查子智能体',
  description: '审查改动的正确性、边界情况与潜在回归，按严重程度排序',
  role: 'review'
})
registerSubAgent({
  id: 'sa-code',
  name: '编码子智能体',
  description: '按任务描述实现代码；受 writeScope 约束，只改分配到的文件',
  role: 'code'
})

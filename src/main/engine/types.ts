// Agent 引擎类型定义

export type ToolCategory = 'read' | 'write' | 'execute' | 'query'

export interface ToolParameter {
  type: string
  description: string
  enum?: string[]
  default?: unknown
  /** 数组/对象类型的子结构（多 agent 任务列表这类参数需要） */
  items?: {
    type?: string
    description?: string
    properties?: Record<string, ToolParameter>
    required?: string[]
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required: string[]
  }
  category: ToolCategory
  /** 并发安全（对齐 TrieCode concurrencySafe）：为 true 时，同轮多个 read/query 类工具可以并行执行；
   *  不声明或为 false 时，必须串行排队，避免读-写/写-写竞争（如 terminal/read_file/write_file/confirm/ask_user 都不能并发）。
   *  未声明时的默认值由 category 推导：read/query → 可并发，其余 → 串行（见 agent-runner 的 isConcurrencySafe）。
   *  本字段只用于**否决**默认推导：不想并发的只读工具显式写 `concurrencySafe: false`。 */
  concurrencySafe?: boolean
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  projectRoot: string | null
  cwd: string
  onOutput?: (chunk: string) => void
}

export interface ToolResult {
  ok: boolean
  content: string
  error?: string
  data?: unknown
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentStatus = 'idle' | 'thinking' | 'tool_calling' | 'need_confirm' | 'done' | 'error' | 'stopped'

export type SecurityMode = 'auto' | 'default' | 'plan'

export interface ConfirmRequest {
  toolCallId: string
  toolName: string
  toolCategory: ToolCategory
  arguments: Record<string, unknown>
  description: string
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'need_confirm' | 'done' | 'error' | 'status' | 'stats'
  timestamp: number
  data?: unknown
}

export interface AgentStats {
  turns: number
  toolCalls: number
  startTime: number
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  /** 工具执行累计耗时（ms）。由 tool-registry 的 post 中间件累加。 */
  toolMs?: number
  /** 最慢的若干次工具调用（{name, ms}，按耗时降序）。用于「哪一步卡住了」的排查。 */
  slowestTools?: Array<{ name: string; ms: number }>
}

export interface AgentRunOptions {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  model?: string
  localModel?: string
  securityMode?: SecurityMode
  thinkingLevel?: 'light' | 'standard' | 'deep'
  projectRoot?: string | null
  maxTurns?: number
  debugMode?: boolean
}

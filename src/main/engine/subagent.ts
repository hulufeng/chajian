/**
 * 子智能体通用运行器（对齐 TrieCode task / Neural Inverse checksAgent 的职责分离）
 *
 * 把「内层工具循环」抽出来复用：research（只读研究）、verify（只读验证，跑命令但不改文件）、
 * closed_loop（可写闭环：build→flash→观察→诊断→修）都用它。
 *
 * 安全要点：子智能体的工具调用**直接走 tool.execute，绕过主 agent 的权限确认管道**，
 * 因此白名单是唯一的闸门——必须在 allowTools 里显式列出，且写类工具只给需要它的角色。
 */
import { aiChatStream, getAiState } from '../services/aiGateway'
import { toolRegistry } from './tool-registry'
import type { ToolContext, ToolResult } from './types'

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

export interface SubAgentOptions {
  /** 子智能体系统提示（角色 + 规则 + 输出格式） */
  system: string
  /** 任务描述（作为首条 user 消息） */
  task: string
  /** 允许调用的工具白名单（工具名） */
  allowTools: string[]
  /** 工具执行上下文（projectRoot/cwd/onOutput） */
  ctx: ToolContext
  /** 最大轮次，默认 10 */
  maxTurns?: number
  /** 单条工具结果截断字符数，默认 12000 */
  maxToolResultChars?: number
  /** 观测回调：每次工具调用后触发（用于日志与结果聚合） */
  onToolCall?: (name: string, args: Record<string, unknown>, result: ToolResult) => void
  /** 是否把子智能体的过程文本透传给 UI（默认 false，避免刷屏） */
  onText?: (text: string) => void
  /** 提前停止：每批工具执行后调用，返回 true 则中止内循环（用于迭代上限护栏） */
  shouldStop?: (calls: Array<{ name: string; ok: boolean }>) => boolean
}

export interface SubAgentResult {
  ok: boolean
  /** 子智能体最终文本结论 */
  text: string
  turns: number
  /** 实际发生的工具调用（名称 + 是否成功） */
  calls: Array<{ name: string; ok: boolean }>
  /** 因白名单被拒绝的越权调用（安全审计用） */
  blocked: string[]
  error?: string
}

function callOnce(messages: ChatMsg[], tools: unknown[]): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: string }> }> {
  return new Promise((resolve, reject) => {
    let content = ''
    const buf: Array<{ id: string; name: string; args: string }> = []
    let idx = -1
    const model = getAiState().modelId || 'deepseek-flash'
    aiChatStream(
      messages as Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
      model,
      tools as never,
      (chunk) => {
        if (chunk.type === 'content') content += chunk.text
        else if (chunk.type === 'tool_call_start') {
          idx++
          buf[idx] = { id: chunk.id || `sub_${Date.now()}_${idx}`, name: chunk.name || '', args: '' }
        } else if (chunk.type === 'tool_call_args' && idx >= 0) {
          buf[idx].args += chunk.text
        }
      },
      (err) => {
        if (err) reject(err)
        else resolve({ content, toolCalls: buf.filter((t) => t.name) })
      }
    )
  })
}

/** 过滤出白名单内的工具 schema。 */
export function subAgentSchemas(allowTools: string[]): ReturnType<typeof toolRegistry.toFunctionSchemas> {
  const set = new Set(allowTools)
  return toolRegistry.toFunctionSchemas().filter((s) => set.has(s.function.name))
}

export async function runSubAgent(opts: SubAgentOptions): Promise<SubAgentResult> {
  const maxTurns = opts.maxTurns ?? 10
  const maxChars = opts.maxToolResultChars ?? 12000
  const schemas = subAgentSchemas(opts.allowTools)
  if (schemas.length === 0) {
    return { ok: false, text: '', turns: 0, calls: [], blocked: [], error: '白名单工具未就绪，无法启动子智能体' }
  }

  const messages: ChatMsg[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.task }
  ]
  const calls: Array<{ name: string; ok: boolean }> = []
  const blocked: string[] = []
  let text = ''
  let halted = false

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const r = await callOnce(messages, schemas)
      if (opts.onText && r.content) opts.onText(r.content)

      if (r.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: r.content,
          tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } }))
        })
        for (const tc of r.toolCalls) {
          const tool = toolRegistry.get(tc.name)
          let out: ToolResult
          if (!tool || !opts.allowTools.includes(tc.name)) {
            blocked.push(tc.name)
            out = {
              ok: false,
              content: '',
              error: `子智能体无权限调用 ${tc.name}（本角色白名单：${opts.allowTools.join(', ')}）。请改用白名单内工具，或把该操作交回主 agent。`
            }
          } else {
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(tc.args || '{}')
            } catch {
              parsed = {}
            }
            out = await tool.execute(parsed, opts.ctx)
            calls.push({ name: tc.name, ok: out.ok })
            opts.onToolCall?.(tc.name, parsed, out)
          }
          const toolContent = out.error ? `Error: ${out.error}` : out.content
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: String(toolContent || '(无输出)').slice(0, maxChars) })
        }
        if (opts.shouldStop?.(calls)) {
          halted = true
          break
        }
        continue
      }

      text = r.content
      break
    }
  } catch (e) {
    return { ok: false, text, turns: calls.length, calls, blocked, error: (e as Error).message }
  }

  if (halted && !text) text = '（已达迭代上限，子智能体被提前中止）'
  return { ok: true, text: text.trim(), turns: calls.length, calls, blocked }
}

/**
 * 单轮纯文本模型调用（无工具）。用于需要「按证据做判断」的判定环节
 * （如闭环里拿串口实际输出判断是否满足通过标准）——判定依据由调用方提供，
 * 不给模型自由发挥空间，避免凭空下结论。
 */
export async function askModelOnce(system: string, user: string): Promise<string> {
  const messages: ChatMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
  try {
    const r = await callOnce(messages, [])
    return r.content.trim()
  } catch (e) {
    return ''
  }
}

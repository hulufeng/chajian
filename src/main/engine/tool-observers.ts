// 工具执行观测中间件：耗时统计 + 审计日志 + 慢工具预警。
//
// 为什么有这些：AgentStats 此前只有轮数/工具数/token，完全看不出「哪一步卡住了」——
// 一次 run 里 compile 花了 8 秒还是 80 秒，从界面上完全看不出来的，
// 而这恰恰是排查「Agent 为什么慢」的第一现场。
//
// 为什么走中间件：这几个关注点对**所有**工具都适用（耗时、失败审计、慢操作提示），
// 塞进 agent-runner 或每个工具里都会重复 N 遍；管道本来就是为此设计的扩展点。
//
// 接线即生效：agent-runner 的 runToolWithRecovery 调的是 toolRegistry.execute()，
// 不经过管道的话这些中间件就是死代码（此前正是如此）。
import type { PostMiddleware, AroundMiddleware, PipelineContext } from './tool-registry'
import type { ToolResult } from './types'

/** 慢工具阈值（ms）：超过则记入 slowestTools 并在日志里点名 */
const SLOW_TOOL_MS = 3000
/** slowestTools 保留条数 */
const SLOWEST_KEEP = 5
/** 审计日志里参数截断长度：避免把整份文件内容写进日志 */
const AUDIT_ARG_CHARS = 200

/** 本次会话的工具耗时累计（每次 run 由 agent-runner 重置） */
export interface ToolTiming {
  toolMs: number
  slowest: Array<{ name: string; ms: number }>
}

export function newToolTiming(): ToolTiming {
  return { toolMs: 0, slowest: [] }
}

/** 记录一次工具耗时并返回更新后的累计值 */
function recordTiming(timing: ToolTiming, name: string, ms: number): void {
  timing.toolMs += ms
  timing.slowest.push({ name, ms })
  timing.slowest.sort((a, b) => b.ms - a.ms)
  if (timing.slowest.length > SLOWEST_KEEP) timing.slowest.length = SLOWEST_KEEP
}

/**
 * post 中间件：耗时统计 + 审计日志。
 *
 * 失败的工具额外打 warn，便于事后从日志还原「Agent 在哪一步反复失败」。
 * 审计日志刻意不吞异常，也不参与决策（观测不该影响行为）。
 */
export function makeTimingAuditMiddleware(getTiming: () => ToolTiming): PostMiddleware & { name: string } {
  const mw = async (ctx: PipelineContext, result: ToolResult) => {
    // around 中间件可能已把开始时间挂上；没有则说明没经过 around，退化为不计时
    const startedAt = (ctx as PipelineContext & { __startedAt?: number }).__startedAt
    if (startedAt !== undefined) {
      const ms = Date.now() - startedAt
      recordTiming(getTiming(), ctx.toolName, ms)
      if (ms >= SLOW_TOOL_MS) {
        console.warn(`[tool] 慢操作 ${ctx.toolName} 耗时 ${ms}ms`)
      }
    }

    if (result?.ok === false) {
      const args = JSON.stringify(ctx.args ?? {}).slice(0, AUDIT_ARG_CHARS)
      console.warn(`[tool] 失败 ${ctx.toolName} args=${args} error=${String(result.error || '').slice(0, 300)}`)
    }
  }
  // name 用于幂等注册：toolRegistry 是单例，多 Agent 实例会各自 new 一次 AgentRunner
  // 注意：箭头函数的 .name 在严格模式下只读，直接赋值会抛 TypeError，用 defineProperty 兜底
  try { Object.defineProperty(mw, 'name', { value: 'timing-audit', configurable: true }) } catch { /* ignore */ }
  return mw
}

/**
 * around 中间件：给 post 中间件打上开始时间戳，并给慢操作一条可见的输出。
 *
 * 「让耗时看得见」不能只写进 stats——用户看到的是聊天流，
 * 所以慢工具通过 ctx.onOutput 推一条耗时，让等待有反馈。
 */
export function makeSlowToolMiddleware(onSlow?: (name: string, ms: number) => void): AroundMiddleware & { name: string } {
  const mw = async (ctx: PipelineContext, next: () => Promise<ToolResult>): Promise<ToolResult> => {
    const startedAt = Date.now()
    // 挂在 ctx 上传给 post（PipelineContext 是接口，这里用扩展字段）
    ;(ctx as PipelineContext & { __startedAt?: number }).__startedAt = startedAt
    const result = await next()
    const ms = Date.now() - startedAt
    if (ms >= SLOW_TOOL_MS) {
      ctx.ctx.onOutput?.(`[${ctx.toolName}] 执行 ${(ms / 1000).toFixed(1)}s`)
      onSlow?.(ctx.toolName, ms)
    }
    return result
  }
  try { Object.defineProperty(mw, 'name', { value: 'slow-tool', configurable: true }) } catch { /* ignore */ }
  return mw
}
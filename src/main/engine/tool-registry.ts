// 工具注册中心 + 执行管道（pre/around/post 三层中间件）
// 对齐 TrieCode ToolPipeline：权限判定(pre) → 外部钩子(around) → 真实执行(core) → 观测(post)
import type { ToolDefinition, ToolResult, ToolContext } from './types'

// 管道上下文
export interface PipelineContext {
  toolName: string
  args: Record<string, unknown>
  ctx: ToolContext
  // pre 中间件可修改
  modifiedArgs?: Record<string, unknown>
  // 决策结果
  decision?: 'allow' | 'reject' | 'confirm'
  rejectReason?: string
}

// 管道结果
export interface PipelineResult {
  result: ToolResult
  // around 中间件可标记已处理（跳过 core 执行）
  handled?: boolean
}

// pre 中间件：执行前判定，可拒绝/改参
export type PreMiddleware = (ctx: PipelineContext) => Promise<void> | void

// around 中间件：包裹执行，返回 handled=true 则跳过 core
export type AroundMiddleware = (
  ctx: PipelineContext,
  next: () => Promise<ToolResult>
) => Promise<ToolResult>

// post 中间件：执行后观测
export type PostMiddleware = (ctx: PipelineContext, result: ToolResult) => Promise<void> | void

/** 带 name 的中间件：用于幂等注册（多 Agent 实例共享同一个 toolRegistry 单例） */
export type NamedMiddleware<T> = T & { name?: string }

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private preMiddlewares: PreMiddleware[] = []
  private aroundMiddlewares: AroundMiddleware[] = []
  private postMiddlewares: PostMiddleware[] = []

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[engine] 工具 ${tool.name} 已存在，覆盖`)
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  // ── 管道中间件注册 ──
  usePre(mw: PreMiddleware): void {
    this.preMiddlewares.push(mw)
  }

  useAround(mw: AroundMiddleware): void {
    this.aroundMiddlewares.push(mw)
  }

  usePost(mw: PostMiddleware): void {
    this.postMiddlewares.push(mw)
  }

  clearMiddlewares(): void {
    this.preMiddlewares = []
    this.aroundMiddlewares = []
    this.postMiddlewares = []
  }

  /** 按名字判断是否已注册同名中间件，避免多实例重复注册导致统计翻倍 */
  hasPostMiddleware(name: string): boolean {
    return this.postMiddlewares.some((m) => m.name === name)
  }

  hasPreMiddleware(name: string): boolean {
    return this.preMiddlewares.some((m) => m.name === name)
  }

  hasAroundMiddleware(name: string): boolean {
    return this.aroundMiddlewares.some((m) => m.name === name)
  }

  // 转换为 OpenAI function calling 格式
  toFunctionSchemas(): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))
  }

  // 执行工具（经管道）
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, content: '', error: `未知工具: ${name}` }
    }

    const pipelineCtx: PipelineContext = {
      toolName: name,
      args: { ...args },
      ctx,
      decision: 'allow'
    }

    // ── 第一层：pre 中间件（权限判定/参数修改）──
    for (const mw of this.preMiddlewares) {
      try {
        await mw(pipelineCtx)
      } catch (e) {
        console.warn(`[pipeline] pre 中间件异常: ${(e as Error).message}`)
      }
      if (pipelineCtx.decision === 'reject') {
        return { ok: false, content: '', error: pipelineCtx.rejectReason || '操作被策略拒绝' }
      }
    }

    // 使用可能被修改的参数
    const effectiveArgs = pipelineCtx.modifiedArgs || pipelineCtx.args

    // ── 第二层：around 中间件（外部钩子/包裹执行）──
    // 构建 next 链：从最后一个 around 开始，逐层包裹 core
    const coreExecute = async (): Promise<ToolResult> => {
      try {
        return await tool.execute(effectiveArgs, ctx)
      } catch (e) {
        return { ok: false, content: '', error: `工具执行异常: ${(e as Error).message}` }
      }
    }

    let current = coreExecute
    for (let i = this.aroundMiddlewares.length - 1; i >= 0; i--) {
      const mw = this.aroundMiddlewares[i]
      const next = current
      current = async () => {
        try {
          return await mw({ ...pipelineCtx, args: effectiveArgs }, next)
        } catch (e) {
          console.warn(`[pipeline] around 中间件异常: ${(e as Error).message}`)
          return next()
        }
      }
    }

    const result = await current()

    // ── 第三层：post 中间件（观测/审计）──
    for (const mw of this.postMiddlewares) {
      try {
        await mw({ ...pipelineCtx, args: effectiveArgs }, result)
      } catch (e) {
        console.warn(`[pipeline] post 中间件异常: ${(e as Error).message}`)
      }
    }

    return result
  }
}

export const toolRegistry = new ToolRegistry()

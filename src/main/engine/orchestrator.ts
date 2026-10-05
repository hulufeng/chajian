// 多智能体编排内核（第四批⑤ 方向：协调者 + 并行 worker）
//
// 要解决的真问题：并行 agent 同时写文件会互相把对方的改动判成「外部修改」而拒绝
// （tools/index.ts 的 aiFileBaselines 是模块级单例）。两种解法：
//   A. 给写工具加文件所有权锁（改工具层，侵入大、容易漏）
//   B. **在调度层就不让它们同时写**（本实现）—— 写范围相交的任务强制串行。
// B 的好处：工具层零改动，冲突面收敛在编排这一处，而且冲突对用户可见、可审计。
//
// 流程：任务分解（由主 agent 或 UI 给）→ 拓扑分层 → 层内并行（冲突组串行 + 全局限流）
//      → 逐层汇总 → 产出报告。审批门（requireApproval）默认挂起，批准后才执行。

export type AgentRole = 'research' | 'code' | 'review' | 'verify' | 'custom'

export interface AgentTaskSpec {
  id: string
  title: string
  role: AgentRole
  /** 给该 agent 的任务描述（首条 user 消息） */
  task: string
  /** 允许写的文件（相对工程根）。缺省或空数组 = 只读任务 */
  writeScope?: string[]
  dependsOn?: string[]
  /** 需要人工放行才执行（审批门） */
  requireApproval?: boolean
  maxTurns?: number
}

export type TaskStatus =
  | 'pending'
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked'

export interface AgentTaskRun {
  spec: AgentTaskSpec
  status: TaskStatus
  /** 执行该任务的 agent 标识（并发时用于区分日志） */
  agentId: string
  startedAt?: number
  endedAt?: number
  elapsedMs?: number
  /** agent 的结论（截断后） */
  summary?: string
  error?: string
  toolCalls: Array<{ name: string; ok: boolean }>
  blockedTools: string[]
  /** 因依赖失败而被跳过 */
  skipReason?: string
}

export interface ConflictPair {
  a: string
  b: string
  files: string[]
  /** 冲突处理方式：串行化（不并发） */
  resolution: 'serialize'
}

export interface OrchestrationReport {
  runId: string
  startedAt: number
  endedAt: number
  elapsedMs: number
  ok: boolean
  tasks: AgentTaskRun[]
  /** 拓扑分层（每层内可并行） */
  layers: string[][]
  conflicts: ConflictPair[]
  /** 人读汇总 */
  summary: string
}

export interface RunOptions {
  projectRoot: string
  /** 已放行的任务 id（审批门） */
  approvedIds?: string[]
  /** 全局并发上限，默认 3 */
  concurrency?: number
  /** 事件回调（任务状态变化时触发，UI 实时刷新用） */
  onEvent?: (run: AgentTaskRun[]) => void
  /** 注入执行器（测试用；默认走 runSubAgent） */
  executor?: TaskExecutor
}

export interface TaskExecutionResult {
  ok: boolean
  text: string
  turns: number
  calls: Array<{ name: string; ok: boolean }>
  blocked: string[]
  error?: string
}

export type TaskExecutor = (
  spec: AgentTaskSpec,
  ctx: { projectRoot: string; agentId: string; onOutput?: (chunk: string) => void }
) => Promise<TaskExecutionResult>

// ────────────────────── 角色 → 工具白名单 ──────────────────────

/** 只读类工具（任何角色都可安全给） */
const READ_TOOLS = [
  'list_files',
  'read_file',
  'search_content',
  'code_symbols',
  'project_overview',
  'lsp_references',
  'lsp_definition',
  'lsp_diagnostics',
  'lsp_hover',
  'web_search',
  'web_fetch'
]

export const ROLE_TOOLS: Record<Exclude<AgentRole, 'custom'>, string[]> = {
  research: [
    ...READ_TOOLS,
    'research',
    'svd_query',
    'serial_read',
    'serial_log_tail',
    'serial_log_grep',
    'mcp_tools',
    'hardware_target'
  ],
  code: [
    ...READ_TOOLS,
    'write_file',
    'edit_file',
    'terminal',
    'run_tests',
    'compile',
    'upload',
    'checkpoint_create',
    'checkpoint_list',
    'labignore_check'
  ],
  review: [...READ_TOOLS, 'verify', 'git_status', 'git_diff', 'git_log'],
  verify: [
    'compile',
    'upload',
    'serial_monitor',
    'serial_read',
    'serial_send',
    'serial_stop',
    'serial_log_tail',
    'verify',
    'closed_loop',
    'board_detect',
    'board_list',
    'hardware_target'
  ]
}

// ────────────────────── 冲突检测 ──────────────────────

/** 两个写范围是否相交（目录前缀视为包含关系） */
function scopesIntersect(a: string[], b: string[]): string[] {
  if (!a?.length || !b?.length) return []
  const hit: string[] = []
  for (const x of a) {
    for (const y of b) {
      const nx = x.replace(/\\/g, '/').replace(/\/$/, '')
      const ny = y.replace(/\\/g, '/').replace(/\/$/, '')
      if (!nx || !ny) continue
      if (nx === ny || nx.startsWith(ny + '/') || ny.startsWith(nx + '/')) hit.push(x)
    }
  }
  return [...new Set(hit)]
}

/**
 * 找出「本可并发但写范围相交」的任务对。
 * 只在**没有依赖关系**的任务之间判冲突——有依赖的本来就串行，不算冲突。
 */
export function detectConflicts(tasks: AgentTaskSpec[]): ConflictPair[] {
  const out: ConflictPair[] = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      const depAB = (b.dependsOn || []).includes(a.id)
      const depBA = (a.dependsOn || []).includes(b.id)
      if (depAB || depBA) continue
      const files = scopesIntersect(a.writeScope || [], b.writeScope || [])
      if (files.length) out.push({ a: a.id, b: b.id, files, resolution: 'serialize' })
    }
  }
  return out
}

// ────────────────────── 拓扑分层 ──────────────────────

export interface LayerizeResult {
  layers: string[][]
  /** 循环依赖导致无法分层的任务 */
  cyclic: string[]
  /** 依赖了不存在的任务 */
  dangling: Array<{ id: string; missing: string }>
}

/** Kahn 分层：同一层内的任务互不依赖，可并发 */
export function layerize(tasks: AgentTaskSpec[]): LayerizeResult {
  const ids = new Set(tasks.map((t) => t.id))
  const dangling: Array<{ id: string; missing: string }> = []
  const deps = new Map<string, string[]>()
  for (const t of tasks) {
    const ds = (t.dependsOn || []).filter((d) => ids.has(d))
    for (const d of t.dependsOn || []) if (!ids.has(d)) dangling.push({ id: t.id, missing: d })
    deps.set(t.id, ds)
  }

  const layers: string[][] = []
  const done = new Set<string>()
  const remaining = tasks.map((t) => t.id)
  let guard = 0
  while (remaining.length && guard++ < tasks.length + 5) {
    const layer = remaining.filter((id) => (deps.get(id) || []).every((d) => done.has(d)))
    if (!layer.length) break
    layers.push(layer)
    for (const id of layer) {
      done.add(id)
      remaining.splice(remaining.indexOf(id), 1)
    }
  }
  return { layers, cyclic: remaining, dangling }
}

// ────────────────────── 调度 ──────────────────────

/** 简易信号量：限制同时运行的 agent 数 */
function makeLimiter(max: number): () => Promise<() => void> {
  let active = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    if (active >= max) return
    // 先取任务再占用名额：否则队列为空时也会把名额卡住（泄漏）
    const run = queue.shift()
    if (!run) return
    active++
    run()
  }
  return () =>
    new Promise<() => void>((resolve) => {
      queue.push(() => {
        resolve(() => {
          active--
          next()
        })
      })
      next()
    })
}

const nowMs = (): number => Date.now()

/**
 * 执行一组任务（多 agent 编排的主入口）。
 * 任何单个 agent 的失败都不会中断整批：失败任务的后继会被标记 blocked 并跳过。
 */
export async function runTasks(
  tasks: AgentTaskSpec[],
  opts: RunOptions
): Promise<OrchestrationReport> {
  const runId = `orx-${nowMs().toString(36)}`
  const startedAt = nowMs()
  const approved = new Set(opts.approvedIds || [])
  const conflicts = detectConflicts(tasks)
  const { layers, cyclic, dangling } = layerize(tasks)

  const runs = new Map<string, AgentTaskRun>()
  for (const spec of tasks) {
    runs.set(spec.id, {
      spec,
      status: 'pending',
      agentId: `${spec.role}-${spec.id}`,
      toolCalls: [],
      blockedTools: []
    })
  }
  const emit = (): void => opts.onEvent?.(Array.from(runs.values()))
  const set = (id: string, patch: Partial<AgentTaskRun>): void => {
    const cur = runs.get(id)
    if (!cur) return
    runs.set(id, { ...cur, ...patch })
    emit()
  }

  // 依赖缺失 / 循环依赖：直接判定
  for (const d of dangling) {
    set(d.id, { status: 'blocked', error: `依赖了不存在的任务：${d.missing}` })
  }
  for (const id of cyclic) {
    set(id, { status: 'blocked', error: '存在循环依赖，无法排入执行顺序' })
  }

  // 冲突分组：同组内的任务串行，不同组并发
  const groupOf = new Map<string, string>()
  conflicts.forEach((c, i) => {
    const g = `cf${i}`
    groupOf.set(c.a, g)
    groupOf.set(c.b, g)
  })
  const serialGroups = new Map<string, string[]>()
  for (const [id, g] of groupOf) {
    if (!serialGroups.has(g)) serialGroups.set(g, [])
    serialGroups.get(g)!.push(id)
  }

  const limiter = makeLimiter(Math.max(1, opts.concurrency ?? 3))
  const exec: TaskExecutor =
    opts.executor ??
    (async (spec, ctx) => {
      const { runSubAgent } = await import('./subagent')
      const { buildSubAgentPrompt } = await import('./subagentPrompts')
      const allowTools = spec.role === 'custom' ? [] : ROLE_TOOLS[spec.role] || []
      const r = await runSubAgent({
        system: buildSubAgentPrompt(spec.role, spec.writeScope || []),
        task: spec.task,
        allowTools,
        ctx: { projectRoot: ctx.projectRoot, cwd: ctx.projectRoot, onOutput: ctx.onOutput },
        maxTurns: spec.maxTurns ?? 10
      })
      return { ok: r.ok, text: r.text, turns: r.turns, calls: r.calls, blocked: r.blocked, error: r.error }
    })

  const runOne = async (spec: AgentTaskSpec): Promise<void> => {
    if (spec.requireApproval && !approved.has(spec.id)) {
      set(spec.id, { status: 'awaiting-approval' })
      return
    }
    set(spec.id, { status: 'running', startedAt: nowMs() })
    try {
      const r = await exec(spec, {
        projectRoot: opts.projectRoot,
        agentId: runs.get(spec.id)!.agentId
      })
      const end = nowMs()
      set(spec.id, {
        status: r.ok ? 'done' : 'failed',
        endedAt: end,
        elapsedMs: end - (runs.get(spec.id)!.startedAt || end),
        summary: (r.text || '').slice(0, 2000),
        error: r.error,
        toolCalls: r.calls,
        blockedTools: r.blocked
      })
    } catch (e) {
      const end = nowMs()
      set(spec.id, {
        status: 'failed',
        endedAt: end,
        elapsedMs: end - (runs.get(spec.id)!.startedAt || end),
        error: (e as Error).message
      })
    }
  }

  for (const layer of layers) {
    // 先判定本层哪些能真跑：前置失败/阻塞 → skipped；前置挂起（审批门）→ 一并挂起。
    // 必须在**调度前**判定，否则后继会在前置失败后照样跑一遍（等于白跑）。
    const runnable: string[] = []
    for (const id of layer) {
      const spec = tasks.find((t) => t.id === id)
      if (!spec) continue
      const depStatus = (d: string): TaskStatus | undefined => runs.get(d)?.status
      const badDep = (spec.dependsOn || []).find((d) => {
        const st = depStatus(d)
        return st === 'failed' || st === 'blocked' || st === 'skipped'
      })
      if (badDep) {
        set(id, {
          status: 'skipped',
          skipReason: `前置任务「${runs.get(badDep)?.spec.title || badDep}」未成功（${depStatus(badDep)}）`
        })
        continue
      }
      const heldDep = (spec.dependsOn || []).find((d) => depStatus(d) === 'awaiting-approval')
      if (heldDep) {
        set(id, { status: 'awaiting-approval' })
        continue
      }
      runnable.push(id)
    }
    if (!runnable.length) continue

    // 同层内：被冲突绑定的一组串行，其余并发
    const serialIds = new Set(runnable.filter((id) => groupOf.has(id)))
    const chains: Array<Promise<void>> = []
    for (const [, ids] of serialGroups) {
      const inLayer = ids.filter((id) => runnable.includes(id))
      if (!inLayer.length) continue
      // 冲突组内按声明顺序串行：组内第一个先跑完，第二个才开跑
      chains.push(
        inLayer.reduce<Promise<void>>(
          (acc, id) => acc.then(() => runOne(tasks.find((t) => t.id === id)!)),
          Promise.resolve()
        )
      )
    }
    // 注意 map 里必须**立即调用**异步函数：写成 `map(id => async () => …)` 会得到函数数组，
    // Promise.all 会把函数当值直接 resolve，任务一个都没跑（这个坑踩过）。
    const free = runnable.filter((id) => !serialIds.has(id)).map((id) =>
      (async () => {
        const release = await limiter()
        try {
          await runOne(tasks.find((t) => t.id === id)!)
        } finally {
          release()
        }
      })()
    )
    await Promise.all([...chains, ...free])
  }

  // 依赖失败/挂起的后继标记 skipped
  for (const spec of tasks) {
    const cur = runs.get(spec.id)!
    if (cur.status !== 'pending') continue
    for (const d of spec.dependsOn || []) {
      const dep = runs.get(d)
      if (!dep) continue
      if (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'skipped') {
        set(spec.id, { status: 'skipped', skipReason: `前置任务「${dep.spec.title}」未成功（${dep.status}）` })
        break
      }
      if (dep.status === 'awaiting-approval') {
        set(spec.id, { status: 'awaiting-approval' })
        break
      }
    }
  }

  const endedAt = nowMs()
  const list = Array.from(runs.values())
  const done = list.filter((r) => r.status === 'done').length
  const failed = list.filter((r) => r.status === 'failed' || r.status === 'blocked').length
  const waiting = list.filter((r) => r.status === 'awaiting-approval').length
  const skipped = list.filter((r) => r.status === 'skipped').length

  const summary =
    `共 ${list.length} 个任务：完成 ${done}` +
    (failed ? `、失败/阻塞 ${failed}` : '') +
    (waiting ? `、待放行 ${waiting}` : '') +
    (skipped ? `、跳过 ${skipped}` : '') +
    `；耗时 ${((endedAt - startedAt) / 1000).toFixed(1)}s` +
    (conflicts.length ? `；检测到 ${conflicts.length} 对写冲突已串行化` : '')

  return {
    runId,
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    ok: failed === 0 && waiting === 0,
    tasks: list,
    layers,
    conflicts,
    summary
  }
}

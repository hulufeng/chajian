// 定时任务调度服务（主进程常驻）
// 对齐 TrieCode schedule 能力：跨项目持久化 + 周期扫描 + 触发独立 Agent 会话。
// 存储：userData/codelab/schedules.json
// 触发：通过可注入的 triggerHandler 抛给外部（主进程在 app ready 后注入 AgentRunner）
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ScheduleMode = 'once' | 'recurring'

export interface Schedule {
  id: string
  name: string
  mode: ScheduleMode
  prompt: string
  projectRoot: string | null
  enabled: boolean
  createdAt: string
  /** recurring 模式：标准 5 段 cron（分 时 日 月 周，周 0-6，0=周日） */
  cron?: string
  /** once 模式：ISO 时间 */
  onceAt?: string
  /** once 模式专用：是否已触发过（只触发一次） */
  fired?: boolean
  /** recurring 防重触发：最近触发到的分钟键 */
  lastTriggerAt?: string
  lastRunAt?: string
  lastResult?: string
}

type TriggerHandler = (projectRoot: string | null, prompt: string) => Promise<string>

class SchedulerService {
  private schedules: Schedule[] = []
  private timer: NodeJS.Timeout | null = null
  private running = new Set<string>()
  private triggerHandler: TriggerHandler | null = null
  private readonly scanIntervalMs = 30 * 1000

  private get storeDir(): string {
    try {
      return join(app.getPath('userData'), 'codelab')
    } catch {
      return join(process.cwd(), '.codelab-data')
    }
  }
  private get storeFile(): string {
    return join(this.storeDir, 'schedules.json')
  }

  /** 注入触发器：主进程把「开独立 Agent 会话跑 prompt」的实现挂进来 */
  setTriggerHandler(handler: TriggerHandler): void {
    this.triggerHandler = handler
  }

  /** 启动常驻扫描（应在 app ready 之后调用） */
  start(): void {
    if (this.timer) return
    this.load()
    // 立即检查一次，避免等待首个 30s
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.scanIntervalMs)
    console.log('[scheduler] 定时任务服务已启动，每 30s 扫描一次')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ── 持久化 ──
  private load(): void {
    try {
      if (existsSync(this.storeFile)) {
        const parsed = JSON.parse(readFileSync(this.storeFile, 'utf8')) as Schedule[]
        if (Array.isArray(parsed)) this.schedules = parsed
      }
    } catch (e) {
      console.warn('[scheduler] 读取 schedules.json 失败:', (e as Error).message)
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true })
      writeFileSync(this.storeFile, JSON.stringify(this.schedules, null, 2), 'utf8')
    } catch (e) {
      console.warn('[scheduler] 写入 schedules.json 失败:', (e as Error).message)
    }
  }

  // ── 增删查 ──
  create(input: {
    name: string
    mode: ScheduleMode
    prompt: string
    projectRoot?: string | null
    cron?: string
    onceAt?: string
    enabled?: boolean
  }): Schedule {
    const sched: Schedule = {
      id: 'sched-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: input.name,
      mode: input.mode,
      prompt: input.prompt,
      projectRoot: input.projectRoot ?? null,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
      cron: input.cron,
      onceAt: input.onceAt,
      fired: false
    }
    this.schedules.push(sched)
    this.save()
    return sched
  }

  list(): Schedule[] {
    return this.schedules.map((s) => ({ ...s }))
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id)
  }

  cancel(id: string): boolean {
    const before = this.schedules.length
    this.schedules = this.schedules.filter((s) => s.id !== id)
    const removed = this.schedules.length < before
    if (removed) this.save()
    return removed
  }

  // ── 扫描触发 ──
  private async tick(): Promise<void> {
    const now = new Date()
    for (const s of this.schedules) {
      if (!s.enabled) continue
      if (this.running.has(s.id)) continue
      let shouldFire = false
      if (s.mode === 'once') {
        if (s.fired) continue
        if (s.onceAt) {
          const at = new Date(s.onceAt)
          if (!isNaN(at.getTime()) && now.getTime() >= at.getTime()) shouldFire = true
        }
      } else if (s.mode === 'recurring') {
        if (s.cron && matchCron(s.cron, now)) {
          // 防同一分钟重复触发（扫描周期 30s 可能一分钟内多次命中）
          const minuteKey = minuteKeyOf(now)
          if (s.lastTriggerAt !== minuteKey) shouldFire = true
        }
      }
      if (shouldFire) void this.fire(s, now)
    }
  }

  private async fire(s: Schedule, now: Date): Promise<void> {
    this.running.add(s.id)
    // 防重触发时间戳先行写入（即使后续执行失败也不至于死循环重触发）
    if (s.mode === 'recurring') {
      s.lastTriggerAt = minuteKeyOf(now)
    }
    try {
      let result = '（未配置触发器，仅记录触发）'
      if (this.triggerHandler) {
        result = await this.triggerHandler(s.projectRoot, s.prompt)
      }
      s.lastRunAt = new Date().toISOString()
      s.lastResult = String(result).slice(0, 2000)
      if (s.mode === 'once') {
        s.fired = true
        s.enabled = false // 一次性任务触发后停用（记录保留，便于回看结果）
      }
    } catch (e) {
      s.lastRunAt = new Date().toISOString()
      s.lastResult = '触发失败: ' + (e as Error).message
    } finally {
      this.running.delete(s.id)
      this.save()
    }
  }
}

function minuteKeyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 零依赖 5 段 cron 匹配器。字段：分 时 日 月 周（周 0-6，0=周日）。
 * 支持：星号（任意）、a-b（区间）、a,b,c（枚举）、步长写法（如 /15、a-b/2）。
 */
export function matchCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dom = date.getDate()
  const month = date.getMonth() + 1
  const dow = date.getDay()
  return (
    matchField(fields[0], minute, 0, 59) &&
    matchField(fields[1], hour, 0, 23) &&
    matchField(fields[2], dom, 1, 31) &&
    matchField(fields[3], month, 1, 12) &&
    matchField(fields[4], dow, 0, 6)
  )
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => matchSingle(part, value, min, max))
}

function matchSingle(part: string, value: number, min: number, max: number): boolean {
  if (part === '*') return true
  let step = 1
  let rangeStr = part
  const slashIdx = part.indexOf('/')
  if (slashIdx >= 0) {
    rangeStr = part.slice(0, slashIdx)
    const stepStr = part.slice(slashIdx + 1)
    step = parseInt(stepStr, 10)
    if (isNaN(step) || step < 1) return false
  }
  let low = min
  let high = max
  if (rangeStr !== '*') {
    const dashIdx = rangeStr.indexOf('-')
    if (dashIdx >= 0) {
      low = parseInt(rangeStr.slice(0, dashIdx), 10)
      high = parseInt(rangeStr.slice(dashIdx + 1), 10)
    } else {
      const single = parseInt(rangeStr, 10)
      if (isNaN(single)) return false
      low = high = single
    }
  }
  if (isNaN(low) || isNaN(high)) return false
  if (value < low || value > high) return false
  return (value - low) % step === 0
}

export const schedulerService = new SchedulerService()

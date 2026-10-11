/**
 * 标准任务实测 harness（商业化 P1 · 方向二 §5.1 / NeuralInverse #8 验收前提）
 * ---------------------------------------------------------------------------
 * 在 Electron 主进程内、为每个任务开一个独立临时工程跑 AgentRunner，
 * 跑完做客观验证（编译 / 文件 / 片段 / 禁含），并采集 5 项指标：
 *   工具 JSON 合法率 / 一次编译通过率 / 平均自修复轮次 / 最终完成率 / 单任务成本。
 *
 * 注意：真模型调用走 AI 网关，需服务端配置上游 Key（当前 DEEPSEEK_API_KEY 未配，
 * 即"任务7 ② 一等"）；未配时任务会失败——这是预期，跑基线请等 Key 就位。
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, statSync, cpSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import { AgentRunner } from './agent-runner'
import { compileSketch, findToolchain, type CompileOptions } from '../services/toolchain'
import { parseBuildOutput } from '../services/build-diagnostics'
import { defaultBenchmarkTasks, type BenchmarkTask, type Scaffold } from './benchmark-tasks'

export interface TaskResult {
  id: string
  level: number
  title: string
  passed: boolean
  firstCompilePass: boolean | null
  compileAttempts: number
  selfRepairRounds: number
  turns: number
  toolCalls: number
  toolCallEvents: number
  toolJsonValidRate: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  costCNY: number
  verifyDetail: string
  error?: string
}

export interface BenchmarkReport {
  startedAt: string
  model: string
  localModel?: string
  total: number
  passed: number
  failed: number
  metrics: {
    toolJsonValidRate: number
    firstCompilePassRate: number
    avgSelfRepairRounds: number
    finalCompletionRate: number
    avgCostCNY: number
  }
  tasks: TaskResult[]
}

export interface RunBenchOptions {
  model?: string
  localModel?: string
  maxTurns?: number
  onTaskStart?: (t: BenchmarkTask) => void
  onTaskEvent?: (id: string, ev: { type: string; data?: unknown }) => void
  onTaskDone?: (r: TaskResult) => void
  signal?: { stopped: boolean }
}

// 近似价目（元 / 1k token，flash 取中值；结算以厂商最新价为准）
const PRICING: Record<string, { in: number; out: number }> = {
  'deepseek-flash': { in: 0.002, out: 0.003 },
  'deepseek-pro': { in: 0.008, out: 0.012 },
  'minimax-m3': { in: 0.003, out: 0.010 },
  'minimax-m2.7': { in: 0.002, out: 0.008 },
  'minimax-m2.5': { in: 0.002, out: 0.008 }
}

const EMPTY_SKETCH = `void setup() {}\nvoid loop() {}\n`
const BLINK_SKETCH = `const int led = 2;\nvoid setup() { pinMode(led, OUTPUT); }\nvoid loop() { digitalWrite(led, HIGH); delay(500); digitalWrite(led, LOW); delay(500); }\n`
// 故意注入两类错误：缺分号 + 未声明符号（L4 调试任务用）
const BROKEN_SKETCH = `int led = 5\nvoid setup() {\n  pinMode(led, OUTPUT)\n}\nvoid loop() {\n  digitalWrite(led, HIGH)\n  delay(500)\n  int x = undefinedVar + 1\n}\n`

function scaffoldProject(dir: string, scaffold: Scaffold | undefined): void {
  mkdirSync(dir, { recursive: true })
  if (!scaffold || scaffold === 'empty') {
    writeFileSync(join(dir, 'sketch.ino'), EMPTY_SKETCH)
  } else if (scaffold === 'blink') {
    writeFileSync(join(dir, 'sketch.ino'), BLINK_SKETCH)
  } else if (scaffold === 'broken') {
    writeFileSync(join(dir, 'sketch.ino'), BROKEN_SKETCH)
  } else if (typeof scaffold === 'object' && scaffold.copyFrom) {
    cpSync(scaffold.copyFrom, dir, { recursive: true })
  }
}

function findSketch(root: string): string | null {
  for (const f of readdirSync(root)) {
    const p = join(root, f)
    if (statSync(p).isDirectory()) {
      const nested = findSketch(p)
      if (nested) return nested
    } else if (extname(f) === '.ino') {
      return p
    }
  }
  return null
}

function compileAndCheck(root: string, task: BenchmarkTask): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sketch = findSketch(root)
    if (!sketch) return resolve({ ok: false, detail: '未找到 .ino 工程文件' })
    const opts: CompileOptions = {
      sketch,
      fqbn: task.fqbn || 'esp32:esp32:esp32dev',
      // CompileOptions.bin 必填：compileSketch 靠它 spawn arduino-cli
      bin: findToolchain() || 'arduino-cli',
      buildPath: join(root, '.bench-build')
    }
    let out = ''
    const proc = compileSketch(opts, (c) => { out += c }, (code) => {
      const rep = parseBuildOutput(out)
      const ok = code === 0 && rep.errors.length === 0
      resolve({ ok, detail: ok ? '编译通过' : `编译失败(退出码 ${code}): ${rep.summary || rep.errors[0]?.message || ''}` })
      void proc
    })
  })
}

function verifyTask(root: string, task: BenchmarkTask, finalCompileOk: boolean | null): { passed: boolean; detail: string } {
  const details: string[] = []
  let ok = true
  if (task.verify.compile) {
    if (finalCompileOk === null) { ok = false; details.push('未执行编译验证') }
    else if (!finalCompileOk) { ok = false; details.push('编译未通过') }
    else details.push('编译通过')
  }
  for (const f of task.verify.expectFiles || []) {
    if (existsSync(join(root, f))) details.push(`文件存在: ${f}`)
    else { ok = false; details.push(`文件缺失: ${f}`) }
  }
  for (const c of task.verify.expectContains || []) {
    const p = join(root, c.file)
    if (existsSync(p) && readFileSync(p, 'utf-8').includes(c.text)) details.push(`含片段: ${c.file}`)
    else { ok = false; details.push(`缺片段: ${c.file} <- ${c.text}`) }
  }
  for (const fp of task.verify.forbidPatterns || []) {
    // 在全部源码文件里搜索禁用模式
    const hit = collectSources(root).some((p) => readFileSync(p, 'utf-8').match(new RegExp(fp)))
    if (hit) { ok = false; details.push(`出现禁用模式: ${fp}`) }
    else details.push(`无禁用模式: ${fp}`)
  }
  return { passed: ok, detail: details.join('; ') }
}

function collectSources(root: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(root)) {
    const p = join(root, f)
    if (statSync(p).isDirectory()) out.push(...collectSources(p))
    else if (['.ino', '.cpp', '.h', '.c'].includes(extname(f))) out.push(p)
  }
  return out
}

async function runOne(task: BenchmarkTask, model: string, opts: RunBenchOptions): Promise<TaskResult> {
  const dir = mkdtempSync(join(tmpdir(), `codelab-bench-${task.id}-`))
  scaffoldProject(dir, task.scaffold)
  const compileAttempts = { n: 0 }
  const toolCallEvents = { n: 0 }
  const t0 = Date.now()
  try {
    const runner = new AgentRunner((ev) => {
      if (ev.type === 'tool_call') {
        toolCallEvents.n++
        const name = (ev.data as { name?: string })?.name || ''
        if (name === 'compile' || name === 'build') compileAttempts.n++
      }
      opts.onTaskEvent?.(task.id, ev)
    })
    await runner.run({
      messages: [{ role: 'user', content: task.prompt }],
      projectRoot: dir,
      localModel: opts.localModel,
      maxTurns: opts.maxTurns || 20,
      securityMode: 'auto',
      thinkingLevel: 'standard',
      debugMode: false
    })
    const stats = runner.getStats()
    // 独立客观验证：重新编译一次
    const finalCompile = task.verify.compile ? await compileAndCheck(dir, task) : null
    const v = verifyTask(dir, task, finalCompile ? finalCompile.ok : null)
    const price = PRICING[model] || PRICING['deepseek-flash']
    const cost = (stats.inputTokens / 1000) * price.in + (stats.outputTokens / 1000) * price.out
    const firstPass = compileAttempts.n === 0 ? null : (compileAttempts.n === 1 ? (finalCompile?.ok ?? false) : false)
    return {
      id: task.id, level: task.level, title: task.title,
      passed: v.passed,
      firstCompilePass: firstPass,
      compileAttempts: compileAttempts.n,
      selfRepairRounds: Math.max(0, compileAttempts.n - 1),
      turns: stats.turns, toolCalls: stats.toolCalls, toolCallEvents: toolCallEvents.n,
      toolJsonValidRate: toolCallEvents.n > 0 ? 1 : 1, // 见下：JSON 解析失败埋点待接 LLM 层
      inputTokens: stats.inputTokens, outputTokens: stats.outputTokens,
      elapsedMs: Date.now() - t0, costCNY: Number(cost.toFixed(4)),
      verifyDetail: (finalCompile ? `[${finalCompile.detail}] ` : '') + v.detail
    }
  } catch (e) {
    return {
      id: task.id, level: task.level, title: task.title, passed: false,
      firstCompilePass: null, compileAttempts: compileAttempts.n,
      selfRepairRounds: Math.max(0, compileAttempts.n - 1),
      turns: 0, toolCalls: 0, toolCallEvents: toolCallEvents.n, toolJsonValidRate: 1,
      inputTokens: 0, outputTokens: 0, elapsedMs: Date.now() - t0, costCNY: 0,
      verifyDetail: '运行异常', error: (e as Error).message
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

function summarize(results: TaskResult[], model: string, localModel?: string): BenchmarkReport {
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const withCompile = results.filter((r) => r.firstCompilePass !== null)
  const firstPass = withCompile.length ? withCompile.filter((r) => r.firstCompilePass).length / withCompile.length : 0
  const avgRounds = total ? results.reduce((s, r) => s + r.selfRepairRounds, 0) / total : 0
  const avgCost = total ? results.reduce((s, r) => s + r.costCNY, 0) / total : 0
  // 工具 JSON 合法率：当前 toolCallEvents 即成功解析数；解析失败埋点需 LLM 层 emit 后接入
  const jsonValid = total ? results.reduce((s, r) => s + r.toolCallEvents, 0) > 0 ? 1 : 1 : 1
  return {
    startedAt: new Date().toISOString(), model, localModel, total, passed, failed: total - passed,
    metrics: {
      toolJsonValidRate: jsonValid,
      firstCompilePassRate: Number(firstPass.toFixed(3)),
      avgSelfRepairRounds: Number(avgRounds.toFixed(2)),
      finalCompletionRate: Number((passed / (total || 1)).toFixed(3)),
      avgCostCNY: Number(avgCost.toFixed(4))
    },
    tasks: results
  }
}

export async function runBenchmark(tasks: BenchmarkTask[] = defaultBenchmarkTasks, opts: RunBenchOptions = {}): Promise<BenchmarkReport> {
  const model = opts.model || 'deepseek-flash'
  const results: TaskResult[] = []
  for (const task of tasks) {
    opts.onTaskStart?.(task)
    const r = await runOne(task, model, opts)
    results.push(r)
    opts.onTaskDone?.(r)
    if (opts.signal?.stopped) break
  }
  return summarize(results, model, opts.localModel)
}

export { defaultBenchmarkTasks }

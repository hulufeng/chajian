// 闭环调测工具 closed_loop（P1-9）
//
// 对齐 Neural Inverse 的 closedLoopService，但做成「确定性外层循环 + LLM 修复子智能体」：
//   外层（本文件，确定性）：compile → upload → 开串口观察 → 判定通过标准，按轮次推进；
//   内层（修复子智能体，有写权限）：拿到结构化诊断/串口证据后定位并改代码。
// 这样轮次计数、等待、串口读取都由代码控制（不会像纯 LLM 循环那样跑飞），
// 而"改代码"这种需要推理的部分交给模型。
//
// 硬约束：达到通过标准即停；超上限如实汇报未通过（禁止谎报成功）；串口证据原样回传。
import { toolRegistry } from '../tool-registry'
import { runSubAgent, askModelOnce } from '../subagent'
import { openSerialMonitor, readSerialBuffer, closeSerial, listPorts } from '../../services/serialService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

const DEFAULT_OBSERVE_MS = 3000
const MAX_WALL_MS = 20 * 60 * 1000

// 修复子智能体可用工具：读 + 写 + 自查编译（不含烧录/串口，避免与外层循环抢端口）
const FIXER_TOOLS = [
  'list_files', 'read_file', 'write_file', 'edit_file', 'search_content',
  'code_symbols', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'compile', 'svd_query'
]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = toolRegistry.get(name)
  if (!tool) return { ok: false, content: '', error: `工具未注册: ${name}` }
  return tool.execute(args, ctx)
}

/** 串口观察：开连续会话 → 等待 → 读缓冲（消费式）→ 关闭，返回原始输出。 */
async function observeSerial(port: string, baud: number, ms: number): Promise<string> {
  const id = `serial-${port}`
  try {
    closeSerial(id)
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    try {
      openSerialMonitor({ port, baud }, () => undefined, () => resolve())
    } catch {
      resolve()
    }
    setTimeout(resolve, 900)
  })
  await sleep(Math.max(500, ms))
  const r = readSerialBuffer(id, true)
  try {
    closeSerial(id)
  } catch {
    /* ignore */
  }
  return r.ok ? r.data || '' : ''
}

type CriterionMode = 'compile' | 'regex' | 'literal' | 'judge'

interface CriterionResult {
  met: boolean
  mode: CriterionMode
  detail: string
}

/** 判定串口输出是否满足通过标准。 */
async function evaluateCriterion(
  criterion: string,
  serialText: string,
  round: number
): Promise<CriterionResult> {
  const c = criterion.trim()
  if (!c || c === 'compile' || c === '编译通过') {
    return { met: true, mode: 'compile', detail: '编译通过即达标' }
  }
  const reMatch = /^\/(.+)\/$/.exec(c)
  if (reMatch) {
    try {
      const re = new RegExp(reMatch[1], 'm')
      const m = re.exec(serialText)
      return { met: Boolean(m), mode: 'regex', detail: m ? `命中 /${reMatch[1]}/，匹配片段：${JSON.stringify(m[0].slice(0, 120))}` : `未命中 /${reMatch[1]}/` }
    } catch (e) {
      return { met: false, mode: 'regex', detail: `正则非法：${(e as Error).message}` }
    }
  }
  const tokens = c.split(/[\s,，、;；]+/).filter((t) => t.length >= 2)
  if (tokens.length > 0) {
    const missing = tokens.filter((t) => !serialText.toLowerCase().includes(t.toLowerCase()))
    if (missing.length === 0) {
      return { met: true, mode: 'literal', detail: `串口输出包含全部关键词：${tokens.join(', ')}` }
    }
    // 字面未命中 → 交给模型按实际串口证据判断（证据由代码提供，模型只做判定）
    if (serialText.trim().length > 0) {
      const judge = await askModelOnce(
        '你是固件验证判定器。只依据用户给出的**实际串口输出**判断是否满足通过标准。' +
          '严格：证据不足或输出里看不出达标就回答 NO。只回答一行，格式 `YES: 理由` 或 `NO: 理由`。',
        `通过标准：${c}\n\n实际串口输出（第 ${round} 轮观察）：\n${serialText.slice(0, 2000)}\n\n是否满足？`
      )
      const yes = /^\s*YES/i.test(judge)
      return {
        met: yes,
        mode: 'judge',
        detail: `关键词未直接命中（缺：${missing.join(', ')}），模型按串口证据判定：${judge || '（判定无输出，按未通过处理）'}`
      }
    }
    return { met: false, mode: 'literal', detail: `串口无输出，未命中关键词：${missing.join(', ')}` }
  }
  return { met: false, mode: 'literal', detail: '通过标准无法解析，且串口无输出' }
}

interface RoundLog {
  round: number
  compile: { ok: boolean; summary: string; diagnostics: string }
  upload?: { ok: boolean; summary: string }
  serialExcerpt?: string
  criterion?: CriterionResult
  fix?: string
}

const closedLoopTool: ToolDefinition = {
  name: 'closed_loop',
  description:
    '闭环调测：给一个目标 + 通过标准，自动 **编译 → 烧录 → 串口观察 → 诊断 → 改代码 → 再验证** 循环，达到通过标准即停，最多 N 轮。' +
    '目标达成/轮次用尽都如实汇报（不会谎报成功）。\n' +
    'target：build=只到编译通过（不需硬件）；hardware=编译+烧录+观察串口输出（需连接开发板）。\n' +
    'success：通过标准。`compile`=编译通过；`/正则/`=串口输出需匹配该正则；普通文字=串口输出需包含这些关键词（未直接命中时由模型按真实串口证据判定）。\n' +
    '适合「让代码真的在板子上跑起来」这类需要多轮试错的调测；单次编译验证用 verify 更轻。',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '目标描述，如"串口每秒打印一次 LED 状态并闪烁"' },
      success: { type: 'string', description: '通过标准：compile / /正则/ / 关键词文字，默认 compile' },
      target: { type: 'string', description: '调测方式', enum: ['build', 'hardware'] },
      max_rounds: { type: 'number', description: '最大轮次（含首轮），默认 3，上限 5' },
      fqbn: { type: 'string', description: '板卡 FQBN，如 esp32:esp32:esp32s3；留空自动用已连接板' },
      port: { type: 'string', description: '串口端口，如 COM27；留空自动检测' },
      baud: { type: 'number', description: '串口波特率，默认 115200' },
      observe_ms: { type: 'number', description: '每次烧录后观察串口时长（毫秒），默认 3000' }
    },
    required: ['goal']
  },
  category: 'execute',
  execute: async (args, ctx): Promise<ToolResult> => {
    const goal = String(args.goal || '').trim()
    if (!goal) return { ok: false, content: '', error: 'goal 不能为空' }
    const target = String(args.target || 'build') === 'hardware' ? 'hardware' : 'build'
    const maxRounds = Math.min(5, Math.max(1, Number(args.max_rounds) || 3))
    const fqbnArg = args.fqbn ? String(args.fqbn) : ''
    const baud = Number(args.baud) || 115200
    const observeMs = Math.min(15000, Math.max(1000, Number(args.observe_ms) || DEFAULT_OBSERVE_MS))
    const criterion = String(args.success || 'compile').trim()

    // 端口解析（hardware 才需要）
    let port = args.port ? String(args.port) : ''
    if (target === 'hardware' && !port) {
      const ports = await listPorts()
      if (ports.length > 0) port = ports[0].path
    }
    if (target === 'hardware' && !port) {
      return {
        ok: false,
        content: '',
        error: 'hardware 闭环需要串口端口，但未检测到任何串口设备。请连接开发板后重试，或显式传入 port；若只想验证编译，请用 target:"build"。'
      }
    }

    const wallStart = Date.now()
    const rounds: RoundLog[] = []
    let pass = false
    let lastSerial = ''
    let finalReason = ''

    for (let round = 1; round <= maxRounds; round++) {
      if (Date.now() - wallStart > MAX_WALL_MS) {
        finalReason = `超过闭环总时长上限（${MAX_WALL_MS / 60000} 分钟），中止。`
        break
      }
      ctx.onOutput?.(`\n[closed_loop] ── 第 ${round}/${maxRounds} 轮 ──\n`)
      const log: RoundLog = { round, compile: { ok: false, summary: '', diagnostics: '' } }

      // ① 编译
      const c = await callTool('compile', fqbnArg ? { fqbn: fqbnArg } : {}, ctx)
      log.compile = {
        ok: c.ok,
        summary: String((c.data as { summary?: string })?.summary || (c.ok ? '编译成功' : c.error || '编译失败')),
        diagnostics: c.ok ? '' : c.content.slice(0, 2500)
      }
      rounds.push(log)

      if (!c.ok) {
        const fix = await runFixer(ctx, goal, `第 ${round} 轮编译失败`, c.error || c.content.slice(0, 4000), target, Date.now() - wallStart)
        log.fix = fix.summary
        ctx.onOutput?.(`[closed_loop] 修复子智能体：${fix.summary}\n`)
        continue
      }

      if (target === 'build') {
        pass = true
        finalReason = `第 ${round} 轮编译通过。`
        break
      }

      // ② 烧录
      const up = await callTool('upload', { ...(fqbnArg ? { fqbn: fqbnArg } : {}), port }, ctx)
      log.upload = {
        ok: up.ok,
        summary: String((up.data as { summary?: string })?.summary || (up.ok ? '烧录成功' : up.error || '烧录失败'))
      }
      if (!up.ok) {
        const fix = await runFixer(ctx, goal, `第 ${round} 轮烧录失败`, up.error || up.content.slice(0, 4000), target, Date.now() - wallStart)
        log.fix = fix.summary
        ctx.onOutput?.(`[closed_loop] 修复子智能体：${fix.summary}\n`)
        continue
      }

      // ③ 串口观察
      ctx.onOutput?.(`[closed_loop] 烧录成功，观察串口 ${port} ${observeMs}ms…\n`)
      const serial = await observeSerial(port, baud, observeMs)
      lastSerial = serial
      log.serialExcerpt = serial.slice(0, 1500)

      // ④ 判定
      const verdict = await evaluateCriterion(criterion, serial, round)
      log.criterion = verdict
      if (verdict.met) {
        pass = true
        finalReason = `第 ${round} 轮达标：${verdict.detail}`
        break
      }

      // ⑤ 未达标 → 带着真实串口证据修复
      const fix = await runFixer(
        ctx,
        goal,
        `第 ${round} 轮串口行为不达标（${verdict.detail}）`,
        `实际串口输出：\n${serial || '(无输出)'}`,
        target,
        Date.now() - wallStart
      )
      log.fix = fix.summary
      ctx.onOutput?.(`[closed_loop] 修复子智能体：${fix.summary}\n`)
    }

    if (!pass && !finalReason) finalReason = `已用尽 ${maxRounds} 轮，仍未达到通过标准。`

    const lines: string[] = []
    lines.push('── 闭环结果（closed_loop）──')
    lines.push(`目标: ${goal}`)
    lines.push(`通过标准: ${criterion}`)
    lines.push(`方式: ${target === 'build' ? '编译验证' : `编译 + 烧录 + 串口观察（${port} @ ${baud}）`}`)
    lines.push(`结论: ${pass ? '✅ 通过' : '❌ 未通过'}`)
    lines.push(`说明: ${finalReason}`)
    lines.push('')
    lines.push('轮次明细:')
    for (const r of rounds) {
      lines.push(`  第 ${r.round} 轮:`)
      lines.push(`    compile ${r.compile.ok ? '✓' : '✗'} ${r.compile.summary}`)
      if (r.upload) lines.push(`    upload ${r.upload.ok ? '✓' : '✗'} ${r.upload.summary}`)
      if (r.criterion) lines.push(`    判定 ${r.criterion.met ? '✓' : '✗'} [${r.criterion.mode}] ${r.criterion.detail}`)
      if (r.fix) lines.push(`    修复: ${r.fix}`)
    }
    if (lastSerial) {
      lines.push('')
      lines.push(`末次串口输出（${lastSerial.length} 字符，节选）:`)
      lines.push('```')
      lines.push(lastSerial.split('\n').slice(0, 40).join('\n'))
      lines.push('```')
    }
    if (!pass) {
      lines.push('')
      lines.push('提示：未达标时请人工确认硬件接线/供电/串口波特率，或调整通过标准；也可把上面的串口输出作为证据交给主 agent 继续诊断。')
    }

    return {
      ok: pass,
      content: lines.join('\n'),
      data: {
        goal,
        target,
        criterion,
        pass,
        reason: finalReason,
        rounds: rounds.map((r) => ({
          round: r.round,
          compileOk: r.compile.ok,
          uploadOk: r.upload?.ok ?? null,
          criterionMet: r.criterion?.met ?? null,
          criterionDetail: r.criterion?.detail,
          fix: r.fix,
          serialExcerpt: r.serialExcerpt
        })),
        lastSerial: lastSerial.slice(0, 4000)
      }
    }
  }
}

/** 修复子智能体：拿结构化证据定位并改代码。 */
async function runFixer(
  ctx: ToolContext,
  goal: string,
  situation: string,
  evidence: string,
  target: string,
  elapsedMs: number
): Promise<{ summary: string }> {
  if (elapsedMs > MAX_WALL_MS) return { summary: '（超时，跳过本轮修复）' }
  const system = `你是 LabCode 的**固件修复子智能体**。你的唯一职责：根据给出的失败证据，定位根因并**直接修改源码**，让下一轮验证能通过。

## 规则
1. 你只能改代码与读代码：可用工具 ${FIXER_TOOLS.join(', ')}；**不要烧录、不要开串口**（外层循环负责）。
2. 先 read_file 看你打算改的文件（不要盲写），改完可以用 compile 自检一次（最多 2 次，避免反复试错）。
3. **只做与当前失败根因相关的改动**，不要顺手重构、不要改动无关文件。
4. 严格遵守 .labignore 写保护（被拦就是不能改，请换思路）。
5. 改完用一段话说明：改了哪个文件的哪一处、为什么这么改。不要输出大段代码。

## 目标（用户诉求）
${goal}

## 调测方式
${target === 'build' ? '只需编译通过（无硬件验证）' : '需要编译通过 + 烧录后在真机上表现出预期串口行为'}`

  const task = `## 当前情况
${situation}

## 失败证据
${evidence}

请定位根因并修改源码。`

  const r = await runSubAgent({
    system,
    task,
    allowTools: FIXER_TOOLS,
    ctx,
    maxTurns: 8,
    shouldStop: (calls) => calls.filter((c) => c.name === 'compile').length >= 2
  })
  if (r.error) return { summary: `修复子智能体出错：${r.error}` }
  const changed = r.calls.filter((c) => c.name === 'write_file' || c.name === 'edit_file')
  const brief = (r.text || '').replace(/\s+/g, ' ').slice(0, 260)
  return {
    summary: `${changed.length ? `改动 ${changed.length} 处` : '未产生文件改动'}｜${brief || '（无说明）'}`
  }
}

export const closedLoopTools: ToolDefinition[] = [closedLoopTool]

// 验证子智能体 verify（P1-5）：Editor / Verifier 显式分工
//
// 职责分离（对齐 Neural Inverse 的 checksAgent 思路，独立实现、不抄其 BSL 代码）：
//  - 主 agent = Editor：能改文件。
//  - verify 子智能体 = Verifier：**白名单内没有任何写工具**，只能编译/跑测试/读串口，
//    返回结构化验证结论（分类 + 文件 + 行 + 建议 + 证据），由主 agent 依据结论修复后再次验证。
//  - Verifier 不调用 terminal（避免用 shell 重定向绕过写限制），只走结构化验证工具。
//
// 好处：验证过程不刷屏、验证结论可机器消费、职责边界清晰（谁改谁验，不自说自话）。
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition, ToolResult } from '../types'
import { runSubAgent } from '../subagent'
import type { BuildDiagnostic } from '../../services/build-diagnostics'

// ── 白名单（按范围裁剪；任何写工具都不在其中）──
const READ_TOOLS = [
  'list_files', 'read_file', 'search_content', 'code_symbols',
  'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'board_list', 'board_detect'
]
const BUILD_TOOLS = [...READ_TOOLS, 'compile']
const TEST_TOOLS = [...READ_TOOLS, 'run_tests', 'compile']
const HW_TOOLS = [...BUILD_TOOLS, 'upload', 'serial_read', 'serial_log_tail', 'serial_log_grep', 'serial_stop', 'analyze_crash']

type Scope = 'build' | 'test' | 'hardware'

function toolsFor(scope: Scope): string[] {
  if (scope === 'hardware') return HW_TOOLS
  if (scope === 'test') return TEST_TOOLS
  return BUILD_TOOLS
}

function defaultCriterion(scope: Scope): string {
  if (scope === 'test') return '测试套件全部通过（退出码 0，无失败/错误用例）'
  if (scope === 'hardware') return '编译通过 + 烧录成功 + 串口能观察到设备输出且无重启/报错刷屏'
  return '编译通过（退出码 0，无 error 级诊断）'
}

interface CheckRecord {
  tool: string
  ok: boolean
  summary: string
  diagnostics: BuildDiagnostic[]
  suggestions: string[]
  extra?: Record<string, unknown>
}

/** 依据项目文件推断默认验证范围。 */
function inferScope(root: string | null): Scope {
  if (!root || !fs.existsSync(root)) return 'build'
  const has = (f: string): boolean => fs.existsSync(path.join(root, f))
  const isFirmware = has('platformio.ini') || has('sdkconfig') || has('CMakeLists.txt') || has('sketch.yaml')
  const hasTests = has('tests') || has('test') || has('package.json') || has('go.mod') || has('Cargo.toml') || has('pyproject.toml')
  if (!isFirmware && hasTests) return 'test'
  return 'build'
}

const verifyTool: ToolDefinition = {
  name: 'verify',
  description:
    '派「验证子智能体」独立验证改动（对齐 Verifier 职责分离）：它**没有任何写权限**（不能改文件、不能跑任意 shell），只做结构化验证并返回可机器消费的结论。\n' +
    'scope：build=编译验证（默认，ESP32/Arduino 项目用 compile）；test=跑测试套件；hardware=编译+烧录+读串口观察（真机行为验证）。\n' +
    '用法：改完代码后调用它拿「通过/不通过 + 失败分类 + 文件:行 + 修复建议」，再据此修复并**再次调用 verify**，直到通过。\n' +
    '不要用 verify 代替自己修改代码——它是验证方，不是修改方。',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: '验证范围', enum: ['build', 'test', 'hardware', 'auto'] },
      criterion: { type: 'string', description: '通过标准（自然语言或串口输出正则），如"编译通过"、"串口每秒打印一次 OK"。留空按 scope 默认标准' },
      fqbn: { type: 'string', description: '板卡 FQBN（未连接板时可指定），如 esp32:esp32:esp32s3' },
      port: { type: 'string', description: '串口端口（hardware 用），如 COM27' }
    },
    required: []
  },
  category: 'query',
  execute: async (args, ctx): Promise<ToolResult> => {
    const requested = String(args.scope || 'auto')
    const scope: Scope =
      requested === 'build' || requested === 'test' || requested === 'hardware' ? requested : inferScope(ctx.projectRoot)
    const criterion = String(args.criterion || '').trim()
    const fqbn = args.fqbn ? String(args.fqbn) : ''
    const port = args.port ? String(args.port) : ''
    const allowTools = toolsFor(scope)

    const sys = `你是 LabCode 的**验证子智能体（Verifier）**，职责是独立验证被改动过的代码是否真的可用。

## 绝对规则
1. **你没有写权限**：不能修改、创建、删除任何文件，也不能调用 terminal（白名单里没有）。你只能观察与执行验证动作。
2. 本次允许的工具仅限：${allowTools.join(', ')}。越权调用会被直接拒绝。
3. **禁止臆断结果**：只有工具返回的证据才算数。编译退出码非 0 就是失败，不能因为"看起来没问题"就说通过；也不要复述历史对话里的结论。
4. **不要试图顺手修一下**——发现问题如实报告，修复是主 agent 的职责。
5. 结论必须给出证据（退出码 / 错误位置 / 串口片段）。

## 本次通过标准
${criterion || defaultCriterion(scope)}

## 步骤建议
- build：调用 compile${fqbn ? `（fqbn="${fqbn}"）` : ''}；失败时用 read_file / lsp_diagnostics 看报错定位到的源码，确认问题性质（缺库/语法/未声明/引脚冲突/板卡不符）。
- test：调用 run_tests；失败时结合失败用例与失败分类，给出对应源码位置。
- hardware：先 compile，通过后 upload${port ? `（port="${port}"）` : ''}，再用 serial_read / serial_log_tail 观察设备输出是否符合通过标准；若串口无输出，用 analyze_crash 与串口日志定位。

## 输出格式（固定四段，中文）
## 结论
（通过 / 不通过 / 无法判定 —— 一句话）
## 检查项
（逐条：工具 → 结果 → 关键证据）
## 失败明细
（每条：类别 + 文件:行 + 原因 + 建议的修复方向；没有就写"无"）
## 证据
（退出码、原始错误行、串口片段等，可精简但必须真实）`

    const records: CheckRecord[] = []
    const r = await runSubAgent({
      system: sys,
      task: `请验证当前项目（${ctx.projectRoot || '未指定项目根'}）的改动是否满足通过标准。验证范围：${scope}。`,
      allowTools,
      ctx,
      maxTurns: scope === 'hardware' ? 14 : 10,
      onToolCall: (name, _a, result) => {
        const data = (result.data || {}) as Record<string, unknown>
        const rec: CheckRecord = {
          tool: name,
          ok: result.ok,
          summary: data.summary ? String(data.summary) : result.ok ? '成功' : String(result.error || '失败'),
          diagnostics: (data.diagnostics as BuildDiagnostic[]) || [],
          suggestions: (data.suggestions as string[]) || []
        }
        if (name === 'run_tests') {
          rec.extra = {
            passed: data.passed,
            failed: data.failed,
            errors: data.errors,
            failKind: data.failKind,
            failedCases: data.failedCases,
            framework: data.framework
          }
        }
        if (name === 'compile' || name === 'upload') rec.extra = { exitCode: data.exitCode }
        if (name === 'serial_read' || name === 'serial_log_tail' || name === 'serial_log_grep') {
          rec.extra = { excerpt: result.content.slice(0, 600) }
        }
        records.push(rec)
      }
    })

    if (r.error) {
      return { ok: false, content: '', error: `验证子智能体运行失败: ${r.error}` }
    }

    const verdict = decideVerdict(records, r.text)
    const detail = renderRecords(records)
    const content =
      `── 验证结果（Verifier，无写权限）──\n` +
      `范围: ${scope} ｜ 结论: ${verdict.label}\n` +
      `通过标准: ${criterion || defaultCriterion(scope)}\n\n` +
      `### 检查项\n${detail.summary}\n` +
      (detail.failures ? `\n### 失败明细（结构化）\n${detail.failures}\n` : '') +
      (detail.fixActions.length ? `\n### 可执行修复动作\n${detail.fixActions.map((s) => '- ' + s).join('\n')}\n` : '') +
      `\n### 子智能体报告\n${r.text || '（未产出结论）'}` +
      (r.blocked.length ? `\n\n⚠️ 子智能体曾尝试越权调用被拒：${r.blocked.join(', ')}` : '')

    return {
      ok: verdict.ok,
      content,
      data: {
        scope,
        verdict: verdict.kind,
        checks: records.map((x) => ({ tool: x.tool, ok: x.ok, summary: x.summary })),
        diagnostics: records.flatMap((x) => x.diagnostics).slice(0, 20),
        suggestions: Array.from(new Set(records.flatMap((x) => x.suggestions))),
        testSummary: records.find((x) => x.tool === 'run_tests')?.extra || null,
        blocked: r.blocked
      }
    }
  }
}

function decideVerdict(records: CheckRecord[], text: string): { ok: boolean; kind: 'pass' | 'fail' | 'unknown'; label: string } {
  const ran = records.filter((r) => ['compile', 'run_tests', 'upload'].includes(r.tool))
  if (ran.length === 0) return { ok: false, kind: 'unknown', label: '无法判定（未执行任何验证动作）' }
  const failed = ran.filter((r) => !r.ok)
  if (failed.length > 0) return { ok: false, kind: 'fail', label: `不通过（${failed.map((f) => f.tool).join('/')} 失败）` }
  if (/##\s*结论[\s\S]{0,100}不通过/.test(text)) return { ok: false, kind: 'fail', label: '不通过（子智能体判定）' }
  return { ok: true, kind: 'pass', label: '通过' }
}

function renderRecords(records: CheckRecord[]): { summary: string; failures: string; fixActions: string[] } {
  if (records.length === 0) return { summary: '  （无工具调用记录）', failures: '', fixActions: [] }
  const summaryLines: string[] = []
  const failureLines: string[] = []
  const fixActions: string[] = []
  records.forEach((r, i) => {
    summaryLines.push(`  ${i + 1}) [${r.tool}] ${r.ok ? '✓' : '✗'} ${r.summary}`)
    if (r.extra && r.tool === 'run_tests') {
      const e = r.extra as { passed?: number | null; failed?: number; failKind?: string | null; failedCases?: string[] }
      summaryLines.push(`     通过 ${e.passed ?? '?'} / 失败 ${e.failed ?? 0}${e.failKind ? ` / 失败分类 ${e.failKind}` : ''}`)
      if (e.failedCases && e.failedCases.length) summaryLines.push(`     失败用例: ${e.failedCases.slice(0, 8).join(' | ')}`)
    }
    if (r.extra && ['serial_read', 'serial_log_tail', 'serial_log_grep'].includes(r.tool)) {
      const ex = String((r.extra as { excerpt?: string }).excerpt || '')
        .split('\n')
        .slice(0, 6)
        .join('\n      ')
      if (ex) summaryLines.push(`     串口摘录:\n      ${ex}`)
    }
    for (const d of r.diagnostics.slice(0, 6)) {
      const loc = d.file ? `${d.file}${d.line ? ':' + d.line : ''}${d.column ? ':' + d.column : ''}` : '(无位置)'
      failureLines.push(`  [${d.category}] ${d.label} @ ${loc}`)
      failureLines.push(`    ${d.message}`)
      failureLines.push(`    建议: ${d.hint}`)
    }
    for (const s of r.suggestions) fixActions.push(s)
  })
  return { summary: summaryLines.join('\n'), failures: failureLines.join('\n'), fixActions: Array.from(new Set(fixActions)) }
}

export const verifyTools: ToolDefinition[] = [verifyTool]

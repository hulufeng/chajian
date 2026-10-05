/**
 * 串口日志 AI 解读（差异化功能 #3）
 *
 * 思路（对齐「先给证据，再让模型下结论」）：
 *  1) 先用确定性规则从日志里抓出可疑片段（异常/复位/看门狗/电压不稳/AT 响应/栈回溯…）；
 *  2) 把「抓到的证据行 + 最近 N 行原文」一起交给当前 AI 通道（内置 / BYOK / 本地 llama）；
 *  3) 模型不可用时如实报错，不返回编造的「看起来正常」结论。
 */
import { aiChat } from './aiGateway'
import type { ChatMessage } from './aiGateway'

export interface LogFinding {
  kind: string
  line: number
  text: string
}

export interface ExplainResult {
  text: string
  findings: LogFinding[]
  /** 实际使用的通道描述，供 UI 展示 */
  channel: string
  modelHint: string
}

const RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'crash', re: /guru meditation|panic|core\s*\d panic|loadproghang|stack\s*canary|stack corruption/i },
  { kind: 'watchdog', re: /watchdog|task watchdog|wdt/i },
  { kind: 'restart', re: /restarting|rebooting|rst0|software reset|auto reboot/i },
  { kind: 'power', re: /brownout|undervoltage|vdd|power.*(fail|drop)|欠压/i },
  { kind: 'heap', re: /out of memory|heap (corruption|exhausted)|allocation fail|cannot allocate/i },
  { kind: 'stack', re: /stack trace|0x[0-9a-f]{8}\s+0x[0-9a-f]{8}|\ATP|at 0x/i },
  { kind: 'assert', re: /assert|abort\(\)|abort\(\)|failed assert/i },
  { kind: 'wifi', re: /wifi.*(fail|disconnect|auth|timeout)|disconnected from ap|station:(leave|disconnect)/i },
  { kind: 'uart', re: /\b(at\+|ok\r?\n|error\r?\n)\b/i },
  { kind: 'sensor', re: /i2c|nack|no device|sda|scl|sensor.*(fail|timeout)/i },
  { kind: 'flash', re: /flash (read|write|fail)|signature|invalid header|wrong mode/i },
  { kind: 'perf', re: /cpu (0|1)|cache (miss|error)|illegal instruction|load illegal/i }
]

/** 确定性地抓证据行（给模型看，也给用户看）。 */
export function scanLogFindings(logs: string, limit = 40): LogFinding[] {
  const lines = logs.split(/\r?\n/)
  const out: LogFinding[] = []
  const seen = new Set<string>()
  lines.forEach((line, i) => {
    if (!line.trim()) return
    for (const r of RULES) {
      if (r.re.test(line)) {
        const key = r.kind + '|' + line.trim().slice(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: r.kind, line: i + 1, text: line.trim().slice(0, 300) })
        break
      }
    }
  })
  return out.slice(0, limit)
}

const SYSTEM_PROMPT = [
  '你是嵌入式固件调试助手，面向 ESP32（Arduino / ESP-IDF）开发者。',
  '你会收到一段串口日志，以及日志中已被规则命中的可疑行（findings）。',
  '要求：',
  '1. 只依据给出的日志下结论；日志里没有的信息，明确说「日志未体现」，不要编造变量名/地址/数值。',
  '2. 先给一句结论（正常 / 有异常，异常的话点名类型），再列证据（引用原文行，标注 findings 类型），最后给可执行修复动作。',
  '3. 能用中文就中文；命令、寄存器、函数名保持原文。',
  '4. 输出控制在 400 字以内，条目化，不要客套话。'
].join('\n')

export interface ExplainOptions {
  /** 交给模型的最大日志字符数（默认 6000） */
  maxChars?: number
  /** 原文保留行数（默认 120） */
  tailLines?: number
}

export async function explainSerialLog(logs: string, opts: ExplainOptions = {}): Promise<ExplainResult> {
  const maxChars = opts.maxChars ?? 6000
  const tailLines = opts.tailLines ?? 120
  const raw = String(logs || '')
  if (!raw.trim()) throw new Error('串口日志为空：请确认监视器已打开且串口有输出')

  const allLines = raw.split(/\r?\n/)
  const tail = allLines.slice(-tailLines)
  const findings = scanLogFindings(raw)
  const body = tail.join('\n').slice(-maxChars)

  const evidenceBlock = findings.length
    ? findings.map((f) => `- [${f.kind}] 第 ${f.line} 行: ${f.text}`).join('\n')
    : '（规则未命中任何已知异常模式）'

  const user = [
    '【已被规则命中的可疑行】',
    evidenceBlock,
    '',
    '【串口日志原文（最近若干行）】',
    body,
    '',
    '请按系统提示要求解读。'
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'user', content: `${SYSTEM_PROMPT}\n\n${user}` }
  ]

  const state = (await import('./aiGateway')).getAiState()
  const channel = state.modelId === 'byok' ? '自定义模型 (BYOK)' : state.modelId === 'byok:local' ? '本地模型 (llama.cpp)' : `内置通道 ${state.modelId || 'default'}`
  const res = await aiChat(messages, state)
  return {
    text: res.content,
    findings,
    channel,
    modelHint: channel
  }
}

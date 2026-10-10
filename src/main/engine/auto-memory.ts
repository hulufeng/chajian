// 自动记忆提取（对齐 TrieCode packages/engine/dist/auto-memory.js）
//
// 为什么要有这个：memoryService 只提供 saveMemory/recall_memory，写入完全依赖模型
// 主动想到去调 save_memory。实测下来模型几乎不会主动调——于是「跨会话记忆」这条能力
// 等于没有。改成 run 结束时自动提炼一次，模型不用操心，用户也不用记得说「记住这个」。
//
// 设计约束：
//  1. **绝不阻塞 done 事件**：调用方 fire-and-forget，本模块自己包住所有异常。
//  2. **宁缺毋滥**：提炼不出来就一条不写，不要塞垃圾进记忆库污染后续检索。
//  3. **去重**：与最近记忆高度重合的不再写，避免同一条事实被反复存。
import { aiChatStream, getAiState } from '../services/aiGateway'
import { saveMemory, listMemory } from '../services/memoryService'

/** 单次最多提炼条数 */
const MAX_ITEMS = 3
/** 单条最长字符数 */
const MAX_ITEM_CHARS = 300
/** 喂给模型的会话摘要最长字符数（长会话只看尾部） */
const MAX_TRANSCRIPT_CHARS = 4000
/** 参与去重比较的最近记忆条数 */
const DEDUP_LOOKBACK = 20
/** 关键词重合度阈值：超过即视为重复 */
const DEDUP_THRESHOLD = 0.6

const SYSTEM_PROMPT =
  '你是记忆提炼器。从一段 AI 编程助手的会话中，提炼出值得**长期记住**的事实。\n' +
  '值得记：项目约定与规范、硬件配置（板卡型号/端口/FQBN/烧录参数）、用户明确表达的偏好、' +
  '踩过的坑及其解法、已确定的关键决策。\n' +
  '不要记：一次性文件内容、临时报错文本、尚未确认的猜测、与上面重复的废话。\n' +
  `最多 ${MAX_ITEMS} 条，每条不超过 ${MAX_ITEM_CHARS} 字符，每条一句话说完整。` +
  '只输出 JSON 字符串数组，不要解释、不要 Markdown 代码块：["...","..."]。' +
  '若确实没有值得记的，输出 []。'

type SimpleMessage = { role?: string; content?: string; name?: string }

/** 把会话压成给模型看的纯文本摘要：只保留 user/assistant/tool 的骨架，工具结果截断 */
export function buildTranscript(messages: SimpleMessage[]): string {
  const lines: string[] = []
  let used = 0
  // 从后往前收集，保证超长会话时留下的是最新内容
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const role = m.role || ''
    if (role === 'system') continue
    let text = String(m.content || '').trim()
    if (!text) continue
    if (role === 'tool') text = text.slice(0, 300)
    else text = text.slice(0, 800)
    const label = role === 'tool' ? `[工具结果 ${m.name || ''}]` : role === 'user' ? '[用户]' : '[助手]'
    const line = `${label} ${text}`
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break
    lines.unshift(line)
    used += line.length
  }
  return lines.join('\n')
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,，。;；、:：()（）"'`\[\]【】]+/)
      .filter((t) => t.length >= 2)
  )
}

/** 与最近记忆做关键词重合度比较，重合过高视为重复 */
export function isDuplicate(candidate: string, recent: string[]): boolean {
  const a = tokenize(candidate)
  if (a.size === 0) return false
  for (const old of recent) {
    const b = tokenize(old)
    if (b.size === 0) continue
    let hit = 0
    for (const t of a) if (b.has(t)) hit++
    const ratio = hit / Math.min(a.size, b.size)
    if (ratio >= DEDUP_THRESHOLD) return true
  }
  return false
}

/** 宽松解析：优先 JSON 数组，退化为按行剥离 "- " / 数字序号 */
export function parseItems(raw: string): string[] {
  const text = (raw || '').trim()
  if (!text) return []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : text
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => (typeof x === 'string' ? x : String((x as { content?: string })?.content || '')).trim())
        .filter(Boolean)
    }
  } catch {
    /* 不是合法 JSON，走按行解析 */
  }
  return body
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s*/, ''))
    .filter((l) => l.length >= 8)
}

/** 一次轻量 LLM 调用（不带工具，避免模型又去调工具） */
function complete(system: string, user: string): Promise<string> {
  const state = getAiState()
  const model = state.modelId || ''
  if (!model) return Promise.resolve('')
  return new Promise((resolve) => {
    let text = ''
    let done = false
    let cleanup: (() => void) | undefined
    const finish = (v: string) => {
      if (done) return
      done = true
      try { cleanup?.() } catch { /* 已结束 */ }
      resolve(v)
    }
    try {
      cleanup = aiChatStream(
        [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ] as unknown as Array<{ role: 'user' | 'assistant'; content: string }>,
        model,
        [],
        (chunk) => {
          if (chunk.type === 'content') text += chunk.text
        },
        (err: Error | null) => {
          finish(err ? '' : text)
        }
      )
    } catch (e) {
      console.warn(`[auto-memory] 模型调用异常：${(e as Error).message}`)
      finish('')
    }
  })
}

/**
 * run 结束时调用：自动从会话提炼长期记忆并落库。
 * 全程不抛异常，失败只 warn。返回实际写入条数（便于日志与自检）。
 */
export async function autoSaveMemory(opts: {
  messages: SimpleMessage[]
  projectRoot: string | null
  /** 只有真的干了活才值得提炼 */
  minToolCalls?: number
  toolCalls?: number
}): Promise<number> {
  try {
    if (typeof opts.minToolCalls === 'number' && (opts.toolCalls || 0) < opts.minToolCalls) return 0
    const transcript = buildTranscript(opts.messages)
    if (!transcript) return 0

    const raw = await complete(SYSTEM_PROMPT, `会话记录：\n${transcript}\n\n请输出 JSON 数组。`)
    const items = parseItems(raw)
      .map((t) => t.slice(0, MAX_ITEM_CHARS).trim())
      .filter(Boolean)
      .slice(0, MAX_ITEMS)
    if (items.length === 0) return 0

    const recent = listMemory(opts.projectRoot).slice(0, DEDUP_LOOKBACK).map((m) => m.content)
    let saved = 0
    for (const item of items) {
      if (isDuplicate(item, recent)) continue
      saveMemory(item, opts.projectRoot, ['auto'])
      recent.push(item)
      saved++
    }
    if (saved > 0) console.log(`[auto-memory] 已写入 ${saved} 条记忆`)
    return saved
  } catch (e) {
    console.warn(`[auto-memory] 提炼失败，忽略：${(e as Error).message}`)
    return 0
  }
}

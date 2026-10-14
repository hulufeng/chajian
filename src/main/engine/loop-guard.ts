/**
 * 循环守卫 — 循环级无菌动作检测（独立模块，对齐 TrieCode loop-engine 的 actionKey）。
 *
 * 与执行层 failureLedger（同工具+同参**失败**台账、连续失败≥3 升级）互补：
 * 本模块在**执行前**就按「tool + 归一化参数」记录重复调用——模型换个换行/空格再试、
 * 或同一只读动作刷轮，都会被参数归一化（trim + 超长内容 hash 化）识别为同一动作。
 *
 * 语义与 TrieCode 的差异（有意为之）：
 *  TrieCode 达阈值 → evaluateStop 判 budget 违规 → 整个任务终止，故需要 clearAction
 *  「清 key 放行一次」给模型自纠机会。LabCode 达阈值 → **仅拦截该次执行**并返回
 *  系统提示（模型下一轮自然换参数/换做法），任务不终止——不存在"恢复零回合即终止"
 *  的问题，因此不需要放行语义，重复同参调用会被一直拦到模型换做法为止。
 */
/** 同工具同参重复达到该次数判定无菌（沿用 LabCode 原阈值） */
export const STERILE_THRESHOLD = 3

/** 长字符串参数 hash（非加密，仅用于稳定去重标识） */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
    h |= 0
  }
  return (h >>> 0).toString(36)
}

/** 超长字符串参数：截断为「前 200 字符 + 全串 hash」。同一长内容得到同一 key（语义去重仍有效），
 *  又避免 key 里存几百 KB 原文（write_file 整文件场景）。短字符串 trim 后原样保留。 */
function compactArg(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (t.length <= 200) return t
  return `${t.slice(0, 200)}…(${hashStr(t)})`
}

/** 稳定动作键：tool + 参数 JSON（字符串值 trim + 超长 hash 化）。
 *  取代旧的「JSON.stringify(args).slice(0, 160)」——旧键下参数里加个换行就会改变
 *  前 160 字符从而绕过检测，大文件 write_file 也会把键撑爆。参数解析失败时退化为
 *  原始串整体 hash，仍可去重。 */
export function actionKey(tool: string, rawArgs: unknown): string {
  let args: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs || '{}')
    } catch {
      args = { __raw: rawArgs }
    }
  }
  let repr: string
  try {
    repr = JSON.stringify(args, (_k, v) => compactArg(v))
  } catch {
    repr = '[unserializable]'
  }
  return `${tool}::${repr}`
}

export class SterileGuard {
  private hits = new Map<string, number>()
  private threshold: number

  constructor(threshold: number = STERILE_THRESHOLD) {
    this.threshold = threshold
  }

  /** 记录一次动作，返回该 key 的累计次数 */
  record(key: string): number {
    const next = (this.hits.get(key) ?? 0) + 1
    this.hits.set(key, next)
    return next
  }

  /** 是否达无菌阈值（达到则调用方应拦截执行并返回系统提示） */
  shouldBlock(key: string): boolean {
    return (this.hits.get(key) ?? 0) >= this.threshold
  }

  /** 每轮 run 开始时重置（无菌状态不跨任务） */
  reset(): void {
    this.hits.clear()
  }
}

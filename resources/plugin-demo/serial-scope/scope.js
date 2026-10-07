'use strict'
/**
 * ASCII 波形渲染与频率估算（纯函数，可被自检直接测）。
 *
 * 为什么用 ASCII 而不是图形：插件跑在宿主里，没有图形上下文；
 * 而 Agent 读文本比读图片可靠得多——波形图能直接进对话让模型「看」出趋势。
 */

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/**
 * 把数值序列渲染成 ASCII 波形。
 * @param {number[]} values 数值序列
 * @param {number} width 宽度（字符数），超出则重采样压缩
 * @param {number} height 高度（行数）
 */
function renderWave(values, width = 60, height = 10) {
  width = Math.max(10, Math.min(200, Math.floor(width) || 60))
  height = Math.max(3, Math.min(40, Math.floor(height) || 10))
  if (!values || values.length === 0) return '(没有数据)'

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min

  // 全部等值时range为 0，直接画一条中线（否则除零得NaN）
  if (span === 0) {
    const line = BLOCKS[Math.floor(BLOCKS.length / 2)].repeat(Math.min(width, values.length))
    return line
  }

  // 宽度小于数据量：把每个桶取「最值」，保留尖峰（取平均会把尖峰抹平）
  let data = values
  if (values.length > width) {
    const bucketSize = values.length / width
    data = []
    for (let i = 0; i < width; i++) {
      const start = Math.floor(i * bucketSize)
      const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize))
      const slice = values.slice(start, end)
      // 保留上下界：这一格画最高和最低两点之间的连线才不会被尖峰骗
      data.push(slice.reduce((a, b) => (b > a.max ? { max: b, min: b } : a), { max: slice[0], min: slice[0] }))
    }
    // 为了简化渲染取 max 作代表值（最低点通过相邻位置体现）
    data = data.map((b) => b.max)
  }

  // 每列映射到一个块字符：按 (值-最小)/(跨度) 分 8 档
  const row = data
    .map((v) => {
      const ratio = (v - min) / span
      const idx = Math.max(0, Math.min(BLOCKS.length - 1, Math.round(ratio * (BLOCKS.length - 1))))
      return BLOCKS[idx]
    })
    .join('')

  const lines = [row]
  // 加一行刻度说明，让模型/用户知道量程
  lines.push(`  min=${min}  max=${max}  n=${values.length}`)
  return lines.join('\n')
}

/**
 * 估算采样频率与周期。
 * @param {number[]} values 数值序列
 * @param {number[]} intervals 相邻采样间隔（毫秒）；没有则退化为「按行数估」
 * @returns {{samples:number, intervalMs:number|null, freqHz:number|null, periodMs:number|null, gaps:number[], gapCount:number}}
 */
function estimateFrequency(values, intervals) {
  const n = values.length
  if (n < 2) {
    return { samples: n, intervalMs: null, freqHz: null, periodMs: null, gaps: [], gapCount: 0 }
  }
  const iv = Array.isArray(intervals) ? intervals.filter((x) => Number.isFinite(x) && x > 0) : []
  if (iv.length === 0) {
    // 没有时间戳：如实说「算不出」，不编一个频率出来
    return { samples: n, intervalMs: null, freqHz: null, periodMs: null, gaps: [], gapCount: 0, note: '无时间戳信息，无法估算频率（当前仅按样本数统计）' }
  }
  const avg = iv.reduce((a, b) => a + b, 0) / iv.length
  // 丢包/中断检测：间隔明显大于中位数（3 倍）视为一次卡顿
  const sortedIv = [...iv].sort((a, b) => a - b)
  const med = sortedIv[Math.floor(sortedIv.length / 2)]
  const gaps = []
  iv.forEach((x, i) => {
    if (med > 0 && x > med * 3) gaps.push({ index: i, intervalMs: x })
  })
  return {
    samples: n,
    intervalMs: avg,
    freqHz: avg > 0 ? 1000 / avg : null, // Hz：1 秒 = 1000 ms
    periodMs: avg,
    medianIntervalMs: med,
    gaps: gaps.slice(0, 10),
    gapCount: gaps.length
  }
}

/** 从一行文本里尝试提取时间戳（毫秒）；支持 Unix 时间戳、ISO 串、相对毫秒数 */
function parseTimestamp(line) {
  const s = String(line || '')
  // Unix 秒（10 位）/毫秒（13 位）
  const unix = /(?:^|\s|\[|ts=)(\d{10}|\d{13})(?:\s|$|\])/.exec(s)
  if (unix) {
    const n = Number(unix[1])
    return n > 1e12 ? n : n * 1000
  }
  // 相对毫秒数（3~9 位，如 "ts=100" / "[250]"）：设备常只输出开机以来的毫秒数
  const rel = /(?:ts=|ms=|^\[)(\d{3,9})\]?$/.exec(s.trim())
  if (rel) return Number(rel[1])
  // ISO 8601
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/.exec(s)
  if (iso) {
    const t = Date.parse(iso[1])
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 从日志行里提取时间戳序列（返回毫秒数组，跳过无时间戳的行） */
function extractIntervals(lines) {
  const ts = []
  for (const l of lines) {
    const t = parseTimestamp(l)
    if (t !== null) ts.push(t)
  }
  const intervals = []
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1]
    if (d > 0) intervals.push(d)
  }
  return intervals
}

module.exports = { renderWave, estimateFrequency, parseTimestamp, extractIntervals, BLOCKS }
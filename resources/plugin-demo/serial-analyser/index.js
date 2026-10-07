'use strict'
/**
 * 串口数据分析器 —— 插件入口。
 *
 * 能力边界（硬件访问全走宿主通道，插件自己不碰串口）：
 *   serial.list  列出串口（宿主 backend 命令，设备面板下拉用）
 *   serial.peek  读会话累积日志（宿主 backend 命令）
 * 插件只负责「格式识别 + 统计计算」，纯函数在 analyser.js 里（可被自检直接测）。
 */

const { detect, columnValues, stats } = require('./analyser.js')

/** 异常跳变阈值（σ），可被插件设置覆盖 */
let sigma = 3
let host = null

/** 取一段设备输出：优先用传入文本，否则回读宿主会话 */
function readText(args) {
  const explicit = args && typeof args.text === 'string' ? args.text : ''
  if (explicit) return { ok: true, text: explicit }
  if (!host || typeof host.invoke !== 'function') {
    return { ok: false, error: '未提供 text，且宿主未开放 invoke 通道，无法读取串口会话' }
  }
  const maxLines = Number(args && args.maxLines) > 0 ? Number(args.maxLines) : 200
  const res = host.invoke('backend', 'serial.peek', { maxLines })
  const data = res && typeof res === 'object' ? res.data : res
  return { ok: true, text: typeof data === 'string' ? data : '' }
}

/** 识别格式 */
function detectCmd(args) {
  const { ok, text, error } = readText(args)
  if (!ok) return { ok: false, error }
  if (!text.trim()) return { ok: false, error: '串口还没有输出（先打开串口监视器）' }
  const d = detect(text)
  return {
    ok: true,
    format: d.format,
    columns: d.columns,
    rows: d.rows,
    sampleRows: d.sampleRows || []
  }
}

/** 对一列（或所有数值列）做统计 */
function statsCmd(args) {
  const { ok, text, error } = readText(args)
  if (!ok) return { ok: false, error }
  if (!text.trim()) return { ok: false, error: '串口还没有输出（先打开串口监视器）' }
  const d = detect(text)
  if (d.rows === 0) return { ok: false, error: '没解析出任何数据行' }

  const wanted = args && args.column !== undefined && args.column !== '' ? args.column : undefined
  if (wanted !== undefined) {
    const { key, values } = columnValues(d, wanted)
    if (!key) return { ok: false, error: `找不到列「${wanted}」，可用列：${d.columns.join(', ') || '(无)'}` }
    return { ok: true, format: d.format, column: key, stats: stats(values, sigma) }
  }

  // 未指定列：对每个含数值的列各统计一份
  const result = {}
  for (const c of d.columns) {
    const { values } = columnValues(d, c)
    if (values.length > 0) result[c] = stats(values, sigma)
  }
  if (Object.keys(result).length === 0) {
    return { ok: false, error: '没有可用于统计的数值列' }
  }
  return { ok: true, format: d.format, rows: d.rows, columns: result }
}

/** 一键分析：格式 + 统计摘要（给「帮我看看正常吗」用） */
function analyse(args) {
  const s = statsCmd(args)
  if (!s.ok) return s
  const lines = []
  lines.push(`数据格式：${s.format}${s.rows ? `（${s.rows} 行）` : ''}`)
  const cols = s.columns || {}
  const names = Object.keys(cols)
  if (names.length > 0) {
    lines.push('')
    for (const c of names) {
      const st = cols[c]
      lines.push(
        `  ${c}：均值 ${fmt(st.mean)}，中位数 ${fmt(st.median)}，标准差 ${fmt(st.stddev)}，` +
          `范围 [${fmt(st.min)}, ${fmt(st.max)}]${st.outlierCount ? `，异常点 ${st.outlierCount} 个` : ''}`
      )
    }
  }
  return { ok: true, summary: lines.join('\n'), detail: s }
}

/** 数值格式化：保留 3 位有效小数，整数不带小数点 */
function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--'
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(3)).toString()
}

/** 纯解析入口（internal）：给 Agent 直接喂文本用，不依赖串口会话 */
function parse(args) {
  return detectCmd(args)
}

function load(ctx) {
  host = ctx
  ctx.registerBackend('serial.analyse', (args, emit) => {
    const r = analyse(args || {})
    emit?.(r.ok ? r.summary + '\n' : `[serial] ${r.error || '分析失败'}\n`)
    return r
  })
  ctx.registerBackend('serial.stats', (args) => statsCmd(args || {}))
  ctx.registerBackend('serial.detect', (args) => detectCmd(args || {}))
  ctx.registerInternal('serial.parse', (args) => parse(args || {}))
}

module.exports = { load, detect: detectCmd, stats: statsCmd, analyse, parse }
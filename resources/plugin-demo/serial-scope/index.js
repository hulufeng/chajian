'use strict'
/**
 * 串口波形监视器 —— 插件入口。
 *
 * 复用宿主 serial.peek 拿数据，自己只做渲染与估算（纯函数在 scope.js）。
 * 渲染成 ASCII 而非图片的理由：Agent 能直接读文本波形并据此判断趋势/抖动。
 */

const { renderWave, estimateFrequency, extractIntervals } = require('./scope.js')

// 注意：这里**不require 另一个插件**（如 serial-analyser 的解析器）。
// 插件是各自独立的 zip 包，跨插件 require 会在对方未安装时直接崩掉。
// 代价是解析逻辑有一份精简副本，换来的是每个插件真正自包含。
// 只取本插件需要的最小能力：识别分隔符 → 找数值列。

let host = null
let defaultHeight = 10

/** 从一行里解析数值（支持单位后缀，如 23.5C / 12ms / 3.3V） */
function parseNumber(raw) {
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*([a-zA-Z%°]*)/.exec(String(raw ?? '').trim())
  if (!m) return null
  const n = Number(m[0].slice(0, m[0].search(/[a-zA-Z%°]/)) || m[0])
  return Number.isFinite(n) ? n : null
}

/** 识别格式并取出第一个含数值列的序列（精简版，仅覆盖 CSV/TSV/JSON/键值对） */
function extractSeriesFromText(text, wanted) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null

  const rows = []
  let columns = []

  // JSON 行
  if (lines[0].startsWith('{') || lines[0].startsWith('[')) {
    try {
      for (const l of lines) {
        const o = JSON.parse(l)
        if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o)
      }
    } catch {
      rows.length = 0
    }
    if (rows.length > 0) {
      columns = [...new Set(rows.flatMap((o) => Object.keys(o).filter((k) => parseNumber(o[k]) !== null)))]
    }
  }

  // CSV / TSV
  if (rows.length === 0) {
    for (const d of ['\t', ',', ';', '|']) {
      const head = lines[0].split(d)
      if (head.length < 2) continue
      const body = lines.slice(1).map((l) => l.split(d))
      if (!body.every((r) => r.length === head.length)) continue
      columns = head.map((h) => h.trim())
      for (const r of body) {
        const o = {}
        columns.forEach((c, i) => {
          o[c] = r[i]
        })
        rows.push(o)
      }
      break
    }
  }

  // 键值对（key=value / key: value）
  if (rows.length === 0) {
    for (const l of lines) {
      const o = {}
      for (const seg of l.split(/[,;]/)) {
        const m = /^([^:=\s]+)\s*[:=]\s*(.+)$/.exec(seg.trim())
        if (m) o[m[1].trim()] = m[2].trim()
      }
      if (Object.keys(o).length > 0) rows.push(o)
    }
    if (rows.length > 0) {
      columns = [...new Set(rows.flatMap((o) => Object.keys(o).filter((k) => parseNumber(o[k]) !== null)))]
    }
  }

  // 兜底：纯文本逐行取数字
  if (rows.length === 0) {
    const values = lines.map(parseNumber).filter((n) => n !== null)
    if (values.length === 0) return null
    return { key: 'value', values, format: 'text' }
  }

  if (columns.length === 0) return null
  const key = wanted !== undefined && wanted !== '' && columns.includes(String(wanted))
    ? String(wanted)
    : columns[0]
  const values = rows.map((r) => parseNumber(r[key])).filter((n) => n !== null)
  if (values.length === 0) return null
  return { key, values, format: 'table', columns }
}

function readLog(args) {
  const maxLines = Number(args && args.maxLines) > 0 ? Number(args.maxLines) : 300
  if (!host || typeof host.invoke !== 'function') {
    return { ok: false, error: '宿主未提供 invoke 通道，无法读取串口会话' }
  }
  const res = host.invoke('backend', 'serial.peek', { maxLines })
  const data = res && typeof res === 'object' ? res.data : res
  return { ok: true, text: typeof data === 'string' ? data : '' }
}

/** 取出数值序列 + 原始行（时间戳要从原始行里提取） */
function extractSeries(args) {
  const r = readLog(args)
  if (!r.ok) return r
  if (!r.text.trim()) return { ok: false, error: '串口还没有输出（先打开串口监视器）' }
  const lines = r.text.split(/\r?\n/).filter((l) => l.trim())
  const wanted = args && args.column !== undefined && args.column !== '' ? args.column : undefined
  const parsed = extractSeriesFromText(r.text, wanted)
  if (!parsed) return { ok: false, error: '没解析出数值数据（期望 CSV/JSON/键值对格式）' }
  return { ok: true, key: parsed.key, values: parsed.values, lines, format: parsed.format }
}

/** 画波形 */
function wave(args) {
  const s = extractSeries(args)
  if (!s.ok) return s
  const width = Number(args && args.width) > 0 ? Number(args.width) : 60
  const height = Number(args && args.height) > 0 ? Number(args.height) : defaultHeight
  const art = renderWave(s.values, width, height)
  return {
    ok: true,
    column: s.key,
    format: s.format,
    samples: s.values.length,
    art
  }
}

/** 频率 / 周期 / 丢包 */
function freq(args) {
  const s = extractSeries(args)
  if (!s.ok) return s
  const intervals = extractIntervals(s.lines)
  const est = estimateFrequency(s.values, intervals)
  const lines = [
    `列：${s.key}（格式 ${s.format}），样本 ${est.samples} 个`
  ]
  if (est.freqHz !== null) {
    lines.push(`平均间隔 ${est.intervalMs.toFixed(1)}ms → 频率 ${est.freqHz.toFixed(2)}Hz（周期 ${est.periodMs.toFixed(1)}ms）`)
    lines.push(`中位间隔 ${est.medianIntervalMs.toFixed(1)}ms`)
    if (est.gapCount > 0) {
      lines.push(`检测到 ${est.gapCount} 处间隔突变（>3×中位数），可能是数据中断或丢包`)
    } else {
      lines.push('采样间隔均匀，未见明显丢包')
    }
  } else {
    lines.push(est.note || '无时间戳信息，无法估算频率')
  }
  return { ok: true, column: s.key, summary: lines.join('\n'), detail: est }
}

function load(ctx) {
  host = ctx
  ctx.registerBackend('scope.wave', (args, emit) => {
    const r = wave(args || {})
    if (!r.ok) {
      emit?.(`[scope] ${r.error || '渲染失败'}\n`)
      return r
    }
    emit?.(`列 ${r.column}（${r.samples} 样本）波形：\n${r.art}\n`)
    return r
  })
  ctx.registerBackend('scope.stats', (args, emit) => {
    const r = freq(args || {})
    if (!r.ok) {
      emit?.(`[scope] ${r.error || '估算失败'}\n`)
      return r
    }
    emit?.(r.summary + '\n')
    return r
  })
  ctx.registerBackend('scope.frequency', (args) => freq(args || {}))
}

module.exports = { load, wave, freq }
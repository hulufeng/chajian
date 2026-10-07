'use strict'
/**
 * 串口数据分析的纯函数（无 IO，可被自检脚本直接 require 验证）。
 *
 * 设计要点：真实设备输出格式很杂，所以识别器按「命中优先级」尝试多种格式，
 * 而不是死板地只认一种：
 *   1. JSON 行（含 { 或 [ 开头，JSON.parse 能过）
 *   2. CSV / TSV（含分隔符且各行字段数一致）
 *   3. 键值对（`key=value` / `key: value` 混合）
 *   4. 纯文本（兜底：只统计能提取到的数字）
 * 识别不出来时如实返回 format:'unknown'，不硬套格式。
 */

/** 从一行文本里解析出数值；支持单位后缀（如 23.5C / 12ms / 3.3V / 1.5e3） */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!s) return null
  // 先按「纯数值」整体尝试（含科学计数法），这样 1.5e3 不会被误截成 1.5
  const direct = Number(s)
  if (Number.isFinite(direct)) return direct
  // 再退到「带单位后缀」：把末尾的非数字单位剥掉
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*([a-zA-Z%°]+)/.exec(s)
  if (!m) return null
  const n = Number(m[0].slice(0, m[0].length - m[1].length).trim())
  return Number.isFinite(n) ? n : null
}

/**
 * 提取一行里出现的**第一个**数字（允许数字前后有任意文字/单位）。
 * 用于「温度 23.5 度」「T=23.5C」「lux: 120」这类真实设备输出——
 * 这些行parseNumber（要求整串是数字）解析不了，但数字确实在里面。
 * @returns {number|null}
 */
function firstNumberIn(line) {
  const s = String(line ?? '')
  // 匹配带可选正负号/小数/指数的数字，允许后面跟单位字母
  const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/** 猜分隔符：优先 tab（设备串口常见），其次逗号、分号 */
function detectDelimiter(lines) {
  const candidates = ['\t', ',', ';', '|']
  let best = null
  for (const d of candidates) {
    const counts = lines.map((l) => l.split(d).length)
    if (counts.length === 0) continue
    // 所有非空行字段数一致才算合法表头
    const first = counts[0]
    if (first < 2) continue
    if (counts.every((c) => c === first)) {
      // 分隔符出现得越少越"像"是分隔符（逗号可能出现在文本里），用更靠后的候选优先
      if (!best || first > best.fields) best = { delim: d, fields: first }
    }
  }
  return best
}

/**
 * 识别文本的数据格式。
 * @returns {{format:string, columns:string[], rows:number, rowsData?:object[], sampleRows?:string[]}}
 */
function detect(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return { format: 'empty', columns: [], rows: 0, sampleRows: [] }
  }

  // ① JSON 行
  const jsonRows = []
  for (const l of lines) {
    if (!(l.startsWith('{') || l.startsWith('['))) continue
    try {
      jsonRows.push(JSON.parse(l))
    } catch {
      // 不是合法 JSON 行，放弃 JSON 方案
      break
    }
  }
  if (jsonRows.length > 0 && jsonRows.length >= Math.ceil(lines.length / 2)) {
    const columns = new Set()
    for (const r of jsonRows) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        for (const k of Object.keys(r)) if (typeof r[k] === 'number') columns.add(k)
      }
    }
    return {
      format: 'json',
      columns: [...columns],
      rows: jsonRows.length,
      rowsData: jsonRows,
      sampleRows: lines.slice(0, 3)
    }
  }

  // ② CSV / TSV（第一行当表头）
  // 注意 detectDelimiter 返回的是 {delim, fields}，这里要取 .delim（曾把它当字符串用过，导致表头不被切分）
  const delimInfo = detectDelimiter(lines)
  if (delimInfo) {
    const delim = delimInfo.delim
    const header = lines[0].split(delim).map((h) => h.trim())
    const rows = lines.slice(1).map((l) => l.split(delim).map((c) => c.trim()))
    return {
      format: delim === '\t' ? 'tsv' : 'csv',
      delimiter: delim,
      columns: header,
      rows: rows.length,
      rowsData: rows.map((r) => {
        const o = {}
        header.forEach((h, i) => {
          o[h] = r[i]
        })
        return o
      }),
      sampleRows: lines.slice(0, 3)
    }
  }

  // ③ 键值对：`k=v` 或 `k: v`
  const kv = /^([^:=\s]+)\s*[:=]\s*(.+)$/.exec(lines[0])
  if (kv && lines.length >= 2) {
    const rowsData = []
    const columns = new Set()
    for (const l of lines) {
      const o = {}
      for (const seg of l.split(/[,;]/)) {
        const m = /^([^:=\s]+)\s*[:=]\s*(.+)$/.exec(seg.trim())
        if (!m) continue
        o[m[1].trim()] = m[2].trim()
        if (parseNumber(m[2]) !== null) columns.add(m[1].trim())
      }
      if (Object.keys(o).length > 0) rowsData.push(o)
    }
    if (rowsData.length > 0) {
      return {
        format: 'kv',
        columns: [...columns],
        rows: rowsData.length,
        rowsData,
        sampleRows: lines.slice(0, 3)
      }
    }
  }

  // ④ 兜底：纯文本。
  // 注意两点：
  //  1) 第一行如果本身就是数字，它也是**数据**而不是表头——单列数据流很常见
  //     （例如只输出一个传感器读数），把首行当表头吃掉会平白少一个样本。
  //  2) 数字常常不在行首（"温度 23.5 度" / "T=23.5C"），所以要能从行内提取。
  const firstIsData = parseNumber(lines[0]) !== null || firstNumberIn(lines[0]) !== null
  const dataLines = firstIsData ? lines : lines.slice(1)
  const numbers = []
  for (const l of dataLines) {
    const n = firstNumberIn(l)
    if (n !== null) numbers.push(n)
  }
  // 表头名：首行是数据时用 'value'，否则用首行原文（并把其中的数字挖掉当列名不合适，直接截断）
  const colName = firstIsData ? 'value' : lines[0].slice(0, 40)
  return {
    format: 'text',
    columns: [colName],
    rows: numbers.length,
    rowsData: numbers.map((n) => ({ [colName]: n })),
    sampleRows: lines.slice(0, 3)
  }
}

/** 取某一列的数值序列；column 可给列名或列序号 */
function columnValues(detected, column) {
  const rows = detected.rowsData || []
  let key = null
  if (column === undefined || column === null || column === '') {
    // 未指定：取第一个含数值的列
    key = detected.columns.find((c) => rows.some((r) => parseNumber(r[c]) !== null)) ?? null
  } else if (typeof column === 'number' || /^\d+$/.test(String(column))) {
    const idx = Number(column)
    key = detected.columns[idx] ?? null
  } else {
    key = String(column)
  }
  if (!key) return { key: null, values: [] }
  const values = []
  for (const r of rows) {
    // 用 firstNumberIn 而不是 parseNumber：单元格可能是 "23.5C" / "60%" 这种带单位的
    const n = firstNumberIn(r[key])
    if (n !== null) values.push(n)
  }
  return { key, values }
}

/** 中位数（统计必需，不能只给均值——分布偏斜时均值会骗人） */
function median(sorted) {
  const n = sorted.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 对一列数值做统计。
 *
 * 离群点判定用 **MAD（中位数绝对偏差）** 而不是 3σ：
 * 3σ 的 σ 会被离群点自己撑大——实测 [10,12,11,13,12,100] 里100 是明显的坏点，
 * 但 σ 被拉到 33，导致 100 只偏离 2.24σ 反而「不算离群」，完全检不出。
 * MAD 用中位数派生，坏点不会影响判定基准，稳健得多。
 * 换算关系：MAD × 1.4826 ≈ 标准差（正态分布下），所以阈值默认取 3（≈3σ）。
 *
 * @param {number[]} values
 * @param {number} madSigma MAD 倍数阈值，默认 3（≈ 3σ）
 */
function stats(values, madSigma = 3) {
  const n = values.length
  if (n === 0) {
    return { count: 0, mean: null, median: null, stddev: null, mad: null, min: null, max: null, outliers: [], outlierCount: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((a, b) => a + b, 0)
  const mean = sum / n
  // 总体标准差（描述这批数据的离散程度，保留在输出里供参考）
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  const med = median(sorted)

  // MAD：各点到中位数的绝对偏差的中位数
  const mad = median(values.map((v) => Math.abs(v - med)).sort((a, b) => a - b))

  const outliers = []
  if (mad > 0) {
    // MAD 换算到 σ 尺度再乘阈值
    const limit = madSigma * mad * 1.4826
    const lo = med - limit
    const hi = med + limit
    values.forEach((v, i) => {
      if (v < lo || v > hi) outliers.push({ index: i, value: v })
    })
  } else if (stddev > 0) {
    // MAD 为 0（半数以上的值完全相同）时退回 3σ：
    // 这时数据高度集中，用极小的 MAD×阈值 会把任何差异都当离群，太激进
    const lo = mean - 3 * stddev
    const hi = mean + 3 * stddev
    values.forEach((v, i) => {
      if (v < lo || v > hi) outliers.push({ index: i, value: v })
    })
  }

  return {
    count: n,
    mean,
    median: med,
    stddev,
    mad,
    min: sorted[0],
    max: sorted[n - 1],
    outliers: outliers.slice(0, 20),
    outlierCount: outliers.length
  }
}

module.exports = { parseNumber, firstNumberIn, detect, columnValues, stats, median }
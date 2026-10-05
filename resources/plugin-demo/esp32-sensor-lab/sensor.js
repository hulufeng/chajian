'use strict'
/**
 * ESP32 传感器实验台 —— 采样解析与历史缓冲。
 *
 * 设备侧固件只需按下面任意一种格式往串口打一行，本插件即可解析：
 *   T=26.4 H=58.1 L=312          （紧凑格式，默认）
 *   SENSOR T=26.4 H=58.1 L=312   （带前缀）
 *   {"tempC":26.4,"humPct":58.1,"lux":312}   （JSON 行）
 *
 * 解析全部自己实现（正则 + 量程校验），不依赖任何第三方库。
 */

/** 紧凑格式字段：T 温度℃ / H 湿度% / L 光照lux */
const FIELD_MAP = { T: 'tempC', H: 'humPct', L: 'lux' }
const FIELD_RE = /(?:^|[\s,;|\[{])([TLH])=(-?\d+(?:\.\d+)?)/g

/** 量程白名单：越界值一律丢弃（防止串口噪声/乱码被当成读数） */
const LIMITS = {
  tempC: [-55, 150],
  humPct: [0, 100],
  lux: [0, 200000]
}

function inRange(key, value) {
  const range = LIMITS[key]
  if (!range) return false
  return value >= range[0] && value <= range[1]
}

/** 解析一行设备输出，返回 { tempC, humPct, lux } 的子集；解析不出就返回 null */
function parseSampleLine(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (!text) return null

  // JSON 行
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text)
      const out = {}
      for (const key of Object.keys(LIMITS)) {
        const v = Number(obj[key])
        if (Number.isFinite(v) && inRange(key, v)) out[key] = v
      }
      return Object.keys(out).length > 0 ? out : null
    } catch {
      /* 落回紧凑格式 */
    }
  }

  FIELD_RE.lastIndex = 0
  const out = {}
  let m
  while ((m = FIELD_RE.exec(text)) !== null) {
    const key = FIELD_MAP[m[1]]
    if (!key || out[key] !== undefined) continue
    const v = Number(m[2])
    if (inRange(key, v)) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 从多行文本里按行解析，返回 [{ line, sample, index }]，跳过无法解析的行 */
function parseSampleBlock(text) {
  if (typeof text !== 'string' || !text) return []
  const lines = text.split(/\r?\n/)
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const sample = parseSampleLine(lines[i])
    if (sample) result.push({ line: i, sample })
  }
  return result
}

/** 环形缓冲：只保留最近 cap 帧，避免长期挂着串口把内存吃满 */
function createHistory(cap = 20) {
  const items = []
  return {
    push(sample) {
      items.push({
        tempC: sample.tempC ?? null,
        humPct: sample.humPct ?? null,
        lux: sample.lux ?? null,
        at: Date.now()
      })
      if (items.length > cap) items.splice(0, items.length - cap)
      return items.length
    },
    all: () => items.slice(),
    latest: () => (items.length ? items[items.length - 1] : null),
    clear: () => {
      items.length = 0
    }
  }
}

/** 对一组采样做均值/极值统计（曲线面板顶部摘要用） */
function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { count: 0 }
  const agg = { count: samples.length }
  for (const [key, label] of [['tempC', 'tempC'], ['humPct', 'humPct'], ['lux', 'lux']]) {
    const nums = samples.map((s) => s[key]).filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (nums.length === 0) continue
    agg[label] = {
      min: Math.min(...nums),
      max: Math.max(...nums),
      avg: nums.reduce((a, b) => a + b, 0) / nums.length
    }
  }
  return agg
}

module.exports = { parseSampleLine, parseSampleBlock, createHistory, summarize, LIMITS, FIELD_MAP }

'use strict'
/**
 * ESP32 传感器实验台 —— 插件入口。
 *
 * 能力边界（全部通过宿主通道拿到，插件自己不直接碰串口/硬件）：
 *   serial.list  列出当前串口（宿主 backend 命令）
 *   serial.peek  读取会话累积日志（宿主 backend 命令）
 * 插件只负责「解析 + 缓冲 + 统计」，硬件细节留在宿主侧，插件卸载不留残留。
 */

const { parseSampleBlock, createHistory, summarize } = require('./sensor.js')

const HISTORY_CAP = 20
const history = createHistory(HISTORY_CAP)
let host = null

/** 向宿主要一段设备输出；宿主没提供 invoke 通道时明确报错，不假装成功 */
function readDeviceOutput(maxLines) {
  if (!host || typeof host.invoke !== 'function') {
    return { ok: false, error: '宿主未提供 invoke 通道，无法读取串口' }
  }
  const res = host.invoke('backend', 'serial.peek', { maxLines })
  const data = res && typeof res === 'object' ? res.data : res
  return { ok: true, data: typeof data === 'string' ? data : '' }
}

/** 串口扫描（devicePanel 的端口下拉用）
 *  宿主命令可能是异步 handler，统一 Promise.resolve 一下再取 ports */
function scan() {
  if (!host || typeof host.invoke !== 'function') return { ok: false, error: '宿主未提供 invoke 通道' }
  return Promise.resolve(host.invoke('backend', 'serial.list', {})).then((res) => {
    const ports = res && Array.isArray(res.ports) ? res.ports : []
    return { ok: true, ports: ports.map((p) => ({ path: p.path, label: p.label || p.path, desc: p.description || '' })) }
  })
}

/** 读一次采样：回溯设备输出 → 解析 → 入历史缓冲 */
function sample(args) {
  const maxLines = Number(args && args.maxLines) > 0 ? Number(args.maxLines) : 40
  const { ok, data, error } = readDeviceOutput(maxLines)
  if (!ok) return { ok: false, error }
  if (!data) return { ok: false, error: '串口还没有输出（先打开串口监视器）' }

  const hits = parseSampleBlock(data)
  if (hits.length === 0) {
    return {
      ok: false,
      error: '解析不到采样行（期望 T=温度 H=湿度 L=光照，或一行 JSON）',
      tail: data.slice(-200)
    }
  }
  for (const h of hits) history.push(h.sample)
  const items = history.all()
  return {
    ok: true,
    sample: hits[hits.length - 1].sample,
    stats: summarize(items),
    history: items,
    parsed: hits.length
  }
}

/** 最近历史（曲线面板直接用） */
function historyCmd(args) {
  const items = history.all()
  const cap = Number(args && args.limit) > 0 ? Number(args.limit) : HISTORY_CAP
  return { ok: true, history: items.slice(-cap), stats: summarize(items) }
}

/** 纯解析：给 Agent 用，把一段文本解析成采样列表（不依赖串口会话） */
function parse(args) {
  const text = args && typeof args.text === 'string' ? args.text : ''
  const hits = parseSampleBlock(text)
  if (hits.length === 0) return { ok: false, error: '解析不到采样行', parsed: 0 }
  return { ok: true, parsed: hits.length, samples: hits.map((h) => h.sample), stats: summarize(hits.map((h) => h.sample)) }
}

function load(ctx) {
  host = ctx
  ctx.registerBackend('sensor.scan', () => scan())
  ctx.registerBackend('sensor.sample', (_args, emit) => {
    const r = sample({})
    if (!r.ok) {
      const msg = r.error || '未知错误'
      emit?.(`[sensor] ${msg}${r.tail ? `\n${r.tail}` : ''}\n`)
      return { ok: false, error: msg }
    }
    const s = r.sample
    emit?.(
      `温度 ${s.tempC ?? '--'}℃  湿度 ${s.humPct ?? '--'}%  光照 ${s.lux ?? '--'}  （本轮解析 ${r.parsed} 帧）\n`
    )
    return r
  })
  ctx.registerBackend('sensor.history', (args) => historyCmd(args))
  ctx.registerInternal('sensor.parse', (args) => parse(args))
}

module.exports = { load, scan, sample, history: historyCmd, parse }

/**
 * 仪器服务（#13）：把接在串口上的 ESP32-S3「仪器固件」变成逻辑分析仪 / 示波器 / 功率计。
 *
 * 设计要点：
 *  - 复用 serialService 的 serialport 动态加载（原生模块缺失时优雅降级，不崩主进程）。
 *  - 控制面用纯文本行协议（ASCII），采样数据用二进制帧（0xAA 0x55 魔数 + 类型 + 长度 + 负载 + CRC），
 *    两者可混在同一串口流里：解析器遇到魔数走帧，否则把到换行前的字节当日志/控制回显。
 *  - 单一仪器连接（同一时刻只跟一块 ESP32-S3 仪器板通信），主进程通过 sink 把数据/日志/状态推给渲染层。
 *
 * 二进制帧格式（小端）：
 *   [0] 0xAA  [1] 0x55  [2] type  [3..4] len(LE)  [5..5+len-1] payload  [5+len] crc8(payload 字节和 & 0xff)
 *   type=1 逻辑分析仪：u32 sampleRateHz | u32 triggerIndex(0xFFFFFFFF=无) | u8 channelCount | u8 channelMask
 *                       | u16 sampleCount | sampleCount 字节（每字节=各通道电平位图，bit i=通道 i 电平）
 *   type=2 示波器：    u32 sampleRateHz | u8 channel | u16 sampleCount | sampleCount*2 字节 int16 LE（ADC 原始值）
 *   type=3 功率计：    f32 busV | f32 shuntV | f32 currentA | f32 powerW
 */

import { listPorts, serialportModule } from './serialService'
import type { SerialPortInfo } from './serialService'
import type { SerialPort } from 'serialport'

// ── 帧类型 ──
export const FRAME_MAGIC_0 = 0xaa
export const FRAME_MAGIC_1 = 0x55
export const FRAME_LA = 0x01
export const FRAME_SCOPE = 0x02
export const FRAME_POWER = 0x03

// ── 渲染层消费的数据结构 ──
export interface LogicAnalyzerFrame {
  kind: 'la'
  sampleRate: number
  triggerIndex: number
  channelCount: number
  channelMask: number
  sampleCount: number
  /** 每个元素是一个字节位图：bit i 置位 = 第 i 通道为高电平 */
  samples: number[]
}
export interface ScopeFrame {
  kind: 'scope'
  sampleRate: number
  channel: number
  sampleCount: number
  /** int16 ADC 原始值 */
  values: number[]
}
export interface PowerReading {
  kind: 'power'
  busV: number
  shuntV: number
  currentA: number
  powerW: number
  present: boolean
}
export type InstrumentData = LogicAnalyzerFrame | ScopeFrame | PowerReading

export interface InstrumentCaps {
  idn?: string
  la?: { maxChannels: number; maxRateHz: number; maxSamples: number }
  scope?: { channels: number[]; maxRateHz: number; maxSamples: number }
  power?: { supported: boolean; i2cAddr?: number }
}

export interface ConnectResult {
  ok: boolean
  error?: string
  port?: string
}

export interface LogicAnalyzerConfig {
  channelMask: number
  sampleRate: number
  preSamples: number
  postSamples: number
  trigChannel: number // 0..7，-1 = 不触发
  trigEdge: 0 | 1 // 0=下降沿 1=上升沿
}
export interface ScopeConfig {
  channel: number // ADC1 通道号 0..9（对应 GPIO1..GPIO10）
  sampleRate: number
  sampleCount: number
}

type Sink = (channel: string, payload: unknown) => void

let sink: Sink | null = null
let instPort: SerialPort | null = null
let instId = ''
let inBuf = Buffer.alloc(0)
let caps: InstrumentCaps = {}
let lastCapture: InstrumentData | null = null
let connecting = false

/** 主进程调用：把仪器事件转发到渲染层（mainWindow.webContents.send 的薄封装）。 */
export function setInstrumentSink(fn: Sink | null): void {
  sink = fn
}
function emitData(d: InstrumentData): void {
  lastCapture = d
  sink?.('instruments:data', d)
}
function emitLog(line: string): void {
  sink?.('instruments:log', line)
}
function emitStatus(s: Partial<InstrumentCaps> & { connected?: boolean; port?: string; error?: string }): void {
  sink?.('instruments:status', s)
}

export function listInstrumentPorts(): Promise<SerialPortInfo[]> {
  return listPorts()
}

export function getCapabilities(): InstrumentCaps {
  return caps
}
export function getLastCapture(): InstrumentData | null {
  return lastCapture
}

export function connectInstruments(opts: { port: string; baud: number }): ConnectResult {
  if (!serialportModule) {
    return { ok: false, error: '当前环境未加载 serialport 原生模块（请执行 electron-rebuild）' }
  }
  if (instPort && instPort.isOpen) {
    return { ok: false, error: `已连接到 ${instId}，请先断开` }
  }
  if (connecting) return { ok: false, error: '正在连接中，请稍候' }
  connecting = true
  instId = `instruments-${opts.port}`
  inBuf = Buffer.alloc(0)
  try {
    const port = new serialportModule.SerialPort({ path: opts.port, baudRate: opts.baud }, (err) => {
      connecting = false
      if (err) {
        emitStatus({ connected: false, port: opts.port, error: `打开串口失败：${err.message}` })
        return
      }
      instPort = port
      emitStatus({ connected: true, port: opts.port })
      emitLog(`[${opts.port}] 仪器已连接 @ ${opts.baud}`)
      // 询问设备身份与能力
      sendInstrumentCommand('IDN?')
      sendInstrumentCommand('CAP?')
    })
    port.on('data', (d: Buffer) => {
      inBuf = Buffer.concat([inBuf, d])
      parseStream()
    })
    port.on('error', (err: Error) => {
      emitLog(`仪器串口错误：${err.message}`)
      emitStatus({ connected: false, port: opts.port, error: err.message })
    })
    port.on('close', () => {
      instPort = null
      emitLog(`[${opts.port}] 仪器已断开`)
      emitStatus({ connected: false, port: opts.port })
    })
    return { ok: true, port: opts.port }
  } catch (e) {
    connecting = false
    return { ok: false, error: (e as Error).message }
  }
}

export function disconnectInstruments(): { ok: boolean; error?: string } {
  if (!instPort) return { ok: false, error: '仪器未连接' }
  try {
    if (instPort.isOpen) instPort.close()
  } catch {
    /* 忽略 */
  }
  instPort = null
  return { ok: true }
}

export function sendInstrumentCommand(cmd: string): { ok: boolean; error?: string } {
  if (!instPort || !instPort.isOpen) return { ok: false, error: '仪器未连接' }
  // 发送失败统一走 'error' 事件，这里不传回调以规避 @serialport/stream 的 write 重载歧义
  instPort.write(cmd.endsWith('\n') ? cmd : cmd + '\n')
  return { ok: true }
}

export function armLogicAnalyzer(cfg: LogicAnalyzerConfig): { ok: boolean; error?: string } {
  const r = sendInstrumentCommand(
    `LA cfg ch=${cfg.channelMask} rate=${cfg.sampleRate} pre=${cfg.preSamples} post=${cfg.postSamples} trig=${cfg.trigChannel} edge=${cfg.trigEdge}`
  )
  if (!r.ok) return r
  return sendInstrumentCommand('LA arm')
}

export function armScope(cfg: ScopeConfig): { ok: boolean; error?: string } {
  const r = sendInstrumentCommand(`SCOPE cfg ch=${cfg.channel} rate=${cfg.sampleRate} nsamp=${cfg.sampleCount}`)
  if (!r.ok) return r
  return sendInstrumentCommand('SCOPE arm')
}

export function readPower(): { ok: boolean; error?: string } {
  return sendInstrumentCommand('PWR read')
}

// ── 流解析：区分二进制帧与 ASCII 文本行 ──
function parseStream(): void {
  // 安全上限：异常情况下防止无限增长
  if (inBuf.length > 2 * 1024 * 1024) inBuf = inBuf.subarray(inBuf.length - 1024 * 1024)
  let progress = true
  while (progress) {
    progress = false
    if (inBuf.length < 2) break
    if (inBuf[0] === FRAME_MAGIC_0 && inBuf[1] === FRAME_MAGIC_1) {
      if (inBuf.length < 5) break
      const type = inBuf[2]
      const len = inBuf[3] | (inBuf[4] << 8)
      const total = 5 + len + 1
      if (inBuf.length < total) break
      const payload = inBuf.subarray(5, 5 + len)
      const crc = inBuf[5 + len]
      if (crc8(payload) === crc) {
        dispatchFrame(type, payload)
      } else {
        emitLog(`[instruments] 帧 CRC 校验失败（type=${type}），已丢弃`)
      }
      inBuf = inBuf.subarray(total)
      progress = true
    } else {
      const nl = inBuf.indexOf(0x0a)
      if (nl < 0) {
        // 还没凑齐一行：保留（上限保护在上面）
        break
      }
      let line = inBuf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim()
      inBuf = inBuf.subarray(nl + 1)
      progress = true
      if (line.length === 0) continue
      handleTextLine(line)
    }
  }
}

function crc8(buf: Buffer): number {
  let s = 0
  for (let i = 0; i < buf.length; i++) s = (s + buf[i]) & 0xff
  return s
}

function handleTextLine(line: string): void {
  if (line.startsWith('CAP ')) {
    try {
      const parsed = JSON.parse(line.slice(4)) as InstrumentCaps
      caps = { ...caps, ...parsed }
      emitStatus({ ...caps })
    } catch {
      emitLog(line)
    }
    return
  }
  if (line.startsWith('IDN ')) {
    caps = { ...caps, idn: line.slice(4) }
    emitStatus({ ...caps })
    return
  }
  // OK / ERR / 普通日志一律透传给渲染层日志区
  emitLog(line)
}

function dispatchFrame(type: number, payload: Buffer): void {
  try {
    if (type === FRAME_LA) {
      let off = 0
      const sampleRate = payload.readUInt32LE(off); off += 4
      const triggerIndex = payload.readUInt32LE(off); off += 4
      const channelCount = payload.readUInt8(off); off += 1
      const channelMask = payload.readUInt8(off); off += 1
      const sampleCount = payload.readUInt16LE(off); off += 2
      const samples = Array.from(payload.subarray(off, off + sampleCount))
      emitData({ kind: 'la', sampleRate, triggerIndex, channelCount, channelMask, sampleCount, samples })
    } else if (type === FRAME_SCOPE) {
      let off = 0
      const sampleRate = payload.readUInt32LE(off); off += 4
      const channel = payload.readUInt8(off); off += 1
      const sampleCount = payload.readUInt16LE(off); off += 2
      const values: number[] = []
      for (let i = 0; i < sampleCount; i++) {
        values.push(payload.readInt16LE(off + i * 2))
      }
      emitData({ kind: 'scope', sampleRate, channel, sampleCount, values })
    } else if (type === FRAME_POWER) {
      let off = 0
      const busV = payload.readFloatLE(off); off += 4
      const shuntV = payload.readFloatLE(off); off += 4
      const currentA = payload.readFloatLE(off); off += 4
      const powerW = payload.readFloatLE(off); off += 4
      emitData({ kind: 'power', busV, shuntV, currentA, powerW, present: true })
    } else {
      emitLog(`[instruments] 未知帧类型 ${type}`)
    }
  } catch (e) {
    emitLog(`[instruments] 帧解析异常：${(e as Error).message}`)
  }
}

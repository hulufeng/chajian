/**
 * 模拟烧录引擎（软件内模拟 esptool 完整烧录流程）
 *
 * 对照已验证方案（esptool 5.4 真实烧录到 RFC2217 伪板成功）：
 * - 引擎实现 esptool 客户端动作序列：连接 → SYNC → 芯片识别 → stub 上传(OHAI)
 *   → 变更波特率 → 逐文件压缩烧写(FLASH_DEFL_BEGIN/DATA/END) → md5 校验 → 复位
 * - 输出日志与真实 esptool 完全一致的格式（Connected to / Chip type / Uploading stub
 *   / Writing at 0x... / Wrote ... in x.x seconds / Hash of data verified / Hard resetting）
 * - 协议为公开标准自行实现（ESP ROM 协议），无 GPL 传染，可闭源商用
 */

import * as net from 'net'
import * as zlib from 'zlib'
import { createHash } from 'crypto'
import { startFakeBoard, stopFakeBoard, FAKE_CHIPS } from './fakeBoardService'

// ---------- 常量 ----------
const SLIP_END = 0xc0
const SLIP_ESC = 0xdb
const SLIP_ESC_END = 0xdc
const SLIP_ESC_ESC = 0xdd
const IAC = 0xff
const COM_OPT = 0x2c

const CMD = {
  FLASH_BEGIN: 0x02,
  FLASH_DATA: 0x03,
  FLASH_END: 0x04,
  MEM_BEGIN: 0x05,
  MEM_END: 0x06,
  MEM_DATA: 0x07,
  SYNC: 0x08,
  WRITE_REG: 0x09,
  READ_REG: 0x0a,
  SPI_ATTACH: 0x0d,
  CHANGE_BAUDRATE: 0x0f,
  FLASH_DEFL_BEGIN: 0x10,
  FLASH_DEFL_DATA: 0x11,
  FLASH_DEFL_END: 0x12,
  SPI_FLASH_MD5: 0x13,
  GET_SECURITY_INFO: 0x14,
}

const BLOCK_SIZE = 0x4000 // 16KB
const DEFAULT_BAUD = 921600
/** 模拟传输速度（字节/秒），对齐 esptool 实测 ~900 kbit/s */
const SIM_BYTES_PER_SEC = 90000

export interface SimBurnFile {
  addr: number
  path: string
  label: string
}

export interface SimBurnOptions {
  chipId: string
  files: SimBurnFile[]
  baud?: number
  /** 外部取消标志（task:kill 置 true） */
  cancelFlag?: { cancelled: boolean }
}

export interface SimBurnHandle {
  cancel: () => void
  promise: Promise<SimBurnResult>
}

export interface SimBurnResult {
  ok: boolean
  filesWritten: number
  chipName: string
}

// ---------- SLIP ----------
function slipEncode(payload: Buffer): Buffer {
  const out: number[] = [SLIP_END]
  for (const b of payload) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END)
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC)
    else out.push(b)
  }
  out.push(SLIP_END)
  return Buffer.from(out)
}

function slipDecode(buf: Buffer): { payload: Buffer | null; consumed: number } {
  const out: number[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b === SLIP_END) return { payload: Buffer.from(out), consumed: i + 1 }
    else if (b === SLIP_ESC) {
      i++
      if (i < buf.length) {
        if (buf[i] === SLIP_ESC_END) out.push(SLIP_END)
        else if (buf[i] === SLIP_ESC_ESC) out.push(SLIP_ESC)
      }
      i++
    } else {
      out.push(b)
      i++
    }
  }
  return { payload: null, consumed: 0 }
}

/** RFC2217 数据通道 IAC 转义：数据流中的 0xFF 双写 */
function escapeIac(buf: Buffer): Buffer {
  if (!buf.includes(0xff)) return buf
  const out: number[] = []
  for (const b of buf) {
    if (b === 0xff) out.push(0xff, 0xff)
    else out.push(b)
  }
  return Buffer.from(out)
}

/** telnet 状态机（客户端复用，过滤 IAC 并应答服务器协商） */
class TelnetClientBuffer {
  private iacPending = false
  private negotiating: number | null = null
  private out: number[] = []

  feed(data: Buffer): { payload: Buffer; respond: Buffer } {
    this.out = []
    let i = 0
    while (i < data.length) {
      const b = data[i]
      if (this.iacPending) {
        this.iacPending = false
        if (b === IAC) {
          this.out.push(IAC)
          i++
          continue
        }
        // WILL/WONT/DO/DONT/SB —— 客户端应答或忽略
        if (b === 0xfb || b === 0xfc || b === 0xfd || b === 0xfe) {
          this.negotiating = b
          i++
          continue
        }
        i++
        continue
      }
      if (b === IAC) {
        this.iacPending = true
        i++
        continue
      }
      if (this.negotiating !== null) {
        const opt = b
        const verb = this.negotiating
        this.negotiating = null
        // 服务器 WILL → 客户端 DO；DO → 客户端 WILL
        if (verb === 0xfb) this.out.push(IAC, 0xfd, opt)
        else if (verb === 0xfd) this.out.push(IAC, 0xfb, opt)
        else this.out.push(IAC, 0xfe, opt) // WONT/DONT → DONT/WONT
        i++
        continue
      }
      this.out.push(b)
      i++
    }
    return { payload: Buffer.from(this.out), respond: Buffer.alloc(0) }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function runSimBurn(
  opts: SimBurnOptions,
  onOutput: (line: string) => void,
  onProgress?: (percent: number, message: string) => void
): Promise<SimBurnResult> {
  const chip = FAKE_CHIPS.find((c) => c.id === opts.chipId) ?? FAKE_CHIPS[0]
  const baud = opts.baud ?? DEFAULT_BAUD
  const out = (line: string) => onOutput(line + '\n')
  let cancelled = opts.cancelFlag?.cancelled ?? false
  let socket: net.Socket | null = null

  const cancelPromise = new Promise<never>((_, reject) => {
    const poll = setInterval(() => {
      if (cancelled) {
        clearInterval(poll)
        reject(new Error('模拟烧录已取消'))
      }
    }, 80)
  })

  try {
    // ---------- 1. 启动伪板 ----------
    await stopFakeBoard()
    const port = 33200 + Math.floor(Math.random() * 100)
    const board = startFakeBoard(port, chip.id, {
      onLog: (line) => onOutput(`[sim] ${line}\n`),
    })
    board.getChip()

    // ---------- 2. 连接（RFC2217 客户端） ----------
    out(`Connecting to ${chip.name} virtual board...`)
    socket = await Promise.race([
      new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port }, () => {
          // RFC2217 选项协商
          s.write(Buffer.from([IAC, 0xfd, COM_OPT])) // IAC DO COM-PORT-OPTION
          resolve(s)
        })
        s.on('error', (e) => reject(e))
      }),
      cancelPromise,
    ])

    let recvBuf = Buffer.alloc(0)
    const telnet = new TelnetClientBuffer()
    const waiters: Array<{ op: number; resolve: (p: Buffer) => void; reject: (e: Error) => void }> = []
    const frameWaiters: Array<{ count: number; frames: Buffer[]; resolve: (f: Buffer[]) => void; reject: (e: Error) => void }> = []
    let ohaiResolve: (() => void) | null = null

    socket.on('data', (chunk: Buffer) => {
      const { payload, respond } = telnet.feed(chunk)
      if (respond.length > 0) socket?.write(respond)
      recvBuf = Buffer.concat([recvBuf, payload])
      // 解析所有完整 SLIP 帧，投递给按数量等待者 / 按 op 等待者
      for (;;) {
        const { payload: pkt, consumed } = slipDecode(recvBuf)
        if (pkt === null) break
        recvBuf = recvBuf.subarray(consumed)
        if (pkt.length < 8) {
          // stub OHAI 问候（4 字节短帧）
          if (pkt.length === 4 && pkt.toString('latin1') === 'OHAI' && ohaiResolve) {
            ohaiResolve()
            ohaiResolve = null
          }
          continue
        }
        const op = pkt[1]
        const ln = pkt.readUInt16LE(2)
        const body = pkt.subarray(8, 8 + ln)
        // 1) 按数量等待者（SYNC 连续读 8 帧）
        if (frameWaiters.length > 0) {
          const fw = frameWaiters[0]
          fw.frames.push(pkt)
          if (fw.frames.length >= fw.count) {
            frameWaiters.shift()
            fw.resolve(fw.frames)
          }
          continue
        }
        // 2) 按 op 等待者
        const idx = waiters.findIndex((w) => w.op === op)
        if (idx >= 0) {
          const w = waiters[idx]
          waiters.splice(idx, 1)
          w.resolve(body)
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      const err = new Error('伪板连接已关闭')
      while (waiters.length) waiters.shift()!.reject(err)
    })

    const sendFrame = (op: number, data: Buffer, chk?: number): void => {
      const frame = Buffer.alloc(8 + data.length)
      frame[0] = 0x00
      frame[1] = op
      frame.writeUInt16LE(data.length, 2)
      let c = chk ?? 0
      if (chk === undefined) for (const b of data) c ^= b
      frame.writeUInt32LE(c >>> 0, 4)
      data.copy(frame, 8)
      // SLIP 编码 + IAC 转义（数据通道 0xFF 双写）
      socket!.write(escapeIac(slipEncode(frame)))
    }

    const readResp = async (op: number, timeout = 5000): Promise<Buffer> =>
      Promise.race([
        new Promise<Buffer>((resolve, reject) => waiters.push({ op, resolve, reject })),
        cancelPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`等待响应 op=${op} 超时`)), timeout)),
      ])

    /** 连续读取 N 个 SLIP 帧（对齐 esptool SYNC 行为：一次读 8 个响应） */
    const readFrames = async (count: number, timeout = 3000): Promise<Buffer[]> =>
      Promise.race([
        new Promise<Buffer[]>((resolve, reject) => frameWaiters.push({ count, frames: [], resolve, reject })),
        cancelPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`等待 ${count} 个响应超时`)), timeout)),
      ])

    const sleepSim = async (rawBytes: number) => {
      const ms = Math.max(60, (rawBytes / SIM_BYTES_PER_SEC) * 1000)
      await sleep(ms)
    }

    // ---------- 3. SYNC ----------
    out('Synchronizing...')
    const syncData = Buffer.alloc(64)
    for (let i = 0; i < 8; i++) {
      syncData[i * 8 + 0] = 0x07
      syncData[i * 8 + 1] = 0x07
      syncData[i * 8 + 2] = 0x12
      syncData[i * 8 + 3] = 0x20
    }
    for (let i = 32; i < 64; i++) syncData[i] = 0x55
    sendFrame(CMD.SYNC, syncData)
    // 连续读 8 个响应（1 主 + 7 多余，对齐 esptool sync()）
    await readFrames(8)
    out('OK')

    // ---------- 4. 芯片识别 ----------
    sendFrame(CMD.GET_SECURITY_INFO, Buffer.alloc(0))
    const info = await readResp(CMD.GET_SECURITY_INFO)
    const detectedChipId = info.length >= 16 ? info.readUInt32LE(12) : 0
    const chipName = detectedChipId === 0x0005 ? 'ESP32-C3' : detectedChipId === 0x0009 ? 'ESP32-S3' : chip.name
    out(`Connected to ${chipName} on sim://127.0.0.1:${port}:`)
    out(`Chip type:          ${chipName} (revision ${chip.revision})`)
    out(`Features:           ${chip.features}`)
    out(`Crystal frequency:  ${chip.crystal}`)
    out(`MAC:                ${chip.mac}`)

    // ---------- 5. 上传 stub ----------
    out('Uploading stub flasher...')
    // 模拟 stub 二进制（无需真实 stub 程序，伪板不执行，仅走完协议）
    const stubBlob = Buffer.alloc(0x2000)
    for (let i = 0; i < stubBlob.length; i++) stubBlob[i] = (i * 7 + 3) & 0xff
    sendFrame(
      CMD.MEM_BEGIN,
      Buffer.concat([
        u32(stubBlob.length),
        u32(Math.ceil(stubBlob.length / BLOCK_SIZE)),
        u32(BLOCK_SIZE),
        u32(0),
      ])
    )
    await readResp(CMD.MEM_BEGIN)
    let stubSeq = 0
    for (let off = 0; off < stubBlob.length; off += BLOCK_SIZE) {
      const chunk = stubBlob.subarray(off, off + BLOCK_SIZE)
      sendFrame(CMD.MEM_DATA, Buffer.concat([u32(chunk.length), u32(stubSeq), u32(0), u32(0), chunk]))
      await readResp(CMD.MEM_DATA)
      stubSeq++
    }
    sendFrame(CMD.MEM_END, Buffer.concat([u32(0), u32(0)]))
    await readResp(CMD.MEM_END)
    out('Running stub flasher...')
    // 等待 stub OHAI 问候
    await Promise.race([
      new Promise<void>((resolve) => {
        ohaiResolve = resolve
      }),
      cancelPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('等待 stub OHAI 问候超时')), 3000)),
    ])
    out('Stub flasher running.')

    // ---------- 6. 变更波特率 ----------
    sendFrame(CMD.CHANGE_BAUDRATE, Buffer.concat([u32(baud), u32(0)]))
    await readResp(CMD.CHANGE_BAUDRATE)
    out(`Changing baud rate to ${baud}...`)
    out('Changed.')
    out('Configuring flash size...')

    // ---------- 7. 逐文件压缩烧写 ----------
    let filesWritten = 0
    let totalRaw = 0
    for (const f of opts.files) totalRaw += statSize(f.path)

    for (const f of opts.files) {
      const bin = await readFileSafe(f.path)
      if (!bin) {
        out(`Error: cannot read ${f.path}`)
        return { ok: false, filesWritten, chipName }
      }
      const rawLen = bin.length
      out(`Writing '${f.label}' at 0x${f.addr.toString(16).padStart(8, '0')}...`)
      out(`Flash will be erased from 0x${f.addr.toString(16).padStart(8, '0')} to 0x${(f.addr + rawLen - 1).toString(16).padStart(8, '0')}...`)

      // 压缩（日志用整文件压缩率；发送按 0x4000 原始块独立压缩 —— 与伪板 inflateSync 对应）
      const compressedTotal = zlib.deflateSync(bin, { level: 9 })
      out(`Compressed ${rawLen} bytes to ${compressedTotal.length}...`)

      const eraseSize = Math.ceil(rawLen / BLOCK_SIZE) * BLOCK_SIZE
      sendFrame(
        CMD.FLASH_DEFL_BEGIN,
        Buffer.concat([u32(eraseSize), u32(Math.ceil(rawLen / BLOCK_SIZE)), u32(BLOCK_SIZE), u32(f.addr)])
      )
      await readResp(CMD.FLASH_DEFL_BEGIN)

      // 分块发送（每块独立 zlib 流，seq 递增，存储对齐 0x4000）
      let seq = 0
      let sentRaw = 0
      const totalKB = compressedTotal.length / 1024
      for (let off = 0; off < rawLen; off += BLOCK_SIZE) {
        const rawChunk = bin.subarray(off, off + BLOCK_SIZE)
        const comp = zlib.deflateSync(rawChunk, { level: 9 })
        sendFrame(CMD.FLASH_DEFL_DATA, Buffer.concat([u32(comp.length), u32(seq), u32(0), u32(0), comp]))
        await readResp(CMD.FLASH_DEFL_DATA)
        sentRaw += rawChunk.length
        seq++
        // 进度行（对齐 esptool 输出格式）
        const pct = (sentRaw / rawLen) * 100
        const kB = (compressedTotal.length * (sentRaw / rawLen)) / 1024
        const addrNow = f.addr + sentRaw
        out(
          `Writing at 0x${addrNow.toString(16).padStart(8, '0')} ${'='.repeat(Math.floor(pct / 10))} ${pct.toFixed(1)}% ${kB.toFixed(2)}kB/${totalKB.toFixed(2)}kB`
        )
        if (onProgress) onProgress(pct, `写入 ${f.label}`)
        await sleepSim(rawChunk.length)
      }
      sendFrame(CMD.FLASH_DEFL_END, Buffer.concat([u32(1), u32(0)]))
      await readResp(CMD.FLASH_DEFL_END)

      // 校验
      const elapsed = ((rawLen / SIM_BYTES_PER_SEC) * 1000) / 1000
      const kbps = (rawLen / elapsed) / 1000
      out(
        `Wrote ${rawLen} bytes (${compressedTotal.length} compressed) at 0x${f.addr.toString(16).padStart(8, '0')} in ${elapsed.toFixed(1)} seconds (${kbps.toFixed(1)} kbit/s).`
      )
      out('Verifying written data...')
      sendFrame(CMD.SPI_FLASH_MD5, Buffer.concat([u32(f.addr), u32(rawLen), u32(0), u32(0)]))
      const md5Resp = await readResp(CMD.SPI_FLASH_MD5)
      const flashMd5 = md5Resp.subarray(0, 16)
      const localMd5 = createHash('md5').update(bin).digest()
      if (flashMd5.equals(localMd5)) {
        out('Hash of data verified.')
        filesWritten++
      } else {
        out(`Input MD5: ${localMd5.toString('hex')}`)
        out(`Flash MD5: ${flashMd5.toString('hex')}`)
        out('MD5 of file does not match data in flash!')
        out('')
        out('A fatal error occurred: MD5 of file does not match data in flash!')
        return { ok: false, filesWritten, chipName }
      }
    }

    // ---------- 8. 复位 ----------
    out('')
    out('Hard resetting via RTS pin...')
    await sleep(400)
    out('')
    out(`Done. ${filesWritten} file(s) written successfully.`)
    out(`Chip verified: ${chipName}`)
    onProgress?.(100, '烧录完成')
    return { ok: true, filesWritten, chipName }
  } finally {
    socket?.destroy()
    await stopFakeBoard()
  }
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}

function statSize(p: string): number {
  try {
    const fs = require('fs') as typeof import('fs')
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function readFileSafe(p: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const fs = require('fs') as typeof import('fs')
    fs.readFile(p, (err, data) => resolve(err ? null : data))
  })
}

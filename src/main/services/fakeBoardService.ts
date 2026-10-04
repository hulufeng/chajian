/**
 * RFC2217 伪 ESP32 开发板（软件内模拟烧录用）
 *
 * 对照已验证方案（_triecode_learn/fake_esp32_rfc2217.py，esptool 5.4 协议精确实现）：
 * - RFC2217 网络串口（telnet COM-PORT-OPTION），无需虚拟串口驱动
 * - esptool ROM 协议：请求帧 <BBHI> (0x00,op,len,chk)+data，应答 <BBHI> (0x01,op,len,val)+data
 * - 命令码：FLASH_BEGIN=0x02 FLASH_DATA=0x03 FLASH_END=0x04 MEM_BEGIN=0x05 MEM_END=0x06
 *   MEM_DATA=0x07 SYNC=0x08 WRITE_REG=0x09 READ_REG=0x0A SPI_ATTACH=0x0D
 *   CHANGE_BAUDRATE=0x0F FLASH_DEFL_BEGIN=0x10 FLASH_DEFL_DATA=0x11 FLASH_DEFL_END=0x12
 *   SPI_FLASH_MD5=0x13 GET_SECURITY_INFO=0x14
 * - stub 模式：SYNC 后连续读 8 个响应；MEM_END 后发 "OHAI" 问候；压缩烧写跨块 zlib 流；
 *   SPI_FLASH_MD5 应答 16 字节二进制 md5；芯片识别走 GET_SECURITY_INFO(chip_id)
 *
 * 商业闭源软件内置使用：协议为公开标准（esptool/ESP ROM 协议），自行实现，无 GPL 传染。
 */

import * as net from 'net'
import * as zlib from 'zlib'
import { createHash } from 'crypto'

// ---------- 常量 ----------
const SLIP_END = 0xc0
const SLIP_ESC = 0xdb
const SLIP_ESC_END = 0xdc
const SLIP_ESC_ESC = 0xdd
const IAC = 0xff
const COM_OPT = 0x2c
const SE = 0xf0
const SB = 0xfa
const WILL = 0xfb
const WONT = 0xfc
const DO = 0xfd
const DONT = 0xfe

/** RFC2217 SET verb -> SERVER verb 应答映射 */
const RFC2217_ANSWER_MAP: Record<number, number> = {
  0x01: 0x65, 0x02: 0x66, 0x03: 0x67, 0x04: 0x68, 0x05: 0x69,
  0x06: 0x6a, 0x07: 0x6b, 0x08: 0x6c, 0x09: 0x6d, 0x0a: 0x6e,
  0x0b: 0x6f, 0x0c: 0x70,
}

/** 支持的内置芯片型号 */
export interface FakeChipConfig {
  id: string
  name: string           // ESP32-C3
  chipId: number         // GET_SECURITY_INFO chip_id：C3=0x0005, S3=0x0009
  revision: string       // v3.0
  features: string
  crystal: string        // 40MHz
  mac: string            // 15:81:33:60:15:81
  flashSize: number      // 4MB
}

export const FAKE_CHIPS: FakeChipConfig[] = [
  {
    id: 'esp32c3',
    name: 'ESP32-C3',
    chipId: 0x0005,
    revision: 'v3.0',
    features: 'Wi-Fi, BT 5 (LE), Single Core, 160MHz',
    crystal: '40MHz',
    mac: '15:81:33:60:15:81',
    flashSize: 4 * 1024 * 1024,
  },
  {
    id: 'esp32s3',
    name: 'ESP32-S3',
    chipId: 0x0009,
    revision: 'v0.2',
    features: 'Wi-Fi, BT 5 (LE), Dual Core, 240MHz, Embedded Flash',
    crystal: '40MHz',
    mac: '3c:71:bf:01:23:45',
    flashSize: 8 * 1024 * 1024,
  },
]

// ---------- SLIP 编解码 ----------
function slipDecode(buf: Buffer): { payload: Buffer | null; consumed: number } {
  const out: number[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b === SLIP_END) {
      return { payload: Buffer.from(out), consumed: i + 1 }
    } else if (b === SLIP_ESC) {
      i++
      if (i < buf.length) {
        if (buf[i] === SLIP_ESC_END) out.push(SLIP_END)
        else if (buf[i] === SLIP_ESC_ESC) out.push(SLIP_ESC)
      }
      i++
      continue
    } else {
      out.push(b)
      i++
    }
  }
  return { payload: null, consumed: 0 }
}

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

/** RFC2217 数据通道 IAC 转义：数据流中的 0xFF 双写（telnet 控制字节除外） */
function escapeIac(buf: Buffer): Buffer {
  if (!buf.includes(0xff)) return buf
  const out: number[] = []
  for (const b of buf) {
    if (b === 0xff) out.push(0xff, 0xff)
    else out.push(b)
  }
  return Buffer.from(out)
}

// ---------- RFC2217 telnet 状态机 ----------
class Rfc2217Buffer {
  private iacPending = false
  private negotiating: number | null = null
  private subnegBuf: number[] = []
  private inSubneg = false
  private onRespond: (b: Buffer) => void

  constructor(onRespond: (b: Buffer) => void) {
    this.onRespond = onRespond
  }

  feed(data: Buffer): Buffer {
    const out: number[] = []
    let i = 0
    while (i < data.length) {
      const b = data[i]
      if (this.inSubneg) {
        if (b === IAC) {
          if (i + 1 < data.length && data[i + 1] === SE) {
            this.inSubneg = false
            this.handleSubneg(Buffer.from(this.subnegBuf))
            this.subnegBuf = []
            i += 2
            continue
          } else {
            this.subnegBuf.push(b)
            i++
            continue
          }
        } else {
          this.subnegBuf.push(b)
          i++
          continue
        }
      }
      if (this.iacPending) {
        this.iacPending = false
        if (b === IAC) {
          out.push(IAC)
          i++
          continue
        } else if (b === WILL || b === WONT || b === DO || b === DONT) {
          this.negotiating = b
          i++
          continue
        } else if (b === SB) {
          this.inSubneg = true
          this.subnegBuf = []
          i++
          continue
        } else {
          i++
          continue
        }
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
        if (verb === WILL) this.onRespond(Buffer.from([IAC, DO, opt]))
        else if (verb === WONT) this.onRespond(Buffer.from([IAC, DONT, opt]))
        else if (verb === DO) this.onRespond(Buffer.from([IAC, WILL, opt]))
        else if (verb === DONT) this.onRespond(Buffer.from([IAC, WONT, opt]))
        i++
        continue
      }
      out.push(b)
      i++
    }
    return Buffer.from(out)
  }

  private handleSubneg(sb: Buffer) {
    if (sb.length < 2) return
    const opt = sb[0]
    const verb = sb[1]
    const data = sb.slice(2)
    const respVerb = RFC2217_ANSWER_MAP[verb]
    if (respVerb !== undefined) {
      this.onRespond(Buffer.from([IAC, SB, opt, respVerb, ...data, IAC, SE]))
    }
  }
}

// ---------- 伪芯片 ----------
export interface FakeBoardEvents {
  onLog?: (line: string) => void
}

export class FakeBoardServer {
  private server: net.Server | null = null
  private flash = new Map<number, Buffer>()
  private curOffset = 0
  private chip: FakeChipConfig

  constructor(private port: number, private chipId: string, private events: FakeBoardEvents = {}) {
    this.chip = FAKE_CHIPS.find((c) => c.id === chipId) ?? FAKE_CHIPS[0]
  }

  getChip(): FakeChipConfig {
    return this.chip
  }

  getPort(): number {
    return this.port
  }

  private log(line: string) {
    this.events.onLog?.(line)
  }

  private storeFlash(offset: number, data: Buffer) {
    this.flash.set(offset, Buffer.from(data))
  }

  /** 按地址范围拼接 flash 数据算 md5（与验证版 Python 伪板一致） */
  private flashMd5(addr: number, size: number): Buffer {
    const parts: Buffer[] = []
    const offsets = [...this.flash.keys()].sort((a, b) => a - b)
    for (const off of offsets) {
      const blk = this.flash.get(off)!
      if (off < addr + size && off + blk.length > addr) {
        const start = Math.max(0, addr - off)
        const end = Math.min(blk.length, addr + size - off)
        parts.push(blk.subarray(start, end))
      }
    }
    return createHash('md5').update(Buffer.concat(parts)).digest()
  }

  private mkResp(op: number, data: Buffer = Buffer.from([0, 0]), val = 0): Buffer {
    const head = Buffer.alloc(8)
    head[0] = 0x01
    head[1] = op
    head.writeUInt16LE(data.length, 2)
    head.writeUInt32LE(val >>> 0, 4)
    // 数据帧必须做 IAC 转义（数据流中的 0xFF 双写）
    return escapeIac(slipEncode(Buffer.concat([head, data])))
  }

  private handleSocket(socket: net.Socket) {
    let buf = Buffer.alloc(0)
    const telnet = new Rfc2217Buffer((b) => socket.write(b))

    socket.on('data', (chunk: Buffer) => {
      const data = telnet.feed(chunk)
      if (data.length === 0) return
      buf = Buffer.concat([buf, data])
      for (;;) {
        const { payload, consumed } = slipDecode(buf)
        if (payload === null) break
        buf = buf.subarray(consumed)
        if (payload.length < 8) continue
        const op = payload[1]
        const ln = payload.readUInt16LE(2)
        const body = payload.subarray(8, 8 + ln)
        this.handleCommand(op, body, socket)
      }
    })

    socket.on('error', () => {})
    socket.on('close', () => {})
  }

  private handleCommand(op: number, body: Buffer, socket: net.Socket) {
    switch (op) {
      case 0x08: {
        // SYNC：主响应 + 7 个多余响应
        for (let i = 0; i < 8; i++) socket.write(this.mkResp(0x08, Buffer.alloc(0), 0x00000001))
        break
      }
      case 0x0a: {
        // READ_REG：寄存器值放帧头 val；data 前 2 字节状态
        const addr = body.length >= 4 ? body.readUInt32LE(0) : 0
        const regVal = addr === 0x40001000 ? 0x00000001 : 0x33601581
        socket.write(this.mkResp(0x0a, Buffer.from([0, 0]), regVal))
        break
      }
      case 0x14: {
        // GET_SECURITY_INFO：<IBBBBBBBBII> flags + 8B key_purposes + chip_id + api_version
        const info = Buffer.alloc(20)
        info.writeUInt32LE(0, 0)
        info.writeUInt32LE(this.chip.chipId, 12)
        info.writeUInt32LE(0, 16)
        socket.write(this.mkResp(0x14, Buffer.concat([info, Buffer.from([0, 0])]), 0))
        break
      }
      case 0x02: // FLASH_BEGIN
      case 0x03: // FLASH_DATA
      case 0x04: // FLASH_END
      case 0x09: // WRITE_REG
      case 0x05: // MEM_BEGIN
      case 0x07: // MEM_DATA
      case 0x0d: // SPI_ATTACH
      case 0x0f: {
        // CHANGE_BAUDRATE
        socket.write(this.mkResp(op, Buffer.from([0, 0]), 0))
        break
      }
      case 0x06: {
        // MEM_END：启动 stub → 回响应后发 OHAI 问候
        socket.write(this.mkResp(0x06, Buffer.from([0, 0]), 0))
        setTimeout(() => socket.write(escapeIac(slipEncode(Buffer.from('OHAI')))), 20)
        break
      }
      case 0x10: {
        // FLASH_DEFL_BEGIN：<IIII> erase_size, num_blocks, block_size, offset
        if (body.length >= 16) {
          this.curOffset = body.readUInt32LE(12)
        }
        socket.write(this.mkResp(0x10, Buffer.from([0, 0]), 0))
        break
      }
      case 0x11: {
        // FLASH_DEFL_DATA：<IIII> len, seq, 0, 0 + zlib_data（每块独立 zlib 流，同步解压）
        const dlen = body.readUInt32LE(0)
        const seq = body.readUInt32LE(4)
        const zdata = body.subarray(16, 16 + dlen)
        try {
          const data = zlib.inflateSync(zdata)
          if (data.length > 0) this.storeFlash(this.curOffset + seq * 0x4000, data)
        } catch (e: any) {
          this.log(`[sim] inflate err seq=${seq} dlen=${dlen} bodyLen=${body.length} err=${e?.message}`)
        }
        socket.write(this.mkResp(0x11, Buffer.from([0, 0]), 0))
        break
      }
      case 0x12: {
        // FLASH_DEFL_END
        socket.write(this.mkResp(0x12, Buffer.from([0, 0]), 0))
        break
      }
      case 0x13: {
        // SPI_FLASH_MD5：stub 模式回 16 字节二进制 md5 + 2 字节状态
        const addr = body.length >= 4 ? body.readUInt32LE(0) : 0
        const size = body.length >= 8 ? body.readUInt32LE(4) : 0
        const md5 = this.flashMd5(addr, size)
        socket.write(this.mkResp(0x13, Buffer.concat([md5, Buffer.from([0, 0])]), 0))
        break
      }
      default:
        socket.write(this.mkResp(op, Buffer.from([0, 0]), 0))
    }
  }

  start(): void {
    if (this.server) return
    this.server = net.createServer((socket) => this.handleSocket(socket))
    this.server.listen(this.port, '127.0.0.1')
    this.log(`[sim-board] ${this.chip.name} RFC2217 已就绪 127.0.0.1:${this.port}`)
  }

  async stop(): Promise<void> {
    const srv = this.server
    this.server = null
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    this.flash.clear()
  }

  isRunning(): boolean {
    return this.server !== null
  }

  /** 供引擎查询已写入的分区（调试/校验） */
  getFlashMap(): Map<number, Buffer> {
    return new Map(this.flash)
  }
}

/** 单例：渲染进程发起模拟烧录时使用 */
let currentServer: FakeBoardServer | null = null

export function startFakeBoard(port: number, chipId: string, events?: FakeBoardEvents): FakeBoardServer {
  if (currentServer) {
    currentServer.stop().then(() => {
      currentServer = new FakeBoardServer(port, chipId, events)
      currentServer.start()
    })
    return currentServer
  }
  currentServer = new FakeBoardServer(port, chipId, events)
  currentServer.start()
  return currentServer
}

export function getFakeBoard(): FakeBoardServer | null {
  return currentServer
}

export async function stopFakeBoard(): Promise<void> {
  if (currentServer) {
    await currentServer.stop()
    currentServer = null
  }
}

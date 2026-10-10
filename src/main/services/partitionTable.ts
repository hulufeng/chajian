// 分区表 / NVS 只读查看（对标 wheat-esp-tools 的「分区表 + NVS」）
//
// 数据源：复用片上调试链路（openocd telnet 的 mdb 读内存），不再额外拉 esptool / 原生依赖。
// 读到的字节按 ESP-IDF 布局解析：
//   分区表：0x8000 处 magic `Pi`(0x50 0x69)，之后每 32 字节一个表项
//           magic(2) type(1) subtype(1) offset(4) size(4) flags(4) label(16)
//   NVS   ：条目头 16B（ns_index/type/span/reserved/crc16/ts + 8 值域），逐条扫描。
// ⚠️ NVS 分段是「尽力解析」：不做 CRC 校验、靠类型/跨页合法性过滤，UI 上会标注；
//    分区表是硬解析（有魔数校验），结果可信。
import type { RawReader } from './debug/debugService'

export interface PartitionEntry {
  /** 分区在片内 Flash 上的起始地址（= 分区表项的 offset 字段） */
  address: number
  /** 该表项自身在分区表里的位置（调试用：0x8000 + 索引*32） */
  tablePos: number
  /** label（分区名） */
  name: string
  type: number
  subtype: number
  offset: number
  size: number
  flags: number
  kind: 'app' | 'data' | 'unknown'
  subtypeName: string
}

export interface NvsEntry {
  namespace: string
  key: string
  type: string
  /** 标量值（字符串/布尔/number），blob/mstring 只回长度提示 */
  value: string | number | boolean | null
}

/** 默认分区表位置（ESP32 全系列） */
export const PARTITION_TABLE_ADDR = 0x8000

const APP_SUBTYPE: Record<number, string> = {
  0: 'factory',
  1: 'ota_0',
  2: 'ota_1',
  3: 'ota_2',
  4: 'ota_3'
}

const DATA_SUBTYPE: Record<number, string> = {
  0: 'ota / phy',
  1: 'ota',
  2: 'nvs',
  3: 'phy',
  4: 'efuse',
  5: 'fat',
  6: 'spiffs',
  8: 'littlefs'
}

const NVS_TYPES: Record<number, string> = {
  0: 'namespace',
  1: 'u8',
  2: 'i8',
  3: 'u16',
  4: 'i16',
  5: 'u32',
  6: 'i32',
  7: 'u64',
  8: 'i64',
  9: 'bool',
  10: 'string',
  11: 'blob'
}

/** 解析一整块分区表字节流。
 * @param baseAddr 本缓冲首字节对应的片上地址（魔数不在缓冲开头时要用，调试字段 tablePos 才准） */
export function parsePartitionTable(buf: Buffer, baseAddr: number = PARTITION_TABLE_ADDR): PartitionEntry[] {
  const out: PartitionEntry[] = []
  for (let off = 0; off + 32 <= buf.length; off += 32) {
    const e = buf.slice(off, off + 32)
    if (e[0] !== 0x50 || e[1] !== 0x69) continue // 'P''i' 魔数
    const type = e[2]
    const subtype = e[3]
    // 结束标记：type/subtype 全 0xff
    if (type === 0xff && subtype === 0xff) break
    const size = e.readUInt32LE(8)
    const offset = e.readUInt32LE(4)
    const label = e.slice(16, 32).toString('utf-8').replace(/\x00+$/g, '').trim()
    const kind = type === 0x00 ? 'app' : type === 0x01 ? 'data' : 'unknown'
    out.push({
      // 注意：分区在 flash 里的地址是表项的 offset 字段，不是它在表里的位置
      address: offset,
      tablePos: baseAddr + off,
      name: label || `type${type}_${subtype}`,
      type,
      subtype,
      offset,
      size,
      flags: e.readUInt32LE(12),
      kind,
      subtypeName: (kind === 'app' ? APP_SUBTYPE[subtype] : DATA_SUBTYPE[subtype]) || `0x${subtype.toString(16)}`
    })
    if (out.length >= 95) break // 分区表最多 95 项
  }
  return out
}

/** 从内存字节里找分区表起始点（默认 0x8000，找不到就扫一遍魔数） */
export function locatePartitionTable(buf: Buffer): number {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x69) return 0
  for (let off = 0; off + 32 <= buf.length; off++) {
    if (buf[off] === 0x50 && buf[off + 1] === 0x69) return off
  }
  return -1
}

/** 读片内 Flash 某地址的字节（复用 openocd mdb） */
async function readAt(read: RawReader, addr: number, count: number): Promise<Buffer> {
  return read(addr, count)
}

/** 读分区表。tableAddr 一般是 0x8000。 */
export async function readPartitionTable(read: RawReader, tableAddr = PARTITION_TABLE_ADDR): Promise<PartitionEntry[]> {
  const buf = await readAt(read, tableAddr, 0x200)
  const rel = locatePartitionTable(buf)
  if (rel < 0) return []
  const slice = rel === 0 ? buf : buf.slice(rel)
  // 缓冲首字节对应的真实片上地址 = 读取起点 + 魔数偏移，tablePos 才准
  return parsePartitionTable(slice, tableAddr + rel)
}

/** 读单个标量值（值域在条目头偏移 10 起的 8 字节内，小端） */
function scalarValue(type: number, e: Buffer): string | number | boolean | null {
  switch (type) {
    case 1:
    case 3:
    case 5:
      return e.readUIntLE(10, type === 1 ? 1 : type === 3 ? 2 : 4)
    case 2:
    case 4:
    case 6:
      return e.readIntLE(10, type === 2 ? 1 : type === 4 ? 2 : 4)
    case 9:
      return e.readUInt8(10) !== 0
    case 10: {
      // mstring：0xFF 结尾的 UTF-8
      const raw = e.slice(10, 18)
      let end = raw.indexOf(0xff)
      if (end < 0) end = raw.length
      return raw.slice(0, end).toString('utf-8').replace(/\0+$/, '')
    }
    default:
      return null
  }
}

/**
 * 尽力解析 NVS 分区（不做 CRC 校验，靠 ns_index/type/span 合法性过滤）。
 * 只返回能读成条目的部分，读不出来的按 null 跳过，不做虚假补全。
 */
export function parseNvs(buf: Buffer, maxEntries = 200): NvsEntry[] {
  const out: NvsEntry[] = []
  const nsCache = new Map<string, string>()
  let lastNs = ''

  for (let off = 0; off + 18 <= buf.length && out.length < maxEntries; off++) {
    const e = buf.slice(off, off + 18)
    const nsIndex = e[0]
    const type = e[1]
    const span = e[2]
    // 合法性过滤：擦除状态/空闲页/越界类型都直接跳过
    if (nsIndex === 0xff || type === 0xff) continue
    if (!NVS_TYPES[type]) continue
    if (nsIndex === 0) continue // ns_index 0 保留
    if (span < 1 || span > 4) continue
    // reserved 字节：已擦除条目是 0xff，部分固件写 0x00，两者都放过
    if (e[3] !== 0x00 && e[3] !== 0xff) continue

    if (type === 0) {
      // 命名空间条目：值域放的是命名空间名
      const raw = e.slice(10, 18)
      let end = raw.indexOf(0xff)
      if (end < 0) end = raw.length
      lastNs = raw.slice(0, end).toString('utf-8').replace(/\0+$/, '')
      nsCache.set(String(nsIndex), lastNs)
      continue
    }

    const ns = nsCache.get(String(nsIndex)) || lastNs || ''
    // key 紧跟在条目头之后：取开头连续的可打印 ASCII。
    // 不能只按 0xff 截断——真实 flash 里 key 正好填满槽位时后面紧跟下一个条目头，没有 0xff。
    let key = ''
    for (const b of buf.slice(off + 18, off + 18 + 32)) {
      if (b < 0x20 || b > 0x7e) break
      key += String.fromCharCode(b)
    }
    if (!key) continue

    const typeName = NVS_TYPES[type] || `type${type}`
    out.push({
      namespace: ns,
      key,
      type: typeName,
      value: type >= 11 ? null : scalarValue(type, e)
    })
    // 不做固定步进：NVS 条目在不同固件/值长度下占用的槽位数不一致，
    // 逐字节扫描 + 上述合法性过滤可以自恢复（擦除区是 0xff，会被 ns_index 过滤掉）。
  }
  return out
}

/** 读某个 nvs 分区的条目 */
export async function readNvsEntries(read: RawReader, part: PartitionEntry, maxBytes = 0x4000): Promise<NvsEntry[]> {
  if (part.kind !== 'data' || part.size <= 0) return []
  const size = Math.min(part.size, maxBytes)
  const buf = await readAt(read, part.address, size)
  return parseNvs(buf)
}

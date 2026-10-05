import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * 自研最小 zip 解压器（零依赖）。
 *
 * 只做插件安装需要的三件事：解析 EOCD + Central Directory、读 Local Header 定位数据区、
 * 按 method 0（store）/ method 8（deflate）解出内容落盘。不引第三方库，
 * 不依赖系统 tar / Expand-Archive，Windows 与 macOS 行为一致。
 *
 * 已处理的边界：
 *  - 路径穿越防护：解压路径会被规范化，拒绝 `..` 段与盘符绝对路径；
 *  - 零字节文件 / 目录条目（name 以 `/` 结尾）；
 *  - UTF-8 文件名（GP bit 11），否则回退按 Buffer 原样取字节；
 *  - zip64：EOCD 里条目数或偏移为 0xFFFF/0xFFFFFFFF 时明确报错，不静默装错包。
 */

const SIG_EOCD = 0x06054b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

interface ZipEntryInfo {
  name: string
  method: number
  uncompressedSize: number
  compressedSize: number
  /** 数据区起始偏移（相对整个 zip） */
  dataOffset: number
}

function readU16(b: Buffer, at: number): number {
  if (at < 0 || at + 2 > b.length) throw new Error('zip 数据越界（读 u16）')
  return b.readUInt16LE(at)
}

function readU32(b: Buffer, at: number): number {
  if (at < 0 || at + 4 > b.length) throw new Error('zip 数据越界（读 u32）')
  return b.readUInt32LE(at)
}

/** 从文件末尾反查 EOCD 签名（兼容注释长度不为 0 的情况） */
function findEocd(buf: Buffer): number {
  const maxBack = Math.min(buf.length, 22 + 0xffff)
  for (let back = 22; back <= maxBack; back++) {
    const at = buf.length - back
    if (at < 0) break
    if (readU32(buf, at) === SIG_EOCD) return at
  }
  throw new Error('不是有效的 zip（找不到 End of Central Directory）')
}

function parseEntries(buf: Buffer): ZipEntryInfo[] {
  const eocd = findEocd(buf)
  const totalEntries = readU16(buf, eocd + 10)
  const cenOffset = readU32(buf, eocd + 16)

  if (totalEntries === 0xffff || cenOffset === 0xffffffff) {
    throw new Error('zip 使用 zip64 扩展，暂不支持（请把插件包打为标准 zip）')
  }

  const entries: ZipEntryInfo[] = []
  let p = cenOffset
  for (let i = 0; i < totalEntries; i++) {
    if (readU32(buf, p) !== SIG_CEN) throw new Error(`中央目录损坏（第 ${i + 1} 条）`)
    const method = readU16(buf, p + 10)
    const compressedSize = readU32(buf, p + 20)
    const uncompressedSize = readU32(buf, p + 24)
    const nameLen = readU16(buf, p + 28)
    const extraLen = readU16(buf, p + 30)
    const commentLen = readU16(buf, p + 32)
    const localOffset = readU32(buf, p + 42)
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen)

    // GP flag bit 11 = 文件名按 UTF-8 解释
    const flags = readU16(buf, p + 8)
    const name = (flags & 0x800) !== 0 ? nameBytes.toString('utf8') : nameBytes.toString('latin1')

    // 从本地头跳过 name + extra 找到真正的データ起点
    if (readU32(buf, localOffset) !== SIG_LOC) {
      throw new Error(`本地头损坏（${name}）`)
    }
    const locNameLen = readU16(buf, localOffset + 26)
    const locExtraLen = readU16(buf, localOffset + 28)
    const dataOffset = localOffset + 30 + locNameLen + locExtraLen

    entries.push({ name, method, uncompressedSize, compressedSize, dataOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 安全化解压目标路径：拒绝绝对路径、盘符与 `..` 上跳 */
function safeJoin(dest: string, entryName: string): string | null {
  const raw = entryName.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw) return null
  const segments = raw.split('/').filter((s) => s.length > 0)
  if (segments.some((s) => s === '..')) return null
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return null
  const target = normalize(join(dest, ...segments))
  // 兜底：规范化后必须仍在目标目录内
  if (!target.startsWith(normalize(dest) + sep) && target !== normalize(dest)) return null
  return target
}

/**
 * 把 zip 内容解压到 dest，返回实际写出的文件相对路径列表。
 * 目录条目会被创建为空目录；同名文件被后面条目覆盖（与常规解压行为一致）。
 */
export function unzipToDir(buf: Buffer, dest: string): string[] {
  const entries = parseEntries(buf)
  mkdirSync(dest, { recursive: true })
  const written: string[] = []

  for (const entry of entries) {
    const target = safeJoin(dest, entry.name)
    if (target === null) continue // 目录条目 / 非法路径：只建目录由下面的写文件处理

    const isDir = entry.name.endsWith('/')
    if (isDir) {
      mkdirSync(target, { recursive: true })
      continue
    }

    const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
    let content: Buffer
    if (entry.method === 0) {
      content = raw
    } else if (entry.method === 8) {
      try {
        content = inflateRawSync(raw)
      } catch (e) {
        throw new Error(`解压失败（${entry.name}）：${(e as Error).message}`)
      }
      if (content.length !== entry.uncompressedSize) {
        throw new Error(`解压结果长度不符（${entry.name}）：${content.length} ≠ ${entry.uncompressedSize}`)
      }
    } else {
      throw new Error(`不支持的压缩方法 ${entry.method}（${entry.name}）`)
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    if (!existsSync(target)) throw new Error(`写入失败（${entry.name}）`)
    written.push(entry.name)
  }
  return written
}

/** 只读列出 zip 内条目名（用于安装前先看包内容，不必全解出来） */
export function listZipEntries(buf: Buffer): string[] {
  return parseEntries(buf).map((e) => e.name)
}

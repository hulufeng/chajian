/**
 * 分区表 / NVS 解析自检（真实二进制夹具 + 真函数，不依赖 Electron）。
 *
 * 盯的是项目原则「硬解析可信、NVS 尽力解析不编造」：
 *   - parsePartitionTable 的 tablePos 调试字段在「魔数不在缓冲开头」时必须算准
 *     （这是上一轮发现的真 bug：readPartitionTable 切 slice 后没把偏移折算进 baseAddr）；
 *   - locatePartitionTable 能回退到扫描魔数、找不到回 -1；
 *   - parseNvs 命名空间归属、标量值、string、blob 只回 null、擦除区不产垃圾条目。
 *
 * 用法：node scripts/check-partition-table.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/partitionTable.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/partitionTable.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + outfile.replace(/\\/g, '/'))
const { parsePartitionTable, locatePartitionTable, parseNvs, readPartitionTable, PARTITION_TABLE_ADDR } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 二进制夹具构造 ───────────────────────────────────────────────────────
function pEntry(type, subtype, offset, size, label = '') {
  // 真实 ESP-IDF 分区表项：未用字节是 0x00（label 区 NUL 收尾），不是 0xff
  const b = Buffer.alloc(32, 0x00)
  b[0] = 0x50
  b[1] = 0x69 // 'P''i' 魔数
  b[2] = type
  b[3] = subtype
  b.writeUInt32LE(offset, 4)
  b.writeUInt32LE(size, 8)
  b.writeUInt32LE(0, 12)
  const lb = Buffer.from(label, 'utf-8').slice(0, 16)
  lb.copy(b, 16)
  return b
}
const pEnd = () => {
  const b = Buffer.alloc(32, 0xff)
  b[0] = 0x50
  b[1] = 0x69
  b[2] = 0xff
  b[3] = 0xff
  return b
}

// ── ① parsePartitionTable：默认基地址（缓冲以魔数开头） ──────────────────
{
  const buf = Buffer.concat([
    pEntry(0x00, 0x00, 0x10000, 0x100000, 'factory'), // app / factory
    pEntry(0x01, 0x02, 0x9000, 0x3000, 'nvs'), // data / nvs
    pEntry(0x01, 0x06, 0xf000, 0x1000, 'spiffs'), // data / spiffs
    pEnd()
  ])
  const r = parsePartitionTable(buf)
  check('① 解析出 3 个表项（结束标记被截断）', r.length === 3, `len=${r.length}`)
  check('  ↳ 表项 0 是 app/factory', r[0].kind === 'app' && r[0].subtypeName === 'factory', JSON.stringify([r[0].kind, r[0].subtypeName]))
  check('  ↳ 表项 1 是 data/nvs', r[1].kind === 'data' && r[1].subtypeName === 'nvs', JSON.stringify([r[1].kind, r[1].subtypeName]))
  check('  ↳ 表项 2 是 data/spiffs', r[2].kind === 'data' && r[2].subtypeName === 'spiffs', r[2].subtypeName)
  check('  ↳ address 用 offset 字段', r[0].address === 0x10000 && r[1].offset === 0x9000, JSON.stringify([r[0].address, r[1].offset]))
  check('  ↳ name 取 label', r[1].name === 'nvs', r[1].name)
  check('  ↳ 默认 baseAddr 时 tablePos 从 0x8000 起算', r[0].tablePos === 0x8000 && r[1].tablePos === 0x8020 && r[2].tablePos === 0x8040,
    JSON.stringify(r.map((x) => x.tablePos)))
}

// ── ② parsePartitionTable：魔数不在缓冲开头（baseAddr 必须折算） ────────
{
  // 前 64 字节是已擦除flash（0xff），分区表从第 64 字节开始
  const junk = Buffer.alloc(64, 0xff)
  const table = Buffer.concat([
    pEntry(0x00, 0x00, 0x10000, 0x100000, 'factory'),
    pEntry(0x01, 0x02, 0x9000, 0x3000, 'nvs'),
    pEnd()
  ])
  const buf = Buffer.concat([junk, table])
  const rel = 64
  const r = parsePartitionTable(buf.slice(rel), PARTITION_TABLE_ADDR + rel)
  check('② 切 slice + 折算 baseAddr 后仍解析出 2 项', r.length === 2, `len=${r.length}`)
  // 关键：tablePos 必须是真实片上地址 0x8000+64，而不是把 slice 当 0x8000 起算的 0x8000
  check('  ↳ 魔数非缓冲开头时 tablePos 仍准（=0x8040 / 0x8060）', r[0].tablePos === 0x8040 && r[1].tablePos === 0x8060,
    JSON.stringify(r.map((x) => x.tablePos)))
}

// ── ③ locatePartitionTable：开头/偏移/找不到 ────────────────────────────
{
  check('③ 缓冲开头就是魔数 → 0', locatePartitionTable(pEntry(0x00, 0x00, 0, 0)) === 0)
  const buf = Buffer.concat([Buffer.alloc(128, 0xff), pEntry(0x01, 0x02, 0, 0, 'nvs')])
  check('  ↳ 魔数在偏移 128 → 128', locatePartitionTable(buf) === 128, `got=${locatePartitionTable(buf)}`)
  const noMagic = Buffer.alloc(64, 0xab)
  check('  ↳ 找不到魔数 → -1', locatePartitionTable(noMagic) === -1)
}

// ── ④ parseNvs：命名空间归属 / 标量 / string / blob / 擦除区 ─────────────
function nvsHeader(nsIndex, type, span) {
  const b = Buffer.alloc(18, 0xff)
  b[0] = nsIndex
  b[1] = type
  b[2] = span
  b[3] = 0x00 // reserved（已写入态）
  return b
}
function nvsBlock(nsIndex, type, span, valueBytes, key) {
  const head = nvsHeader(nsIndex, type, span)
  // value 放在 offset 10（标量用）。valueBytes 用字节数组显式给出，避免 JS '\xff' 被当 U+00FF
  const v = Buffer.alloc(8, 0xff)
  if (valueBytes) Buffer.from(valueBytes).copy(v, 0)
  v.copy(head, 10)
  // key 紧跟在条目头之后（offset 18 起），可打印 ASCII + 0xff 结尾
  const kbuf = Buffer.alloc(32, 0xff)
  const kb = Buffer.from(key, 'utf-8').slice(0, 31)
  kb.copy(kbuf, 0)
  return Buffer.concat([head, kbuf])
}
{
  const blocks = [
    nvsBlock(1, 0, 1, [0x6e, 0x76, 0x73, 0xff, 0xff, 0xff, 0xff, 0xff], ''), // 命名空间 "nvs"（0xff 收尾）
    nvsBlock(1, 5, 1, [0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff], 'wifi'), // u32 = 0x12345678
    nvsBlock(1, 10, 1, [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xff, 0xff], 'ssid'), // string "hello"
    nvsBlock(1, 11, 1, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 'cert'), // blob → value null
    Buffer.alloc(64, 0xff) // 擦除区
  ]
  const buf = Buffer.concat(blocks)
  const r = parseNvs(buf)
  const byKey = Object.fromEntries(r.map((e) => [e.key, e]))
  check('④ 命名空间 entry 不进结果、但被后续条目归属', byKey['wifi']?.namespace === 'nvs', JSON.stringify(byKey['wifi']))
  check('  ↳ u32 标量正确解码（0x12345678）', byKey['wifi']?.type === 'u32' && byKey['wifi']?.value === 0x12345678, JSON.stringify(byKey['wifi']))
  check('  ↳ string 类型解码 "hello"', byKey['ssid']?.type === 'string' && byKey['ssid']?.value === 'hello', JSON.stringify(byKey['ssid']))
  check('  ↳ blob 只回 null（不编造值）', byKey['cert']?.type === 'blob' && byKey['cert']?.value === null, JSON.stringify(byKey['cert']))
  check('  ↳ 擦除区（0xff）不产垃圾条目', !r.some((e) => e.key === ''), JSON.stringify(r))
}

// ── ⑤ readPartitionTable：用假 RawReader 验证 slice 偏移折算闭环 ─────────
{
  const junk = Buffer.alloc(64, 0xff)
  const table = Buffer.concat([
    pEntry(0x00, 0x00, 0x10000, 0x100000, 'factory'),
    pEntry(0x01, 0x02, 0x9000, 0x3000, 'nvs'),
    pEnd()
  ])
  // 模拟从 0x8000 读 0x200 字节，分区表在缓冲内偏移 64 处
  const read = async (addr, count) => {
    const b = Buffer.alloc(count, 0xff)
    if (addr === PARTITION_TABLE_ADDR && count >= 64 + table.length) table.copy(b, 64)
    return b
  }
  const r = await readPartitionTable(read, PARTITION_TABLE_ADDR)
  check('⑤ 假 reader 解析出 2 项', r.length === 2, `len=${r.length}`)
  // 这是上一轮 bug 的回归点：readPartitionTable 切 slice 后必须带 tableAddr+rel
  check('  ↳ tablePos 回归正确（=0x8040 / 0x8060）', r[0].tablePos === 0x8040 && r[1].tablePos === 0x8060,
    JSON.stringify(r.map((x) => x.tablePos)))
}

console.log(`[partition] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[partition] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[partition] ✓ 全部通过')

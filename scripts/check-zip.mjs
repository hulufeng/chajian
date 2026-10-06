/**
 * zip.ts 自检（零依赖自研解压器，插件安装全靠它，风险最高）。
 *
 * 盯的是「插件包装错、解错、被路径穿越」三类事故。
 * 用真实字节造 zip 夹具（store + deflate 双方法、UTF-8 文件名、目录条目、带注释），
 * 以及畸形包（截断/zip64/坏方法/长度不符）断言报错而非静默装错。
 *
 * 用法：node scripts/check-zip.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const outfile = 'scripts/.tmp/zip.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/zip.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { unzipToDir, listZipEntries } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 真实 zip 构造器（最小实现，仅覆盖 method 0 / 8）─────────────────────────
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function makeZip(files, comment) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const method = f.method ?? 0
    const data = f.data instanceof Buffer ? f.data : Buffer.from(f.data)
    const comp = method === 0 ? data : deflateRawSync(data)
    const crc = crc32(data)
    const uncompLen = f.uncompressedSizeOverride ?? data.length
    const compLen = comp.length

    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x0800, 6) // UTF-8 文件名（bit 11）
    loc.writeUInt16LE(method, 8)
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(compLen, 18)
    loc.writeUInt32LE(uncompLen, 22)
    loc.writeUInt16LE(nameBuf.length, 26)
    loc.writeUInt16LE(0, 28)
    chunks.push(loc, nameBuf, comp)
    const dataStart = offset + 30 + nameBuf.length

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(compLen, 20)
    cen.writeUInt32LE(uncompLen, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset = dataStart + compLen
  }

  let cdSize = 0
  for (const c of central) cdSize += c.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment ? Buffer.byteLength(comment) : 0, 20)

  const all = [...chunks, ...central, eocd]
  if (comment) all.push(Buffer.from(comment, 'utf8'))
  return Buffer.concat(all)
}

const tmp = mkdtempSync(join(tmpdir(), 'zipout-'))
const teardown = () => rmSync(tmp, { recursive: true, force: true })

try {
  // ── ① store + deflate 往返一致 ────────────────────────────────────────
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"id":"demo"}'), method: 0 },
    { name: 'dist/main.js', data: Buffer.from('console.log("hello world")'), method: 8 },
    { name: 'assets/', data: Buffer.alloc(0), method: 0 },
    { name: 'readme.txt', data: Buffer.from('hi'), method: 0 },
  ]
  const zip = makeZip(files)
  const dest = join(tmp, 'a')
  const written = unzipToDir(zip, dest)
  check('① manifest.json 落盘内容一致', readFileSync(join(dest, 'manifest.json'), 'utf8') === '{"id":"demo"}')
  check('① dist/main.js deflate 还原一致', readFileSync(join(dest, 'dist/main.js'), 'utf8') === 'console.log("hello world")')
  check('① readme.txt store 还原一致', readFileSync(join(dest, 'readme.txt'), 'utf8') === 'hi')
  check('① 目录条目被创建', existsSync(join(dest, 'assets')) && !existsSync(join(dest, 'assets', 'placeholder')))
  check('① 返回的相对路径列表含 3 个文件', written.filter((n) => !n.endsWith('/')).length === 3, JSON.stringify(written))

  // ── ② listZipEntries 只读列出 ─────────────────────────────────────────
  const names = listZipEntries(zip)
  check('② listZipEntries 含 4 条', names.length === 4, JSON.stringify(names))
  check('② listZipEntries 含嵌套路径', names.includes('dist/main.js'))

  // ── ③ 路径穿越防护（Unix 风格）───────────────────────────────────────
  const evilU = makeZip([{ name: '../evil.txt', data: Buffer.from('pwn'), method: 0 }])
  const destU = join(tmp, 'u')
  const writtenU = unzipToDir(evilU, destU)
  check('③ 上跳绝对被拒（不写入）', !writtenU.includes('../evil.txt') && !existsSync(join(tmp, 'evil.txt')))

  // ── ④ 路径穿越防护（Windows 风格反斜杠）──────────────────────────────
  const evilW = makeZip([{ name: '..\\evil.txt', data: Buffer.from('pwn'), method: 0 }])
  const destW = join(tmp, 'w')
  const writtenW = unzipToDir(evilW, destW)
  check('④ 反斜杠上跳被拒', !existsSync(join(tmp, 'evil.txt')))

  // ── ⑤ 绝对路径被拒 ───────────────────────────────────────────────────
  const absU = makeZip([{ name: '/etc/passwd', data: Buffer.from('x'), method: 0 }])
  const destA = join(tmp, 'a2')
  const writtenA = unzipToDir(absU, destA)
  check('⑤ 绝对路径被拒（不写入）', writtenA.length === 0 && !existsSync('/etc/passwd'.replace('/', join(tmp, '') + '/')))
  const absD = makeZip([{ name: 'C:\\windows\\x.txt', data: Buffer.from('x'), method: 0 }])
  const writtenD = unzipToDir(absD, join(tmp, 'a3'))
  check('⑤ windows 盘符绝对路径被拒', writtenD.length === 0)

  // ── ⑥ 损坏包（乱码）报错而非静默装错 ─────────────────────────────────
  let threwCorrupt = false
  try { unzipToDir(Buffer.from('not a zip at all'), join(tmp, 'c')) } catch (e) { threwCorrupt = /不是有效的 zip/.test(e.message) }
  check('⑥ 乱码包报错', threwCorrupt)

  // ── ⑦ zip64 明确报错 ────────────────────────────────────────────────
  const z64 = Buffer.alloc(22)
  z64.writeUInt32LE(0x06054b50, 0)
  z64.writeUInt16LE(0xffff, 10) // totalEntries = 0xffff → zip64 哨兵
  let threw64 = false
  try { unzipToDir(z64, join(tmp, 'd')) } catch (e) { threw64 = /zip64/.test(e.message) }
  check('⑦ zip64 哨兵报错', threw64)

  // ── ⑧ 不支持的压缩方法报错 ──────────────────────────────────────────
  const badMethod = makeZip([{ name: 'x.txt', data: Buffer.from('y'), method: 9 }])
  let threwMethod = false
  try { unzipToDir(badMethod, join(tmp, 'e')) } catch (e) { threwMethod = /不支持的压缩方法/.test(e.message) }
  check('⑧ 坏方法（9）报错', threwMethod)

  // ── ⑨ deflate 长度不符报错 ───────────────────────────────────────────
  const badLen = makeZip([{ name: 'x.txt', data: Buffer.from('payload'), method: 8, uncompressedSizeOverride: 999 }])
  let threwLen = false
  try { unzipToDir(badLen, join(tmp, 'f')) } catch (e) { threwLen = /解压结果长度不符/.test(e.message) }
  check('⑨ deflate 长度不符报错', threwLen)

  // ── ⑩ 带注释的 zip 仍能定位 EOCD ─────────────────────────────────────
  const commented = makeZip(files, 'this is a comment longer than ten bytes!!')
  const destC = join(tmp, 'g')
  unzipToDir(commented, destC)
  check('⑩ 带注释 zip 还原一致', readFileSync(join(destC, 'readme.txt'), 'utf8') === 'hi')

  // ── ⑪ UTF-8 文件名（bit 11）─────────────────────────────────────────
  const uni = makeZip([{ name: '文档/main.js', data: Buffer.from('// 中文'), method: 0 }])
  const destUni = join(tmp, 'h')
  unzipToDir(uni, destUni)
  check('⑪ UTF-8 文件名还原', existsSync(join(destUni, '文档', 'main.js')) && readFileSync(join(destUni, '文档', 'main.js'), 'utf8') === '// 中文')
  check('⑪ list 含中文名', listZipEntries(uni).includes('文档/main.js'))

  // ── ⑫ 空 zip（0 条目）不崩 ──────────────────────────────────────────
  const empty = makeZip([])
  const destE = join(tmp, 'i')
  const writtenE = unzipToDir(empty, destE)
  check('⑫ 空 zip 返回空列表且建目录', Array.isArray(writtenE) && writtenE.length === 0 && existsSync(destE))
} finally {
  teardown()
}

console.log(`\n[check-zip] ${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}

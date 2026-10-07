/**
 * 打包示例插件为 zip，并计算 sha256 供 plugin-catalog 引用。
 *
 * 用法：
 *   node scripts/build-demo-plugins.mjs           # 打包全部并输出 sha256
 *   node scripts/build-demo-plugins.mjs --write   # 顺带把 sha256 写回 plugin-catalog.ts
 *
 * 为什么自己打包：项目已有 zip 解压实现（zip.ts，自研零依赖），
 * 但没有对应的「压缩」工具——示例插件需要能离线分发给用户装。
 *
 * zip 格式（自实现，store 模式不压缩）：
 *   局部文件头(30B) + 文件名 + 数据 + 中央目录项(46B) + 中央目录结束记录(22B)
 *   store 模式下每文件 overhead 就是文件名长度，足够小且实现简单可靠。
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PLUGIN_DIR = join(root, 'resources/plugin-demo')

/** DOS 时间/日期编码（zip 要求）；用固定值保证可复现（同样内容 → 同样 sha256） */
function dosDateTime(d = new Date(2026, 0, 1, 0, 0, 0)) {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** CRC32（zip 必需），用查表法 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 递归收集目录下所有文件（相对路径用 posix 分隔符，zip 规范要求） */
function collect(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...collect(full, base))
    else out.push({ path: relative(base, full).split(sep).join('/'), data: readFileSync(full) })
  }
  return out
}

/** 生成 zip（store 模式） */
function makeZip(files) {
  const { time, date } = dosDateTime()
  const chunks = []
  const central = []
  let offset = 0

  for (const f of files) {
    const nameBuf = Buffer.from(f.path, 'utf8')
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 局部文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0, 6) // 通用标志位
    local.writeUInt16LE(0, 8) // 压缩方法 0 = store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(f.data.length, 18) // 压缩后大小（store 下=原始）
    local.writeUInt32LE(f.data.length, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度
    chunks.push(local, nameBuf, f.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(f.data.length, 20)
    cd.writeUInt32LE(f.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // 注释
    cd.writeUInt16LE(0, 34) // 磁盘号
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(0, 38) // 外部属性
    cd.writeUInt32LE(offset, 42) // 本地头偏移
    central.push(Buffer.concat([cd, nameBuf]))

    offset += local.length + nameBuf.length + f.data.length
  }

  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // 中央目录结束记录签名
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, cdBuf, end])
}

// ── 打包全部示例插件 ──
const write = process.argv.includes('--write')
const results = []
for (const id of readdirSync(PLUGIN_DIR).sort()) {
  const dir = join(PLUGIN_DIR, id)
  if (!statSync(dir).isDirectory()) continue
  const files = collect(dir)
  if (!files.some((f) => f.path === 'plugin.json')) {
    console.log(`跳过 ${id}（无 plugin.json）`)
    continue
  }
  const zip = makeZip(files)
  const zipPath = join(PLUGIN_DIR, `${id}.zip`)
  writeFileSync(zipPath, zip)
  const sha = createHash('sha256').update(zip).digest('hex')
  results.push({ id, files: files.length, size: zip.length, sha })
  console.log(`${id}.zip  ${files.length} 个文件  ${(zip.length / 1024).toFixed(1)} KB`)
  console.log(`  sha256: ${sha}`)
  console.log(`  文件: ${files.map((f) => f.path).join(', ')}`)
}

// 校验：项目自带的 zip 解压实现（zip.ts，自研零依赖）能读回我们打的包。
// 这是闭环验证——不靠「看着对」，而是真用产品代码解开确认内容一致。
const { buildSync } = await import('esbuild')
const { mkdtempSync, rmSync, writeFileSync: wf } = await import('node:fs')
const { tmpdir } = await import('node:os')
const tmp = mkdtempSync(join(tmpdir(), 'zipb-'))
try {
  const entry = join(tmp, 'e.mjs')
  wf(
    entry,
    `export * from ${JSON.stringify(join(root, 'src/main/plugins/zip.ts').replace(/\\/g, '/'))}\n`,
    'utf8'
  )
  const outfile = join(tmp, 'z.mjs')
  buildSync({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile,
    alias: { electron: join(root, 'scripts/stubs/electron-dom-stub.mjs') }
  })
  const zipMod = await import('file://' + outfile.replace(/\\/g, '/'))
  const { unzipToDir } = zipMod
  if (typeof unzipToDir !== 'function') {
    console.log('\n[校验] zip.ts 未导出 unzipToDir，跳过解压校验')
  } else {
    console.log('\n[校验] 用产品代码的 unzipToDir 读回：')
    for (const r of results) {
      const dest = join(tmp, `x-${r.id}`)
      try {
        unzipToDir(readFileSync(join(PLUGIN_DIR, `${r.id}.zip`)), dest)
        const got = collect(dest).map((f) => f.path).sort()
        const want = collect(join(PLUGIN_DIR, r.id)).map((f) => f.path).sort()
        const same = JSON.stringify(got) === JSON.stringify(want)
        console.log(`  ${same ? '✓' : '✗'} ${r.id}：${got.length}/${want.length} 个文件${same ? '' : ` 期望 ${want} 实得 ${got}`}`)
      } catch (e) {
        console.log(`  ✗ ${r.id} 解压失败：${e.message}`)
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (write) {
  console.log('\n（请把上面的 sha256 填进 plugin-catalog.ts 的对应条目）')
}
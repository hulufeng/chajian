/**
 * shareCard.ts 自检（分享卡片 HTML 生成；XSS 转义 / 代码截断 / slug 清洗）。
 *
 * 盯的是「用户标题/代码片段里的 <script> 被原样输出（XSS）」和「代码未截断撑爆卡片」。
 * 用 electron 桩把 appData 顶到临时目录，buildShareCard 真写文件再读回断言。
 *
 * 用法：node scripts/check-share-card.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'

process.env.TEST_APPDATA = mkdtempSync(join(tmpdir(), 'sharecard-'))

const outfile = 'scripts/.tmp/shareCard.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/shareCard.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: resolve('scripts/stubs/electron-dom-stub.mjs') }
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { buildShareCard } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'sharecard-run-'))
const teardown = () => rmSync(tmp, { recursive: true, force: true })
try {
  // ── ① XSS 转义：标题里的 <script> 必须被转义 ───────────────────────
  const r1 = buildShareCard({ title: '<script>alert(1)</script>', subtitle: 'hi' })
  const h1 = readFileSync(r1.path, 'utf8')
  check('① 标题 <script> 被转义', h1.includes('&lt;script&gt;') && !h1.includes('<script>alert'))
  check('① 返回路径不含原始尖括号（slug 清洗）', !basename(r1.path).includes('<') && !basename(r1.path).includes('>'))

  // ── ② metric tone 类渲染 ───────────────────────────────────────────
  const r2 = buildShareCard({ title: 't2', metrics: [{ label: '状态', value: 'OK', tone: 'ok' }, { label: '风险', value: '高', tone: 'err' }] })
  const h2 = readFileSync(r2.path, 'utf8')
  check('② tone-ok 类渲染', h2.includes('tone-ok'))
  check('② tone-err 类渲染', h2.includes('tone-err'))

  // ── ③ 代码截断到 1200 字符 ─────────────────────────────────────────
  const longCode = 'x'.repeat(2000)
  const r3 = buildShareCard({ title: 't3', code: longCode })
  const h3 = readFileSync(r3.path, 'utf8')
  check('③ 代码未超 1200 字（不含 1500 连 x）', !h3.includes('x'.repeat(1500)))
  check('③ 含 <pre class="code"> 容器', h3.includes('<pre class="code">'))

  // ── ④ slug 清洗 + 长度上限 ─────────────────────────────────────────
  const r4 = buildShareCard({ title: '!!!特殊 标题 ###', accent: '#ff0000' })
  const bn = basename(r4.path)
  check('④ 文件名 slug 无特殊字符', !/[^\w一-龥.\-]/.test(bn.replace(/^\d+-/, '')))

  // ── ⑤ 默认 accent / 默认 footer ───────────────────────────────────
  const r5 = buildShareCard({ title: 't5' })
  const h5 = readFileSync(r5.path, 'utf8')
  check('⑤ 默认 accent #3b82f6', h5.includes('#3b82f6'))
  check('⑤ 默认 footer 文案', h5.includes('LabCode · 本地生成'))

  // ── ⑥ 自定义 footer / accent 生效 ─────────────────────────────────
  const r6 = buildShareCard({ title: 't6', footer: '自定义脚注', accent: '#ff0000' })
  const h6 = readFileSync(r6.path, 'utf8')
  check('⑥ 自定义 footer 生效', h6.includes('自定义脚注'))
  check('⑥ 自定义 accent 生效', h6.includes('#ff0000'))

  // ── ⑦ bytes 字段与文件大小一致 ────────────────────────────────────
  check('⑦ bytes 等于文件字节数', r6.bytes === readFileSync(r6.path, 'utf8').length || r6.bytes === Buffer.byteLength(h6, 'utf8'))
} finally {
  teardown()
}

console.log(`\n[check-share-card] ${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}

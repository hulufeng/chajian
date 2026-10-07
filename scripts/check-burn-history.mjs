/**
 * burnHistory.ts 自检（烧录历史记录 / 快照 / 回滚；数据安全第一）。
 *
 * 盯的是「快照漏采源文件（回滚变空操作）」「误把 build/.git 当源码回滚」「回滚写错/漏写」「超大文件/超多文件失控」。
 * 用 electron 桩把 appData 顶到临时目录，recordBurn/rollbackBurn 真落盘再断言。
 *
 * 用法：node scripts/check-burn-history.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'

process.env.TEST_APPDATA = mkdtempSync(join(tmpdir(), 'burnhist-'))

const outfile = 'scripts/.tmp/burnHistory.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/burnHistory.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: resolve('scripts/stubs/electron-dom-stub.mjs') }
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { recordBurn, listBurnHistory, getBurn, rollbackBurn, removeBurn, summarizeBurn } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'burnhist-run-'))
const teardown = () => rmSync(tmp, { recursive: true, force: true })
try {
  // 造一个工程：源码 + build/ + .git/（均应被快照跳过）
  const proj = join(tmp, 'myproj')
  mkdirSync(join(proj, 'src'), { recursive: true })
  mkdirSync(join(proj, 'build'), { recursive: true })
  mkdirSync(join(proj, '.git'), { recursive: true })
  writeFileSync(join(proj, 'sketch.ino'), 'void setup(){}\n')
  writeFileSync(join(proj, 'src', 'main.cpp'), 'int main(){return 0;}\n')
  writeFileSync(join(proj, 'src', 'cfg.h'), '#define X 1\n')
  writeFileSync(join(proj, 'build', 'firmware.bin'), 'BINARY')
  writeFileSync(join(proj, '.git', 'config'), 'gitdir')

  // ── ① 记录：只采源码，跳过 build/.git ─────────────────────────────
  const rec = recordBurn({ projectRoot: proj, fqbn: 'esp32:esp32:esp32', port: 'COM3', ok: true, logTail: 'done', durationMs: 1234, note: 'n' })
  const rels = rec.files.map((f) => f.rel)
  check('① 采到 sketch.ino', rels.includes('sketch.ino'))
  check('① 采到 src/main.cpp', rels.includes('src/main.cpp'))
  check('① 采到 src/cfg.h', rels.includes('src/cfg.h'))
  check('① 跳过 build/ 产物', !rels.some((r) => r.startsWith('build/')))
  check('① 跳过 .git/', !rels.some((r) => r.startsWith('.git/')))
  check('① 记录元信息正确', rec.ok === true && rec.fqbn === 'esp32:esp32:esp32' && rec.port === 'COM3' && rec.projectName === 'myproj' && rec.note === 'n')
  check('① id 以 b 开头', rec.id.startsWith('b'))

  // ── ② 不存在的工程 → 抛错 ─────────────────────────────────────────
  let threw = false
  try { recordBurn({ projectRoot: join(tmp, 'nope'), ok: true }) } catch { threw = true }
  check('② 工程目录不存在抛错', threw)

  // ── ③ summarizeBurn 视图 ──────────────────────────────────────────
  const v = summarizeBurn(rec)
  check('③ summarize fileCount 一致', v.fileCount === rec.files.length)
  check('③ summarize ok 透传', v.ok === true)

  // ── ④ list / get ─────────────────────────────────────────────────
  check('④ listBurnHistory 含刚记录', listBurnHistory().some((r) => r.id === rec.id))
  check('④ getBurn 命中', getBurn(rec.id)?.id === rec.id)

  // ── ⑤ 回滚：先改源码，再回滚还原 ─────────────────────────────────
  writeFileSync(join(proj, 'sketch.ino'), 'void setup(){}\n// 被我改了\n')
  const rb = rollbackBurn(rec.id)
  check('⑤ 回滚 written 含 sketch.ino', rb.written.includes('sketch.ino'))
  check('⑤ 回滚 changed 含被改文件', rb.changed.includes('sketch.ino'))
  check('⑤ 回滚 missing 为空', rb.missing.length === 0)
  check('⑤ 源码已还原', readFileSync(join(proj, 'sketch.ino'), 'utf8') === 'void setup(){}\n')

  // ── ⑥ 回滚缺失：删掉快照再回滚 ───────────────────────────────────
  rmSync(join(process.env.TEST_APPDATA, 'codelab-desktop', 'burn-history', rec.id, 'src', 'cfg.h'))
  const rb2 = rollbackBurn(rec.id)
  check('⑥ 快照缺失进入 missing', rb2.missing.includes('src/cfg.h'))
  check('⑥ 其余文件仍正常 written', rb2.written.includes('sketch.ino') && rb2.written.includes('src/main.cpp'))

  // ── ⑦ 删除记录 ───────────────────────────────────────────────────
  check('⑦ removeBurn 成功', removeBurn(rec.id) === true)
  check('⑦ 删除后 getBurn 为 null', getBurn(rec.id) === null)

  // ── ⑧ 超大文件跳过（>512KB）──────────────────────────────────────
  const proj2 = join(tmp, 'big')
  mkdirSync(proj2, { recursive: true })
  writeFileSync(join(proj2, 'sketch.ino'), 'void setup(){}\n')
  writeFileSync(join(proj2, 'big.bin'), Buffer.alloc(513 * 1024, 0x41))
  const rec2 = recordBurn({ projectRoot: proj2, ok: true })
  check('⑧ 超大文件不进快照', !rec2.files.some((f) => f.rel === 'big.bin'))
  check('⑧ 小文件仍进快照', rec2.files.some((f) => f.rel === 'sketch.ino'))

  // ── ⑨ 文件数上限（MAX_FILES=60）─────────────────────────────────
  const proj3 = join(tmp, 'many')
  mkdirSync(proj3, { recursive: true })
  for (let i = 0; i < 70; i++) writeFileSync(join(proj3, `f${i}.ino`), `// ${i}\n`)
  const rec3 = recordBurn({ projectRoot: proj3, ok: true })
  check('⑨ 文件数封顶 60', rec3.files.length === 60, String(rec3.files.length))
} finally {
  teardown()
}

console.log(`\n[check-burn-history] ${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}

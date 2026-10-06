/**
 * 编辑器自检（纯函数，不依赖 Electron）。
 * 覆盖：大文件/二进制判定、打开决策（add/protect/reload/keep-dirty/noop）。
 * 用法：node scripts/check-editor.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..') // scripts/.. => 项目根
const entry = join(root, 'src/renderer/src/components/editor/editorLogic.ts')

const tmp = mkdtempSync(join(tmpdir(), 'editor-'))
const outfile = join(tmp, 'editorLogic.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})
const { classifyFile, decideOpen, BIG_FILE_BYTES } = await import('file://' + outfile.replace(/\\/g, '/'))

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

const meta = (size = 10, mtimeMs = 100) => ({ size, mtimeMs })

// --- classifyFile ---
check('二进制.bin 保护', classifyFile('a.bin', meta()).readOnly === true)
check('二进制.elf 保护', classifyFile('fw.elf', meta()).readOnly === true)
check('小文本不过保护', classifyFile('main.ino', meta()).readOnly === false)
check('大文件 >1MB 保护', classifyFile('big.log', { size: BIG_FILE_BYTES + 1, mtimeMs: 1 }).readOnly === true)
check('边界 1MB 不过保护', classifyFile('edge.txt', { size: BIG_FILE_BYTES, mtimeMs: 1 }).readOnly === false)
check('图片(.png)不在二进制集合', classifyFile('pic.png', meta()).readOnly === false, '图片走预览分支，不归二进制保护')

// --- decideOpen ---
check('新文件 → add', decideOpen(undefined, 'a.ino', meta(), 'hello').kind === 'add')
check('二进制 → protect', decideOpen(undefined, 'a.bin', meta(), '').kind === 'protect')
check(
  '已存在+未变+有内容 → noop',
  decideOpen({ id: 'a', name: 'a.ino', language: 'cpp', content: 'x', mtimeMs: 100 }, 'a.ino', meta(10, 100), 'x').kind === 'noop'
)
check(
  '已存在+外部更新 → reload',
  decideOpen({ id: 'a', name: 'a.ino', language: 'cpp', content: 'x', mtimeMs: 100 }, 'a.ino', meta(10, 200), 'y').kind === 'reload'
)
check(
  '已存在+外部更新+脏 → keep-dirty',
  decideOpen({ id: 'a', name: 'a.ino', language: 'cpp', content: 'x', dirty: true, mtimeMs: 100 }, 'a.ino', meta(10, 200), 'y').kind ===
    'keep-dirty'
)
check(
  '已存在+无内容 → reload(首次填充)',
  decideOpen({ id: 'a', name: 'a.ino', language: 'cpp', content: '', mtimeMs: 100 }, 'a.ino', meta(10, 100), 'y').kind === 'reload'
)
check(
  'protect 带提示文案',
  /^a\.bin\n二进制文件/.test(decideOpen(undefined, 'a.bin', meta(), '').notice ?? '')
)
check(
  'keep-dirty 带警告文案',
  /已保留本地版本/.test(decideOpen({ id: 'a', name: 'a.ino', language: 'cpp', content: 'x', dirty: true, mtimeMs: 100 }, 'a.ino', meta(10, 200), 'y').warn ?? '')
)

rmSync(tmp, { recursive: true, force: true })

console.log(`\n编辑器自检：通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
} else {
  console.log('✓ 全部通过')
}

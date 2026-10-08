/**
 * diff 解析器自检 —— 覆盖「整文件可视化 diff」的结构化解析（对齐 TrieCode 精细度）。
 *
 * 被测：src/renderer/src/components/diff-parse.ts（纯函数，无 React 依赖）
 * 覆盖：标准 unified diff（@@ 头）/ 本项目简式 diff / 行号 / 增删统计 /
 *      词级 segments / CRLF 容忍 / 空输入 / 不成对时的整行变更。
 *
 * 用法：node scripts/check-diff-view.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/diff-parse.bundle.mjs'
buildSync({
  entryPoints: ['src/renderer/src/components/diff-parse.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { parseUnifiedDiff, wordDiff, hasChangedSegment, tokenize } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 1. 标准 unified diff（带 @@ hunk 头）──
console.log('\n[1] 标准 unified diff：hunk 头 / 行号 / 统计')
{
  const text = [
    '@@ -1,3 +1,4 @@',
    ' line1',
    '-old line',
    '+new line',
    '+added line',
    ' line3',
  ].join('\n')
  const d = parseUnifiedDiff(text)
  ok(d.hunks.length === 1, '识别出 1 个 hunk')
  ok(d.hunks[0].header === '@@ -1,3 +1,4 @@', 'hunk 头被保留')
  ok(d.added === 2, `added = 2（实际 ${d.added}）`)
  ok(d.removed === 1, `removed = 1（实际 ${d.removed}）`)
  const lines = d.hunks[0].lines
  ok(lines.length === 5, '共 5 行')
  ok(lines[0].type === 'context' && lines[0].oldNo === 1 && lines[0].newNo === 1, '首行 context 双号=1')
  ok(lines[1].type === 'del' && lines[1].oldNo === 2 && lines[1].newNo === null, 'del 行只有旧号=2')
  ok(lines[2].type === 'add' && lines[2].newNo === 2 && lines[2].oldNo === null, 'add 行只有新号=2')
  ok(lines[3].type === 'add' && lines[3].newNo === 3, '第二个 add 新号=3')
  ok(lines[4].type === 'context' && lines[4].oldNo === 3 && lines[4].newNo === 4, '末行 context 旧3/新4')
  ok(lines[0].text === 'line1', '标准模式文本不含标记符（去掉 1 个空格）')
}

// ── 2. 本项目简式 diff（edit_file 输出：'- ' / '+ ' / '  '，无 @@）──
console.log('\n[2] 简式 diff（本项目 edit_file 产物）：标记 2 字符')
{
  const text = [
    '- const a = 1',
    '+ const a = 2',
    '  context here',
  ].join('\n')
  const d = parseUnifiedDiff(text)
  ok(d.hunks.length === 1, '无 @@ 也能成 hunk')
  ok(d.added === 1 && d.removed === 1, '统计 +1 −1')
  const lines = d.hunks[0].lines
  ok(lines[0].text === 'const a = 1', `del 文本去掉了 "- "（实际 ${JSON.stringify(lines[0].text)}）`)
  ok(lines[1].text === 'const a = 2', 'add 文本去掉了 "+ "')
  ok(lines[2].type === 'context' && lines[2].text === 'context here', `context 文本去掉了两个空格（实际 ${JSON.stringify(lines[2].text)}）`)
}

// ── 3. 词级差异：成对的删+增行 ──
console.log('\n[3] 词级差异：成对 del/add 标注行内变更段')
{
  const d = parseUnifiedDiff('- const a = 1\n+ const a = 2')
  const [del, add] = d.hunks[0].lines
  ok(Array.isArray(del.segments) && Array.isArray(add.segments), '两条得到 segments')
  ok(hasChangedSegment(del) && hasChangedSegment(add), 'hasChangedSegment 为真')
  ok(del.segments.some((s) => s.changed && s.text === '1'), 'del 侧「1」被标为变更')
  ok(add.segments.some((s) => s.changed && s.text === '2'), 'add 侧「2」被标为变更')
  ok(del.segments.some((s) => !s.changed && s.text.includes('const')), '「const」保持未变更（不整行染色）')
}

// ── 4. 不成对的删/增：不做词级 ──
console.log('\n[4] 不成对时降级：不误标词级')
{
  // del 与 add 之间夹着 context → 不构成「删紧接增」的对，双方都不做词级
  const d = parseUnifiedDiff('- a\n  context\n+ b')
  const [del, , add] = d.hunks[0].lines
  ok(del.segments === undefined, '被 context 隔开的 del 行不做词级（无 segments）')
  ok(add.segments === undefined, '被 context 隔开的 add 行不做词级')
  // 1 删 + 2 增：只配对第一对，多出的那行不参与词级
  const d2 = parseUnifiedDiff('- only\n+ one\n+ two')
  const [d2del, d2a1, d2a2] = d2.hunks[0].lines
  ok(Array.isArray(d2del.segments) && Array.isArray(d2a1.segments), '1 删 2 增：第一对被词级比对')
  ok(d2a2.segments === undefined, '多出的 add 行不参与词级')
}

// ── 5. CRLF 容忍 ──
console.log('\n[5] CRLF 容忍')
{
  const d = parseUnifiedDiff('- a\r\n+ b\r\n')
  const lines = d.hunks[0].lines
  ok(lines[0].text === 'a' && lines[1].text === 'b', '文本中不含 \\r')
}

// ── 6. 空输入与纯上下文 ──
console.log('\n[6] 边界：空输入 / 纯上下文')
{
  const e = parseUnifiedDiff('')
  ok(e.hunks.length === 0 && e.added === 0 && e.removed === 0, '空输入 → 0 hunk / 0 统计')
  const c = parseUnifiedDiff('  only context\n  second')
  ok(c.added === 0 && c.removed === 0 && c.hunks[0].lines.length === 2, '纯上下文：无增删，行数正确')
}

// ── 7. tokenize / wordDiff 单元 ──
console.log('\n[7] tokenize / wordDiff 基础')
{
  ok(tokenize('a b').length === 3, `tokenize('a b') → 3 个 token（实际 ${tokenize('a b').length}）`)
  const { old: o, new: n } = wordDiff('x = 1', 'x = 1')
  ok(o.every((s) => !s.changed) && n.every((s) => !s.changed), '完全相同的两行 → 无变更段')
}

console.log('')
console.log(`[diff 解析自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

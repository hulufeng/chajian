// 扫描渲染层「未捕获的 Promise rejection」隐患：window.api.*() 返回的 Promise 若既不 await 也不 .catch，
// 一旦主进程那个 handler reject（网络/工具链失败/缺 handler），就会冒成 unhandledRejection，
// 轻则功能静默失败、重则整页报错。这正是 335d8fc 修的 ai:setModel/ai:setByok 那一类（await 但没 try/catch）。
// 用法：node scripts/scan-unhandled-rejection.mjs
//
// 判定（只看 window.api 链上「最内层」的那次调用，避免把 .then/.catch 那一层也误匹配进来）：
//   - 直接 await  → 算"已 await"（若不在 try 内，仍可能抛未处理异常，列 WARN 供人工确认）
//   - 链上带 .catch / .finally → 已捕获（安全，跳过）
//   - .then() 但后续无 .catch → 未捕获（thenNoCatch，硬性遗漏，列 CRITICAL）
//   - 裸调用 / 当参数传入 → 未捕获（fireAndForget，多为有意 fire-and-forget，列出来供补 .catch）
//   - void window.api.x() → 开发者显式丢弃，跳过（不报）
//   - 事件订阅型 window.api.onXxx() / offXxx() → 返回的不是需要 catch 的 Promise，跳过
// 口径宁漏勿误报：只把"明显没兜住"的列出来；fire-and-forget 与 await-无-try 只是提示，不阻断构建。
import { createRequire } from 'module'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer')

const files = []
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) files.push(p)
  }
}
walk(ROOT)

const fireAndForget = [] // 裸调用 / 当参数（多为有意 fire-and-forget，提示性）
const thenNoCatch = []   // .then() 但无 .catch（明确遗漏，硬性）
const awaitNoTry = []    // await 但不在 try 内（reject 会向上抛，需确认调用方兜底）

// 只匹配 window.api 链上「最内层」的那次调用：沿 expression 一路向上必须是属性访问，
// 直到根标识符 window，且中间不能夹着任何 CallExpression（否则它就是 .then/.catch 那一层，不是叶子）。
function isApiCall(node) {
  if (!ts.isCallExpression(node)) return null
  let e = node.expression
  const parts = []
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text)
    e = e.expression
  }
  if (!ts.isIdentifier(e) || e.text !== 'window') return null
  if (parts[0] !== 'api') return null
  return parts.join('.') // 例如 'ai.setModel' / 'window.close'，打印时拼回 window.<method>
}

function classify(node, inTry) {
  if (ts.isVoidExpression(node._parent)) return { type: 'void' }
  let cur = node
  let passedThen = false
  while (cur) {
    const p = cur._parent
    if (!p) break
    if (ts.isAwaitExpression(p)) return { type: 'await', inTry }
    if (ts.isPropertyAccessExpression(p)) {
      const name = p.name.text
      if (name === 'catch' || name === 'finally') return { type: 'caught' }
      if (name === 'then') {
        passedThen = true
        if (ts.isCallExpression(p.parent)) { cur = p.parent; continue }
        return { type: 'thenNoCatch' }
      }
      return { type: 'bare' }
    }
    return { type: 'bare' }
  }
  return { type: 'bare' }
}

function scan(file) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = file.replace(ROOT + '\\', '')
  const stack = []

  function visit(node, inTry) {
    node._parent = stack.length ? stack[stack.length - 1] : null
    let nextTry = inTry
    if (ts.isTryStatement(node)) nextTry = true
    const method = isApiCall(node)
    if (method) {
      const lastSeg = method.split('.').pop()
      // 事件订阅型（onXxx / offXxx）返回的不是需要 catch 的 Promise，跳过
      if (/^(on|off)[A-Z]/.test(lastSeg)) { stack.push(node); ts.forEachChild(node, (c) => visit(c, nextTry)); stack.pop(); return }
      const r = classify(node, inTry)
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (r.type === 'thenNoCatch') thenNoCatch.push({ rel, line, method })
      else if (r.type === 'bare') fireAndForget.push({ rel, line, method })
      else if (r.type === 'await' && !r.inTry) awaitNoTry.push({ rel, line, method })
    }
    stack.push(node)
    ts.forEachChild(node, (c) => visit(c, nextTry))
    stack.pop()
  }
  visit(sf, false)
}

for (const f of files) scan(f)

const hard = thenNoCatch.length
console.log('=== 渲染层未捕获 Promise rejection 扫描 ===')
console.log(`裸调用(fire-and-forget)=${fireAndForget.length}  .then无catch=${thenNoCatch.length}  await但不在try内=${awaitNoTry.length}`)

if (thenNoCatch.length) {
  console.log('\n[CRITICAL] 以下 .then() 之后没有 .catch（明确遗漏，必冒 unhandledRejection）：')
  for (const f of thenNoCatch.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line))
    console.log(`  ${f.rel}:${f.line}  window.${f.method}().then(...)`)
} else {
  console.log('\n[OK] 无 .then() 无 .catch 的明确遗漏')
}

if (fireAndForget.length) {
  console.log('\n[REVIEW] 以下为裸调用（多为有意 fire-and-forget，建议按需补 .catch 防 unhandledRejection）：')
  for (const f of fireAndForget.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line))
    console.log(`  ${f.rel}:${f.line}  window.${f.method}()`)
}

if (awaitNoTry.length) {
  console.log('\n[WARN] 以下为 await 但不在 try 内（reject 会向上抛，需确认调用方兜底）：')
  for (const f of awaitNoTry.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line))
    console.log(`  ${f.rel}:${f.line}  await window.${f.method}()`)
}

console.log(`\n命中：CRITICAL ${hard}（.then无catch） + REVIEW ${fireAndForget.length}（裸调用） + WARN ${awaitNoTry.length}（await无try）`)
console.log('提示：渲染层 main.tsx 已挂全局 unhandledrejection 监听兜底，裸调用即便 reject 也不会让页面崩。')
process.exit(hard > 0 ? 1 : 0)

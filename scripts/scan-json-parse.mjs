// 扫描全仓 JSON.parse 是否被 try/catch 兜住。
// 没兜住的 JSON.parse 一旦解析外部数据（localStorage / IPC 返回值 / 网络）损坏就抛未捕获异常，
// 在渲染层会一路冒泡到 ErrorBoundary（已加），但仍是功能断裂；在主进程会崩。
// 用法：node scripts/scan-json-parse.mjs
// 判定：JSON.parse 出现在某个 TryStatement 节点之内（其 try/catch/finally 任一）即视为已兜住。
// 注意：本 AST 只看词法作用域，helper 函数内部的 JSON.parse 即使调用方包了 try 也会报（需人工复核）。
import { createRequire } from 'module'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const files = []
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) files.push(p)
  }
}
walk(ROOT)

const findings = []
function scan(file) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = file.replace(ROOT + '\\', '')

  function visit(n, inTry) {
    let nextTry = inTry
    if (ts.isTryStatement(n)) nextTry = true
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.expression.getText(sf) === 'JSON' &&
      n.expression.name.text === 'parse'
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
      const arg = n.arguments[0]
      const argText = arg ? text.slice(arg.getStart(), arg.getEnd()).replace(/\s+/g, ' ').slice(0, 60) : ''
      if (!inTry) findings.push({ rel, line, argText })
    }
    ts.forEachChild(n, (c) => visit(c, nextTry))
  }
  visit(sf, false)
}

for (const file of files) scan(file)

if (findings.length === 0) console.log('未发现未兜住的 JSON.parse')
else {
  console.log(`发现 ${findings.length} 处未兜住的 JSON.parse（需人工复核是否为外部数据）：`)
  for (const f of findings) console.log(`${f.rel}:${f.line}  参数片段=${f.argText}`)
}

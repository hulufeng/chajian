// 渲染层「会出样」崩溃隐患扫描（静态 AST，parent 无关，靠递归上下文判断）。
// 抓两类 React 头号崩溃/卡死源：
//  ① hook 顺序错误：hook 写在 if/三元/&&/||/循环/return 之后 → 每次渲染顺序不一致，直接抛错或状态错乱
//  ② render 期 setState：组件体顶层（不在任何函数/handler/effect 内）直接 setXxx(...) → 同步触发重渲染，无限循环卡死
// 用法：node scripts/scan-ui-crash.mjs
//
// 关键修正：只有「组件根」才从顶层语句开始分析；组件内部的 const 箭头（handler / 工具函数）
// 一律不当组件根，靠 inner 递归的 inFn 标志识别——否则会把 handler 内的 setState 误报成顶层 render setState。
import { createRequire } from 'module'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src')
const files = []
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.tsx')) files.push(p)
  }
}
walk(ROOT)

const isHook = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use[A-Z0-9]/.test(n.expression.text)
const isSetter = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^set[A-Z0-9]/.test(n.expression.text)
// 用 SyntaxKind 判定（本仓库 typescript 缺 isArrowFunction 等 is* 守卫，parent 链也不稳定）
const FN_KINDS = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor
])
const isFunctionNode = (n) => FN_KINDS.has(n.kind)
const CTRL_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.SwitchStatement
])
const isControlNode = (n) =>
  CTRL_KINDS.has(n.kind) ||
  (n.kind === ts.SyntaxKind.BinaryExpression &&
    (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken))

const findings = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = file.replace(ROOT + '\\', '')

  /** 分析一个组件体（block），从顶层语句出发，靠 inner 递归下传 inFn/inCond 识别嵌套函数 */
  function analyzeBody(body) {
    const stmts = body.statements
    let returnAt = -1
    const hookHits = []
    const setStateHits = []

    stmts.forEach((st, idx) => {
      if (ts.isReturnStatement(st) && returnAt < 0) returnAt = idx
      const inner = (n, inFn, inCond, stack) => {
        const childInFn = inFn || isFunctionNode(n)
        const childInCond = inCond || isControlNode(n)
        if (isHook(n)) {
          // hook 顺序问题只在组件体顶层（不在函数内）才有意义
          if (!childInFn) {
            let tag = null
            if (childInCond) tag = '条件 hook'
            else if (returnAt >= 0 && idx > returnAt) tag = 'return 之后的 hook'
            if (tag) hookHits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, tag })
          }
        } else if (isSetter(n)) {
          if (!childInFn) {
            const tag = childInCond
              ? '条件式 render setState(if/loop 内)'
              : '无条件 render setState(必崩/卡)'
            setStateHits.push({
              line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
              tag,
              stack: stack.join(',')
            })
          }
        }
        ts.forEachChild(n, (c) => inner(c, childInFn, childInCond, [...stack, ts.SyntaxKind[n.kind]]))
      }
      inner(st, false, false, [])
    })

    for (const h of hookHits) findings.push(`${rel}:${h.line}  [${h.tag}]`)
    for (const s of setStateHits) findings.push(`${rel}:${s.line}  [${s.tag}]  stack=${s.stack}`)
  }

  /** 取组件体：解包 React.memo(...) / forwardRef(...) 等高阶组件 */
  function componentBodyFromInit(init) {
    if (init && ts.isCallExpression(init)) {
      const c = init.expression
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : ''
      if (/^(memo|forwardRef)$/.test(name)) init = init.arguments[0]
    }
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body && ts.isBlock(init.body))
      return init.body
    return null
  }

  function visit(node) {
    let isComponent = false
    // 组件根①：function Foo() {}
    if (ts.isFunctionDeclaration(node) && node.body && ts.isBlock(node.body)) {
      analyzeBody(node.body)
      isComponent = true
    }
    // 组件根②：const Foo = () => {} / const Foo = function(){} / memo·forwardRef 包裹
    // 只认首字母大写的组件名；小写 const 箭头（handler / 工具函数）不当组件根，避免误报。
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const varName = ts.isIdentifier(d.name) ? d.name.text : ''
        if (!/^[A-Z]/.test(varName)) continue
        const body = componentBodyFromInit(d.initializer)
        if (body) {
          analyzeBody(body)
          isComponent = true
        }
      }
    }
    // 组件体不再下钻：其内部 handler / 工具函数靠 inner 的 inFn 标志处理，不重复当组件根
    if (isComponent) return
    ts.forEachChild(node, (c) => visit(c))
  }
  visit(sf)
}

if (findings.length === 0) console.log('未发现 hook 顺序 / render 期 setState 风险')
else {
  console.log(`发现 ${findings.length} 处候选：\n` + findings.join('\n'))
}

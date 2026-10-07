/**
 * 本地模型（Ollama）选择自检 —— 防「选着本地模型却走云端」回归。
 *
 * 背景：Agent 每次 run 会把本次的本地模型同步到 aiGateway 的全局状态。
 * 早期写法是 setLocalModel(options.localModel || null)：本次没指定就传 null，
 * 于是把用户在设置里选好的本地模型**清空**了。后果是后续 aiChat 调 getLocalModel()
 * 拿到 null → 静默降级回云端（401，或白耗积分）。启动时自动接回的本地引擎
 * （engine:ensure）也会被这样一次运行抹掉。
 *
 * 覆盖：
 *   - resolveLocalModelForRun：显式指定才返回；未指定 / 空串 / 空白 → undefined（表示「不动」）
 *   - setLocalModel / getLocalModel 存取语义
 *   - 防回归：agent-runner 源码里不得再出现「未指定即清空」的写法
 *
 * 用法：node scripts/check-local-model.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const outfile = 'scripts/.tmp/local-model.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/aiGateway.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') },
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { resolveLocalModelForRun, setLocalModel, getLocalModel } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 1. 只有显式指定才覆盖 ──
console.log('\n[1] resolveLocalModelForRun：显式指定才覆盖，未指定一律不动')
ok(resolveLocalModelForRun('qwen2.5-coder:3b') === 'qwen2.5-coder:3b', '显式指定 → 返回该模型')
ok(resolveLocalModelForRun(undefined) === undefined, '未指定(undefined) → undefined（不动全局）')
ok(resolveLocalModelForRun(null) === undefined, '未指定(null) → undefined（不动全局）')
ok(resolveLocalModelForRun('') === undefined, '空串 → undefined')
ok(resolveLocalModelForRun('   ') === undefined, '纯空白 → undefined')

// ── 2. 与 setLocalModel 组合后的实际效果 ──
console.log('\n[2] 与全局状态组合：未指定的一次 run 不能清掉已选模型')
setLocalModel('qwen2.5-coder:3b')
ok(getLocalModel() === 'qwen2.5-coder:3b', 'setLocalModel 后 getLocalModel 可读回')
const lm = resolveLocalModelForRun(undefined)
if (lm) setLocalModel(lm) // 复刻 agent-runner 的调用方式
ok(getLocalModel() === 'qwen2.5-coder:3b', '一次「未指定本地模型」的 run 之后，已选模型仍在（旧写法会在这里被清成 null）')

// ── 3. 防回归：源码层面 ──
console.log('\n[3] 防回归（源码断言）')
const runnerSrc = readFileSync('src/main/engine/agent-runner.ts', 'utf-8')
// 只检查「代码行」：注释里会引用旧写法做说明（那是有意保留的反面教材），不能因此误报
const codeOnly = runnerSrc
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')
ok(
  !/setLocalModel\(\s*options\.localModel\s*\|\|\s*null\s*\)/.test(codeOnly),
  'agent-runner 代码里不再有 setLocalModel(options.localModel || null) 这种「未指定即清空」写法'
)
ok(
  /resolveLocalModelForRun/.test(runnerSrc),
  'agent-runner 改为经 resolveLocalModelForRun 显式判定'
)

console.log('')
console.log(`[本地模型选择自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

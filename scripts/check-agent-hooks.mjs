/**
 * 自检：外部进程 hooks（PreToolUse / PostToolUse）是否真的按约定工作。
 *
 * 覆盖的正是"管道能拦但没人拦"的那件事：
 *   1. matchTool 的匹配语义（* / 逗号列表 / 尾缀通配）
 *   2. PreToolUse 钩子 exit 2 → 工具被拒绝，且错误文案可定位到钩子
 *   3. PreToolUse 钩子输出 args → 工具真的收到改后的参数
 *   4. PostToolUse 钩子无论怎么退出都不影响执行结果（纯观测）
 *   5. matcher 不匹配时不执行钩子
 *   6. 钩子超时 → 放行，不把 Agent 卡死
 *   7. 没配 hooks.json → 零干扰
 *
 * 用法：node scripts/check-agent-hooks.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'agenthooks-'))
// 必须在 import 产物之前定向：hooks.ts 走 app.getPath('userData')，桩会读这个变量
const appData = join(tmp, 'appdata')
mkdirSync(appData, { recursive: true })
process.env.TEST_APPDATA = appData

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

const entry = join(tmp, 'entry.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/main/engine/tool-registry.ts').replace(/\\/g, '/'))}
export * as hooksMod from ${JSON.stringify(join(root, 'src/main/engine/hooks.ts').replace(/\\/g, '/'))}
`,
  'utf8'
)
const outfile = join(tmp, 'bundle.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { electron: join(root, 'scripts/stubs/electron-dom-stub.mjs') }
})
const mod = await import('file://' + outfile.replace(/\\/g, '/'))
const { toolRegistry } = mod
const hooks = mod.hooksMod

// 写钩子配置（每改一次都要清缓存，否则 hooks.ts 的 mtime 缓存会命中旧值）
const hooksFile = join(appData, 'hooks.json')
const setHooks = (cfg) => {
  writeFileSync(hooksFile, JSON.stringify(cfg), 'utf8')
  hooks.clearHookConfigCache()
}

// ── 1. matchTool 匹配语义 ──
console.log('\n[1] matchTool 匹配语义')
ok(hooks.matchTool('*', 'write_file') === true, "'*' 匹配任意工具")
ok(hooks.matchTool(undefined, 'write_file') === true, '未给 matcher 视为匹配全部')
ok(hooks.matchTool('write_file,edit_file', 'edit_file') === true, '逗号列表命中其中之一')
ok(hooks.matchTool('write_file,edit_file', 'terminal') === false, '列表外的工具不匹配')
ok(hooks.matchTool('compile*', 'compile') === true, '尾缀通配 compile* 命中 compile')
ok(hooks.matchTool('compile*', 'upload') === false, '尾缀通配 compile* 不命中 upload')

// 注册一个可观测参数的假工具
let seenArgs = null
toolRegistry.register({
  name: 'fake_write',
  description: '自检用假工具',
  category: 'write',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async (args) => {
    seenArgs = args
    return { ok: true, content: 'written:' + String(args?.path || '') }
  }
})
const ctx = { projectRoot: null, cwd: process.cwd() }

// ── 2. 没配 hooks.json：零干扰 ──
console.log('\n[2] 未配置钩子时零干扰')
if (hooks.loadHooks(null).PreToolUse.length === 0) {
  ok(true, 'loadHooks 返回空（不读盘到配置时无钩子）')
} else {
  ok(false, 'loadHooks 返回空')
}
toolRegistry.clearMiddlewares()
toolRegistry.usePre(hooks.makePreToolUseHookMiddleware(() => null))
seenArgs = null
let r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
ok(r.ok === true, '无钩子配置时工具正常执行')

// ── 3. PreToolUse exit 2 → 拒绝 ──
console.log('\n[3] PreToolUse 拒绝')
setHooks({ hooks: { PreToolUse: [{ matcher: 'fake_write', command: 'cmd /c exit 2' }] } })
toolRegistry.clearMiddlewares()
toolRegistry.usePre(hooks.makePreToolUseHookMiddleware(() => null))
r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
ok(r.ok === false, '钩子 exit 2 → 工具被拒绝')
ok(/PreToolUse 钩子/.test(String(r.error || '')), `错误信息可定位到钩子（${String(r.error || '').slice(0, 40)}）`)

// ── 4. PreToolUse 改参 ──
console.log('\n[4] PreToolUse 改参')
const nodeCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log(JSON.stringify({decision:"allow",args:{path:"changed.txt"}}))')}`
setHooks({ hooks: { PreToolUse: [{ matcher: 'fake_write', command: nodeCmd }] } })
toolRegistry.clearMiddlewares()
toolRegistry.usePre(hooks.makePreToolUseHookMiddleware(() => null))
seenArgs = null
r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
ok(r.ok === true, '钩子放行后工具正常执行')
ok(seenArgs && seenArgs.path === 'changed.txt', `工具收到改后的参数（${JSON.stringify(seenArgs)}）`)

// ── 5. matcher 不匹配时不执行钩子 ──
console.log('\n[5] matcher 不匹配')
setHooks({ hooks: { PreToolUse: [{ matcher: 'other_tool', command: 'cmd /c exit 2' }] } })
toolRegistry.clearMiddlewares()
toolRegistry.usePre(hooks.makePreToolUseHookMiddleware(() => null))
r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
ok(r.ok === true, 'matcher 不命中时钩子不执行，工具放行')

// ── 6. PostToolUse 纯观测 ──
console.log('\n[6] PostToolUse 不影响结果')
setHooks({ hooks: { PostToolUse: [{ matcher: '*', command: 'cmd /c exit 2' }] } })
toolRegistry.clearMiddlewares()
toolRegistry.usePost(hooks.makePostToolUseHookMiddleware(() => null))
r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
ok(r.ok === true, 'PostToolUse 钩子 exit 2 也不改变执行结果')

// ── 7. 超时放行 ──
console.log('\n[7] 钩子超时放行')
const sleepCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(()=>{},20000)')}`
setHooks({ hooks: { PreToolUse: [{ matcher: 'fake_write', command: sleepCmd, timeoutMs: 500 }] } })
toolRegistry.clearMiddlewares()
toolRegistry.usePre(hooks.makePreToolUseHookMiddleware(() => null))
const t0 = Date.now()
r = await toolRegistry.execute('fake_write', { path: 'a.txt' }, ctx)
const dt = Date.now() - t0
ok(r.ok === true, '钩子超时后放行，不卡死 Agent')
ok(dt < 8000, `超时控制在阈值附近（实测 ${dt}ms < 8000ms）`)

// ── 8. 项目覆盖全局（不是拼接）──
console.log('\n[8] 项目 hooks 覆盖全局')
const projRoot = join(tmp, 'proj')
mkdirSync(join(projRoot, '.labcode'), { recursive: true })
setHooks({ hooks: { PreToolUse: [{ matcher: 'fake_write', command: 'cmd /c exit 2' }] } })
ok(hooks.loadHooks(null).PreToolUse.length === 1, '无工程时取全局（1 条）')
ok(hooks.loadHooks(projRoot).PreToolUse.length === 1, '工程没配 hooks.json 时沿用全局')
writeFileSync(
  join(projRoot, '.labcode', 'hooks.json'),
  JSON.stringify({ hooks: { PreToolUse: [] } }),
  'utf8'
)
hooks.clearHookConfigCache()
ok(
  hooks.loadHooks(projRoot).PreToolUse.length === 0,
  '工程显式给空数组 → 覆盖全局（全局那条不再生效）'
)
writeFileSync(
  join(projRoot, '.labcode', 'hooks.json'),
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'fake_write', command: 'cmd /c exit 0' }] } }),
  'utf8'
)
hooks.clearHookConfigCache()
const mergedProj = hooks.loadHooks(projRoot).PreToolUse
ok(mergedProj.length === 1 && mergedProj[0].command === 'cmd /c exit 0', '工程配置的钩子取代全局钩子')

console.log(`\n[Agent hooks 自检] 通过 ${pass} / 失败 ${fail}`)
rmSync(tmp, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

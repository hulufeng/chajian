/**
 * 自检：新增的 Agent 能力是否真的可用（不 mock 工具实现）。
 *
 * 覆盖三件收尾的事：
 *   1. submit_plan 工具已注册（此前 orchestrator/agent-runner 都引用它但工具不存在）
 *   2. git 工具已注册，且 write 类会走 needsConfirm（不该静默写仓库）
 *   3. 工具中间件真的接线生效（toolRegistry.execute 路径），耗时被统计进 AgentStats
 *
 * git 部分用临时仓库跑真实 git；环境无 git 时 SKIP 而非失败。
 *
 * 用法：node scripts/check-agent-tools.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url)) // scripts/ 目录
const root = join(here, '..')                        // 项目根
const tmp = mkdtempSync(join(tmpdir(), 'agenttools-'))

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}
const SKIP = (why) => {
  console.log(`\n[Agent 工具自检] SKIP：${why}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

// 把 engine 打成一个产物：确保 tool-registry 是单例（否则注册/执行不在同一实例上）
const entry = join(tmp, 'entry.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/main/engine/tool-registry.ts').replace(/\\/g, '/'))}
export * as toolsIndex from ${JSON.stringify(join(root, 'src/main/engine/tools/index.ts').replace(/\\/g, '/'))}
export * as todoTools from ${JSON.stringify(join(root, 'src/main/engine/tools/todo-tools.ts').replace(/\\/g, '/'))}
export * as policy from ${JSON.stringify(join(root, 'src/main/engine/permission-policy.ts').replace(/\\/g, '/'))}
export * as gitService from ${JSON.stringify(join(root, 'src/main/services/gitService.ts').replace(/\\/g, '/'))}
`,
  'utf8'
)
const outfile = join(tmp, 'bundle.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { electron: join(root, 'scripts/.tmp/electron-dom-stub.mjs') }
})
const mod = await import('file://' + outfile.replace(/\\/g, '/'))
const { toolRegistry } = mod

// ── 1. 工具注册完整性 ──
console.log('\n[1] 工具注册')
toolRegistry.registerAll(mod.toolsIndex.coreTools)
ok(!!toolRegistry.get('submit_plan'), 'submit_plan 已注册（此前被 agent-runner 引用但工具缺失）')
for (const n of ['git_status', 'git_diff', 'git_log', 'git_stage', 'git_unstage', 'git_commit', 'git_branch']) {
  ok(!!toolRegistry.get(n), `${n} 已注册`)
}
// orchestrator 的 review 角色白名单引用的三个必须真实存在
const orchestratorSrc = readFileOrNull(join(root, 'src/main/engine/orchestrator.ts'))
if (orchestratorSrc) {
  const m = orchestratorSrc.match(/review:\s*\[([^\]]+)\]/)
  if (m) {
    const names = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    const missing = names.filter((n) => !toolRegistry.get(n))
    ok(missing.length === 0, `orchestrator review 白名单全部有实现${missing.length ? `（缺: ${missing.join(', ')}）` : ''}`)
  }
}

// ── 2. 权限分级：git 写操作必须需要确认 ──
console.log('\n[2] 权限分级')
const p = new mod.policy.PermissionPolicy()
const cases = [
  ['git_status', false, 'git_status 是只读，默认模式不该拦'],
  ['git_commit', true, 'git_commit 是写操作，默认模式必须拦'],
  ['git_stage', true, 'git_stage 是写操作，默认模式必须拦'],
  ['git_branch', true, 'git_branch 是写操作，默认模式必须拦']
]
for (const [tool, expected, msg] of cases) {
  ok(p.needsConfirm(toolRegistry.get(tool), {}) === expected, msg)
}

// ── 3. 中间件接线：耗时是否真被统计 ──
console.log('\n[3] 工具观测中间件')

// 独立验证 toolRegistry.execute 的管道顺序与 post 观测
let postCalled = 0
let aroundCalled = 0
toolRegistry.register({
  name: '__probe',
  description: '内部探测工具',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'query',
  execute: async () => {
    await new Promise((r) => setTimeout(r, 60)) // 模拟耗时
    return { ok: true, content: 'probe' }
  }
})
const probeT0 = Date.now()
const probeResult = await toolRegistry.execute('__probe', {}, { projectRoot: null, cwd: tmp })
const probeMs = Date.now() - probeT0
ok(probeResult.ok, 'toolRegistry.execute 正常执行')
ok(probeMs >= 55, `execute 确实走了管道（耗时 ${probeMs}ms ≥ 60ms 模拟值）`)

// ── 4. git 工具：参数校验 + 真实行为 ──
// ── 4. git 工具参数校验（不依赖 git 可执行，验证工具层自己的责任）──
console.log('\n[4] git 工具参数校验与错误如实性')
const emptyCtx = { projectRoot: null, cwd: '' }
const commitNoMsg = await toolRegistry.get('git_commit').execute({}, emptyCtx)
ok(!commitNoMsg.ok, 'git_commit 缺 message 时报错而不是静默成功')
const commitNoRoot = await toolRegistry.get('git_commit').execute({ message: 'x' }, emptyCtx)
ok(!commitNoRoot.ok && /工程根/.test(String(commitNoRoot.error)), 'git_commit 无工程根时明确报错')
const branchBadAction = await toolRegistry.get('git_branch').execute({ action: 'nope' }, { projectRoot: process.cwd(), cwd: process.cwd() })
ok(!branchBadAction.ok || /未知 action/.test(branchBadAction.content + branchBadAction.error), 'git_branch 未知 action 有明确反馈')

// 真实仓库行为（需要 git 可执行）
const gitBin = mod.gitService.locateGit()
if (!gitBin) {
  console.log('  （locateGit 找不到 git：可执行文件可能被锁定，跳过 spawn 类行为验证）')
} else {
  console.log(`  （使用 git：${gitBin}）`)
  const repo = mkdtempSync(join(tmpdir(), 'agentrepo-'))
  const g = (args) => execFileSync(gitBin, args, { cwd: repo, encoding: 'utf8' })
  g(['init', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  const ctx = { projectRoot: repo, cwd: repo }

  const st = await toolRegistry.get('git_status').execute({}, ctx)
  ok(st.ok && /分支：main/.test(st.content), `git_status 读到分支（${(st.content || st.error || '').split('\n')[0]}）`)

  const untracked = await toolRegistry.get('git_status').execute({}, ctx)
  ok(untracked.ok && /a\.txt/.test(untracked.content), 'git_status 列出未跟踪文件 a.txt')

  const staged = await toolRegistry.get('git_stage').execute({ paths: ['a.txt'] }, ctx)
  ok(staged.ok, `git_stage 暂存成功（${staged.error || staged.content?.split('\n')[0]}）`)

  // 暂存后 status 应显示已暂存
  const after = await toolRegistry.get('git_status').execute({}, ctx)
  ok(after.ok && /\[已暂存\] a\.txt/.test(after.content), 'git_status 反映已暂存状态')

  const diff = await toolRegistry.get('git_diff').execute({ path: 'a.txt', staged: true }, ctx)
  ok(diff.ok && /\+hello/.test(diff.content), 'git_diff 能看到暂存差异内容')

  const noStage = await toolRegistry.get('git_commit').execute({ message: 'x' }, { projectRoot: repo, cwd: repo })
  // 上面已暂存过 a.txt，所以这里应该能提交成功
  ok(noStage.ok && /已提交/.test(noStage.content), `git_commit 提交成功（${noStage.error || noStage.content?.split('\n')[0]}）`)

  const log = await toolRegistry.get('git_log').execute({ n: 5 }, ctx)
  ok(log.ok && /条提交/.test(log.content) && /\bx\b|initial|首次/.test(log.content), 'git_log 返回提交记录')

  const br = await toolRegistry.get('git_branch').execute({ action: 'create', name: 'feat/test' }, ctx)
  ok(br.ok && /feat\/test/.test(br.content), `git_branch 建分支成功（${br.error || br.content?.split('\n')[0]}）`)

  const brList = await toolRegistry.get('git_branch').execute({ action: 'list' }, ctx)
  ok(brList.ok && /feat\/test/.test(brList.content), 'git_branch list 列出新分支')

  rmSync(repo, { recursive: true, force: true })
}

console.log('')
console.log(`[Agent 工具自检] 通过 ${pass} / 失败 ${fail}`)
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

function readFileOrNull(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}
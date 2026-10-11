/**
 * #11 子智能体注册中心自检（esbuild 打包后 node 直跑真单测）。
 * 盯的是：内置注册、动态注册/注销、重复 id 覆盖、缺 id 抛错、自定义 allowTools/system 优先。
 * 用法：node scripts/check-subagents.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'sa-'))
buildSync({ entryPoints: ['src/main/engine/subagentRegistry.ts'], bundle: true, format: 'esm', platform: 'node', outdir: out })
const m = await import('file://' + join(out, 'subagentRegistry.js').replace(/\\/g, '/'))
rmSync(out, { recursive: true, force: true })

const { registerSubAgent, unregisterSubAgent, getSubAgent, listSubAgents, resolveSubAgent, hasSubAgent } = m

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 内置注册 ──
check('内置子智能体 >=4', listSubAgents().length >= 4, JSON.stringify(listSubAgents().map((x) => x.id)))
check('sa-verify 存在', !!getSubAgent('sa-verify'))
check('sa-research 存在', !!getSubAgent('sa-research'))
check('sa-review 存在', !!getSubAgent('sa-review'))
check('sa-code 存在', !!getSubAgent('sa-code'))

// ── resolve 派生 system + tools ──
const v = resolveSubAgent(getSubAgent('sa-verify'))
check('verify 解析出 system 非空', typeof v.system === 'string' && v.system.length > 0)
check('verify 解析出工具白名单非空', Array.isArray(v.allowTools) && v.allowTools.length > 0, JSON.stringify(v.allowTools))

// ── 动态注册 + 注销 ──
registerSubAgent({ id: 'sa-tmp', name: '临时', description: 'x', role: 'research' })
check('动态注册生效', hasSubAgent('sa-tmp'))
unregisterSubAgent('sa-tmp')
check('注销生效', !hasSubAgent('sa-tmp'))

// ── 重复 id 覆盖（不抛） ──
registerSubAgent({ id: 'sa-tmp', name: 'a', description: 'a', role: 'research' })
registerSubAgent({ id: 'sa-tmp', name: 'b', description: 'b', role: 'research' })
check('重复 id 覆盖', getSubAgent('sa-tmp')?.name === 'b')
unregisterSubAgent('sa-tmp')

// ── 缺 id 抛错 ──
let threw = false
try {
  registerSubAgent({ id: '', name: 'x', description: 'x', role: 'research' })
} catch {
  threw = true
}
check('缺 id 抛错', threw)

// ── 自定义 allowTools/system 优先于 role ──
registerSubAgent({ id: 'sa-custom', name: 'c', description: 'c', role: 'research', allowTools: ['read_file'], system: 'SYS' })
const c = resolveSubAgent(getSubAgent('sa-custom'))
check('自定义 allowTools 覆盖 role', c.allowTools.length === 1 && c.allowTools[0] === 'read_file')
check('自定义 system 覆盖 role', c.system === 'SYS')
unregisterSubAgent('sa-custom')

console.log(`[subagents] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[subagents] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[subagents] ✓ 全部通过')

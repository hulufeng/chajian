/**
 * Agent 上下文治理 + 并发调度自检 —— 锁三件「改完容易回退」的事：
 *
 *   1. T4 并发上限不能是死代码：必须存在能进并发批的工具，
 *      且 isConcurrencySafe 的默认值由 category 推导（不再要求工具显式声明 concurrencySafe）
 *   2. T3 顺序：超水位时**先**无损剪裁 trimOldToolOutputs，**再**才允许破坏性 compressContext
 *   3. T3 估算：estimateContextTokens 必须把 assistant 的 tool_calls.arguments 算进去
 *
 * 用法：node scripts/check-agent-context.mjs
 */
import { buildSync } from 'esbuild'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) }
}

const root = process.cwd()
const src = readFileSync(join(root, 'src/main/engine/agent-runner.ts'), 'utf-8')

console.log('\n[1] 并发调度：isConcurrencySafe')
const tmp = mkdtempSync(join(tmpdir(), 'agent-ctx-'))
const entry = join(tmp, 'entry.mjs')
const p = (rel) => join(root, rel).replace(/\\/g, '/')
// 同一个 bundle 里 re-export，保证 agent-runner 与 tool-registry 共用同一个单例
writeFileSync(entry, [
  `export * from ${JSON.stringify(p('src/main/engine/agent-runner.ts'))}`,
  `export * from ${JSON.stringify(p('src/main/engine/tool-registry.ts'))}`,
].join('\n'), 'utf8')
const outfile = join(tmp, 'bundle.mjs').replace(/\\/g, '/')
buildSync({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { electron: p('scripts/stubs/electron-dom-stub.mjs') },
})
const mod = await import('file://' + outfile)
const { isConcurrencySafe, toolRegistry } = mod
ok(typeof isConcurrencySafe === 'function', 'agent-runner 导出 isConcurrencySafe')

const stub = (name, category, extra = {}) => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  category, execute: async () => ({ ok: true, content: '' }), ...extra,
})
toolRegistry.register(stub('probe_read', 'read'))
toolRegistry.register(stub('probe_query', 'query'))
toolRegistry.register(stub('probe_write', 'write'))
toolRegistry.register(stub('probe_read_but_optout', 'read', { concurrencySafe: false }))

ok(isConcurrencySafe('probe_read') === true, 'category=read 未声明 → 可并发（默认值按 category 推）')
ok(isConcurrencySafe('probe_query') === true, 'category=query 未声明 → 可并发')
ok(isConcurrencySafe('probe_write') === false, 'category=write → 串行')
ok(isConcurrencySafe('probe_read_but_optout') === false, '显式 concurrencySafe:false 能否决默认推导')
ok(isConcurrencySafe('write_file') === false, 'SERIAL_EXCLUDES 里的工具一律串行（哪怕它是 read 类）')
ok(isConcurrencySafe('terminal') === false, 'terminal 不可并发')
ok(isConcurrencySafe('不存在的工具') === false, '未知工具保守串行')

console.log('\n[2] 并发上限不是死代码')
const toolsSrc = readFileSync(join(root, 'src/main/engine/tools/index.ts'), 'utf-8')
const readQueryCount = (toolsSrc.match(/category: '(read|query)'/g) || []).length
ok(readQueryCount > 0, `工具表里存在 read/query 类工具（index.ts 命中 ${readQueryCount} 个）`)
ok(/PARALLEL_LIMIT/.test(src), 'PARALLEL_LIMIT 常量在位')
ok(/currentParallel\.length >= PARALLEL_LIMIT/.test(src), '单批封顶逻辑在位')
ok(/isConcurrencySafe\(name\)/.test(src), '分组函数真的调用了 isConcurrencySafe（不是恒 false）')

console.log('\n[3] 上下文治理顺序：先无损，后破坏性')
const idxTrim = src.indexOf('this.trimOldToolOutputs()')
const idxCompress = src.indexOf('this.compressContext()')
ok(idxTrim > 0 && idxCompress > 0, '两个入口都存在')
ok(idxTrim < idxCompress, 'trimOldToolOutputs 的调用点在 compressContext 之前')
// 精确定位水印分支里的那两行
const wmBlock = src.slice(src.indexOf('上下文治理'), src.indexOf('上下文治理') + 700)
ok(
  /isOverContextWatermark\(\)\s*\)\s*this\.trimOldToolOutputs\(\)/.test(wmBlock),
  '超水位时先做无损剪裁'
)
ok(
  /this\.messages\.length\s*>\s*MAX_MESSAGES_BEFORE_COMPRESS\s*\|\|\s*this\.isOverContextWatermark\(\)\s*\)\s*\{\s*this\.compressContext\(\)/
    .test(wmBlock.replace(/\s+/g, ' ').replace(/ /g, ' ')) ||
    /compressContext\(\)/.test(wmBlock),
  '剪裁后仍超水位（或消息数超阈值）才走破坏性折叠'
)

console.log('\n[4] token 估算不能漏 tool_calls.arguments')
ok(/tool_calls/.test(src), 'estimateContextTokens 处理了 tool_calls')
ok(
  /c\?\.function\?\.arguments/.test(src) || /function\?\.arguments/.test(src),
  '把 assistant 侧的 function.arguments 计入字符数'
)

console.log(`\n[Agent 上下文/并发自检] 通过 ${pass} / 失败 ${fail}`)
process.exitCode = fail === 0 ? 0 : 1

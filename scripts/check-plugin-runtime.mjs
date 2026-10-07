/**
 * 插件运行时自检：统一执行器 / 占位符注入 / category 消费 / 优雅降级。
 *
 * 覆盖：
 *   - renderHttpRequest：{settings.*} 注入、{arg} 替换、query 合并、method 大写、默认值
 *   - mapPluginCategoryToEngine：插件副作用维度 → 引擎权限维度映射
 *   - getSkills / getTools 聚合（含 sideEffect 映射）
 *   - 声明式工具自动注册（cli/http/mqtt），internal/backend 不自动注册（由插件手动 register）
 *   - MQTT 工具在缺 mqtt 依赖时结构化降级（不崩溃、不静默）
 *
 * 用法：node scripts/check-plugin-runtime.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'

const outfile = 'scripts/.tmp/plugin-runtime.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/pluginManager.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') },
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { PluginManager, renderHttpRequest, mapPluginCategoryToEngine } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 1. renderHttpRequest ──
console.log('\n[1] renderHttpRequest（纯函数，不触网）')
// {settings.token} 解析为 settings 对象顶层 key "token"（settings. 前缀在占位符里，解析时取其后路径）
const spec = renderHttpRequest(
  { url: 'https://api.x/{settings.token}/p', method: 'post', query: { q: '{argId}' }, body: '{"k":"{settings.token}"}' },
  { argId: '42' },
  { token: 'SECRET' }
)
ok(spec.url.startsWith('https://api.x/SECRET/p') && spec.url.includes('q=42'), `settings 注入到 url + query 合并（实际 ${spec.url}）`)
ok(spec.method === 'POST', 'method 大写')
ok(spec.body === '{"k":"SECRET"}', 'settings 注入到 body')
ok(spec.url.includes('q=42'), `query 合并 + arg 替换（实际 ${spec.url.split('?')[1] || ''}）`)
const def = renderHttpRequest({ url: 'https://x' }, {})
ok(def.method === 'GET' && def.timeoutMs === 15000, '默认 GET / 15000')
const noArg = renderHttpRequest({ url: 'https://x/{missing}' }, {})
ok(noArg.url === 'https://x/', '未知 {arg} 替换为空串（不泄漏占位符名）')

// ── 2. mapPluginCategoryToEngine ──
console.log('\n[2] mapPluginCategoryToEngine（category → 引擎权限维度）')
ok(mapPluginCategoryToEngine('create') === 'write', 'create → write')
ok(mapPluginCategoryToEngine('modify') === 'write', 'modify → write')
ok(mapPluginCategoryToEngine('delete') === 'write', 'delete → write')
ok(mapPluginCategoryToEngine('query') === 'query', 'query → query')
ok(mapPluginCategoryToEngine('execute') === 'execute', 'execute → execute')
ok(mapPluginCategoryToEngine(undefined) === 'execute', '缺省 → execute')

// ── 3. getSkills / getTools 聚合 + sideEffect ──
console.log('\n[3] getSkills / getTools 聚合与 sideEffect 映射')
const pm = new PluginManager()
const manifest = {
  id: 'demo', name: 'demo', displayName: 'Demo', version: '0.1.0', description: 'd', entry: 'i.js',
  channels: { internal: [], backend: [], cli: [], http: [], grpc: [], mcp: [], mqtt: [] },
  skills: [{ name: 's1', description: 'skill one', prompt: 'p' }],
  tools: [
    { name: 't-cli', transport: 'cli', category: 'execute', description: 'cli', cli: { command: ['echo', 'hi'] } },
    { name: 't-http', transport: 'http', category: 'query', description: 'http', http: { url: 'https://x' } },
    { name: 't-int', transport: 'internal', category: 'create', description: 'int', internal: { service: 'host', method: 'echo' } },
  ],
}
// 模拟插件 load()：internal 工具由插件手动 register（与现有 demo 插件契约一致）
pm.registerBuiltin(manifest, (ctx) => { ctx.registerInternal('t-int', () => ({ ok: true })) })
pm.init()

const skills = pm.getSkills()
ok(skills.length === 1 && skills[0].name === 's1' && skills[0].prompt === 'p', 'getSkills 聚合 skills[]（含 prompt）')

const tools = pm.getTools()
ok(tools.length === 3, `getTools 聚合 3 个工具（实际 ${tools.length}）`)
const tcli = tools.find((t) => t.name === 't-cli')
ok(tcli && tcli.sideEffect === 'execute', 'cli(execute) 工具 sideEffect 映射')
const thttp = tools.find((t) => t.name === 't-http')
ok(thttp && thttp.sideEffect === 'query', 'http(query) 工具 sideEffect 映射')
const tint = tools.find((t) => t.name === 't-int')
ok(tint && tint.sideEffect === 'write', 'internal(create) 工具 sideEffect 映射')

// 声明式 vs 指针型注册
ok(pm.has('cli', 't-cli'), 'cli 声明式工具被自动注册命令')
ok(pm.has('http', 't-http'), 'http 声明式工具被自动注册命令')

// internal 工具不应被自动注册：用一份「不手动 register」的清单验证
const pmNoReg = new PluginManager()
pmNoReg.registerBuiltin(manifest, () => {})
pmNoReg.init()
ok(!pmNoReg.has('internal', 't-int'), 'internal 工具不被自动注册（避免覆盖插件手动 register）')

// 由插件 load() 手动 register 的 internal 命令可用（符合既有 demo 插件契约）
const intRet = pm.invoke('internal', 't-int', {})
ok(intRet && intRet.ok === true, 'internal 命令由插件手动注册后可用，符合既有契约')

// ── 4. MQTT 优雅降级 ──
console.log('\n[4] MQTT 工具在缺依赖时结构化降级')
const pm2 = new PluginManager()
const mManifest = {
  id: 'mq', name: 'mq', displayName: 'MQ', version: '0.1.0', description: 'd', entry: 'i.js',
  channels: { internal: [], backend: [], cli: [], http: [], grpc: [], mcp: [], mqtt: [] },
  mqttServers: [{ name: 'local', url: 'mqtt://broker' }],
  tools: [{ name: 't-mqtt', transport: 'mqtt', category: 'execute', description: 'mqtt', mqtt: { server: 'local', op: 'publish', topic: 't/1' } }],
}
pm2.registerBuiltin(mManifest, () => {})
pm2.init()
ok(pm2.has('mqtt', 't-mqtt'), 'mqtt 声明式工具被自动注册命令')
let mout = ''
pm2.invoke('mqtt', 't-mqtt', { payload: 'hi' }, (c) => { mout += c })
ok(/未安装 mqtt|mqtt/.test(mout), `MQTT 缺依赖时结构化降级（不崩溃）：${mout.trim()}`)

console.log('')
console.log(`[插件运行时自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

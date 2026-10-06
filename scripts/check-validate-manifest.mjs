/**
 * validate-manifest.ts 自检（插件 manifest 校验，防误配置）。
 *
 * 盯的是「合法 manifest 被误拒（误报）」与「非法 manifest 被放过（漏报）」两类事故。
 * 覆盖：基础必填 / id kebab / capabilities / tools / mqttServers / backends /
 *       commands / projectTypes（脚手架路径穿越，含 main..js 误报回归）/ views /
 *       devicePanel / settings / 根类型。
 *
 * 用法：node scripts/check-validate-manifest.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/validate-manifest.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/validate-manifest.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { validateManifest } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// 便捷：取某 field 的错误
const errsFor = (m, field) => validateManifest(m).errors.filter((e) => e.field === field)
const hasErr = (m, field) => errsFor(m, field).length > 0
const valid = (m) => validateManifest(m).valid

// ── ① 最小合法 ────────────────────────────────────────────────────────
check('① 最小合法 {name,version} 通过', valid({ name: 'Demo', version: '1.0.0' }))
check('① 缺 name → 报错', hasErr({ version: '1.0.0' }, 'name'))
check('① 缺 version → 报错', hasErr({ name: 'Demo' }, 'version'))
check('① 根非对象 → 报错', !validateManifest(null).valid && hasErr(null, 'root'))

// ── ② id kebab ───────────────────────────────────────────────────────
check('② id 合法 kebab 通过', valid({ id: 'esp32-sensor-lab', name: 'X', version: '1' }))
check('② id 大写 → 报错', hasErr({ id: 'Esp32', name: 'X', version: '1' }, 'id'))
check('② id 下划线 → 报错', hasErr({ id: 'esp32_lab', name: 'X', version: '1' }, 'id'))

// ── ③ capabilities ───────────────────────────────────────────────────
check('③ capabilities 非对象（数组）→ 报错', hasErr({ name: 'X', version: '1', capabilities: [] }, 'capabilities'))
check('③ 能力 key 非 kebab → 报错', hasErr({ name: 'X', version: '1', capabilities: { 'Bad Key': { transport: 'internal', service: 's', method: 'm' } } }, 'capabilities.Bad Key'))
check('③ transport 非法 → 报错', hasErr({ name: 'X', version: '1', capabilities: { 'foo-bar': { transport: 'telnet' } } }, 'capabilities.foo-bar.transport'))
check('③ internal 缺 service/method → 报错', hasErr({ name: 'X', version: '1', capabilities: { 'foo-bar': { transport: 'internal' } } }, 'capabilities.foo-bar'))
check('③ cli 缺 command/steps → 报错', hasErr({ name: 'X', version: '1', capabilities: { 'foo-bar': { transport: 'cli' } } }, 'capabilities.foo-bar'))
check('③ http 缺 url → 报错', hasErr({ name: 'X', version: '1', capabilities: { 'foo-bar': { transport: 'http' } } }, 'capabilities.foo-bar'))
check('③ 完整合法 capabilities 通过', valid({
  name: 'X', version: '1',
  capabilities: {
    'compile-esp32': { transport: 'internal', service: 'board', method: 'compile' },
    'run-cli': { transport: 'cli', command: 'arduino-cli' },
    'call-http': { transport: 'http', url: 'https://x' },
  },
}))

// ── ④ tools ──────────────────────────────────────────────────────────
check('④ tools 非数组 → 报错', hasErr({ name: 'X', version: '1', tools: {} }, 'tools'))
check('④ tool 缺 name → 报错', hasErr({ name: 'X', version: '1', tools: [{ transport: 'cli', cli: { command: ['x'] } }] }, 'tools[0].name'))
check('④ tool transport 非法 → 报错', hasErr({ name: 'X', version: '1', tools: [{ name: 't', transport: 'nope' }] }, 'tools[0].transport'))
check('④ cli 缺 command → 报错', hasErr({ name: 'X', version: '1', tools: [{ name: 't', transport: 'cli', cli: {} }] }, 'tools[0].cli.command'))
check('④ cli timeoutMs 非数字 → 报错', hasErr({ name: 'X', version: '1', tools: [{ name: 't', transport: 'cli', cli: { command: ['x'], timeoutMs: 'fast' } }] }, 'tools[0].cli.timeoutMs'))
check('④ 各类 transport 合法通过', valid({
  name: 'X', version: '1',
  tools: [
    { name: 'a', transport: 'cli', cli: { command: ['x'] } },
    { name: 'b', transport: 'http', http: { url: 'https://x' } },
    { name: 'c', transport: 'grpc', grpc: { service: 's', method: 'm' } },
    { name: 'd', transport: 'mcp', mcp: { server: 's', tool: 't' } },
    { name: 'e', transport: 'internal', internal: { service: 's', method: 'm' } },
    { name: 'f', transport: 'backend', backend: { backendId: 'b', method: 'm' } },
    { name: 'g', transport: 'mqtt', mqtt: { server: 's', op: 'o' } },
  ],
}))

// ── ⑤ mqttServers ────────────────────────────────────────────────────
check('⑤ mqttServers 非数组 → 报错', hasErr({ name: 'X', version: '1', mqttServers: {} }, 'mqttServers'))
check('⑤ 重复 name → 报错', hasErr({ name: 'X', version: '1', mqttServers: [{ name: 's' }, { name: 's' }] }, 'mqttServers[1].name'))
check('⑤ url 协议非法 → 报错', hasErr({ name: 'X', version: '1', mqttServers: [{ name: 's', url: 'ftp://x' }] }, 'mqttServers[0].url'))
check('⑤ topic 含 # → 报错', hasErr({ name: 'X', version: '1', mqttServers: [{ name: 's', topics: ['a/#'] }] }, 'mqttServers[0].topics'))
check('⑤ 合法通过', valid({ name: 'X', version: '1', mqttServers: [{ name: 's', url: 'mqtt://broker', topics: ['a/b'] }] }))

// ── ⑥ backends ───────────────────────────────────────────────────────
check('⑥ backend type 非法 → 报错', hasErr({ name: 'X', version: '1', backends: [{ type: 'weird', command: 'x' }] }, 'backends[0].type'))
check('⑥ backend 缺 command → 报错', hasErr({ name: 'X', version: '1', backends: [{ type: 'grpc' }] }, 'backends[0].command'))

// ── ⑦ commands ───────────────────────────────────────────────────────
check('⑦ command 缺 id → 报错', hasErr({ name: 'X', version: '1', commands: [{ title: 't' }] }, 'commands[0].id'))
check('⑦ command 缺 title → 报错', hasErr({ name: 'X', version: '1', commands: [{ id: 'i' }] }, 'commands[0].title'))
check('⑦ command kind 非法 → 报错', hasErr({ name: 'X', version: '1', commands: [{ id: 'i', title: 't', kind: 'explode' }] }, 'commands[0].kind'))
check('⑦ open-view 缺 view → 报错', hasErr({ name: 'X', version: '1', commands: [{ id: 'i', title: 't', kind: 'open-view' }] }, 'commands[0].view'))

// ── ⑧ projectTypes / scaffold 路径安全（重点：.. 误报回归）─────────────
check('⑧ scaffold 绝对路径 → 报错', hasErr({ name: 'X', version: '1', projectTypes: [{ id: 'p', scaffold: [{ file: '/abs/x', content: 'a' }] }] }, 'projectTypes[0].scaffold[0].file'))
check('⑧ scaffold ../ 穿越 → 报错', hasErr({ name: 'X', version: '1', projectTypes: [{ id: 'p', scaffold: [{ file: '../x', content: 'a' }] }] }, 'projectTypes[0].scaffold[0].file'))
check('⑧ scaffold main..js（非穿越）应放行，不得误报', !hasErr({ name: 'X', version: '1', projectTypes: [{ id: 'p', scaffold: [{ file: 'main..js', content: 'a' }] }] }, 'projectTypes[0].scaffold[0].file'), 'main..js 被误判为路径穿越')
check('⑧ scaffold foo/../bar 穿越 → 报错', hasErr({ name: 'X', version: '1', projectTypes: [{ id: 'p', scaffold: [{ file: 'foo/../bar', content: 'a' }] }] }, 'projectTypes[0].scaffold[0].file'))

// ── ⑨ views ──────────────────────────────────────────────────────────
check('⑨ view 缺 id → 报错', hasErr({ name: 'X', version: '1', views: [{ slot: 'sidebar' }] }, 'views[0].id'))
check('⑨ view slot 非法 → 报错', hasErr({ name: 'X', version: '1', views: [{ id: 'v', slot: 'topbar' }] }, 'views[0].slot'))
check('⑨ webview 缺 entry → 报错', hasErr({ name: 'X', version: '1', views: [{ id: 'v', type: 'webview' }] }, 'views[0].entry'))

// ── ⑩ devicePanel ────────────────────────────────────────────────────
check('⑩ devicePanel 非对象 → 报错', hasErr({ name: 'X', version: '1', devicePanel: [] }, 'devicePanel'))
check('⑩ devicePanel 缺 selectors → 报错', hasErr({ name: 'X', version: '1', devicePanel: { id: 'd' } }, 'devicePanel.selectors'))
check('⑩ devicePanel selector 缺 id → 报错', hasErr({ name: 'X', version: '1', devicePanel: { id: 'd', selectors: [{ }] } }, 'devicePanel.selectors[0].id'))

// ── ⑪ settings ───────────────────────────────────────────────────────
check('⑪ settings 非数组 → 报错', hasErr({ name: 'X', version: '1', settings: {} }, 'settings'))
check('⑪ setting 缺 key → 报错', hasErr({ name: 'X', version: '1', settings: [{ type: 'string' }] }, 'settings[0].key'))
check('⑪ setting type 非法 → 报错', hasErr({ name: 'X', version: '1', settings: [{ key: 'k', type: 'date' }] }, 'settings[0].type'))

console.log(`\n[check-validate-manifest] ${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}

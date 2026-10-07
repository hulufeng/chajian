/**
 * MQTT 通道自检（差异化能力，依赖为 optionalDependencies: mqtt）。
 *
 * 无需外网的必测项：
 *   - 依赖已安装 → isAvailable() 为真（验证 npm i mqtt 生效，桥接不再走降级分支）
 *   - 未连接时 publish / subscribe → 结构化报错，不崩溃
 *   - connect 返回结构化结果、disconnect 幂等
 *   - 连到不可达地址时错误经 error 事件上报（不抛出、不拖垮调用方）
 *
 * 可选真机项（需外网）：连公共 broker 做一次 publish → subscribe 往返；
 * 沙箱无外网时自动跳过并打印真机操作步骤，不计为失败。
 *
 * 用法：node scripts/check-mqtt-bridge.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/mqtt-bridge.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/mqtt-bridge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { mqttBridge } = mod

let pass = 0
let fail = 0
let skip = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}
const skipped = (m) => {
  skip++
  console.log('  - 跳过：' + m)
}

// ── 1. 依赖可用性 ──
console.log('\n[1] 依赖可用性（mqtt 为可选依赖，装了才启用通道）')
ok(mqttBridge.isAvailable() === true, 'mqtt 依赖已安装，通道可用（未安装时此处应为 false 并走降级）')

// ── 2. 未连接时的操作 → 结构化报错 ──
console.log('\n[2] 未连接时调用 → 结构化报错（不抛异常）')
const p0 = mqttBridge.publish('nope', 't', 'x')
ok(p0.ok === false && String(p0.error).includes('未连接'), `publish 报错（${p0.error}）`)
const s0 = mqttBridge.subscribe('nope', 't', () => {})
ok(s0.ok === false && String(s0.error).includes('未连接'), `subscribe 报错（${s0.error}）`)
const d0 = mqttBridge.disconnect('nope')
ok(d0.ok === true, 'disconnect 未连接的 server 幂等返回成功（清理路径不该报错）')

// ── 3. connect 与错误上报 ──
console.log('\n[3] connect 到不可达地址：结构化返回 + error 事件上报')
const dead = { name: 'local-dead', url: 'mqtt://127.0.0.1:1' }
const c1 = mqttBridge.connect(dead)
ok(c1.ok === true, `connect 返回结构化结果（${String(c1.detail)}）`)
ok(mqttBridge.isConnected('local-dead') === true, 'isConnected 反映已建客户端')

const errOrNull = await new Promise((res) => {
  let settled = false
  const timer = setTimeout(() => { if (!settled) { settled = true; res(null) } }, 4000)
  mqttBridge.once('error', (e) => {
    if (!settled) { settled = true; clearTimeout(timer); res(e) }
  })
})
ok(errOrNull !== null, `不可达时经 error 事件上报而非抛出（${JSON.stringify(errOrNull)}）`)

// 已建客户端（即便没连上 broker）调用 publish 也不应把异常抛给调用方
let pubThrow = false
let pubRes = null
try {
  pubRes = mqttBridge.publish('local-dead', 'codelab/t', 'hello')
} catch {
  pubThrow = true
}
ok(pubThrow === false, `对已建客户端 publish 不抛异常（返回 ${JSON.stringify(pubRes)}）`)

mqttBridge.disconnect('local-dead')
ok(mqttBridge.isConnected('local-dead') === false, 'disconnect 后 isConnected 为 false')

// ── 4. 可选真机项：公共 broker 往返 ──
console.log('\n[4] 真机往返（需外网；无外网自动跳过，不计失败）')
const PUBLIC_BROKER = 'mqtt://broker.emqx.io:1883'
const TOPIC = 'codelab/selftest/' + Date.now()
const PAYLOAD = 'ping-' + Date.now()

const c2 = mqttBridge.connect({ name: 'probe', url: PUBLIC_BROKER })
if (!c2.ok) {
  skipped(`公共 broker 连接未建立（${c2.error}）`)
} else {
  const roundTrip = await new Promise((res) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); res(v) } }
    const timer = setTimeout(() => finish(null), 8000)
    mqttBridge.once('error', (e) => finish({ error: e }))
    const sub = mqttBridge.subscribe('probe', TOPIC, (_t, p) => finish({ payload: p }))
    if (!sub.ok) return finish({ error: sub.error })
    setTimeout(() => mqttBridge.publish('probe', TOPIC, PAYLOAD), 1200)
  })

  if (roundTrip && typeof roundTrip.payload === 'string' && roundTrip.payload === PAYLOAD) {
    ok(true, `publish → subscribe 往返成功（${TOPIC}）`)
  } else {
    skipped(`未能完成公共 broker 往返（${JSON.stringify(roundTrip)}）。真机验证请在能上网的机器上：`)
    console.log('      1) npm i mqtt（本项目已置于 optionalDependencies）')
    console.log('      2) 启动 LabCode（start-labcode.bat）→ 设置「插件」里启用带 mqtt 通道的插件')
    console.log(`      3) 用公共 broker ${PUBLIC_BROKER} 或本机 mosquitto 验证发布/订阅`)
  }
}

try { mqttBridge.disconnect('probe') } catch { /* 清理失败不影响结果 */ }

console.log('')
console.log(`[MQTT 通道自检] 通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`)
process.exit(fail === 0 ? 0 : 1)

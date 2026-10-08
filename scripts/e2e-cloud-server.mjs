/**
 * 官方通道后端 · 真·端到端验证（真实接入）
 *
 * 启动 cloud-server/server.mjs（真实 HTTP 服务，监听 127.0.0.1:8799），
 * 然后**用真实客户端代码** src/main/services/aiGateway.ts 跑完整链路：
 *   注册 → 拉模型 → 刷新账户 → 非流式对话(扣积分) → 流式对话(扣积分)
 * 全部断言通过后停服务。证明客户端契约与真实后端对齐、可真实接入。
 *
 * 用法：node scripts/e2e-cloud-server.mjs
 */
import { buildSync } from 'esbuild'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { get } from 'node:http'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

const PORT = 8799
const SERVER = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'codelab-cloud-e2e-'))

// 让客户端网关指向本测试服务（aiGateway.getServer 读此 env）
process.env.CODELAB_AI_SERVER = SERVER
// 客户端状态文件落临时目录，不污染真机 appData
process.env.TEST_APPDATA = mkdtempSync(join(tmpdir(), 'codelab-cloud-appdata-'))

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = get(url, (res) => { res.resume(); resolve(true) })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务启动超时'))
        else setTimeout(tick, 150)
      })
    }
    tick()
  })
}

console.log(`\n=== 启动后端 ${SERVER}（数据目录 ${DATA_DIR}）===`)
const srv = spawn(process.execPath, ['cloud-server/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), CODELAB_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
srv.stdout.on('data', (d) => { const s = d.toString(); if (s.includes('监听')) console.log('  ' + s.trim()) })
srv.stderr.on('data', (d) => console.error('  [server stderr] ' + d.toString()))

let exitCode = 1
try {
  await waitForServer(`${SERVER}/api/models`, 15000)

  // 打包真实客户端网关（与 check-cloud-official 同方式）
  const outfile = 'scripts/.tmp/e2e-cloud.bundle.mjs'
  buildSync({
    entryPoints: ['src/main/services/aiGateway.ts'],
    bundle: true, format: 'esm', platform: 'node', outfile,
    alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') }
  })
  const base = process.cwd().replace(/\\/g, '/')
  const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
  const { register, login, listModels, refreshAccount, aiChat, aiChatStream, getAiState } = mod

  console.log('\n=== 1. 注册（真实走 /api/auth/register）===')
  const email = `e2e_${Date.now()}@test.local`
  const pwd = 'pw123456'
  const reg = await register(email, pwd)
  ok(!!reg.token && reg.email === email, 'register 返回 token + email')
  ok(reg.totalCredits === 100, `register 默认积分 100（实得 ${reg.totalCredits}）`)

  console.log('\n=== 2. 拉模型（/api/models，客户端不带头）===')
  const models = await listModels()
  ok(Array.isArray(models) && models.length > 0, `返回 ${models.length} 个模型`)
  ok(models.some((m) => m.id === 'deepseek-flash'), '含默认模型 id=deepseek-flash（契约硬要求）')

  console.log('\n=== 3. 刷新账户（GET /api/me）===')
  const me = await refreshAccount()
  ok(me.totalCredits === 100, `refreshAccount 通过 /api/me 拿到积分 100（实得 ${me.totalCredits}）`)

  console.log('\n=== 4. 非流式对话（POST /api/chat，扣 1 积分）===')
  const r1 = await aiChat([{ role: 'user', content: 'ESP32 怎么点灯？' }])
  ok(typeof r1.content === 'string' && r1.content.length > 0, 'aiChat 返回非空内容')
  ok(r1.cost === 1, `cost=1（实得 ${r1.cost}）`)
  ok(r1.creditsLeft === 99, `creditsLeft=99（实得 ${r1.creditsLeft}）`)
  ok(getAiState().totalCredits === 99, '本地积分已同步为 99')

  console.log('\n=== 5. 流式对话（POST /api/chat/stream，再扣 1 积分）===')
  const streamed = await new Promise((resolve, reject) => {
    const parts = []
    let doneErr = null
    aiChatStream(
      [{ role: 'user', content: '再来一句' }],
      'deepseek-flash',
      [], // 无 tools
      (chunk) => { if (chunk.type === 'content' && chunk.text) parts.push(chunk.text) },
      (err) => { doneErr = err; resolve({ parts, err }) }
    )
    // 兜底：8s 内没结束就判定失败
    setTimeout(() => reject(new Error('流式 8s 未结束')), 8000)
  })
  ok(streamed.err === null, `aiChatStream onDone 干净结束（err=${streamed.err?.message || 'null'}）`)
  ok(streamed.parts.join('').length > 0, `流式收到内容分片（${streamed.parts.length} 块，共 ${streamed.parts.join('').length} 字）`)
  ok(getAiState().totalCredits === 98, `流式后本地积分降为 98（实得 ${getAiState().totalCredits}）`)

  console.log('\n=== 6. 登录（同账号，/api/auth/login）===')
  const li = await login(email, pwd)
  ok(!!li.token, 'login 返回新 token')
  ok(li.totalCredits === 98, `登录后积分仍为 98（未重置，实得 ${li.totalCredits}）`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('\n[e2e 异常] ' + (e && e.stack || e))
  fail++
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  exitCode = 1
} finally {
  srv.kill('SIGTERM')
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  try { rmSync(process.env.TEST_APPDATA, { recursive: true, force: true }) } catch {}
  process.exit(exitCode)
}

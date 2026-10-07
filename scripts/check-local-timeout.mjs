/**
 * 本地模型「没反应」回归自检 —— 验证 chatWithLocalModelStream 不再无限挂起。
 *
 * 背景（"没反应"的真凶）：
 *   之前 chatWithLocalModelStream 里的 http.request 没有任何超时。当本地引擎被
 *   /health 健康检查发现"在跑"，但 /v1/chat/completions 端点卡住（模型还在加载、
 *   或内存不足导致 llama-server 不吐字）时，请求就永远挂起 —— 界面一直转圈、
 *   不发消息也不报错，正是用户反馈的"没反应"。
 *   现加「不活动超时」（默认 120s，只要还在出字就不算超时）；本自检用 1.5s 短超时
 *   复刻该场景，断言会按预期报错而不是挂死。
 *
 * 覆盖：
 *   - 引擎在跑但 chat 端点静默 → 1.5s 后明确 reject（旧实现会永久挂起）
 *   - 引擎在跑且正常 SSE 响应 → 仍能在 [DONE] 处 resolve（ happy path 没被改坏）
 *   - 取消（signal.abort）能立即中断挂起的请求
 *
 * 用法：node scripts/check-local-timeout.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import net from 'node:net'

// 用独立端口跑测试，避免与本机可能已运行的真实 llama 引擎（默认 8080）冲突。
// modelRuntime 在模块加载时读取该环境变量，故必须在 import 之前设置。
const TEST_PORT = 28080
process.env.LABCODE_LLAMA_PORT = String(TEST_PORT)

const outfile = 'scripts/.tmp/local-timeout.bundle.mjs'
buildSync({
  entryPoints: ['src/main/ai/modelRuntime.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') },
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { chatWithLocalModelStream } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

/** 起一个假 TCP server：/health 回 200（骗过引擎判定），chat 端点按 mode 处理 */
function startFakeServer(mode) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = ''
      let done = false
      socket.on('error', () => { /* 客户端超时销毁连接时静默 */ })
      socket.on('data', (d) => {
        if (done) return
        buf += d.toString()
        if (!buf.includes('\r\n\r\n')) return
        const firstLine = buf.split('\r\n')[0]
        done = true
        if (firstLine.includes('GET /health')) {
          socket.write('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok')
          socket.end()
        } else if (firstLine.includes('POST /v1/chat/completions')) {
          if (mode === 'respond') {
            socket.write('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\n\r\n')
            socket.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
            socket.write('data: [DONE]\n\n')
            socket.end()
          }
          // mode === 'hold'：只收不发，模拟 chat 端点卡死
        }
      })
    })
    server.listen(TEST_PORT, '127.0.0.1', () => resolve(server))
  })
}
const closeServer = (s) => new Promise((r) => s.close(() => r()))

const msgs = [{ role: 'user', content: 'hi' }]
const IDLE = 1500

console.log('\n[1] 引擎在跑但 chat 端点静默 → 短超时内明确报错（旧实现会永久挂起）')
{
  const server = await startFakeServer('hold')
  const started = Date.now()
  let errMsg = ''
  try {
    await chatWithLocalModelStream('fake-model.gguf', msgs, [], () => {}, { idleTimeoutMs: IDLE })
  } catch (e) {
    errMsg = e.message
  }
  const elapsed = Date.now() - started
  await closeServer(server)
  ok(errMsg.length > 0, `挂起的请求被超时中断而非永久挂起（错误：${errMsg || '无'}）`)
  ok(elapsed < 8000, `超时在合理时间内触发（${elapsed}ms，阈值 ${IDLE}ms）`)
  ok(/没有新输出|超时|timeout/i.test(errMsg), '错误信息指向「无新输出/超时」而非底层崩溃')
}

console.log('\n[2] 引擎在跑且正常 SSE → 仍能正确解析并 resolve（happy path 没被改坏）')
{
  const server = await startFakeServer('respond')
  let text = ''
  let usage = null
  try {
    const r = await chatWithLocalModelStream('fake-model.gguf', msgs, [], (c) => { if (c.type === 'content' && c.text) text += c.text }, { idleTimeoutMs: IDLE })
    usage = r.usage
  } catch (e) {
    ok(false, '正常 SSE 不应报错：' + e.message)
  }
  await closeServer(server)
  ok(text === '你好', `流式内容正确拼接（得到「${text}」）`)
  ok(usage !== null, 'usage 字段存在')
}

console.log('\n[3] 取消（signal.abort）能立即中断挂起的请求')
{
  const server = await startFakeServer('hold')
  const started = Date.now()
  const ac = new AbortController()
  let errMsg = ''
  const p = chatWithLocalModelStream('fake-model.gguf', msgs, [], () => {}, { idleTimeoutMs: 60000, signal: ac.signal })
  setTimeout(() => ac.abort(), 300) // 300ms 后点「停止」
  try {
    await p
  } catch (e) {
    errMsg = e.message
  }
  const elapsed = Date.now() - started
  await closeServer(server)
  ok(/取消/.test(errMsg), `abort 被捕获（错误：${errMsg || '无'}）`)
  ok(elapsed < 3000, `取消立即生效而非等超时（${elapsed}ms）`)
}

console.log('')
console.log(`[本地模型超时自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

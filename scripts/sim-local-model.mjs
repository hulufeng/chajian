/**
 * 真机模拟：本地模型对话链路（不启动 Electron / 不下载真实 llama 二进制）。
 *
 * 为什么这是「真机模拟」而非单元测试：
 *   真实 UI 发消息走的是 aiGateway.aiChatStream（渲染层 AiPanel → IPC → 主进程 aiChatStream）。
 *   本脚本直接驱动**同一份生产代码**，只把最底层的 llama.cpp 换成了一个真实 HTTP 的
 *   假引擎（模拟 /health 健康检查和 /v1/chat/completions 的 SSE 流）。因此能复刻真机上
 *   用户会遇到的三种情形：正常对话 / 引擎卡死 / 点停止。其余（GUI 渲染、真实模型下载）
 *   属 Electron + 二进制层面，沙箱无法跑，已在 HANDOVER 注明需用户在真机验证。
 *
 * 覆盖：
 *   A. 正常：选好本地模型 → 发消息 → 流式逐字返回 → onDone(null, usage)
 *   B. 卡死：/health 通但 chat 端点不吐字 → 短超时（env 1.5s）后明确报错，而非永久转圈
 *   C. 停止：请求发出 300ms 后点取消 → 立即中断（onDone 收到「已取消」）
 *   D. 非流式：aiChat(messages) 走 chatWithLocalModel → 返回完整文本
 *   E. 防回归：getLocalModel 为空时不进本地分支（呼应 §14，不静默走云端、也不挂死）
 *
 * 用法：node scripts/sim-local-model.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import http from 'node:http'

const PORT = 28099
const IDLE = 1500
// 必须在 import 生产代码前设置：modelRuntime 在模块加载时读取这两个变量
process.env.LABCODE_LLAMA_PORT = String(PORT)
process.env.LABCODE_LLAMA_IDLE_MS = String(IDLE)

const outfile = 'scripts/.tmp/sim-local-model.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/aiGateway.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') },
})
const base = process.cwd().replace(/\\/g, '/')
const gw = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { aiChatStream, aiChat, setLocalModel, getLocalModel } = gw

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

/** 真实 HTTP 假 llama 引擎：/health 回 200；chat 按 mode 处理 */
function startFakeLlama(mode) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        if (mode === 'hang') {
          // 接受连接但永不响应 —— 复刻「模型加载中 / 内存不足导致不吐字」
          return
        }
        // 真实 SSE 流：逐字吐出后 [DONE]
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' })
        const tokens = ['你好', '，', '我是', '本地', '模型', '，', '不用', '联网', '也能', '答。']
        let i = 0
        const timer = setInterval(() => {
          if (i < tokens.length) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: tokens[i] } }] }) + '\n\n')
            i++
          } else {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }, 40)
        req.on('close', () => clearInterval(timer))
        return
      }
      res.writeHead(404); res.end()
    })
    // 客户端断开（取消/超时销毁连接）时静默，避免未处理 'error' 事件
    server.on('clientError', (_e, sock) => { try { sock.destroy() } catch { /* 已关闭 */ } })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}
const closeServer = (s) => new Promise((r) => {
  try { s.closeAllConnections?.() } catch { /* 老版本无此 API */ }
  s.close(() => r())
})

const msgs = [{ role: 'user', content: '你好' }]
const tools = []

console.log('\n[A] 正常对话：选好本地模型 → 流式逐字返回')
{
  setLocalModel('qwen2.5-coder:3b')
  const s = await startFakeLlama('respond')
  let text = ''
  let chunks = 0
  let doneErr = null
  let usage = null
  await new Promise((resolve) => {
    const stop = aiChatStream(msgs, 'ignored-model', tools, (c) => {
      if (c.type === 'content' && c.text) { text += c.text; chunks++ }
    }, (err, u) => { doneErr = err; usage = u; resolve() })
    // 不取消，等自然结束
  })
  await closeServer(s)
  ok(doneErr === null, `onDone 无错误（实际：${doneErr ? doneErr.message : 'null'}）`)
  ok(text.includes('本地') && chunks >= 5, `流式逐字返回（${chunks} 块，共 ${text.length} 字：「${text}」）`)
  ok(usage !== null, 'usage 字段随 onDone 返回')
}

console.log('\n[B] 卡死场景：/health 通但 chat 不吐字 → 短超时明确报错（而非永久转圈）')
{
  setLocalModel('qwen2.5-coder:3b')
  const s = await startFakeLlama('hang')
  const started = Date.now()
  let doneErr = null
  await new Promise((resolve) => {
    aiChatStream(msgs, 'ignored-model', tools, () => {}, (err) => { doneErr = err; resolve() })
  })
  const elapsed = Date.now() - started
  await closeServer(s)
  ok(doneErr && /没有新输出|超时/.test(doneErr.message), `挂死被超时中断而非永久转圈（错误：${doneErr ? doneErr.message : '无'}）`)
  ok(elapsed < 8000, `超时在合理时间内触发（${elapsed}ms，阈值 ${IDLE}ms）`)
}

console.log('\n[C] 点停止：请求发出 300ms 后取消 → 立即中断，且 onDone 必须被调用（否则 Agent 模式会卡死）')
{
  setLocalModel('qwen2.5-coder:3b')
  const s = await startFakeLlama('hang')
  const started = Date.now()
  let doneCalled = false
  let doneErr = null
  await new Promise((resolve) => {
    // 这正是 AgentRunner.callModel 的消费方式：把 onDone 当作 await 的 resolver
    const stop = aiChatStream(msgs, 'ignored-model', tools, () => {}, (err) => {
      doneCalled = true
      doneErr = err
      resolve()
    })
    setTimeout(stop, 300)
    // 兜底：若 2s 内 onDone 都没被调用，说明取消后 promise 永不安顿（旧 bug：Agent 卡死）
    setTimeout(resolve, 2000)
  })
  const elapsed = Date.now() - started
  await closeServer(s)
  ok(doneCalled, '取消后 onDone 被调用（旧实现会吞掉 → Agent 的 await 永远挂死）')
  ok(doneErr === null, `取消走干净结束 onDone(null)，不弹「已取消」错误（实际：${doneErr ? doneErr.message : 'null'}）`)
  ok(elapsed < 1000, `取消立即生效而非等超时（${elapsed}ms）`)
}

console.log('\n[D] 非流式：aiChat(messages) 返回完整文本')
{
  setLocalModel('qwen2.5-coder:3b')
  const s = await startFakeLlama('respond')
  let text = ''
  let err = null
  try { const r = await aiChat(msgs); text = r.content } catch (e) { err = e }
  await closeServer(s)
  ok(err === null, `aiChat 无错误（实际：${err ? err.message : 'null'}）`)
  ok(text.includes('本地'), `返回完整文本（${text.length} 字：「${text}」）`)
}

console.log('\n[E] 防回归：getLocalModel 为空时不进本地分支（呼应 §14，不静默走云端、也不挂死）')
{
  setLocalModel(null)
  ok(getLocalModel() === null, '清空后 getLocalModel() === null')
  const s = await startFakeLlama('respond')
  let doneErr = '未触发'
  await new Promise((resolve) => {
    // 没有本地模型：aiChatStream 会走云端判定，因无 token 而快速报错，绝不挂死
    aiChatStream(msgs, 'ignored-model', tools, () => {}, (err) => { doneErr = err ? err.message : 'ok'; resolve() })
    setTimeout(resolve, 3000) // 兜底：若 3s 内没回调，说明挂死了（不应发生）
  })
  await closeServer(s)
  ok(doneErr !== '未触发' && doneErr !== undefined, `未选本地模型时快速给出明确结果（${doneErr}），而非永久转圈`)
}

console.log('')
console.log(`[真机模拟 · 本地模型对话链路] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

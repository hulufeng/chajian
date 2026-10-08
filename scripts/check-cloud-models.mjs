/**
 * 云端模型清单扩充自检 —— 验证「扩充云端模型清单」后后端按 provider 正确分派。
 *
 * 被测：cloud-server/server.mjs（官方通道后端）
 * 覆盖：
 *   1) /api/models 含新增模型（gpt-4o / gemini-1.5-pro）且保留默认 deepseek-flash
 *   2) OpenAI 兼容档（gpt-4o）：请求打到 /v1/chat/completions + Bearer + model=gpt-4o，返回文本
 *   3) Gemini 档（gemini-1.5-pro）非流式：请求打到 .../models/gemini-1.5-pro:generateContent，返回文本
 *   4) Gemini 流式：Gemini SSE 被归一化为 OpenAI 兼容 SSE（content），客户端契约不变
 *   5) 无 Key 模型（deepseek-flash，未配 DEEPSEEK_KEY / 全局 UPSTREAM）走演示回复，不报错
 *
 * 用本地假上游（无真实 Key），验证路由与格式归一化即可。
 * 用法：node scripts/check-cloud-models.mjs
 */
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

const PORT = 18799
const FOPEN = 18801
const FGEM = 18802
const SERVER = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'codelab-cloud-models-'))

// 假 OpenAI 上游：记录请求，按 Accept 回 OpenAI 兼容 JSON 或 SSE
const openaiReq = { hit: false, url: '', auth: '', model: '' }
const fakeOpenai = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    openaiReq.hit = true; openaiReq.url = req.url; openaiReq.auth = req.headers['authorization'] || ''
    try { openaiReq.model = JSON.parse(b).model } catch {}
    const isStream = (req.headers['accept'] || '').includes('text/event-stream')
    if (isStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from openai' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi from openai' } }] }))
    }
  })
})

// 假 Gemini 上游：记录请求，回 Gemini 格式（非流式 JSON / 流式 SSE）
const geminiReq = { hit: false, url: '', key: '' }
const fakeGemini = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    geminiReq.hit = true; geminiReq.url = req.url
    const u = new URL(req.url, `http://x`)
    geminiReq.key = u.searchParams.get('key') || ''
    if (req.url.includes('streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }] }) + '\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }] }))
    }
  })
})

// 简易 HTTP 客户端
function httpReq(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER + path)
    const data = body ? JSON.stringify(body) : null
    const req = request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : {} }) } catch { resolve({ status: r.statusCode, body: d }) } })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// 拉 SSE 流，收集 content 文本 + tool_calls
function streamChat(model, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER + '/api/chat/stream')
    const req = request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    }, (r) => {
      let buf = '', content = '', toolCalls = 0, done = false
      r.on('data', (c) => {
        buf += c.toString()
        const evs = buf.split('\n\n'); buf = evs.pop() || ''
        for (const ev of evs) {
          for (const line of ev.split('\n')) {
            const t = line.trim()
            if (t.startsWith('data:')) {
              const s = t.slice(5).trim()
              if (s === '[DONE]') { done = true; continue }
              try {
                const j = JSON.parse(s)
                const delta = j.choices?.[0]?.delta
                if (delta?.content) content += delta.content
                if (delta?.tool_calls) toolCalls++
              } catch {}
            }
          }
        }
      })
      r.on('end', () => resolve({ content, toolCalls, done }))
    })
    req.on('error', reject)
    req.write(JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], tools: [] }))
    req.end()
  })
}

console.log(`\n=== 启动后端 + 假上游（端口 ${PORT}/${FOPEN}/${FGEM}）===`)
await new Promise((r) => fakeOpenai.listen(FOPEN, r))
await new Promise((r) => fakeGemini.listen(FGEM, r))

const srv = spawn(process.execPath, ['cloud-server/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT), CODELAB_DATA_DIR: DATA_DIR,
    OPENAI_BASE_URL: `http://127.0.0.1:${FOPEN}/v1`, OPENAI_API_KEY: 'fake-openai',
    GEMINI_BASE_URL: `http://127.0.0.1:${FGEM}/v1beta/models`, GEMINI_API_KEY: 'fake-gemini'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
srv.stderr.on('data', (d) => console.error('  [server stderr] ' + d.toString()))

let exitCode = 1
try {
  // 等后端
  for (let i = 0; i < 100; i++) {
    try { const r = await httpReq('GET', '/api/models'); if (r.status === 200) break } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }

  console.log('\n[1] /api/models 含新增模型且保留默认')
  const models = (await httpReq('GET', '/api/models')).body.models
  ok(Array.isArray(models) && models.length >= 9, `模型总数 ${models.length}（≥9）`)
  ok(models.some((m) => m.id === 'deepseek-flash'), '保留默认 deepseek-flash')
  ok(models.some((m) => m.id === 'gpt-4o'), '含 gpt-4o')
  ok(models.some((m) => m.id === 'gemini-1.5-pro'), '含 gemini-1.5-pro')
  ok(models.find((m) => m.id === 'gpt-4o')?.provider === 'openai', 'gpt-4o provider=openai')
  ok(models.find((m) => m.id === 'gemini-1.5-pro')?.provider === 'gemini', 'gemini-1.5-pro provider=gemini')

  // 注册 + 登录拿 token
  const email = `m_${Date.now()}@test.local`, pwd = 'pw123456'
  await httpReq('POST', '/api/auth/register', { email, password: pwd })
  const li = (await httpReq('POST', '/api/auth/login', { email, password: pwd })).body
  const token = li.token

  console.log('\n[2] OpenAI 兼容档（gpt-4o）路由正确')
  const r2 = await httpReq('POST', '/api/chat', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, token)
  ok(r2.status === 200, `非流式 200（实 ${r2.status}）`)
  ok(r2.body.content === 'hi from openai', '内容来自 OpenAI 上游')
  ok(openaiReq.hit && openaiReq.url === '/v1/chat/completions', `上游收到 /v1/chat/completions（实 ${openaiReq.url}）`)
  ok(openaiReq.auth === 'Bearer fake-openai', '上游收到 Bearer key')
  ok(openaiReq.model === 'gpt-4o', `上游收到 model=gpt-4o（实 ${openaiReq.model}）`)

  console.log('\n[3] Gemini 档（gemini-1.5-pro）非流式路由 + 解析')
  const r3 = await httpReq('POST', '/api/chat', { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'hi' }] }, token)
  ok(r3.status === 200, `非流式 200（实 ${r3.status}）`)
  ok(r3.body.content === 'hi from gemini', 'Gemini 响应被解析为文本')
  ok(geminiReq.hit && geminiReq.url.includes('/models/gemini-1.5-pro:generateContent'), `Gemini 上游 URL 正确（实 ${geminiReq.url}）`)
  ok(geminiReq.key === 'fake-gemini', 'Gemini 上游收到 key 参数')

  console.log('\n[4] Gemini 流式：SSE 归一化为 OpenAI 兼容')
  const s4 = await streamChat('gemini-1.5-pro', token)
  ok(s4.done === true, '流式干净结束（[DONE]）')
  ok(s4.content === 'hi from gemini', `流式内容来自 Gemini 并经归一化（实 ${JSON.stringify(s4.content)}）`)

  console.log('\n[5] OpenAI 流式：同样走 OpenAI 兼容 SSE')
  const s5 = await streamChat('gpt-4o', token)
  ok(s5.done === true && s5.content === 'hi from openai', 'OpenAI 流式内容正确')

  console.log('\n[6] 无 Key 模型（deepseek-flash，未配 DEEPSEEK_KEY / 全局 UPSTREAM）走演示')
  const r6 = await httpReq('POST', '/api/chat', { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }, token)
  ok(r6.status === 200 && /演示/.test(r6.body.content || ''), '未配 Key → 演示回复，不报错')

  console.log(`\n[云端模型清单自检] 通过 ${pass} / 失败 ${fail}`)
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('\n[异常] ' + (e && e.stack || e))
  fail++
  console.log(`\n[云端模型清单自检] 通过 ${pass} / 失败 ${fail}`)
  exitCode = 1
} finally {
  srv.kill('SIGTERM')
  fakeOpenai.close(); fakeGemini.close()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  process.exit(exitCode)
}

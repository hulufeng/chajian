/**
 * codelab-desktop 官方通道（云端）后端 · 最小可用实现（零运行时依赖，纯 Node ESM）
 *
 * 严格实现客户端契约 docs/dev-log/CLOUD-BACKEND-CONTRACT.md（取自 src/main/services/aiGateway.ts）：
 *   POST /api/auth/register  {email,password}            -> {token,user}
 *   POST /api/auth/login     {email,password}            -> {token,user}
 *   GET  /api/me             (Bearer)                    -> {user}
 *   GET  /api/models                                     -> {models:[AiModel]}
 *   POST /api/chat           {model,messages} (Bearer)   -> {content,creditsLeft,cost}
 *   POST /api/chat/stream    SSE (Bearer)                -> data:{...} + event:credits
 *
 * 两种运行模式（用环境变量切换）：
 *   1) 演示模式（默认，无需任何 key）：/api/chat 与 /api/chat/stream 返回确定性演示回复，
 *      并真实扣减积分 —— 足以让客户端「设置→模型→官方账户」整链路跑通。
 *   2) 真实 LLM 代理：设置 AI_UPSTREAM_URL（如 https://api.deepseek.com/v1）与
 *      AI_UPSTREAM_KEY 后，/api/chat 与 /api/chat/stream 会原样代理到该 OpenAI 兼容端点
 *      （透传 model + messages + stream），实现真正的模型输出。积分仍在本服务扣减。
 *
 * 运行：node server.mjs  （端口 PORT，默认 8787；数据落 cloud-server/data/db.json）
 * 客户端指向本服务：启动 Electron 前设 CODELAB_AI_SERVER=http://127.0.0.1:8787
 */
import { createServer } from 'node:http'
import { scryptSync, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.CODELAB_DATA_DIR || join(__dirname, 'data')
const DB_FILE = join(DATA_DIR, 'db.json')
const PORT = Number(process.env.PORT || 8787)
const UPSTREAM_URL = process.env.AI_UPSTREAM_URL || ''      // 如 https://api.deepseek.com/v1
const UPSTREAM_KEY = process.env.AI_UPSTREAM_KEY || ''      // Bearer token
// SMTP 发邮件（验证码登录用）：用户自己配
const SMTP_HOST = process.env.SMTP_HOST || ''       // 如 smtp.qq.com
const SMTP_PORT = Number(process.env.SMTP_PORT || 465)
const SMTP_USER = process.env.SMTP_USER || ''       // 发件邮箱
const SMTP_PASS = process.env.SMTP_PASS || ''       // 授权码（不是邮箱密码）
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER
const SERVER = `http://127.0.0.1:${PORT}`

// ── 验证码存储：email -> { code, expiresAt } ──
const codeStore = new Map()

// ── 发邮件（零依赖，用 Node 原生 net/tls 写 SMTP）──
async function sendEmail(toEmail, subject, text) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[smtp] 未配置 SMTP，验证码不真发（开发模式）:', toEmail, 'code=', text.match(/\d{6}/)?.[0])
    return { ok: true, devMode: true }
  }
  // 用基础 SMTP（SSL/465）
  const tls = await import('node:tls')
  return new Promise((resolve, reject) => {
    const sock = tls.connect(SMTP_PORT, SMTP_HOST, { rejectUnauthorized: false }, () => {
      const lines = []
      let step = 0
      const writeln = (s) => sock.write(s + '\r\n')
      sock.on('data', (d) => {
        const resp = d.toString()
        lines.push(resp)
        if (resp.startsWith('220') && step === 0) { writeln(`EHLO labcode`); step = 1 }
        else if (resp.startsWith('235') && step === 3) {
          writeln(`MAIL FROM: <${SMTP_FROM}>`); step = 4
        } else if (resp.startsWith('250') && step === 1) { writeln(`AUTH LOGIN`); step = 2 }
        else if (resp.startsWith('334') && step === 2) { writeln(Buffer.from(SMTP_USER).toString('base64')); step = 3 }
        else if (resp.startsWith('334') && step === 3) { writeln(Buffer.from(SMTP_PASS).toString('base64')); step = 3 }
        else if (resp.startsWith('250') && step === 4) { writeln(`RCPT TO: <${toEmail}>`); step = 5 }
        else if (resp.startsWith('250') && step === 5) { writeln(`DATA`); step = 6 }
        else if (resp.startsWith('354') && step === 6) {
          const body = `From: LabCode <${SMTP_FROM}>\r\nTo: <${toEmail}>\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`
          writeln(body); step = 7
        } else if (resp.startsWith('250') && step === 7) { writeln('QUIT'); sock.end(); resolve({ ok: true }) }
        else if (resp.startsWith('5')) { sock.end(); reject(new Error('SMTP 错误: ' + resp.trim())) }
      })
    })
    sock.on('error', (e) => reject(e))
    setTimeout(() => { sock.destroy(); reject(new Error('SMTP 超时')) }, 10000)
  })
}

// ── 内置模型（必须含 id:"deepseek-flash"，即客户端默认 modelId）──
const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', baseUrl: '', model: 'deepseek-chat', costPerCall: 1, desc: '快速日常问答', available: true },
  { id: 'deepseek-coder', name: 'DeepSeek Coder', provider: 'deepseek', baseUrl: '', model: 'deepseek-coder', costPerCall: 2, desc: '代码专用', available: true },
  { id: 'deepseek-r1', name: 'DeepSeek R1 推理', provider: 'deepseek', baseUrl: '', model: 'deepseek-reasoner', costPerCall: 4, desc: '深度推理/复杂调试', available: true },
  { id: 'qwen-coder', name: '通义千问 Coder', provider: 'qwen', baseUrl: '', model: 'qwen2.5-coder-32b', costPerCall: 2, desc: '中文代码友好', available: true },
  { id: 'qwen-max', name: '通义千问 Max', provider: 'qwen', baseUrl: '', model: 'qwen-max', costPerCall: 3, desc: '通用强模型', available: true }
]

// ── 持久化（单进程 JSON，足够开发/演示）──
function loadDb() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(DB_FILE)) return { users: {} }
  try { return JSON.parse(readFileSync(DB_FILE, 'utf-8')) } catch { return { users: {} } }
}
function saveDb(db) { writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8') }
let db = loadDb()

// ── 密码哈希（scrypt）──
function hashPassword(pw, salt) { return scryptSync(pw, salt, 64).toString('hex') }

// ── 工具 ──
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  })
  res.end(body)
}

// ── 请求日志 ──
function logReq(method, path, status, extra = '') {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${method} ${path} -> ${status} ${extra}`)
}

// ── 简单限流（内存版,单进程足够）──
// key -> { count, resetAt }
const rateBuckets = new Map()
function rateLimit(key, maxPerMinute = 20) {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60000 })
    return true
  }
  bucket.count++
  return bucket.count <= maxPerMinute
}

// ── 输入校验 ──
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}
function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 128
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}
function getUserByToken(token) {
  if (!token) return null
  for (const u of Object.values(db.users)) if (u.tokens && u.tokens[token]) return u
  return null
}
function publicUser(u) {
  return { email: u.email, planCredits: u.planCredits, rechargeCredits: u.rechargeCredits, totalCredits: u.totalCredits, planMonth: u.planMonth }
}
function costOf(modelId) {
  const m = MODELS.find((x) => x.id === modelId)
  return m ? m.costPerCall : 1
}
/** 扣积分：先用套餐分，再用充值分；total = plan + recharge */
function deduct(u, cost) {
  if (u.planCredits >= cost) u.planCredits -= cost
  else { const r = cost - u.planCredits; u.planCredits = 0; u.rechargeCredits = Math.max(0, u.rechargeCredits - r) }
  u.totalCredits = u.planCredits + u.rechargeCredits
  saveDb(db)
}

const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end() }

  const url = new URL(req.url, SERVER)
  const path = url.pathname
  const method = req.method
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  try {
    // 1) 注册
    if (req.method === 'POST' && path === '/api/auth/register') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!rateLimit(`reg:${ip}`, 10)) return sendJson(res, 429, { error: '尝试过于频繁,请稍后再试' })
      const { email, password } = await readBody(req)
      if (!isValidEmail(email)) return sendJson(res, 400, { error: '邮箱格式不正确' })
      if (!isValidPassword(password)) return sendJson(res, 400, { error: '密码至少 6 位' })
      if (db.users[email]) return sendJson(res, 409, { error: '该邮箱已注册' })
      const salt = randomBytes(16).toString('hex')
      const u = {
        email, salt, pwHash: hashPassword(password, salt),
        planCredits: 100, rechargeCredits: 0, totalCredits: 100, planMonth: '2099-12', tokens: {}
      }
      const t = randomUUID()
      u.tokens[t] = true
      db.users[email] = u; saveDb(db)
      logReq(method, path, 200, `email=${email}`)
      return sendJson(res, 200, { token: t, user: publicUser(u) })
    }

    // 1.5) 匿名试用：不需要邮箱密码，自动创建 guest 用户，送免费额度
    if (req.method === 'POST' && path === '/api/guest') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!rateLimit(`guest:${ip}`, 5)) return sendJson(res, 429, { error: '创建试用名额过于频繁,请稍后再试' })
      // 机器指纹（客户端传 deviceId），同一设备只送一次免费额度
      const { deviceId } = await readBody(req).catch(() => ({}))
      const id = typeof deviceId === 'string' && deviceId.length >= 8 ? deviceId : randomUUID()
      // 已有 guest 就直接返回 token，不重复送
      const existing = db.guests && db.guests[id]
      if (existing) {
        const t = existing.token
        if (!existing.tokens[t]) existing.tokens[t] = true
        logReq(method, path, 200, `guest=${id.slice(0,8)} 续用`)
        return sendJson(res, 200, { token: t, user: publicUser(existing) })
      }
      const u = {
        email: `guest_${id.slice(0,8)}@labcode.local`,
        salt: randomBytes(16).toString('hex'),
        pwHash: '',
        planCredits: Number(process.env.GUEST_FREE_CREDITS || 50),
        rechargeCredits: 0,
        totalCredits: Number(process.env.GUEST_FREE_CREDITS || 50),
        planMonth: 'trial',
        tokens: {}
      }
      const t = randomUUID()
      u.tokens[t] = true
      if (!db.guests) db.guests = {}
      db.guests[id] = u
      saveDb(db)
      logReq(method, path, 200, `guest=${id.slice(0,8)} 新建 送${u.totalCredits}次`)
      return sendJson(res, 200, { token: t, user: publicUser(u), isGuest: true })
    }

    // 2.5) 发邮箱验证码
    if (req.method === 'POST' && path === '/api/auth/send-code') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!rateLimit(`sendcode:${ip}`, 5)) return sendJson(res, 429, { error: '发送过于频繁,请稍后再试' })
      const { email } = await readBody(req)
      if (!isValidEmail(email)) return sendJson(res, 400, { error: '邮箱格式不正确' })
      const code = String(Math.floor(100000 + Math.random() * 900000))
      codeStore.set(email.toLowerCase(), { code, expiresAt: Date.now() + 10 * 60 * 1000 })
      try {
        await sendEmail(email, 'LabCode 登录验证码', `您的验证码是 ${code}，10 分钟内有效。\n\n如非本人操作请忽略。`)
        logReq(method, path, 200, `email=${email}`)
        return sendJson(res, 200, { ok: true, devMode: !SMTP_HOST })
      } catch (e) {
        logReq(method, path, 500, `email=${email} err=${e.message}`)
        return sendJson(res, 500, { error: '邮件发送失败: ' + e.message })
      }
    }

    // 2.6) 验证码登录/注册（自动注册）
    if (req.method === 'POST' && path === '/api/auth/verify-code') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!rateLimit(`verify:${ip}`, 10)) return sendJson(res, 429, { error: '尝试过于频繁' })
      const { email, code } = await readBody(req)
      if (!isValidEmail(email)) return sendJson(res, 400, { error: '邮箱格式不正确' })
      if (!code || !/^\d{6}$/.test(code)) return sendJson(res, 400, { error: '验证码为6位数字' })
      const saved = codeStore.get(email.toLowerCase())
      if (!saved || saved.code !== code || Date.now() > saved.expiresAt) {
        return sendJson(res, 400, { error: '验证码错误或已过期' })
      }
      codeStore.delete(email.toLowerCase())
      // 已有用户就登录，没有就注册（送 100 积分）
      let u = db.users[email.toLowerCase()]
      if (!u) {
        u = {
          email: email.toLowerCase(),
          salt: randomBytes(16).toString('hex'),
          pwHash: '', // 验证码登录不需要密码
          planCredits: 100, rechargeCredits: 0, totalCredits: 100,
          planMonth: new Date().toISOString().slice(0, 7), tokens: {}
        }
        db.users[email.toLowerCase()] = u
        logReq(method, path, 200, `注册 email=${email}`)
      } else {
        logReq(method, path, 200, `登录 email=${email}`)
      }
      const t = randomUUID()
      u.tokens[t] = true
      saveDb(db)
      return sendJson(res, 200, { token: t, user: publicUser(u), isNew: !db.users[email.toLowerCase()].pwHash })
    }

    // 2) 登录
    if (req.method === 'POST' && path === '/api/auth/login') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!rateLimit(`login:${ip}`, 20)) return sendJson(res, 429, { error: '尝试过于频繁,请稍后再试' })
      const { email, password } = await readBody(req)
      const u = db.users[email]
      if (!u || u.pwHash !== hashPassword(password, u.salt)) {
        logReq(method, path, 401, `email=${email}`)
        return sendJson(res, 401, { error: '邮箱或密码错误' })
      }
      const t = randomUUID()
      u.tokens[t] = true; saveDb(db)
      logReq(method, path, 200, `email=${email}`)
      return sendJson(res, 200, { token: t, user: publicUser(u) })
    }

    // 3) 查账户
    if (req.method === 'GET' && path === '/api/me') {
      const u = getUserByToken(token)
      if (!u) return sendJson(res, 401, { error: '未登录或登录已过期' })
      return sendJson(res, 200, { user: publicUser(u) })
    }

    // 4) 模型列表（客户端不带头，故不需鉴权）
    if (req.method === 'GET' && path === '/api/models') {
      return sendJson(res, 200, { models: MODELS })
    }

    // 5) 非流式对话
    if (req.method === 'POST' && path === '/api/chat') {
      const u = getUserByToken(token)
      if (!u) return sendJson(res, 401, { error: '未登录或登录已过期' })
      const { model, messages } = await readBody(req)
      const cost = costOf(model)
      if (u.totalCredits < cost) return sendJson(res, 402, { error: '积分不足,请充值' })
      const content = await generateContent(UPSTREAM_URL, UPSTREAM_KEY, model, messages, false)
      deduct(u, cost)
      logReq(method, path, 200, `user=${u.email} model=${model} cost=${cost}`)
      return sendJson(res, 200, { content, creditsLeft: u.totalCredits, cost })
    }

    // 6) 流式对话（SSE）
    if (req.method === 'POST' && path === '/api/chat/stream') {
      const u = getUserByToken(token)
      if (!u) return sendJson(res, 401, { error: '未登录或登录已过期' })
      const { model, messages } = await readBody(req)
      const cost = costOf(model)
      if (u.totalCredits < cost) return sendJson(res, 402, { error: '积分不足,请充值' })
      logReq(method, path, 200, `user=${u.email} model=${model} stream`)
      if (UPSTREAM_URL && UPSTREAM_KEY) {
        return await proxyStream(res, UPSTREAM_URL, UPSTREAM_KEY, model, messages, () => { deduct(u, cost); return u.totalCredits })
      }
      // 演示流式：分块吐字 + 末尾发积分事件
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' })
      const demo = `（bluebubai 云端演示后端）已收到你的消息，当前模型 ${model}。这是联通测试回复——真实接入时此处会是模型输出。`
      const chunks = demo.match(/./gu) ? Array.from(demo) : [demo]
      let i = 0
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer)
          const remaining = (() => { deduct(u, cost); return u.totalCredits })()
          res.write(`event: credits\ndata: ${JSON.stringify({ remaining })}\n\n`)
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
      }, 12)
      req.on('close', () => clearInterval(timer))
      return
    }

    return sendJson(res, 404, { error: 'Not Found' })
  } catch (e) {
    return sendJson(res, 400, { error: e.message || '请求处理失败' })
  }
})

// ── 生成内容：真实代理 or 演示 ──
async function generateContent(upstreamUrl, upstreamKey, model, messages, _stream) {
  if (upstreamUrl && upstreamKey) {
    const r = await fetch(`${upstreamUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}` },
      body: JSON.stringify({ model: MODELS.find((m) => m.id === model)?.model || model, messages, stream: false })
    })
    const data = await r.json().catch(() => ({}))
    return data.choices?.[0]?.message?.content || '（上游返回为空）'
  }
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user')
  return `（演示后端·无 LLM key）你问的是：「${last ? last.content : ''}」。设置 AI_UPSTREAM_URL / AI_UPSTREAM_KEY 即可接入真实模型。`
}

// ── 真实 LLM 流式代理：把上游 SSE 透传，结束后补发积分事件 ──
async function proxyStream(res, upstreamUrl, upstreamKey, model, messages, onEnd) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' })
  try {
    const r = await fetch(`${upstreamUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}`, Accept: 'text/event-stream' },
      body: JSON.stringify({ model: MODELS.find((m) => m.id === model)?.model || model, messages, stream: true })
    })
    if (!r.ok) { res.write(`data: ${JSON.stringify({ error: `上游错误 ${r.status}` })}\n\n`); res.end(); return }
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('data:')) res.write(t + '\n\n')
      }
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
  }
  const remaining = onEnd()
  res.write(`event: credits\ndata: ${JSON.stringify({ remaining })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

server.listen(PORT, () => {
  console.log(`[cloud-server] 监听 ${SERVER}`)
  console.log(`[cloud-server] 客户端指向：CODELAB_AI_SERVER=${SERVER}`)
  console.log(`[cloud-server] 真实 LLM 代理：${UPSTREAM_URL ? '已启用 (' + UPSTREAM_URL + ')' : '未启用（演示模式）'}`)
})

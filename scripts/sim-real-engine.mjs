/**
 * 真实引擎端到端：本地模型对话链路（让 app 自己拉起 llama-server.exe + 真实 GGUF 推理）。
 *
 * 与 sim-local-model.mjs 的区别：那个用「假 HTTP 引擎」复刻三种情形；本脚本走完整真实路径 ——
 * 由生产代码 modelRuntime.startLlamaEngine 自己探测引擎、扫描并加载真实 .gguf、拉起 llama-server.exe，
 * 做真实 CPU 推理，再驱动 aiGateway.aiChatStream / aiChat。验证：
 *   A. 正常：选好本地模型 → 真实流式逐字返回 → onDone(null, usage)
 *   C. 点停止：请求发出后取消 → 立即中断，且 onDone 必须被调用 onDone(null)（否则 Agent 卡死）
 *   D. 非流式：aiChat(messages) 返回真实完整文本
 *
 * 模型准备：把本机已有的 qwen2.5-coder-1.5b q4_k_m.gguf 软链进 app 的 modelsDir（TEST_APPDATA 指向临时目录，
 * 不污染仓库；软链失败则复制）。引擎由 app 管理，命令结束前按端口精准杀掉，不误伤其它 llama 进程。
 *
 * 用法：node scripts/sim-real-engine.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const PORT = 28099
const SRC_MODEL = 'D:/工作/esp32从入门到实践/app/local-llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'

// 把 app 的 appData 指到一个临时目录，models 子目录放软链模型，绝不污染仓库/真实配置
const APPDATA = join(process.cwd(), 'scripts/.tmp', 'sim-real-appdata')
process.env.TEST_APPDATA = APPDATA
const MODELS_DIR = join(APPDATA, 'codelab-desktop', 'models')
process.env.LABCODE_LLAMA_PORT = String(PORT)
process.env.LABCODE_LLAMA_IDLE_MS = String(30000) // 真实引擎正常吐字不会触发；仅作安全网

const outfile = 'scripts/.tmp/sim-real-engine.bundle.mjs'

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.setTimeout(2000, () => { req.destroy(new Error('health timeout')) })
  })
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await get(`http://127.0.0.1:${PORT}/health`)
      if (r.status === 200) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/** 按端口精准杀掉我们拉起的引擎，避免 taskkill /IM 误伤用户其它 llama 进程 */
function killByPort(port) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`, { encoding: 'utf-8' })
    const pids = [...new Set(out.split(/\s+/).map((s) => s.trim()).filter(Boolean))]
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
    }
  } catch { /* 没有监听者，忽略 */ }
}

// 真实场景的简短提示词，让 1.5B 在 CPU 上快速出短答
const msgs = [{ role: 'user', content: '用一句话介绍你自己。' }]
const tools = []

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

function prepareModel() {
  fs.mkdirSync(MODELS_DIR, { recursive: true })
  const dest = join(MODELS_DIR, 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf')
  if (fs.existsSync(dest)) return dest
  try {
    fs.symlinkSync(SRC_MODEL, dest, 'file') // 软链：不复制 1.1GB
    console.log('  · 已软链模型到 modelsDir')
  } catch (e) {
    console.log('  · 软链失败，改用复制：' + e.message)
    fs.copyFileSync(SRC_MODEL, dest)
  }
  return dest
}

async function main() {
  prepareModel()

  // 打包并导入真实生产代码（与 sim-local-model 同款 esbuild + electron stub 流程）
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
  const { aiChatStream, aiChat, setLocalModel, stopLlamaEngine } = gw
  setLocalModel('qwen2.5-coder:1.5b')

  // 总安全网：任何场景若 90s 内 onDone 都没回来，判失败并退出
  const guard = (label, ms = 90000) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时未回调 onDone（疑似挂死）`)), ms))

  console.log('\n[A] 真实正常对话：app 拉起引擎 → 真实流式逐字返回')
  {
    let text = ''
    let chunks = 0
    let doneErr = null
    let usage = null
    const p = new Promise((resolve) => {
      aiChatStream(msgs, 'ignored-model', tools, (c) => {
        if (c.type === 'content' && c.text) { text += c.text; chunks++ }
      }, (err, u) => { doneErr = err; usage = u; resolve() })
    })
    await Promise.race([p, guard('A')])
    ok(doneErr === null, `onDone 无错误（实际：${doneErr ? doneErr.message : 'null'}）`)
    ok(chunks >= 1 && text.length > 0, `真实流式返回（${chunks} 块，${text.length} 字：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」）`)
    ok(usage !== null, 'usage 字段随 onDone 返回')
  }

  console.log('\n[C] 真实点停止：请求发出后取消 → 立即中断，且 onDone 必须被调用 onDone(null)')
  {
    let doneCalled = false
    let doneErr = null
    let firstChunkMs = -1
    const started = Date.now()
    const p = new Promise((resolve) => {
      const stop = aiChatStream(msgs, 'ignored-model', tools, () => {
        if (firstChunkMs < 0) firstChunkMs = Date.now() - started
      }, (err) => { doneCalled = true; doneErr = err; resolve() })
      // 引擎已热（A 已加载），1500ms 取消可命中「首字已到 → 中断」
      setTimeout(stop, 1500)
    })
    await Promise.race([p, guard('C', 10000)])
    const elapsed = Date.now() - started
    ok(doneCalled, '取消后 onDone 被调用（旧实现会吞掉 → Agent 的 await 永远挂死）')
    ok(doneErr === null, `取消走干净结束 onDone(null)，不弹「已取消」错误（实际：${doneErr ? doneErr.message : 'null'}）`)
    ok(elapsed < 5000, `取消在合理时间内生效（${elapsed}ms，首字约 ${firstChunkMs}ms）`)
  }

  console.log('\n[D] 真实非流式：aiChat(messages) 返回完整文本')
  {
    let text = ''
    let err = null
    try {
      const r = await Promise.race([aiChat(msgs), guard('D')])
      text = r.content
    } catch (e) { err = e }
    ok(err === null, `aiChat 无错误（实际：${err ? err.message : 'null'}）`)
    ok(text.length > 0, `返回真实完整文本（${text.length} 字：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」）`)
  }

  // 收尾：只杀掉本测试拉起、监听在 PORT 的引擎，不误伤其它 llama 进程
  try { killByPort(PORT) } catch { /* */ }
  try { fs.rmSync(APPDATA, { recursive: true, force: true }) } catch { /* */ }
  console.log('')
  console.log(`[真实引擎端到端 · 本地模型对话链路] 通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('致命错误：', e)
  try { killByPort(PORT) } catch { /* */ }
  process.exit(3)
})

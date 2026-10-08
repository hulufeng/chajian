/**
 * 验证 bug #2 修复：killEngine 不再用 `taskkill /IM llama-server.exe /F` 误杀全机 llama 进程。
 *
 * 做法：拉起一个「外部」引擎（监听 8080，本脚本子进程，非 app 受管）+ 一个「受管」引擎
 * （监听 28099，由 app 的 startLlamaEngine 拉起，记录在 engineProcess）。然后调 stopLlamaEngine()
 * （→ killEngine → 只杀受管 PID）。断言：
 *   - 受管 28099 引擎被关闭（dead）
 *   - 外部 8080 引擎仍然存活（health 200）—— 旧实现会被一并 taskkill 掉
 *
 * 用法：node scripts/verify-no-kill-external.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const EXT_PORT = 28999
const MGMT_PORT = 28099
const EXE = 'D:/工作/代码实验室/codelab-desktop/resources/llama/llama-server.exe'
const SRC_MODEL = 'D:/工作/esp32从入门到实践/app/local-llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'

const APPDATA = join(process.cwd(), 'scripts/.tmp', 'verify-appdata')
process.env.TEST_APPDATA = APPDATA
const MODELS_DIR = join(APPDATA, 'codelab-desktop', 'models')
process.env.LABCODE_LLAMA_PORT = String(MGMT_PORT)

function get(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => { req.destroy(); resolve(false) })
  })
}
async function waitHealth(port, timeoutMs) {
  const d = Date.now() + timeoutMs
  while (Date.now() < d) { if (await get(port)) return true; await new Promise((r) => setTimeout(r, 800)) }
  return false
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 准备受管引擎的模型（软链进临时 modelsDir，不污染仓库）
fs.mkdirSync(MODELS_DIR, { recursive: true })
const dest = join(MODELS_DIR, 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf')
if (!fs.existsSync(dest)) {
  try { fs.symlinkSync(SRC_MODEL, dest, 'file') } catch { fs.copyFileSync(SRC_MODEL, dest) }
}

async function main() {
  // 1) 拉起外部 8080 引擎（本脚本子进程，模拟「用户其它应用的 llama 引擎」）
  const ext = spawn(EXE, ['--host', '127.0.0.1', '--port', String(EXT_PORT), '-m', SRC_MODEL, '--ctx-size', '2048', '--n-gpu-layers', '0'], { stdio: 'ignore' })
  const extPid = ext.pid
  console.log(`\n外部 ${EXT_PORT} 引擎 PID=${extPid}，等待就绪...`)
  const extReady = await waitHealth(EXT_PORT, 120000)
  ok(extReady, `外部 ${EXT_PORT} 引擎就绪（PID ${extPid}）`)
  if (!extReady) { cleanup(ext); process.exit(2) }

  // 2) 打包并导入生产代码（modelRuntime 同时导出 startLlamaEngine / stopLlamaEngine，
  //    aiGateway 只透传 stopLlamaEngine，不导出 startLlamaEngine）
  buildSync({ entryPoints: ['src/main/ai/modelRuntime.ts'], bundle: true, format: 'esm', platform: 'node', outfile: 'scripts/.tmp/verify-no-kill.bundle.mjs', alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') } })
  const base = process.cwd().replace(/\\/g, '/')
  const gw = await import('file://' + base + '/scripts/.tmp/verify-no-kill.bundle.mjs')
  const { startLlamaEngine, stopLlamaEngine } = gw

  // 3) 让 app 受管地拉起 28099 引擎
  const started = await startLlamaEngine('qwen2.5-coder:1.5b')
  ok(started.success, `受管 28099 引擎拉起成功（${started.model}）`)
  const mgmtReady = await waitHealth(MGMT_PORT, 120000)
  ok(mgmtReady, '受管 28099 引擎就绪')

  // 4) 关键：调 stopLlamaEngine（→ killEngine），只应杀受管 PID
  console.log('\n调用 stopLlamaEngine()（→ killEngine，应只杀受管 28099）...')
  stopLlamaEngine()
  await new Promise((r) => setTimeout(r, 1500))

  // 5) 断言
  const extStillAlive = await get(EXT_PORT)
  const mgmtDead = !(await get(MGMT_PORT))
  ok(extStillAlive, `外部 8080 引擎仍存活（PID ${extPid}）—— 未误杀（旧实现会被 taskkill /IM 干掉）`)
  ok(mgmtDead, '受管 28099 引擎已被关闭')

  cleanup(ext)
  fs.rmSync(APPDATA, { recursive: true, force: true })
  console.log(`\n[验证 #2 · 不误杀外部 llama 进程] 通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

function cleanup(ext) {
  try { if (ext.pid) require('node:child_process').execSync(`taskkill /PID ${ext.pid} /F`, { stdio: 'ignore' }) } catch { /* */ }
}

main().catch((e) => { console.error('致命错误：', e); process.exit(3) })

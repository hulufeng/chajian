/**
 * 诊断：app 拉起的 llama 引擎在一次对话后是否还存活（排查 A→C 复用失败的根因）。
 * 直接复用 modelRuntime.startLlamaEngine 拉起，跑一次真实对话，然后每 2s 探一次 /health，共 12s。
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

const PORT = 28099
const EXE = 'D:/工作/代码实验室/codelab-desktop/resources/llama/llama-server.exe'
const SRC_MODEL = 'D:/工作/esp32从入门到实践/app/local-llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
const APPDATA = join(process.cwd(), 'scripts/.tmp', 'diag-appdata')
process.env.TEST_APPDATA = APPDATA
process.env.LABCODE_LLAMA_PORT = String(PORT)
const MODELS_DIR = join(APPDATA, 'codelab-desktop', 'models')
fs.mkdirSync(MODELS_DIR, { recursive: true })
const dest = join(MODELS_DIR, 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf')
if (!fs.existsSync(dest)) { try { fs.symlinkSync(SRC_MODEL, dest, 'file') } catch { fs.copyFileSync(SRC_MODEL, dest) } }

function get(url) {
  return new Promise((res) => { const r = http.get(url, (x) => { x.resume(); res(x.statusCode === 200) }); r.on('error', () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false) }) })
}

async function main() {
  buildSync({ entryPoints: ['src/main/services/aiGateway.ts'], bundle: true, format: 'esm', platform: 'node', outfile: 'scripts/.tmp/diag.bundle.mjs', alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') } })
  const base = process.cwd().replace(/\\/g, '/')
  const gw = await import('file://' + base + '/scripts/.tmp/diag.bundle.mjs')
  const { aiChatStream, setLocalModel } = gw
  setLocalModel('qwen2.5-coder:1.5b')

  const started = await gw.startLlamaEngine ? null : null
  console.log('startLlamaEngine 是否导出：', typeof gw.startLlamaEngine)
  // 用一次真实对话触发引擎拉起
  let text = ''
  await new Promise((resolve) => {
    aiChatStream([{ role: 'user', content: '你好' }], 'ignored', [], (c) => { if (c.type === 'content' && c.text) text += c.text }, (e) => { console.log('对话结束 err=', e && e.message); resolve() })
  })
  console.log('对话拿到文本长度：', text.length)
  const psList = () => { try { return execSync('ps -W', { encoding: 'utf-8' }) } catch { return '' } }
  console.log('=== 对话后即时核查进程 + health ===')
  {
    const alive = await get(`http://127.0.0.1:${PORT}/health`)
    const ps = psList()
    const running = ps.split('\n').some((l) => /llama-server/.test(l))
    console.log('  health=', alive, ' | ps 中 llama-server 进程存在=', running)
    console.log('  ps 片段:', ps.split('\n').filter((l) => /llama-server/.test(l)).join(' | ').slice(0, 200))
  }
  console.log('=== 对话后每 2s 探 /health（共 12s）===')
  for (let i = 0; i < 6; i++) {
    const alive = await get(`http://127.0.0.1:${PORT}/health`)
    console.log(`  t+${i * 2}s health=${alive ? '存活' : '死亡'}`)
    if (!alive) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  // 清理
  try { const out = require('node:child_process').execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue).OwningProcess"`, { encoding: 'utf-8' }); for (const p of [...new Set(out.split(/\s+/).filter(Boolean))]) { try { require('node:child_process').execSync(`taskkill /PID ${p} /F`, { stdio: 'ignore' }) } catch {} } } catch {}
  fs.rmSync(APPDATA, { recursive: true, force: true })
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

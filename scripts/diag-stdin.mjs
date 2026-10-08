/**
 * 对照实验②：验证引擎对话后死亡是否由 app 的 stdio=['ignore','pipe','pipe'] 引起。
 * 两个 trial 都做：拉起(-ngl 0) → 对话 → 等 3s → 探活 + 捕获退出码。
 *   ① stdio=['ignore','ignore','ignore']（不管道）
 *   ② stdio=['ignore','pipe','pipe']（与 app 一致，读 stdout）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'

const EXE = 'D:/工作/代码实验室/codelab-desktop/resources/llama/llama-server.exe'
const MODEL = 'D:/工作/esp32从入门到实践/app/local-llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'

function health(port) {
  return new Promise((res) => { const r = http.get(`http://127.0.0.1:${port}/health`, (x) => { x.resume(); res(x.statusCode === 200) }); r.on('error', () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false) }) })
}
function waitHealth(port, ms) {
  return new Promise(async (res) => { const d = Date.now() + ms; while (Date.now() < d) { if (await health(port)) return res(true); await new Promise((r) => setTimeout(r, 800)) } res(false) })
}
function chat(port) {
  return new Promise((res) => {
    const data = JSON.stringify({ model: 'local', messages: [{ role: 'user', content: '你好' }], stream: false, max_tokens: 32 })
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res(b.length > 0)) })
    r.on('error', () => res(false)); r.write(data); r.end()
  })
}

async function trial(label, stdio) {
  console.log(`\n=== ${label} ===`)
  let exitCode = '未退出'; let exited = false
  const child = spawn(EXE, ['--host', '127.0.0.1', '--port', '28112', '-m', MODEL, '--ctx-size', '2048', '--n-gpu-layers', '0'], { stdio })
  child.on('exit', (code, sig) => { exited = true; exitCode = `code=${code} sig=${sig}` })
  if (!await waitHealth(28112, 120000)) { console.log('  ✗ 启动失败'); try { child.kill('SIGKILL') } catch {}; return }
  console.log('  ✓ 启动就绪')
  const chatted = await chat(28112)
  console.log('  ' + (chatted ? '✓' : '✗') + ' 对话返回')
  await new Promise((r) => setTimeout(r, 3000))
  const alive = await health(28112)
  console.log('  ' + (alive ? '✓' : '✗') + ' 对话后 3s 存活=' + alive + '（退出状态：' + exitCode + '）')
  try { child.kill('SIGKILL') } catch {}
}

async function main() {
  await trial('① stdio=ignore,ignore,ignore', ['ignore', 'ignore', 'ignore'])
  await trial('② stdio=ignore,pipe,pipe（与 app 一致）', ['ignore', 'pipe', 'pipe'])
  console.log('\n若②死亡而①存活 → app 的管道 stdio 是诱因')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })

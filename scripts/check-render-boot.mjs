/**
 * 渲染层启动自检（不需要 Electron）。
 *
 * 为什么需要它：本沙箱里 Electron 起不来（GPU 子进程 exit_code=-1073741819，
 * --disable-gpu / --in-process-gpu 都救不回）。但 Electron 的渲染层本质就是个 webview，
 * 起个本地静态服务把 build 产物喂给 Chrome 无头，就能验证整棵组件树能不能挂上：
 *   - 走在 http 上（不是 file://）：file:// 下 module script 会静默不执行，验证不了任何东西；
 *   - 保持 index.html 原样（含 CSP），只额外注入一个同源桩脚本 —— CSP 允许 'self'，外链可用；
 *   - window.api 用万能桩顶掉，主进程不在也能跑完初始化。
 *
 * 判据：#root 有子节点 + 无致命错误 → 通过。
 *
 * 用法：node scripts/check-render-boot.mjs [out/renderer]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DIR = resolve(process.cwd(), process.argv[2] || 'out/renderer')
const PORT = 9333
const PROFILE = 'C:/Users/Administrator/.cache/codelab-probe-boot'
const ENTRY = 'index.html'
const STUB_REL = '_probe_stub.js'
const REPORT_REL = '_probe_report.js'

if (!existsSync(resolve(DIR, ENTRY))) {
  console.error(`[probe] ✗ 找不到 ${ENTRY}，先跑 electron-vite build`)
  process.exit(1)
}

/** window.api 万能桩：任意层级既能调用（订阅返回的 off）又能 await */
const STUB = `
window.__errs = []
window.addEventListener('error', function (e) {
  window.__errs.push('error: ' + (e.message || 'unknown'))
})
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason || {}
  window.__errs.push('rejection: ' + (r.message || String(r)))
})
function makePlain() {
  return new Proxy({}, {
    get: function (_t, k) {
      if (k === 'then') return function (res) { res(makePlain()); return makePromise() }
      if (k === Symbol.toPrimitive) return function () { return '[stub]' }
      if (k === Symbol.iterator) return undefined
      return makeFn()
    },
    has: function () { return true }
  })
}
function makePromise() { return Promise.resolve(makePlain()) }
function makeFn() {
  var raw = function () { return makePromise() }
  return new Proxy(raw, {
    get: function (_t, k) {
      if (k === 'then') return function (res) { res(makePlain()); return makePromise() }
      if (k === Symbol.toPrimitive) return function () { return '[stub]' }
      if (k === Symbol.iterator) return undefined
      return makeFn()
    },
    apply: function () { return makePromise() },
    has: function () { return true }
  })
}
window.api = makeFn()
window.__stubbed = true
`

/** 挂载完成后把结果写进 DOM（外链脚本，CSP 只限 script-src 'self'，inline 会被拦） */
const REPORT = `
setTimeout(function () {
  var root = document.getElementById('root')
  var out = {
    stubbed: !!window.__stubbed,
    rootKids: root ? root.children.length : -1,
    bodyLen: document.body.innerHTML.length,
    hasTitlebar: !!document.querySelector('header.titlebar'),
    hasPanels: document.querySelectorAll('header, footer, aside').length,
    theme: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    errs: window.__errs || []
  }
  var pre = document.createElement('pre')
  pre.id = 'probe'
  pre.textContent = 'PROBE=' + JSON.stringify(out)
  document.body.appendChild(pre)
}, 1200)
`

await writeFile(resolve(DIR, STUB_REL), STUB)
await writeFile(resolve(DIR, REPORT_REL), REPORT)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.map': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const rel = url.pathname.replace(/^\//, '') || ENTRY
    const abs = resolve(DIR, rel)
    if (!abs.startsWith(DIR) || !existsSync(abs)) {
      res.writeHead(404).end('not found')
      return
    }
    let body = await readFile(abs)
    const ext = abs.slice(abs.lastIndexOf('.'))
    if (rel === ENTRY) {
      // 只插桩，页面其余部分（含 CSP、真实 script 引用）保持原样
      let html = body.toString('utf8')
        .replace('<div id="root"></div>', `<script src="/${STUB_REL}"></script><div id="root"></div>`)
        .replace('</body>', `<script src="/${REPORT_REL}"></script></body>`)
      body = Buffer.from(html)
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' }).end(body)
  } catch (e) {
    res.writeHead(500).end(String(e))
  }
})
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok))

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--virtual-time-budget=6000',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  `--dump-dom=http://127.0.0.1:${PORT}/${ENTRY}`,
], { stdio: ['ignore', 'pipe', 'pipe'] })

const done = new Promise((ok) => {
  const onData = (d) => {
    const m = String(d)
    const hit = m.match(/PROBE=(\{.*?\})<\/pre>/)
    if (hit) ok(hit[1])
  }
  chrome.stdout && chrome.stdout.on('data', onData)
  chrome.stderr && chrome.stderr.on('data', onData)
})
const dump = await Promise.race([
  done,
  new Promise((ok) => setTimeout(() => ok(null), 45000)),
])
try { chrome.kill() } catch { /* ignore */ }
await new Promise((ok) => server.close(ok))
await Promise.all([unlink(resolve(DIR, STUB_REL)).catch(() => {}), unlink(resolve(DIR, REPORT_REL)).catch(() => {})])

if (!dump) {
  console.error('[probe] ✗ 没拿到探针结果（Chrome 超时或未渲染）')
  process.exit(1)
}

const r = JSON.parse(dump)
const fatal = (r.errs || []).filter((e) => !/favicon/i.test(e))
console.log('[probe] 桩挂载      :', r.stubbed)
console.log('[probe] #root 子节点:', r.rootKids, '| body 长度:', r.bodyLen)
console.log('[probe] 结构命中    : header/footer/aside =', r.hasPanels, '| header.titlebar =', r.hasTitlebar)
console.log('[probe] 主题变量    :', r.theme || '(空)')
console.log('[probe] 错误        :', fatal.length === 0 ? '0' : fatal.length)
fatal.slice(0, 10).forEach((e) => console.log('          -', String(e).slice(0, 200)))

const ok = r.rootKids > 0 && fatal.length === 0
console.log(ok ? '[probe] ✓ 渲染层能起来' : '[probe] ✗ 渲染层起不来')
process.exit(ok ? 0 : 1)

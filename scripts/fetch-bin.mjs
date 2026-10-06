/**
 * 下载器：绕开 Windows curl 的 schannel TLS 握手失败（CDN 域名上必现）。
 * 用 Node 自带的 OpenSSL 栈，支持重定向、重试、断点续传、进度输出。
 * 用法：node scripts/fetch-bin.mjs <url> <输出路径>
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, openSync, readSync, writeSync } from 'node:fs'
import { get } from 'node:https'
import { dirname } from 'node:path'

const url = process.argv[2]
const out = process.argv[3]
const MAX_RETRY = 4

if (!url || !out) {
  console.error('用法：node scripts/fetch-bin.mjs <url> <输出路径>')
  process.exit(2)
}

mkdirSync(dirname(out), { recursive: true })

/** 已有部分文件则续传，返回起始偏移 */
function resumeOffset(p) {
  if (!existsSync(p)) return 0
  try {
    const st = statSync(p)
    return st.isFile() && st.size > 0 ? st.size : 0
  } catch {
    return 0
  }
}

function attempt(offset) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'LabCode-Fetcher/1.0', Accept: '*/*' }
    if (offset > 0) headers.Range = `bytes=${offset}-`

    const req = get(url, { headers }, (res) => {
      const status = res.statusCode || 0
      // 3xx：跟随
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        attempt(offset).then(resolve, reject)
        return
      }
      if (status !== 200 && status !== 206) {
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      // 服务端不支持续传（200 而非 206）时从头写
      const appending = offset > 0 && status === 206
      const startAt = appending ? offset : 0
      if (!appending && offset > 0) {
        try { unlinkSync(out) } catch { /* 忽略 */ }
      }
      const ws = createWriteStream(out, { flags: appending ? 'a' : 'w', start: appending ? offset : 0 })
      let got = 0
      const total = Number(res.headers['content-length'] || 0)
      let lastPrint = 0
      res.on('data', (c) => {
        got += c.length
        const now = Date.now()
        if (now - lastPrint > 1500) {
          lastPrint = now
          const mb = (got / 1048576).toFixed(1)
          const pct = total ? ` (${((got / total) * 100).toFixed(1)}%)` : ''
          process.stdout.write(`\r  已下载 ${mb} MB${pct}   `)
        }
      })
      res.pipe(ws)
      ws.on('finish', () => {
        process.stdout.write('\n')
        resolve()
      })
      ws.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60000, () => {
      req.destroy(new Error('请求超时'))
    })
  })
}

let lastErr = null
for (let i = 1; i <= MAX_RETRY; i++) {
  try {
    const off = resumeOffset(out)
    if (off > 0) console.log(`  第 ${i} 次尝试，从 ${(off / 1048576).toFixed(1)} MB 续传`)
    await attempt(off)
    const size = statSync(out).size
    console.log(`  完成：${(size / 1048576).toFixed(1)} MB -> ${out}`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.log(`  第 ${i}/${MAX_RETRY} 次失败：${e.message}`)
    await new Promise((r) => setTimeout(r, 2000 * i))
  }
}
console.error('下载失败：', lastErr?.message)
process.exit(1)
// 扫描 IPC 通道闭合性：渲染层 / preload 调用的通道，主进程是否都注册了对应 handler / sender。
// 这是 Electron 里最隐蔽的"功能静默崩溃"来源：
//   - 渲染层 ipcRenderer.invoke('x') 但主进程没 ipcMain.handle('x') → Promise 永远 reject，功能断。
//   - 渲染层 ipcRenderer.on('y') 订阅事件，但主进程从没 webContents.send('y') → 监听永远不触发，功能死。
// 用法：node scripts/scan-ipc-handlers.mjs
//
// 只抓静态字符串字面量通道（第一参数为 'x' / "x"）。动态拼出来的通道（变量）跳过，需人工复核。
import { readdirSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

function walk(d, acc) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(p)
  }
  return acc
}

const mainFiles = walk(join(ROOT, 'main'), [])
const rendererFiles = walk(join(ROOT, 'renderer'), [])
const preloadFiles = walk(join(ROOT, 'preload'), [])

// 捕获 ipcRenderer/ipcMain 的 invoke/on/handle/send 通道
const callRe = /(?:ipcRenderer|ipcMain)\.(invoke|on|handle|send)\(\s*(['"])([^'"]+)\2/g
// 主进程向外发事件：webContents.send / mainWindow.webContents.send / event.sender.send / win.webContents.send
const sendRe = /\.send\(\s*(['"])([^'"]+)\1/g
// 主进程 event.reply
const replyRe = /event\.reply\(\s*(['"])([^'"]+)\1/g
// 主进程经 broadcast('channel', payload) 帮助函数外发（内部仍 webContents.send）
const broadcastRe = /\bbroadcast\(\s*(['"])([^'"]+)\1/g

const invokeOnRenderer = new Set() // 渲染层 invoke（请求/响应）
const onOnRenderer = new Set()     // 渲染层 on（订阅主进程事件）
const sendOnRenderer = new Set()   // 渲染层 send（上发主进程，fire-and-forget）
const handleOnMain = new Set()     // 主进程 handle（响应 invoke）
const onOnMain = new Set()         // 主进程 on（接收渲染层 send）
const sendOnMain = new Set()       // 主进程向外 send / reply（驱动渲染层 on）

function collect(files, bucket) {
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    let m
    callRe.lastIndex = 0
    while ((m = callRe.exec(text))) {
      const kind = m[1]
      const ch = m[3]
      if (bucket === 'renderer') {
        if (kind === 'invoke') invokeOnRenderer.add(ch)
        else if (kind === 'on') onOnRenderer.add(ch)
        else if (kind === 'send') sendOnRenderer.add(ch)
      } else {
        if (kind === 'handle') handleOnMain.add(ch)
        else if (kind === 'on') onOnMain.add(ch)
      }
    }
    if (bucket === 'main') {
      sendRe.lastIndex = 0
      while ((m = sendRe.exec(text))) sendOnMain.add(m[2])
      replyRe.lastIndex = 0
      while ((m = replyRe.exec(text))) sendOnMain.add(m[2])
      broadcastRe.lastIndex = 0
      while ((m = broadcastRe.exec(text))) sendOnMain.add(m[2])
    }
  }
}
collect(rendererFiles, 'renderer')
collect(preloadFiles, 'renderer')
collect(mainFiles, 'main')

// 渲染层 invoke 必须有主进程 handle
const missingHandlers = [...invokeOnRenderer].filter((ch) => !handleOnMain.has(ch))
// 渲染层 on（订阅）必须有主进程 send（reply 也算 sender）
const noSender = [...onOnRenderer].filter((ch) => !sendOnMain.has(ch))
// 渲染层 send（上发）必须有主进程 ipcMain.on
const noReceiver = [...sendOnRenderer].filter((ch) => !onOnMain.has(ch))

let bugs = 0
console.log('=== IPC 通道闭合性扫描 ===')
console.log(`渲染层 invoke=${invokeOnRenderer.size} on(订阅)=${onOnRenderer.size} send(上发)=${sendOnRenderer.size}`)
console.log(`主进程 handle=${handleOnMain.size} on(接收)=${onOnMain.size} send/reply(外发)=${sendOnMain.size}`)

if (missingHandlers.length) {
  bugs += missingHandlers.length
  console.log(`\n[CRITICAL] ${missingHandlers.length} 个 invoke 通道主进程未注册 handler（必然 reject / 功能断）：`)
  for (const ch of missingHandlers.sort()) console.log(`  - ${ch}`)
} else {
  console.log('\n[OK] 全部 invoke 通道均有主进程 handler')
}

if (noSender.length) {
  console.log(`\n[WARN] ${noSender.length} 个渲染层订阅(on)主进程从未发送（监听永不触发，功能可能静默死）：`)
  for (const ch of noSender.sort()) console.log(`  - ${ch}`)
} else {
  console.log('\n[OK] 渲染层 on 订阅均有主进程 sender')
}

if (noReceiver.length) {
  console.log(`\n[WARN] ${noReceiver.length} 个渲染层上发(send)主进程从未接收(ipcMain.on)：`)
  for (const ch of noReceiver.sort()) console.log(`  - ${ch}`)
} else {
  console.log('\n[OK] 渲染层 send 上发均有主进程接收')
}

console.log(`\n命中需人工复核项：${bugs}（CRITICAL 缺 handler） + ${noSender.length + noReceiver.length}（WARN 收发待核）`)
process.exit(bugs > 0 ? 1 : 0)

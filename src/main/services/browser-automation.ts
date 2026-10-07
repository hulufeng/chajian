/**
 * 浏览器自动化：Electron BrowserWindow + 内置 webContents.debugger（CDP），零三方依赖。
 *
 * 为什么不用 Playwright：
 *   Playwright 需要 npm 安装 + 300MB 浏览器二进制，而本项目主进程本身就是 Electron
 *   （自带完整 Chromium），再引一个浏览器自动化库既重复又沉重；而且它不在 package.json 里，
 *   导致浏览器工具在未装依赖的环境里整体不可用。
 *   Electron 的 webContents.debugger 就是现成的 CDP 客户端——不开调试端口（避免给本机任意
 *   进程开后门）、不需要额外依赖、协议支持完整（Network/DOM/Page 域）。
 *
 * 本文件自己实现自动化逻辑：元素定位、点击合成、表单填写（含 React 受控组件兼容）、
 * 网络记录、下载捕获、对话框处理。不依赖任何浏览器自动化三方库。
 *
 * 单例会话：navigate 之后 click/fill/screenshot 共享同一个窗口。
 */
import { BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

export interface NetworkRecord {
  url: string
  method: string
  status?: number
}

/**
 * 会话对象。CDP 相关的操作（send/evaluate/attach）作为方法挂在 BrowserSession 上，
 * 而不是外部弱类型字典——这样访问它们有完整类型检查，不需要 as unknown as 强转。
 */
interface BrowserSession {
  win: BrowserWindow
  requests: NetworkRecord[]
  downloads: string[]
  dialogs: string[]
  dialogAction: 'accept' | 'dismiss' | 'ignore'
  dialogText?: string
  /** CDP 命令；attached 为真时才可用 */
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  /** 在页面上下文求值；awaitPromise 允许 async 表达式 */
  evaluate: <T>(expression: string) => Promise<T>
}

let session: BrowserSession | null = null

async function ensureSession(): Promise<BrowserSession> {
  if (session && !session.win.isDestroyed()) return session

  const win = new BrowserWindow({
    show: false, // 离屏：不需要用户看到窗口，自动化照常跑
    width: 1280,
    height: 800,
    webPreferences: {
      // 页面是外部不可信内容：不开 nodeIntegration、保持上下文隔离
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      sandbox: false
    }
  })

  const requests: NetworkRecord[] = []
  const downloads: string[] = []
  const dialogs: string[] = []

  // ── 附着调试器（CDP）──
  // 监听器在下方只注册一次；这里只负责「确保已附着」并打开 Network/Page 域。
  // 注意不要把 on('message') 写进这个函数：send() 每次都会调它，
  // 会导致监听器重复注册（网络记录翻倍、对话框被处理多次）。
  const ensureAttached = async (): Promise<void> => {
    if (win.webContents.debugger.isAttached()) return
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Network.enable').catch(() => undefined)
    await win.webContents.debugger.sendCommand('Page.enable').catch(() => undefined)
  }

  // ── CDP 事件监听（注册一次）──
  // 用 sRef 破除 TDZ：监听器要读 s.dialogAction，而 s 在下方才声明。
  // 回调是延迟执行的（attach 之后才可能收到事件），但直接引用 s 仍属脆弱写法。
  const sRef: { current: BrowserSession | null } = { current: null }
  win.webContents.debugger.on('message', (_evt, method, params) => {
    const p = params as Record<string, unknown>
    const s = sRef.current
    if (!s) return
    switch (method) {
      case 'Network.requestWillBeSent': {
        const req = p.request as { url?: string; method?: string } | undefined
        if (req?.url) requests.push({ url: req.url, method: req.method || 'GET' })
        break
      }
      case 'Network.responseReceived': {
        const res = p.response as { url?: string; status?: number } | undefined
        if (res?.url) {
          // 回填最近一条同 url 且尚无 status 的请求
          for (let i = requests.length - 1; i >= 0; i--) {
            if (requests[i].url === res.url && requests[i].status === undefined) {
              requests[i].status = res.status
              break
            }
          }
        }
        break
      }
      case 'Page.javascriptDialogOpening': {
        // Electron 44 没有内置 dialog 事件，对话框必须经 CDP 处理。
        // 关键：**不回应的话页面会一直阻塞**（脚本卡住），所以三种策略都必须回应，
        // 差别只在 accept 与是否填 promptText：
        //   accept  → accept=true，prompt 时填 dialogText
        //   dismiss → accept=false（等同于按「取消」，对 alert/confirm 是明确否认）
        //   ignore  → accept=false 且不填任何文本（与 dismiss 实测同效，保留语义区分）
        const message = String(p.message || '')
        dialogs.push(message)
        const accept = s.dialogAction === 'accept'
        const fillPrompt = accept && p.type === 'prompt'
        void (async () => {
          try {
            await win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
              accept,
              promptText: fillPrompt ? (s.dialogText ?? (p.defaultPrompt as string) ?? '') : undefined
            })
          } catch {
            // 窗口已销毁 / 未附着：忽略，不能让异常冒到 IPC 层
          }
        })()
        break
      }
    }
  })

  const send = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    await ensureAttached()
    return (await win.webContents.debugger.sendCommand(method, params as never)) as T
  }

  const evaluate = async <T>(expression: string): Promise<T> => {
    const res = await send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本执行失败'
      )
    }
    return res.result?.value as T
  }

  const s: BrowserSession = { win, requests, downloads, dialogs, dialogAction: 'ignore', send, evaluate }
  session = s
  sRef.current = s

  await ensureAttached()

  // ── 下载：Electron 内置 will-download 直接给保存路径，比 CDP 域省事且可靠 ──
  win.webContents.session.on('will-download', (_event, item) => {
    // 路径来自 DownloadItem.getSavePath()（session 事件的第三参是 webContents，不是路径）
    const p = item.getSavePath()
    if (p) downloads.push(p)
  })

  return s
}

/** 统一的元素定位脚本：返回是否找到 + 简要信息 */
function locateScript(selector: string): string {
  return `
(function (sel) {
  try {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80),
             visible: r.width > 0 && r.height > 0 };
  } catch (e) {
    return { found: false, error: String(e && e.message || e) };
  }
})(${JSON.stringify(selector)})
`
}

// ── 对外接口（与 browser-tools.ts 的约定一致）──

export async function browserNavigate(url: string): Promise<string> {
  const s = await ensureSession()
  // loadURL 比 CDP Page.navigate 更可靠（能拿到 did-fail-load 的真实原因）
  await s.win.loadURL(url)
  const title = await s.evaluate<string>('document.title').catch(() => '')
  return `已导航到 ${url}，页面标题：${title || '(无)'}`
}

export async function browserScreenshot(path?: string): Promise<string> {
  const s = await ensureSession()
  const out = path && path.trim() ? path.trim() : join(tmpdir(), `codelab-shot-${Date.now()}.png`)
  // capturePage 内部走 CDP captureScreenshot，但省去 base64 转存
  const img = await s.win.webContents.capturePage()
  const buf = img.toPNG()
  if (!buf || buf.length === 0) throw new Error('截图失败：未捕获到图像数据')
  writeFileSync(out, buf)
  return `截图已保存：${out}`
}

export async function browserClick(selector: string): Promise<string> {
  const s = await ensureSession()
  const loc = await s.evaluate<{ found: boolean; visible?: boolean; text?: string; error?: string }>(locateScript(selector))
  if (!loc.found) {
    throw new Error(loc.error ? `选择器无效：${loc.error}` : `找不到匹配「${selector}」的元素`)
  }
  // 真实点击：派发鼠标事件序列，页面能收到冒泡，效果与用户点击一致
  await s.evaluate<void>(`
(function(){
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('元素已消失');
  el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  const x = r.left + r.width/2, y = r.top + r.height/2;
  for (const type of ['mousedown','mouseup','click']) {
    el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:x, clientY:y}));
  }
  return 1;
})()
  `)
  const extra = loc.visible ? '' : '（元素当前不可见，已直接派发事件）'
  return `已点击元素：${selector}${loc.text ? ` —「${loc.text}」` : ''}${extra}`
}

export async function browserFill(selector: string, value: string): Promise<string> {
  const s = await ensureSession()
  const ok = await s.evaluate<boolean>(`
(function(){
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({block:'center'});
  el.focus();
  // 用原生 setter 赋值，React/Vue 这类受控组件才认（直接改 .value 会被状态覆盖）
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  return true;
})()
  `)
  if (!ok) throw new Error(`找不到匹配「${selector}」的元素`)
  return `已填写表单 ${selector} = ${value}`
}

export async function browserEvaluate(js: string): Promise<string> {
  const s = await ensureSession()
  const result = await s.evaluate<unknown>(js)
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return `JS 执行结果：\n${text || '(空)'}`
}

export function browserNetwork(): NetworkRecord[] {
  return session?.requests || []
}

/** 在文件输入框设置待上传的本地文件（DOM 域专用命令，比 JS 赋值可靠） */
export async function browserUpload(selector: string, filePath: string): Promise<string> {
  const s = await ensureSession()
  const loc = await s.evaluate<{ found: boolean; error?: string }>(locateScript(selector))
  if (!loc.found) throw new Error(loc.error ? `选择器无效：${loc.error}` : `找不到匹配「${selector}」的元素`)
  const doc = await s.send<{ root: { nodeId: number } }>('DOM.getDocument')
  const { nodeId } = await s.send<{ nodeId: number }>('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector
  })
  if (!nodeId) throw new Error(`找不到匹配「${selector}」的文件输入框`)
  await s.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
  return `已为 ${selector} 设置上传文件：${filePath}`
}

/** 等待一次下载完成并返回保存路径 */
export async function browserDownload(url?: string, timeoutMs = 30000): Promise<string> {
  const s = await ensureSession()
  const before = s.downloads.length
  if (url) {
    await s.win.loadURL(url).catch(() => undefined)
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (s.downloads.length > before) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const saved = s.downloads.slice(before)
  if (saved.length > 0) return `下载完成，已保存：${saved[0]}`
  if (url) return `已访问下载链接 ${url}（未捕获到下载事件，可能该链接不是直链下载）`
  throw new Error(`等待下载超时（${timeoutMs}ms）`)
}

/** 设定对话框（alert/confirm/prompt）处理策略 */
export function browserDialogHandler(action: 'accept' | 'dismiss' | 'ignore', text?: string): string {
  if (!session) {
    throw new Error('尚未打开浏览器会话，请先 browser_navigate 访问页面。')
  }
  session.dialogAction = action
  session.dialogText = text
  const last = session.dialogs[session.dialogs.length - 1] || ''
  return `已设定对话框处理策略：${action}${text ? `（填充文本：${text}）` : ''}。最近一次对话框消息：${last || '(无)'}`
}

/** 读取已捕获到的对话框消息列表 */
export function browserDialogs(): string[] {
  return session?.dialogs || []
}

export function browserClose(): void {
  const s = session
  session = null
  if (!s) return
  try {
    if (s.win.webContents.debugger.isAttached()) s.win.webContents.debugger.detach()
  } catch {
    /* 忽略 */
  }
  try {
    if (!s.win.isDestroyed()) s.win.destroy()
  } catch {
    /* 忽略 */
  }
}

/** 便于诊断：当前会话是否活着 */
export function browserSessionAlive(): boolean {
  return !!session && !session.win.isDestroyed()
}
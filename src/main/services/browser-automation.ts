// 浏览器自动化：基于 Playwright 动态加载（对齐 TrieCode 截图的"浏览器自动化"能力）。
// playwright 未安装时优雅提示用户安装，不强制构建期下载 chromium。
// 单例浏览器会话，navigate 后 click/fill/screenshot/evaluate 共享同一页面。
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface NetworkRecord {
  url: string
  method: string
  status?: number
}

interface BrowserSession {
  browser: unknown
  page: unknown
  requests: NetworkRecord[]
  downloads: string[]
  dialogs: string[]
  dialogAction: 'accept' | 'dismiss' | 'ignore'
  dialogText?: string
}

let session: BrowserSession | null = null
let playwrightMod: unknown = null

async function loadPlaywright(): Promise<any> {
  if (playwrightMod) return playwrightMod
  try {
    // @ts-ignore 动态加载；playwright 未安装时由调用方捕获并提示安装
    playwrightMod = await import('playwright')
  } catch {
    throw new Error('未安装 playwright。请先执行：npm i playwright && npx playwright install chromium')
  }
  return playwrightMod
}

async function ensureSession(): Promise<BrowserSession> {
  if (session) return session
  const pw = await loadPlaywright()
  const browser = await pw.chromium.launch({ headless: true })
  const page = await browser.newPage()
  const requests: NetworkRecord[] = []
  const downloads: string[] = []
  const dialogs: string[] = []
  page.on('request', (r: any) => requests.push({ url: r.url(), method: r.method() }))
  page.on('response', (r: any) => {
    const url = r.url()
    // 粗略匹配：更新同 url 中尚未记录 status 的最后一条
    for (let i = requests.length - 1; i >= 0; i--) {
      if (requests[i].url === url && requests[i].status === undefined) {
        requests[i].status = r.status()
        break
      }
    }
  })
  // 对话框处理：按会话配置（默认忽略，由 browser_handle_dialog 设定 accept/dismiss）
  page.on('dialog', async (d: any) => {
    const msg = d.message()
    dialogs.push(msg)
    if (session?.dialogAction === 'accept') {
      try { await d.accept(session.dialogText) } catch { /* 忽略 */ }
    } else if (session?.dialogAction === 'dismiss') {
      try { await d.dismiss() } catch { /* 忽略 */ }
    }
    // ignore：不做处理，交由页面默认行为
  })
  // 下载事件：记录保存路径
  page.on('download', async (dl: any) => {
    const out = join(tmpdir(), `codelab-dl-${Date.now()}-${dl.suggestedFilename?.() || 'file'}`)
    try {
      await dl.saveAs(out)
      downloads.push(out)
    } catch {
      /* 忽略 */
    }
  })
  session = { browser, page, requests, downloads, dialogs, dialogAction: 'ignore' }
  return session
}

export async function browserNavigate(url: string): Promise<string> {
  const s = await ensureSession()
  await (s.page as any).goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => undefined)
  const title = await (s.page as any).title()
  return `已导航到 ${url}，页面标题：${title || '(无)'}`
}

export async function browserScreenshot(path?: string): Promise<string> {
  const s = await ensureSession()
  const out = path && path.trim() ? path.trim() : join(tmpdir(), `codelab-shot-${Date.now()}.png`)
  await (s.page as any).screenshot({ path: out, fullPage: false })
  return `截图已保存：${out}`
}

export async function browserClick(selector: string): Promise<string> {
  const s = await ensureSession()
  await (s.page as any).click(selector, { timeout: 10000 })
  return `已点击元素：${selector}`
}

export async function browserFill(selector: string, value: string): Promise<string> {
  const s = await ensureSession()
  await (s.page as any).fill(selector, value, { timeout: 10000 })
  return `已填写表单 ${selector} = ${value}`
}

export async function browserEvaluate(js: string): Promise<string> {
  const s = await ensureSession()
  const result = await (s.page as any).evaluate(js)
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return `JS 执行结果：\n${text || '(空)'}`
}

export function browserNetwork(): NetworkRecord[] {
  return session?.requests || []
}

/** 在文件输入框（CSS 选择器匹配）中设置要上传的本地文件，触发上传。 */
export async function browserUpload(selector: string, filePath: string): Promise<string> {
  const s = await ensureSession()
  await (s.page as any).setInputFiles(selector, filePath, { timeout: 10000 })
  return `已为 ${selector} 设置上传文件：${filePath}`
}

/**
 * 等待一次下载完成并返回保存路径。
 * - 若传入 url：先导航到该 URL（通常是下载直链），再等待 download 事件。
 * - 否则：等待页面上后续点击触发的 download 事件（最长 30s）。
 */
export async function browserDownload(url?: string, timeoutMs = 30000): Promise<string> {
  const s = await ensureSession()
  if (url) {
    await (s.page as any).goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => undefined)
  }
  const before = s.downloads.length
  try {
    const dl: any = await (s.page as any).waitForEvent('download', { timeout: timeoutMs })
    const savePath = join(tmpdir(), `codelab-dl-${Date.now()}-${dl.suggestedFilename?.() || 'file'}`)
    await dl.saveAs(savePath)
    if (!s.downloads.includes(savePath)) s.downloads.push(savePath)
    return `下载完成，已保存：${savePath}（文件名：${dl.suggestedFilename?.() || '未知'}）`
  } catch (e) {
    const saved = s.downloads.slice(before)
    if (saved.length > 0) return `下载已完成（事件前已落盘）：${saved.join(', ')}`
    throw new Error(`等待下载超时（${timeoutMs}ms）：${(e as Error).message}`)
  }
}

/**
 * 设定对话框（alert/confirm/prompt）处理策略。
 * action: 'accept' 自动确认（可附带 text 填 prompt）；'dismiss' 自动取消；'ignore' 交页面默认。
 * 返回最近一次捕获到的对话框消息（若有）。
 */
export function browserDialogHandler(action: 'accept' | 'dismiss' | 'ignore', text?: string): string {
  if (!session) {
    throw new Error('尚未打开浏览器会话，请先 browser_navigate 访问页面。')
  }
  session.dialogAction = action
  session.dialogText = text
  const last = session.dialogs[session.dialogs.length - 1] || ''
  return `已设定对话框处理策略：${action}${text ? `（填充文本：${text}）` : ''}。最近一次对话框消息：${last || '(无)'}`
}

/** 读取已捕获的对话框消息列表。 */
export function browserDialogs(): string[] {
  return session?.dialogs || []
}

export function browserClose(): void {
  if (session) {
    try {
      ;(session.browser as any).close()
    } catch {
      /* 忽略 */
    }
    session = null
  }
}

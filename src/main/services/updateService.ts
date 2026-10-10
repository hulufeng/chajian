import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'

// ───────────────────────────────────────────────────────────
//  强制更新 / 自动更新服务（零依赖：原生 fetch + 静默 NSIS 安装）
// ───────────────────────────────────────────────────────────
//
//  ★ 发布渠道：自建静态 HTTP 服务（https://bluebubai.work/updates/）★
//  两套元数据都支持，统一到一个入口：
//    1) update.json —— 可选，人工写的版本元数据（格式见下方 UpdateInfo）。
//       它的唯一价值是能带 forceUpdate / notes，需要「强制更新」时才放。
//    2) latest.yml  —— electron-builder 出包自动生成，**线上真实存在的源**。
//       只要目录里有它，即使没有 update.json 也能正常检查更新。
//  优先级：update.json 存在时以它为准（可覆盖安装包直链），否则回退解析 latest.yml。
//
//  app 启动后（仅打包态）会拉取元数据比对版本：
//    - 非强制更新：弹原生对话框「立即更新 / 稍后」
//    - 强制更新（forceUpdate=true）：弹只读提示后自动下载并以 /S 静默安装、重启
//  安装包下载后会以 `LabCode-Setup-x.y.z.exe /S` 静默运行并替换旧文件，随后 app 退出。
// ───────────────────────────────────────────────────────────
export const UPDATE_BASE_URL = 'https://bluebubai.work/updates/'

const UPDATE_INFO_URL = `${UPDATE_BASE_URL}update.json`
const UPDATE_LATEST_YML_URL = `${UPDATE_BASE_URL}latest.yml`
const PLACEHOLDER_HOST = 'your-host.example.com'

export interface UpdateInfo {
  version: string
  forceUpdate?: boolean
  notes?: string
  /** 可选：覆盖默认命名规则的安装包直链 */
  url?: string
  pubDate?: string
}

export type UpdaterState =
  | 'disabled'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'postponed'
  | 'error'

export interface UpdaterStatus {
  state: UpdaterState
  info?: UpdateInfo
  /** 下载进度 0..1（无 content-length 时为 undefined） */
  progress?: number
  bytes?: number
  total?: number
  message?: string
  /** 是否为强制更新 */
  force?: boolean
}

let mainWindowRef: BrowserWindow | null = null
let checking = false

export function setUpdaterWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

function sendStatus(status: UpdaterStatus): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:status', status)
  }
}

function isPlaceholder(): boolean {
  return UPDATE_BASE_URL.includes(PLACEHOLDER_HOST)
}

function parseVer(v: string): [number, number, number] {
  const m = String(v).replace(/^v/, '').split('.')
  return [parseInt(m[0], 10) || 0, parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0]
}

function isNewer(remote: string, local: string): boolean {
  const a = parseVer(remote)
  const b = parseVer(local)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * 极简 latest.yml 解析（electron-builder 产出）。
 *
 * 为什么要自己解析而不引 yaml 包：这里只需要 version / path / files[0].url / releaseDate
 * 四个字段，auri 那份 yml 结构十年没变过；为零依赖目标（本项目主进程刻意不引三方解析库），
 * 用逐行匹配足够，且**解析不出来一律返回 null**，由调用方按「无更新」处理，不会误升级。
 */
export function parseLatestYml(text: string): UpdateInfo | null {
  const pick = (re: RegExp): string | null => {
    const m = text.match(re)
    return m ? m[1].trim() : null
  }
  const version = pick(/^version:\s*(.+)$/m)
  if (!version) return null
  // files: 列表里的 url 优先（多文件分发时它才是真实文件名），没有就用顶层 path
  const fileUrl = pick(/^\s*-\s*url:\s*(.+)$/m) || pick(/^path:\s*(.+)$/m)
  const info: UpdateInfo = {
    version,
    pubDate: pick(/^releaseDate:\s*(.+)$/m) ?? undefined,
  }
  if (fileUrl) info.url = new URL(fileUrl, UPDATE_BASE_URL).toString()
  return info
}

/** 取版本元数据：update.json 优先（可带 forceUpdate/notes），缺失则回退 latest.yml */
async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  const json = await fetchJson<UpdateInfo>(UPDATE_INFO_URL)
  if (json && json.version) return json
  const yml = await fetchText(UPDATE_LATEST_YML_URL)
  if (!yml) return null
  return parseLatestYml(yml)
}

function downloadTo(
  url: string,
  dest: string,
  onProgress?: (bytes: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https:') ? https : http
    const req = proto.get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        downloadTo(next, dest, onProgress).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const total = parseInt((res.headers['content-length'] as string) ?? '0', 10) || 0
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (total > 0 && onProgress) onProgress(bytes, total)
      })
      const out = createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => resolve())
      out.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function doUpdate(info: UpdateInfo): Promise<void> {
  const url = info.url || `${UPDATE_BASE_URL}LabCode-Setup-${info.version}.exe`
  const dest = join(tmpdir(), `LabCode-Setup-${info.version}.exe`)
  sendStatus({ state: 'downloading', info, progress: 0 })
  try {
    await downloadTo(url, dest, (bytes, total) => {
      sendStatus({ state: 'downloading', info, progress: total > 0 ? bytes / total : undefined, bytes, total })
    })
    sendStatus({ state: 'downloaded', info })
    // 以 /S 静默安装：先启动安装进程（detached 脱离当前进程），再退出当前 app 释放文件锁
    const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      sendStatus({ state: 'error', info, message: '安装程序启动失败，请手动运行下载的安装包' })
    })
    setTimeout(() => app.quit(), 800)
  } catch (e) {
    sendStatus({ state: 'error', info, message: `更新下载失败：${(e as Error).message}` })
  }
}

export async function checkForUpdates(opts: { interactive?: boolean } = {}): Promise<void> {
  if (checking) return
  if (!app.isPackaged) {
    if (opts.interactive) sendStatus({ state: 'disabled', message: '开发模式不检查更新' })
    return
  }
  if (isPlaceholder()) {
    console.warn(
      '[updater] UPDATE_BASE_URL 仍是占位地址，已跳过自检。请在 src/main/services/updateService.ts 配置真实托管地址。'
    )
    if (opts.interactive) sendStatus({ state: 'disabled', message: '未配置更新地址' })
    return
  }
  checking = true
  try {
    sendStatus({ state: 'checking' })
    const info = await fetchUpdateInfo()
    if (!info || !info.version) {
      if (opts.interactive) sendStatus({ state: 'up-to-date', message: '无更新信息' })
      else sendStatus({ state: 'up-to-date' })
      return
    }
    const local = app.getVersion()
    if (!isNewer(info.version, local)) {
      if (opts.interactive) sendStatus({ state: 'up-to-date', message: `已是最新（v${local}）` })
      else sendStatus({ state: 'up-to-date' })
      return
    }
    const force = info.forceUpdate === true
    sendStatus({ state: 'available', info, force })
    const parent = mainWindowRef ?? undefined
    if (force) {
      await dialog.showMessageBox(parent!, {
        type: 'warning',
        title: '发现强制更新',
        message: `检测到重要更新 v${info.version}（当前 v${local}）。\n为保证正常使用，将自动下载并安装，应用即将重启。`,
        detail: info.notes || '',
        buttons: ['知道了，开始更新'],
        noLink: true,
        defaultId: 0
      })
      await doUpdate(info)
    } else {
      const { response } = await dialog.showMessageBox(parent!, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${info.version}（当前 v${local}）。是否立即更新？`,
        detail: info.notes || '',
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) await doUpdate(info)
      else sendStatus({ state: 'postponed' })
    }
  } catch (e) {
    sendStatus({ state: 'error', message: `检查更新失败：${(e as Error).message}` })
  } finally {
    checking = false
  }
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:check', (_e, opts?: { interactive?: boolean }) => checkForUpdates(opts ?? {}))
  ipcMain.handle('updater:getBaseUrl', () => UPDATE_BASE_URL)
}

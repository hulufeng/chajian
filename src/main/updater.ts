import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/** 用户数据目录下持久化的运行配置（如 updateUrl 覆盖） */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): Record<string, unknown> {
  try {
    const p = settingsPath()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
  } catch {
    /* 忽略损坏配置 */
  }
  return {}
}

export function writeSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const cur = readSettings()
  const next = { ...cur, ...patch }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    /* 忽略写失败 */
  }
  return next
}

/**
 * 更新源解析优先级（高→低）：
 * 1. 环境变量 CODELAB_UPDATE_URL（临时覆盖，适合测试）
 * 2. userData/settings.json 的 updateUrl（持久化，界面可写）
 * 3. package.json build.publish.url（打包时内置，默认）
 */
function resolveUpdateUrl(): string | null {
  const fromEnv = process.env.CODELAB_UPDATE_URL
  if (fromEnv) return fromEnv
  const settings = readSettings()
  if (typeof settings.updateUrl === 'string' && settings.updateUrl) return settings.updateUrl
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf-8')) as {
      build?: { publish?: Array<{ url?: string }> }
    }
    const url = pkg.build?.publish?.[0]?.url
    if (typeof url === 'string' && url) return url
  } catch {
    /* 忽略 */
  }
  return null
}

export function currentUpdateUrl(): string | null {
  return resolveUpdateUrl()
}

function applyFeed(): void {
  const url = resolveUpdateUrl()
  if (url) {
    autoUpdater.setFeedURL({ provider: 'generic', url })
    console.log(`[updater] 更新源已设置：${url}`)
  } else {
    console.warn('[updater] 未配置更新源（build.publish.url / updateUrl）')
  }
}

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win

  if (!app.isPackaged) {
    console.log('[updater] 开发模式跳过自动更新')
    // 仍注册 IPC，返回不可用提示
    ipcMain.handle('update:check', () => false)
    ipcMain.handle('update:download', () => false)
    ipcMain.handle('update:install', () => false)
    ipcMain.handle('update:getUrl', () => ({ dev: true, url: resolveUpdateUrl() }))
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send('update:checking'))
  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }))
  autoUpdater.on('update-not-available', () => send('update:not-available'))
  autoUpdater.on('error', (err) => send('update:error', err.message))
  autoUpdater.on('download-progress', (p) =>
    send('update:progress', {
      percent: Math.round(p.percent * 100) / 100,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', { version: info.version }))

  ipcMain.handle('update:check', () => {
    autoUpdater.checkForUpdates().catch((e) => send('update:error', (e as Error).message))
    return true
  })
  ipcMain.handle('update:download', () => {
    autoUpdater.downloadUpdate().catch((e) => send('update:error', (e as Error).message))
    return true
  })
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
    return true
  })
  ipcMain.handle('update:getUrl', () => ({ dev: false, url: resolveUpdateUrl() }))

  // 启动后延迟自动检查（不打扰，仅提示有更新）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }, 8000)
}

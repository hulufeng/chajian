import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pluginManager } from './pluginManager'

const execFileAsync = promisify(execFile)

/** 插件市场 API 地址（开发环境本地，生产环境线上） */
const MARKET_API = process.env.LABCODE_MARKET_API || 'http://localhost:3100/api'

export interface MarketPlugin {
  id: string
  name: string
  version: string
  developer: string
  icon: string
  description: string
  installedCount: number
  updatedAt: string
  downloadUrl: string
  installed?: boolean
  installing?: boolean
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  path: string
  enabled: boolean
}

/** 用户插件目录：%APPDATA%/LabCode/plugins */
function getUserPluginsDir(): string {
  const userData = app.getPath('userData')
  const dir = join(userData, 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 获取已安装插件列表 */
export function getInstalledPlugins(): InstalledPlugin[] {
  const dir = getUserPluginsDir()
  if (!existsSync(dir)) return []
  const result: InstalledPlugin[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(dir, entry.name)
    const manifestPath = join(pluginDir, 'manifest.json')
    const pluginJsonPath = join(pluginDir, 'plugin.json')
    const manifestFile = existsSync(manifestPath) ? manifestPath : existsSync(pluginJsonPath) ? pluginJsonPath : null
    if (!manifestFile) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'))
      result.push({
        id: manifest.id || entry.name,
        name: manifest.name || manifest.displayName || entry.name,
        version: manifest.version || '0.0.0',
        path: pluginDir,
        enabled: true,
      })
    } catch {
      // 跳过无效插件
    }
  }
  return result
}

/** 从市场获取插件列表 */
export async function fetchMarketPlugins(): Promise<MarketPlugin[]> {
  return new Promise((resolve, reject) => {
    const url = `${MARKET_API}/plugins`
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`市场 API 返回 ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const installed = getInstalledPlugins()
          const installedIds = new Set(installed.map((p) => p.id))
          const plugins: MarketPlugin[] = (json.plugins || []).map((p: Record<string, unknown>) => ({
            id: p.id as string,
            name: p.name as string,
            version: p.version as string,
            developer: p.developer as string,
            icon: (p.icon as string) || '📦',
            description: p.description as string,
            installedCount: (p.installedCount as number) || 0,
            updatedAt: (p.updatedAt as string) || '',
            downloadUrl: (p.downloadUrl as string) || `${MARKET_API}/plugins/${p.id}/download`,
            installed: installedIds.has(p.id as string),
          }))
          resolve(plugins)
        } catch (e) {
          reject(new Error(`解析市场数据失败: ${(e as Error).message}`))
        }
      })
    }).on('error', reject)
  })
}

/** 下载文件 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location
        if (redirectUrl) {
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject)
          return
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      const fileStream = createWriteStream(destPath)
      pipeline(res, fileStream).then(() => resolve()).catch(reject)
    }).on('error', reject)
  })
}

/** 解压 zip（使用 PowerShell，避免额外依赖） */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ])
}

/** 安装插件：下载 → 解压 → 加载 */
export async function installPlugin(pluginId: string, downloadUrl: string): Promise<{ success: boolean; message: string }> {
  const dir = getUserPluginsDir()
  const pluginDir = join(dir, pluginId)
  const zipPath = join(dir, `${pluginId}.zip`)

  try {
    // 1. 下载
    console.log(`[plugin-market] 下载插件 ${pluginId}: ${downloadUrl}`)
    await downloadFile(downloadUrl, zipPath)

    // 2. 解压
    console.log(`[plugin-market] 解压插件 ${pluginId}`)
    if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
    mkdirSync(pluginDir, { recursive: true })
    await extractZip(zipPath, pluginDir)

    // 3. 清理 zip
    if (existsSync(zipPath)) rmSync(zipPath)

    // 4. 加载插件
    pluginManager.loadFromDir(pluginDir)
    pluginManager.init()

    console.log(`[plugin-market] 插件 ${pluginId} 安装成功`)
    return { success: true, message: '安装成功' }
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[plugin-market] 插件 ${pluginId} 安装失败: ${msg}`)
    // 清理
    if (existsSync(zipPath)) rmSync(zipPath)
    if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
    return { success: false, message: `安装失败: ${msg}` }
  }
}

/** 卸载插件 */
export function uninstallPlugin(pluginId: string): { success: boolean; message: string } {
  const dir = getUserPluginsDir()
  const pluginDir = join(dir, pluginId)
  if (!existsSync(pluginDir)) {
    return { success: false, message: '插件未安装' }
  }
  try {
    rmSync(pluginDir, { recursive: true, force: true })
    console.log(`[plugin-market] 插件 ${pluginId} 已卸载`)
    return { success: true, message: '卸载成功' }
  } catch (e) {
    return { success: false, message: `卸载失败: ${(e as Error).message}` }
  }
}

/** 启动时加载用户已安装插件 */
export function loadUserPlugins(): void {
  const dir = getUserPluginsDir()
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(dir, entry.name)
    pluginManager.loadFromDir(pluginDir)
  }
}

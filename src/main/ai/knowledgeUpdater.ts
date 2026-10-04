/**
 * 教学知识库插件化一键更新
 * 数据流：用户 GitHub（hulufeng/labcode-knowledge）latest.json + knowledge.zip
 *        → 软件内拉取 → sha256 校验 → 解压到 %APPDATA%/codelab-desktop/knowledge（用户级，优先级高于内置）
 * 用途：IMA/任意编辑端维护知识库 → 打包 zip 发布到 GitHub → 用户软件内一键更新，重启生效
 */
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import { resumableDownload } from './modelRuntime'

/** 内置知识库版本（resources/knowledge 打包内容，随软件发版更新） */
export const KB_BUILTIN_VERSION = '20261004-78'
/** 知识库清单地址（gh-proxy 镜像 GitHub raw，国内可达） */
export const KB_MANIFEST_URL =
  'https://gh-proxy.com/https://raw.githubusercontent.com/hulufeng/labcode-knowledge/main/latest.json'

export interface KnowledgeManifest {
  version: string
  zipUrl: string
  sha256: string
  note: string
  updatedAt: string
}

/** 用户级知识库目录（插件更新落这里；加载器候选路径优先级最高） */
export function getKnowledgeUserDir(): string {
  return path.join(app.getPath('appData'), 'codelab-desktop', 'knowledge')
}

function readJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const client = u.protocol === 'https:' ? require('node:https') : require('node:http')
    const req = client.get(url, { timeout: timeoutMs }, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        readJson<T>(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (c: string) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T) } catch { reject(new Error('清单格式错误（非 JSON）')) }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
  })
}

/** 当前生效版本：用户级更新优先，否则内置 */
export function getCurrentKbVersion(): { version: string; source: 'user' | 'builtin' } {
  const verFile = path.join(getKnowledgeUserDir(), '.version')
  if (fs.existsSync(verFile)) {
    const v = fs.readFileSync(verFile, 'utf-8').trim()
    if (v) return { version: v, source: 'user' }
  }
  return { version: KB_BUILTIN_VERSION, source: 'builtin' }
}

/** 检查远端是否有新版本（失败抛错，由 UI 提示网络/仓库问题） */
export async function checkKnowledgeUpdate(): Promise<{
  current: { version: string; source: 'user' | 'builtin' }
  latest: KnowledgeManifest | null
  hasUpdate: boolean
}> {
  const current = getCurrentKbVersion()
  const latest = await readJson<KnowledgeManifest>(KB_MANIFEST_URL)
  const hasUpdate = latest.version !== current.version
  return { current, latest, hasUpdate }
}

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 解压 zip 到目标目录（PowerShell Expand-Archive，Windows 自带） */
function unzipTo(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
      { timeout: 120000, windowsHide: true },
      (err) => (err ? reject(new Error(`解压失败: ${err.message}`)) : resolve()),
    )
  })
}

/** 执行更新：下载 → 校验 sha256 → 覆盖用户级知识库目录 → 写版本号（重启后加载器生效） */
export async function updateKnowledge(onProgress?: (p: { status: string; percent: number }) => void): Promise<{
  success: boolean
  version?: string
  error?: string
}> {
  try {
    const manifest = await readJson<KnowledgeManifest>(KB_MANIFEST_URL)
    onProgress?.({ status: '下载知识库更新包…', percent: 5 })
    const userDir = getKnowledgeUserDir()
    const tmpDir = path.join(app.getPath('appData'), 'codelab-desktop', 'tmp-kb')
    fs.mkdirSync(tmpDir, { recursive: true })
    const zipPath = path.join(tmpDir, 'knowledge.zip')
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    await resumableDownload(manifest.zipUrl, zipPath, (p) => {
      onProgress?.({ status: `下载中… ${p.downloadedMB.toFixed(1)}MB`, percent: Math.min(5 + p.percent * 0.7, 75) })
    })
    const sha = sha256Of(zipPath)
    if (manifest.sha256 && sha.toLowerCase() !== manifest.sha256.toLowerCase()) {
      return { success: false, error: `校验失败：下载文件 sha256 与清单不符（${sha.slice(0, 12)}…）` }
    }
    onProgress?.({ status: '解压安装…', percent: 85 })
    // 清空旧用户目录（保留 .version 由后面重写）
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true })
    fs.mkdirSync(userDir, { recursive: true })
    await unzipTo(zipPath, userDir)
    fs.writeFileSync(path.join(userDir, '.version'), manifest.version, 'utf-8')
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    onProgress?.({ status: '完成', percent: 100 })
    return { success: true, version: manifest.version }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

/** 恢复内置知识库：删除用户级目录（重启后回退内置 resources/knowledge） */
export async function resetKnowledge(): Promise<{ success: boolean; error?: string }> {
  try {
    const userDir = getKnowledgeUserDir()
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

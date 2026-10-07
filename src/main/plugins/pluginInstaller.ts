import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipToDir } from './zip'
import { validateManifest } from './validate-manifest'
import { readSettings, writeSettings } from '../settings'
import { DEFAULT_CATALOG, type CatalogEntry } from './plugin-catalog'
import { pluginManager } from './pluginManager'

/**
 * 插件安装器：清单 → 下载 → 校验 → 解压 → 落盘 → 加载。
 *
 * 设计要点：
 *  - 信任模型：远端代码本质是执行别人的逻辑，首次安装必须走确认；确认后记进
 *    settings.json 的 pluginTrusted，之后该插件更新不再打扰用户（新来源每次都问）。
 *  - 不做静默失败：任何一步（下载/校验和/解压/manifest 校验）失败都会把原因回传，
 *    由调用方（设置页或 Agent）展示，不吞异常。
 *  - 落地位置：userData/plugins/<id>/，与内置插件目录 src/main/plugins 完全隔离，
 *    卸载就是把目录删掉，不会误伤内置插件。
 */

export type Emit = (msg: string) => void

export interface InstallSummary {
  id: string
  name: string
  displayName: string
  version: string
  loaded: boolean
  error?: string
}

export interface InstallOutcome {
  ok: boolean
  /** 未信任时的信号：调用方应弹确认，用户同意后带 trust:true 重调 */
  needConfirm: boolean
  entry?: CatalogEntry
  summary?: InstallSummary
  error?: string
}

export function pluginsRoot(): string {
  return join(app.getPath('userData'), 'plugins')
}

export function pluginDir(id: string): string {
  return join(pluginsRoot(), id)
}

function stagingRoot(): string {
  return join(app.getPath('userData'), '.plugin-staging')
}

// ── 信任状态 ─────────────────────────────────────────────────────────────────

function trustedMap(): Record<string, boolean> {
  const s = readSettings()
  const v = s.pluginTrusted
  return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
}

export function isTrusted(id: string): boolean {
  return trustedMap()[id] === true
}

export function trustPlugin(id: string, trusted = true): void {
  writeSettings({ pluginTrusted: { ...trustedMap(), [id]: trusted } })
}

export function untrustPlugin(id: string): void {
  const next = { ...trustedMap() }
  delete next[id]
  writeSettings({ pluginTrusted: next })
}

// ── 清单 ─────────────────────────────────────────────────────────────────────

function remoteCatalogUrl(): string | null {
  const v = readSettings().pluginCatalogUrl
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function fetchJson(buf: Buffer): Promise<CatalogEntry[]> {
  const parsed = JSON.parse(buf.toString('utf-8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('远端清单格式错误（应为数组）')
  return parsed as CatalogEntry[]
}

/** 拉清单：有配置远端就优先远端，失败回退内置；远端条目覆盖同 id 的内置条目 */
export async function loadCatalog(emit?: Emit): Promise<CatalogEntry[]> {
  const url = remoteCatalogUrl()
  if (!url) return DEFAULT_CATALOG
  try {
    const buf = await downloadBuffer(url, emit ? (m) => emit(`[清单] ${m}`) : undefined)
    const remote = await fetchJson(buf)
    const merged = new Map(DEFAULT_CATALOG.map((e) => [e.id, e]))
    for (const e of remote) merged.set(e.id, e)
    emit?.(`[清单] 已加载远端清单，共 ${merged.size} 个插件`)
    return [...merged.values()]
  } catch (e) {
    emit?.(`[清单] 远端不可用（${(e as Error).message}），回退内置清单`)
    return DEFAULT_CATALOG
  }
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

async function downloadBuffer(rawUrl: string, emit?: Emit): Promise<Buffer> {
  // 空 url 是「清单里没给可用来源」的信号（内置包的路径探测全部落空就是这种）。
  // 明确报错，别掉进下面 readFileSync('') 抛一个看不懂的 ENOENT。
  if (!rawUrl || !rawUrl.trim()) {
    throw new Error('插件清单未提供可用下载地址（内置包路径探测全部落空，请确认 resources 目录已随应用打包，或改用远端清单 pluginCatalogUrl）')
  }
  if (/^file:\/\//.test(rawUrl)) {
    // 走 fileURLToPath 而不是手拼路径：Windows 下 file:///D:/x 的手工剥壳会变成 /D:/x 再被解析成 D:\D:\x
    const p = fileURLToPath(new URL(rawUrl))
    emit?.(`读取本地包 ${p}`)
    return readFileSync(p)
  }
  // 裸路径也当本地文件处理（本机离线源用着顺手）
  if (!/^https?:\/\//.test(rawUrl)) {
    emit?.(`读取本地包 ${rawUrl}`)
    return readFileSync(rawUrl)
  }

  const { get } = await import('node:https')
  const { request: httpRequest } = await import('node:http')

  let url = rawUrl
  const redirects = new Set([301, 302, 303, 307, 308])
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? get : httpRequest
    const res = await new Promise<{ status: number; buffer: Buffer; location?: string }>((resolve, reject) => {
      const req = mod(
        u,
        { headers: { 'user-agent': 'CodeLab-PluginInstaller/1.0' } },
        (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, buffer: Buffer.concat(chunks), location: r.headers.location }))
        }
      )
      req.on('error', reject)
      req.end()
    })

    if (redirects.has(res.status) && res.location) {
      url = new URL(res.location, url).toString()
      emit?.(`跟随重定向 → ${url}`)
      continue
    }
    if (res.status !== 200) throw new Error(`下载失败：HTTP ${res.status}`)
    return res.buffer
  }
  throw new Error('重定向次数过多，已中止')
}

// ── 安装 ─────────────────────────────────────────────────────────────────────

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function installPlugin(
  id: string,
  opts: { trust?: boolean } = {},
  emit?: Emit
): Promise<InstallOutcome> {
  const entry = DEFAULT_CATALOG.find((e) => e.id === id)
  if (!entry) return { ok: false, needConfirm: false, error: `清单里没有插件 ${id}` }

  if (!isTrusted(id) && opts.trust !== true) {
    return { ok: false, needConfirm: true, entry }
  }

  try {
    emit?.(`▶ 下载 ${entry.displayName} v${entry.version}`)
    const buf = await downloadBuffer(entry.url, emit)
    const digest = sha256Of(buf)
    if (entry.sha256 && digest !== entry.sha256.toLowerCase()) {
      return {
        ok: false,
        needConfirm: false,
        entry,
        error: `校验和不符（期望 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已中止安装`,
      }
    }
    emit?.(`↓ 已下载 ${(buf.length / 1024).toFixed(1)} KB，校验通过`)

    const stage = join(stagingRoot(), `${id}-${Date.now()}`)
    mkdirSync(stage, { recursive: true })
    try {
      unzipToDir(buf, stage)

      const manPath = [join(stage, 'plugin.json'), join(stage, 'manifest.json')].find(existsSync)
      if (!manPath) throw new Error('插件包里没有 plugin.json / manifest.json')
      const manifest = JSON.parse(readFileSync(manPath, 'utf-8')) as Record<string, unknown>
      const validation = validateManifest(manifest)
      if (!validation.valid) {
        throw new Error(
          `manifest 校验失败：${validation.errors.map((e) => `${e.field} ${e.message}`).join('；') || '未知原因'}`
        )
      }

      const target = pluginDir(id)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(dirname(target), { recursive: true })
      // staging 与 target 同在 userData 下，rename 是原子操作
      renameSync(stage, target)

      if (!isTrusted(id)) trustPlugin(id)
      emit?.(`✔ 已安装到 ${target}`)

      const m = manifest as { name?: string; displayName?: string; version?: string }
      return {
        ok: true,
        needConfirm: false,
        entry,
        summary: {
          id,
          name: m.name ?? id,
          displayName: m.displayName ?? entry.displayName,
          version: m.version ?? entry.version,
          loaded: true,
        },
      }
    } catch (e) {
      rmSync(stage, { recursive: true, force: true })
      throw e
    }
  } catch (e) {
    return { ok: false, needConfirm: false, error: (e as Error).message }
  }
}

export function uninstallPlugin(id: string): { ok: boolean; error?: string } {
  const dir = pluginDir(id)
  if (!existsSync(dir)) return { ok: false, error: `未安装 ${id}` }
  try {
    rmSync(dir, { recursive: true, force: true })
    untrustPlugin(id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 已安装插件（扫 userData/plugins 下的 manifest），用于启动加载与列表展示 */
export function installedPlugins(): Array<{
  id: string
  name: string
  displayName: string
  version: string
  description: string
  entry?: string
  valid: boolean
  error?: string
}> {
  const root = pluginsRoot()
  if (!existsSync(root)) return []
  const result: Array<{
    id: string
    name: string
    displayName: string
    version: string
    description: string
    entry?: string
    valid: boolean
    error?: string
  }> = []

  for (const id of readdirSync(root)) {
    const dir = join(root, id)
    if (!existsSync(join(dir, 'plugin.json')) && !existsSync(join(dir, 'manifest.json'))) continue
    try {
      const mp = existsSync(join(dir, 'plugin.json')) ? join(dir, 'plugin.json') : join(dir, 'manifest.json')
      const manifest = JSON.parse(readFileSync(mp, 'utf-8')) as Record<string, unknown>
      const valid = validateManifest(manifest).valid
      result.push({
        id,
        name: String(manifest.name ?? id),
        displayName: String(manifest.displayName ?? id),
        version: String(manifest.version ?? '0.0.0'),
        description: String(manifest.description ?? ''),
        entry: typeof manifest.entry === 'string' ? manifest.entry : undefined,
        valid,
        error: valid ? undefined : 'manifest 校验未通过（不会加载）',
      })
    } catch (e) {
      result.push({
        id,
        name: id,
        displayName: id,
        version: '0.0.0',
        description: '',
        valid: false,
        error: `manifest 读取失败：${(e as Error).message}`,
      })
    }
  }
  return result
}

/**
 * 扫描 userData/plugins/* 并把已装插件接进运行时。
 * 启动时跑一次（装完的插件立即生效，不用重启），装/卸载后再跑一次即可热更新。
 */
export function scanInstalledPlugins(): Array<{ manifest: { name: string; displayName: string; version: string }; loaded: boolean; error?: string }> {
  const root = pluginsRoot()
  if (existsSync(root)) {
    for (const id of readdirSync(root)) {
      const dir = pluginDir(id)
      if (!existsSync(join(dir, 'plugin.json')) && !existsSync(join(dir, 'manifest.json'))) continue
      pluginManager.loadFromDir(dir)
    }
  }
  return pluginManager.init()
}

/** 给设置页用：可用（清单）+ 已装 合并成一个列表 */
export async function listPlugins(emit?: Emit): Promise<Array<CatalogEntry & { installed?: boolean; trusted?: boolean }>> {
  const catalog = await loadCatalog(emit)
  const installed = new Set(installedPlugins().map((p) => p.name))
  return catalog.map((e) => ({
    ...e,
    installed: installed.has(e.name) || installed.has(e.id),
    trusted: isTrusted(e.id),
  }))
}

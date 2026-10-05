// MCP 服务器配置（第四批④）
//
// 定位：把「外部 MCP 服务器」变成和工具链一样的**可管理资源** —— 有配置文件、有启停、
// 有信任开关，而不是在代码里写死。
//
// 安全设计（重要）：
//  1. **配置与信任分离**：命令定义可以来自工程仓库（`.labcode/mcp.json`），
//     但「是否信任」只存在本机独立的 mcp-trust.json 里。
//     这样既解决了「项目里声明的服务器无法被信任」的问题（配置会覆盖同名全局条目，
//     信任若写在配置里就会被覆盖掉），也让仓库无法替用户做决定。
//  2. **默认不信任**：trust.json 里没有记录的服务器永远不会被自动拉起。
//     MCP 服务器等于在本机执行任意命令，被塞进工程仓库的 mcp.json 是真实风险。
//  3. **不经过 shell**：spawn 时用命令 + 参数数组，不拼 shell 字符串，避免注入。
//
// 配置格式刻意与 Claude Desktop 的 mcp.json 保持一致，用户可以直接迁移。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

export interface McpServerEntry {
  /** stdio 传输：启动命令 */
  command: string
  args: string[]
  env?: Record<string, string>
  /** 用户是否关掉了它（关掉不删除配置）；项目配置里的这个字段不生效，由本机信任记录决定 */
  enabled: boolean
  /** 备注（UI 展示） */
  note?: string
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerEntry>
}

/** 本机信任记录：与配置分开存，仓库里永远带不来「已信任」 */
export interface McpTrustStore {
  trusted: string[]
  disabled: string[]
}

/** 服务器视图 = 配置内容 + 本机信任/启用状态 */
export interface McpServerView extends McpServerEntry {
  name: string
  source: 'global' | 'project'
  /** 是否已信任（只来自本机信任记录，仓库里带不来） */
  trusted: boolean
  /** 项目来源的服务器需要用户显式点信任 */
  trustLocked: boolean
}

export function globalConfigPath(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'codelab-desktop', 'mcp.json')
}

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, '.labcode', 'mcp.json')
}

function emptyConfig(): McpConfigFile {
  return { mcpServers: {} }
}

function emptyTrust(): McpTrustStore {
  return { trusted: [], disabled: [] }
}

function readConfigFile(path: string): McpConfigFile {
  try {
    if (!existsSync(path)) return emptyConfig()
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<McpConfigFile>
    const servers = raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : {}
    const out: Record<string, McpServerEntry> = {}
    for (const [name, v] of Object.entries(servers as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const e = v as Partial<McpServerEntry> & { trusted?: unknown }
      if (typeof e.command !== 'string' || !e.command.trim()) continue // 没命令的条目直接丢弃
      out[name] = {
        command: e.command.trim(),
        args: Array.isArray(e.args) ? e.args.map(String) : [],
        env: e.env && typeof e.env === 'object' ? (e.env as Record<string, string>) : undefined,
        enabled: e.enabled !== false,
        note: typeof e.note === 'string' ? e.note : undefined
      }
    }
    return { mcpServers: out }
  } catch {
    // 配置文件坏了不要让整个 IDE 起不来
    return emptyConfig()
  }
}

function writeConfigFile(path: string, cfg: McpConfigFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf-8')
}

export function trustStorePath(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'codelab-desktop', 'mcp-trust.json')
}

function readTrust(): McpTrustStore {
  try {
    const p = trustStorePath()
    if (!existsSync(p)) return emptyTrust()
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<McpTrustStore>
    return {
      trusted: Array.isArray(raw.trusted) ? raw.trusted.map(String) : [],
      disabled: Array.isArray(raw.disabled) ? raw.disabled.map(String) : []
    }
  } catch {
    return emptyTrust()
  }
}

function writeTrust(store: McpTrustStore): string {
  const p = trustStorePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8')
  return p
}

/** 读全局 + 项目配置并合并；信任与启用状态一律取自本机信任记录 */
export function loadMcpServers(projectRoot?: string | null): {
  servers: McpServerView[]
  globalPath: string
  projectPath: string | null
  trustPath: string
} {
  const gPath = globalConfigPath()
  const pPath = projectRoot ? projectConfigPath(projectRoot) : null
  const g = readConfigFile(gPath)
  const p = pPath ? readConfigFile(pPath) : null
  const trust = readTrust()

  const map = new Map<string, McpServerView>()
  const push = (name: string, e: McpServerEntry, source: 'global' | 'project'): void => {
    map.set(name, {
      name,
      ...e,
      source,
      // 信任/启用只认本机记录：仓库里写什么都不算
      trusted: trust.trusted.includes(name),
      enabled: e.enabled && !trust.disabled.includes(name),
      trustLocked: source === 'project'
    })
  }
  for (const [name, e] of Object.entries(g.mcpServers)) push(name, e, 'global')
  for (const [name, e] of Object.entries(p?.mcpServers ?? {})) push(name, e, 'project')

  return {
    servers: Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)),
    globalPath: gPath,
    projectPath: pPath,
    trustPath: trustStorePath()
  }
}

/** 校验一条服务器配置，返回可读的错误（空串 = 合法） */
export function validateServerEntry(input: {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}): string {
  const name = String(input.name || '').trim()
  if (!name) return '名称不能为空'
  if (!/^[\w.-]{1,64}$/.test(name)) return '名称只能用字母、数字、下划线、点、短横线（1-64 字符）'
  const command = String(input.command || '').trim()
  if (!command) return '启动命令不能为空'
  if (/[|;&<>`$(){}[\]!*?]/.test(command)) {
    return '命令里不能包含管道/重定向/通配符等 shell 语法（本 IDE 用参数数组直连执行，不走 shell）'
  }
  const args = input.args || []
  for (const a of args) {
    if (typeof a !== 'string') return '参数必须都是字符串'
  }
  const env = input.env || {}
  for (const [k, v] of Object.entries(env)) {
    if (!/^[\w.-]+$/.test(k)) return `环境变量名不合法：${k}`
    if (typeof v !== 'string') return `环境变量 ${k} 的值必须是字符串`
  }
  return ''
}

/** 拆分命令字符串（用户习惯直接粘 `npx -y @xxx/yyy`） */
export function splitCommand(input: string): { command: string; args: string[] } {
  const parts = String(input || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return { command: parts[0] || '', args: parts.slice(1) }
}

export function saveGlobalServer(name: string, entry: McpServerEntry): { ok: boolean; path: string; error?: string } {
  const path = globalConfigPath()
  const cfg = readConfigFile(path)
  cfg.mcpServers[name] = entry
  writeConfigFile(path, cfg)
  return { ok: true, path }
}

export function removeGlobalServer(name: string): { ok: boolean; path: string } {
  const path = globalConfigPath()
  const cfg = readConfigFile(path)
  delete cfg.mcpServers[name]
  writeConfigFile(path, cfg)
  return { ok: true, path }
}

/** 信任 / 取消信任：写本机信任记录（与配置分离，仓库改不动它） */
export function setServerTrusted(name: string, trusted: boolean, projectRoot?: string | null): { ok: boolean; error?: string; path?: string } {
  const merged = loadMcpServers(projectRoot)
  if (!merged.servers.some((s) => s.name === name)) {
    return { ok: false, error: `配置里没有名为 ${name} 的服务器` }
  }
  const store = readTrust()
  const set = new Set(store.trusted)
  if (trusted) set.add(name)
  else set.delete(name)
  const path = writeTrust({ ...store, trusted: Array.from(set) })
  return { ok: true, path }
}

/** 启用 / 停用：同样记在本机（disabled 优先于配置里的 enabled） */
export function setServerEnabled(name: string, enabled: boolean, projectRoot?: string | null): { ok: boolean; error?: string; path?: string } {
  const merged = loadMcpServers(projectRoot)
  if (!merged.servers.some((s) => s.name === name)) {
    return { ok: false, error: `配置里没有名为 ${name} 的服务器` }
  }
  const store = readTrust()
  const set = new Set(store.disabled)
  if (enabled) set.delete(name)
  else set.add(name)
  const path = writeTrust({ ...store, disabled: Array.from(set) })
  return { ok: true, path }
}

/** 命令是否为绝对路径（用于提示「路径可能不存在」） */
export function isAbsoluteCommand(command: string): boolean {
  return isAbsolute(command)
}

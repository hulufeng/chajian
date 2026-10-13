// MCP 服务器运行时管理（第四批④）
//
// 职责：读配置 → 只拉起「已启用且已信任」的服务器 → 汇总它们提供的工具 → 供 Agent 与 UI 使用。
//
// 为什么要这层间接：MCP 服务器是外部进程，出问题（命令写错、启动超时、协议不兼容）时
// 不能影响 IDE 其它功能。所以这里的任何异常都收敛成「这个 server 启动失败 + 原因」，
// 绝不让它冒泡到窗口层。
import { loadMcpServers, getMcpGlobalEnabled, type McpServerView } from './mcpConfig'
import { startMcpClient, stopMcpClient, getMcpClient, type McpTool } from './mcp-client'

export interface McpRuntimeState {
  name: string
  source: 'global' | 'project'
  command: string
  args: string[]
  enabled: boolean
  trusted: boolean
  /** running | stopped | failed | starting | not-trusted | disabled */
  status: 'running' | 'stopped' | 'failed' | 'starting' | 'not-trusted' | 'disabled'
  error?: string
  tools: Array<{ name: string; description?: string }>
}

export interface McpOverview {
  servers: McpRuntimeState[]
  totalTools: number
  globalPath: string
  projectPath: string | null
  /** MCP 全局总开关（对齐 TrieCode「启用 MCP 服务器」） */
  globalEnabled: boolean
}

/** 记录启动失败原因，供 UI 展示（进程本身由 mcp-client 持有） */
const failures = new Map<string, string>()

/** 拉起所有「已启用 + 已信任」的服务器。返回本次启动后的整体快照，不抛异常。 */
export async function startTrustedServers(projectRoot?: string | null): Promise<McpOverview> {
  if (!getMcpGlobalEnabled()) return await getOverview(projectRoot)
  const { servers } = loadMcpServers(projectRoot)
  for (const s of servers) {
    if (!s.enabled || !s.trusted) continue
    if (getMcpClient(s.name)?.isRunning()) continue
    failures.delete(s.name)
    try {
      const client = await startMcpClient(s.name, s.command, s.args)
      // 工具列表异步补：拿到后 UI 的「工具数」会自动更新，失败也不影响服务器本身已连上
      void client.listTools().catch((e: Error) => {
        failures.set(s.name, `已连接但读取工具列表失败：${e.message}`)
      })
    } catch (e) {
      failures.set(s.name, (e as Error).message)
    }
  }
  return await getOverview(projectRoot)
}

export function stopServer(name: string): void {
  stopMcpClient(name)
  failures.delete(name)
}

export function stopAllServers(): void {
  for (const s of loadMcpServers(null).servers) stopMcpClient(s.name)
  failures.clear()
}

function statusOf(s: McpServerView): { status: McpRuntimeState['status']; error?: string; tools: McpRuntimeState['tools'] } {
  if (!s.enabled) return { status: 'disabled', tools: [] }
  if (!s.trusted) return { status: 'not-trusted', tools: [] }
  const client = getMcpClient(s.name)
  if (failures.has(s.name)) return { status: 'failed', error: failures.get(s.name), tools: [] }
  if (client?.isRunning()) {
    // 工具列表可能是异步补拉的：这里发现还空着就补拉一次（带节流，避免每次刷新都打一次）
    if (client.toolCache.length === 0 && !listing.has(s.name)) {
      listing.add(s.name)
      void client
        .listTools()
        .catch((e: Error) => {
          failures.set(s.name, `已连接但读取工具列表失败：${e.message}`)
        })
        .finally(() => listing.delete(s.name))
    }
    const tools = client.toolCache as McpTool[]
    return {
      status: 'running',
      error: client.lastError ?? undefined,
      tools: tools.map((t) => ({ name: t.name, description: t.description }))
    }
  }
  return { status: 'stopped', tools: [] }
}

/** 正在补拉工具列表的服务器，避免并发重复请求 */
const listing = new Set<string>()

/** 当前所有服务器的状态快照（UI 与 Agent 都用它） */
export async function getOverview(projectRoot?: string | null): Promise<McpOverview> {
  const { servers, globalPath, projectPath } = loadMcpServers(projectRoot)
  const views: McpRuntimeState[] = servers.map((s) => {
    const st = statusOf(s)
    return {
      name: s.name,
      source: s.source,
      command: s.command,
      args: s.args,
      enabled: s.enabled,
      trusted: s.trusted,
      status: st.status,
      error: st.error,
      tools: st.tools
    }
  })
  return {
    servers: views,
    totalTools: views.reduce((n, v) => n + v.tools.length, 0),
    globalPath,
    projectPath,
    globalEnabled: getMcpGlobalEnabled()
  }
}

/** 汇总已连接服务器提供的工具（Agent 的 mcp_tools 工具用它） */
export async function listExternalTools(
  projectRoot?: string | null
): Promise<Array<{ server: string; name: string; description: string }>> {
  if (!getMcpGlobalEnabled()) return []
  const ov = await getOverview(projectRoot)
  const out: Array<{ server: string; name: string; description: string }> = []
  for (const s of ov.servers) {
    if (s.status !== 'running') continue
    for (const t of s.tools) out.push({ server: s.name, name: t.name, description: t.description || '' })
  }
  return out
}

/** 调用外部工具；未信任/未运行的服务器一律拒绝 */
export async function callExternalTool(
  projectRoot: string | null | undefined,
  server: string,
  tool: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; content: string; error?: string }> {
  const { servers } = loadMcpServers(projectRoot)
  const cfg = servers.find((s) => s.name === server)
  if (!cfg) return { ok: false, content: '', error: `没有名为 ${server} 的 MCP 服务器` }
  if (!cfg.enabled) return { ok: false, content: '', error: `${server} 已被禁用` }
  if (!cfg.trusted) return { ok: false, content: '', error: `${server} 未被信任，已拒绝调用（请在设置里点「信任」）` }
  const client = getMcpClient(server)
  if (!client?.isRunning()) {
    if (cfg.trusted) {
      try {
        await startMcpClient(cfg.name, cfg.command, cfg.args)
      } catch (e) {
        return { ok: false, content: '', error: `启动 ${server} 失败：${(e as Error).message}` }
      }
    }
  }
  try {
    const r = await (getMcpClient(server) as NonNullable<ReturnType<typeof getMcpClient>>).callTool(tool, args)
    const text = (r.content || [])
      .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
      .join('\n')
    return { ok: !r.isError, content: text || '(空响应)', error: r.isError ? text : undefined }
  } catch (e) {
    return { ok: false, content: '', error: `调用 ${server}/${tool} 失败：${(e as Error).message}` }
  }
}

/**
 * 测试单个服务器连通性（对齐 TrieCode 的「测试连接」）：临时拉起它并读工具列表。
 * 已启用+已信任才会连；不影响其它服务器，也不改信任状态。
 */
export async function testServer(
  name: string,
  projectRoot?: string | null
): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const { servers } = loadMcpServers(projectRoot)
  const s = servers.find((x) => x.name === name)
  if (!s) return { ok: false, toolCount: 0, error: `没有名为 ${name} 的服务器` }
  if (!s.enabled) return { ok: false, toolCount: 0, error: `${name} 已被禁用` }
  if (!s.trusted) return { ok: false, toolCount: 0, error: `${name} 未信任，先点「信任」再测试` }
  try {
    const existing = getMcpClient(name)
    const client = existing?.isRunning() ? existing : await startMcpClient(s.name, s.command, s.args)
    const tools = await client.listTools()
    return { ok: true, toolCount: tools.length }
  } catch (e) {
    return { ok: false, toolCount: 0, error: (e as Error).message }
  }
}

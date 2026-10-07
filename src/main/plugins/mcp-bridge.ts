import { getMcpClient, startMcpClient, getAllMcpClients, type McpClient } from '../services/mcp-client'

/**
 * MCP 通道桥接：manifest 里 transport=mcp 的工具由这里真实执行。
 *
 * 自研设计要点（复用宿主已有的 stdio JSON-RPC 2.0 客户端，不另起一套协议实现）：
 *   1. 双来源：既可用宿主「MCP 设置」里已连接的 server（mcp.server 指名），
 *      也可由插件自带启动命令（mcp.command/args）按需拉起——插件自带能力不必预先配置。
 *   2. 结果归一化：MCP 的 content[] 结构收敛成 { ok, data }，插件侧不用理解 MCP 协议细节。
 *   3. 失败明确：server 没连/启动失败/工具不存在都返回结构化错误，不抛异常、不静默。
 */

export interface McpCallSpec {
  /** 宿主已连接的 MCP server 名（MCP 设置里配的那个） */
  server?: string
  /** 要调用的 MCP 工具名 */
  tool?: string
  /** 插件自带 server 的启动命令（server 未预连接时用） */
  command?: string
  args?: string[]
  timeoutMs?: number
}

export interface McpCallResult {
  ok: boolean
  /** 文本化结果（content[].text 拼接） */
  data?: unknown
  error?: string
}

class McpBridge {
  /** 解析出可用客户端：优先复用宿主已连接的，其次按 command 拉起 */
  private async resolveClient(spec: McpCallSpec): Promise<{ client?: McpClient; error?: string }> {
    if (spec.server) {
      const existing = getMcpClient(spec.server)
      if (existing) return { client: existing }
    }
    if (spec.command) {
      // 插件自带 server：用「插件工具名」当会话名，避免与宿主已连接的同名 server 串台
      const name = spec.server || `plugin:${spec.tool || 'mcp'}`
      try {
        const started = await startMcpClient(name, spec.command, spec.args || [])
        return { client: started }
      } catch (e) {
        return { error: `启动 MCP server 失败: ${(e as Error).message}` }
      }
    }
    if (spec.server) {
      return {
        error: `宿主未找到已连接的 MCP server: ${spec.server}（先在 MCP 设置里连接，或在工具里声明 mcp.command 由插件自带启动）`
      }
    }
    return { error: 'MCP 工具缺少 mcp.server（宿主 server 名）或 mcp.command（插件自带启动命令）' }
  }

  /** 调用 MCP 工具 */
  async call(spec: McpCallSpec, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!spec || !spec.tool) return { ok: false, error: 'MCP 工具缺少 mcp.tool（目标 MCP 工具名）' }
    const { client, error } = await this.resolveClient(spec)
    if (!client) return { ok: false, error }
    try {
      if (Number(spec.timeoutMs) > 0) client.requestTimeoutMs = Number(spec.timeoutMs)
      const r = await client.callTool(spec.tool as string, args || {})
      const text = (r.content || [])
        .map((c) => (typeof c.text === 'string' ? c.text : ''))
        .join('\n')
      if (r.isError) return { ok: false, error: text || 'MCP 工具返回错误' }
      return { ok: true, data: text || r.content }
    } catch (e) {
      return { ok: false, error: `MCP 调用失败: ${(e as Error).message}` }
    }
  }

  /** 列出该 server 提供的工具（供 UI/诊断展示） */
  async listTools(spec: McpCallSpec): Promise<{ ok: boolean; tools?: Array<{ name: string; description: string }>; error?: string }> {
    const { client, error } = await this.resolveClient(spec)
    if (!client) return { ok: false, error }
    try {
      const list = await client.listTools()
      return { ok: true, tools: list.map((t) => ({ name: t.name, description: t.description })) }
    } catch (e) {
      return { ok: false, error: `列举 MCP 工具失败: ${(e as Error).message}` }
    }
  }

  /**
   * 停止由插件拉起的 MCP server（插件热加载/卸载时调用）。
   * 只停 plugin: 前缀的会话，不碰用户在「MCP 设置」里自己连的 server——避免插件卸载把用户配置一起关掉。
   */
  stopAll(): void {
    for (const c of getAllMcpClients()) {
      if (c.serverName.startsWith('plugin:')) {
        try {
          c.stop()
        } catch {
          /* 单个停止失败不影响其余清理 */
        }
      }
    }
  }
}

export const mcpBridge = new McpBridge()

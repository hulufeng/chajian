/**
 * MCP JSON-RPC 服务端（协议层，零业务依赖）。
 *
 * 只负责协议：处理 initialize / tools/list / tools/call / ping 与通知，
 * 具体工具的实现通过构造函数注入的 `dispatch` 回调提供（见 hardwareHandlers.ts）。
 * 这样既便于单元测试（注入 mock dispatch），也能让业务实现与协议解耦。
 */
import type { JsonRpcRequest, JsonRpcResponse, McpTool, HardwareToolResult } from './mcpTypes'

const PROTOCOL_VERSION = '2024-11-05'

export class McpServer {
  constructor(
    private readonly tools: McpTool[],
    private readonly dispatch: (name: string, args: Record<string, unknown>) => Promise<HardwareToolResult>
  ) {}

  private ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result }
  }

  private error(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  /**
   * 处理一条 JSON-RPC 请求，返回响应对象；通知类（无 id 或未定义响应）返回 null。
   */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null

    // 通知（notifications）：不需要回包
    if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
      return null
    }

    if (!req.method) {
      return this.error(id, -32600, 'Invalid Request: missing method')
    }

    switch (req.method) {
      case 'ping':
        return this.ok(id, {})

      case 'initialize':
        return this.ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'codelab-mcp', version: '1.0.0' }
        })

      case 'tools/list':
        return this.ok(id, { tools: this.tools })

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const name = params.name
        const args = params.arguments ?? {}
        if (!name) return this.error(id, -32602, 'Invalid params: missing tool name')

        const tool = this.tools.find((t) => t.name === name)
        if (!tool) return this.error(id, -32601, `Tool not found: ${name}`)

        try {
          const r = await this.dispatch(name, args)
          return this.ok(id, {
            content: [{ type: 'text', text: r.content }],
            isError: r.isError ?? false,
            // 透传结构化数据，方便客户端二次解析
            ...(r.data !== undefined ? { structuredContent: r.data } : {})
          })
        } catch (e) {
          return this.ok(id, {
            content: [{ type: 'text', text: `工具执行异常：${(e as Error).message}` }],
            isError: true
          })
        }
      }

      default:
        return this.error(id, -32601, `Method not found: ${req.method}`)
    }
  }

  /**
   * 处理一行 stdio 输入（一行一条 JSON-RPC 请求）。
   * 返回要写回 stdout 的 JSON 字符串，或 null（空行 / 通知 / 解析失败）。
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim()
    if (!trimmed) return null
    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      return null
    }
    const res = await this.handle(req)
    if (!res) return null
    return JSON.stringify(res)
  }
}

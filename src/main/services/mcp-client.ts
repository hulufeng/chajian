import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/**
 * MCP 客户端（stdio 传输）
 * 实现 JSON-RPC 2.0 over stdin/stdout，支持 initialize / tools/list / tools/call
 */
export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private reqId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private initialized = false
  /** 最近一次 tools/list 的结果：UI 与 Agent 都要展示「这个 server 提供了哪些工具」 */
  toolCache: McpTool[] = []
  /** 最近一次启动/运行错误，供 UI 展示 */
  lastError: string | null = null
  /** 单次请求超时：外部进程不响应时不能永久挂住（否则 IDE 侧调用方全被拖死） */
  requestTimeoutMs = 20000
  readonly serverName: string
  readonly command: string
  readonly args: string[]

  constructor(serverName: string, command: string, args: string[] = []) {
    this.serverName = serverName
    this.command = command
    this.args = args
  }

  /** 启动 MCP server 并发送 initialize */
  async start(): Promise<void> {
    if (this.proc) return
    this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // 必须监听 error：命令不存在 / 无权限时 ChildProcess 会发 error 事件，
    // 没有监听器会变成未捕获异常直接把整个 IDE 带崩（这是实测踩到的）。
    this.proc.on('error', (err: Error) => {
      this.lastError = err.message
      this.proc = null
      this.initialized = false
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP server ${this.serverName} 启动失败：${err.message}`))
      }
      this.pending.clear()
    })

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      this.processBuffer()
    })
    this.proc.stderr.on('data', (chunk: Buffer) => {
      // MCP server 的 stderr 通常是日志，忽略或记录
      console.error(`[MCP ${this.serverName} stderr]`, chunk.toString('utf-8').slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      this.proc = null
      this.initialized = false
      this.toolCache = []
      // 拒绝所有 pending 请求
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP server exited with code ${code}`))
      }
      this.pending.clear()
    })

    // initialize
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LabCode', version: '0.1.9' }
    })
    // notifications/initialized
    this.notify('notifications/initialized', {})
    this.initialized = true
  }

  /** 列出 MCP server 提供的工具（结果进 toolCache 供 UI 展示） */
  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.start()
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] }
    this.toolCache = result.tools || []
    return this.toolCache
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.initialized) await this.start()
    return (await this.request('tools/call', { name, arguments: args })) as McpCallResult
  }

  /** 停止 MCP server */
  stop(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
    }
    this.pending.clear()
    this.toolCache = []
    if (this.proc) {
      try { this.proc.kill() } catch { /* 忽略 */ }
      this.proc = null
      this.initialized = false
    }
  }

  isRunning(): boolean {
    return this.proc !== null
  }

  // ---------- 内部 ----------

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('MCP server 未启动'))
        return
      }
      const id = ++this.reqId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.serverName} 的 ${method} 请求超时（${this.requestTimeoutMs}ms 无响应）`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.proc.stdin.write(msg + '\n')
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.proc?.stdin.write(msg + '\n')
  }

  private processBuffer(): void {
    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(new Error(msg.error.message))
          } else {
            p.resolve(msg.result)
          }
        }
      } catch {
        // 非 JSON 行（如日志），忽略
      }
    }
  }
}

/** 全局 MCP 客户端管理器 */
const mcpClients = new Map<string, McpClient>()

export function getMcpClient(name: string): McpClient | undefined {
  return mcpClients.get(name)
}

export function getAllMcpClients(): McpClient[] {
  return Array.from(mcpClients.values())
}

export async function startMcpClient(name: string, command: string, args: string[] = []): Promise<McpClient> {
  let client = mcpClients.get(name)
  if (!client) {
    client = new McpClient(name, command, args)
    mcpClients.set(name, client)
  }
  await client.start()
  return client
}

export function stopMcpClient(name: string): void {
  const client = mcpClients.get(name)
  if (client) {
    client.stop()
    mcpClients.delete(name)
  }
}

export function stopAllMcpClients(): void {
  for (const client of mcpClients.values()) {
    client.stop()
  }
  mcpClients.clear()
}

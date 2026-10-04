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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private initialized = false
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
      // 拒绝所有 pending 请求
      for (const [, p] of this.pending) {
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

  /** 列出 MCP server 提供的工具 */
  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) await this.start()
    const result = await this.request('tools/list', {}) as { tools: McpTool[] }
    return result.tools || []
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.initialized) await this.start()
    return (await this.request('tools/call', { name, arguments: args })) as McpCallResult
  }

  /** 停止 MCP server */
  stop(): void {
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
      const id = ++this.reqId
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.proc?.stdin.write(msg + '\n')
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

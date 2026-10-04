// 极简 LSP 客户端：手写 JSON-RPC over stdio，零 npm 依赖。
// 语言服务器（clangd / typescript-language-server / pylsp / gopls 等）由系统提供，
// 在 PATH 中即可。提供 initialize / didOpen / definition / references / documentSymbol /
// publishDiagnostics 收集 / shutdown。供 Agent 工具做代码智能查询。
import { spawn, type ChildProcess } from 'node:child_process'

interface PendingRequest {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class LspClient {
  private proc: ChildProcess | null = null
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private buffer = ''
  private diagnostics = new Map<string, unknown[]>()
  private openDocs = new Set<string>()
  private ready = false

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly rootUri: string
  ) {}

  /** 启动语言服务器并完成 initialize 握手 */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        reject(new Error(`无法启动语言服务器 ${this.command}：${(e as Error).message}`))
        return
      }
      this.proc.stdout?.on('data', (d: Buffer) => this.onData(d.toString()))
      this.proc.stderr?.on('data', () => { /* 服务器诊断日志，忽略 */ })
      this.proc.on('error', (e) => reject(new Error(`语言服务器进程错误：${e.message}`)))
      this.proc.on('exit', (code) => {
        if (!this.ready && code !== 0) reject(new Error(`语言服务器 ${this.command} 异常退出（码 ${code}），可能未安装`))
      })

      this.request('initialize', {
        processId: process.pid,
        rootUri: this.rootUri,
        capabilities: {
          textDocument: {
            definition: { linkSupport: false },
            references: true,
            hover: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: {}
          },
          workspace: {}
        },
        locale: 'zh-CN'
      })
        .then(() => {
          this.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          this.ready = true
          resolve()
        })
        .catch(reject)
    })
  }

  private send(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg)
    const payload = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
    this.proc?.stdin?.write(payload)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`LSP 请求超时: ${method}`))
        }
      }, 30000)
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    // 解析 Content-Length 分帧
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const header = this.buffer.slice(0, headerEnd)
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const len = parseInt(m[1], 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + len) break
      const body = this.buffer.slice(bodyStart, bodyStart + len)
      this.buffer = this.buffer.slice(bodyStart + len)
      let msg: { id?: number | null; method?: string; params?: { uri?: string; diagnostics?: unknown[] }; error?: { message?: string }; result?: unknown }
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: { id?: number | null; method?: string; params?: { uri?: string; diagnostics?: unknown[] }; error?: { message?: string }; result?: unknown }): void {
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'))
        else p.resolve(msg.result)
      }
    } else if (msg.method) {
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        this.diagnostics.set(msg.params.uri, msg.params.diagnostics || [])
      }
    }
  }

  /** 打开/同步文档（server 索引需要） */
  async openDocument(uri: string, languageId: string, text: string, delayMs = 600): Promise<void> {
    if (!this.openDocs.has(uri)) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text }
      })
      this.openDocs.add(uri)
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }

  async definition(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character }
    })
  }

  async references(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true }
    })
  }

  async hover(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character }
    })
  }

  async documentSymbol(uri: string): Promise<unknown> {
    return this.request('textDocument/documentSymbol', { textDocument: { uri } })
  }

  async workspaceSymbol(query: string): Promise<unknown> {
    return this.request('workspace/symbol', { query })
  }

  getDiagnostics(uri: string): unknown[] {
    return this.diagnostics.get(uri) || []
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', null)
    } catch {
      /* 忽略 */
    }
    this.notify('exit', null)
    this.proc = null
  }
}

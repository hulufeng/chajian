/**
 * MCP stdio 服务入口（纯 Node 进程，无需 Electron GUI）。
 *
 * 启动方式：
 *   node out/main/mcp-stdio.js --mcp
 * 或随主程序以子进程形式拉起。通过 stdin 逐行读取 JSON-RPC 请求，
 * stdout 写回 JSON-RPC 响应；所有诊断日志走 stderr，避免污染协议流。
 */
import { McpServer } from './mcpServer'
import { HARDWARE_MCP_TOOLS } from './mcpTypes'
import { dispatchHardwareTool } from './hardwareHandlers'

export function startMcpStdioServer(): void {
  const server = new McpServer(HARDWARE_MCP_TOOLS, dispatchHardwareTool)
  let buffer = ''

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      void server
        .handleLine(line)
        .then((out) => {
          if (out) process.stdout.write(out + '\n')
        })
        .catch((e) => {
          process.stderr.write(`[mcp] handle error: ${(e as Error).message}\n`)
        })
    }
  })
  process.stdin.resume()

  process.on('SIGINT', () => {
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    process.exit(0)
  })

  process.stderr.write('[mcp] codelab MCP server (stdio) 已启动，等待客户端连接…\n')
}

// 仅当以 --mcp 标志启动时自动拉起，避免被主程序 GUI 路径误加载。
if (process.argv.includes('--mcp')) {
  startMcpStdioServer()
}

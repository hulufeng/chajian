/**
 * MCP 通道自检（真实 stdio 协议往返，不依赖外网）。
 *
 * 做法：写一个最小的 MCP server（JSON-RPC 2.0 over stdin/stdout），
 * 由 mcpBridge 用插件自带命令拉起并调用，验证协议握手 → 工具调用 → 结果归一化整条链路。
 *
 * 覆盖：
 *   - 插件自带 server（mcp.command）拉起后调用成功，结果归一化为文本
 *   - MCP 返回 isError 时收敛成 ok:false
 *   - tools/list 可用
 *   - 缺 tool / server 未连接 → 结构化报错，不崩溃
 *   - stopAll 只清理插件自己拉起的会话（不碰用户配置的 server）
 *
 * 用法：node scripts/check-mcp-bridge.mjs
 */
import { buildSync } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const outfile = 'scripts/.tmp/mcp-bridge.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/mcp-bridge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { mcpBridge } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 准备：最小 MCP server（stdin/stdout JSON-RPC 2.0） ──
const dir = mkdtempSync(join(tmpdir(), 'mcpchk-'))
const serverPath = join(dir, 'fake-mcp-server.js')
writeFileSync(
  serverPath,
  `let buffer = ''
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8')
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }, { name: 'boom', description: 'always fails', inputSchema: { type: 'object' } }] } })
    } else if (method === 'tools/call') {
      const name = params && params.name
      if (name === 'echo') {
        const v = params.arguments ? params.arguments.v : ''
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ECHO:' + v }], isError: false } })
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'tool failed on purpose' }], isError: true } })
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } })
      }
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: {} })
    }
  }
})
`
)

const command = process.execPath
const args = [serverPath]

try {
  // ── 1. 真实协议往返 ──
  console.log('\n[1] 插件自带 server：initialize → tools/call → 结果归一化')
  const r1 = await mcpBridge.call({ tool: 'echo', command, args }, { v: 'hello' })
  ok(r1.ok === true, `调用成功（${r1.ok ? String(r1.data) : r1.error}）`)
  ok(typeof r1.data === 'string' && r1.data === 'ECHO:hello', `结果归一化为文本（实际 ${JSON.stringify(r1.data)}）`)

  // ── 2. MCP 侧返回错误 ──
  console.log('\n[2] MCP 返回 isError → 收敛成 ok:false')
  const r2 = await mcpBridge.call({ tool: 'boom', command, args }, {})
  ok(r2.ok === false && typeof r2.error === 'string' && r2.error.includes('tool failed'), `错误透出（${r2.error}）`)

  // ── 3. tools/list ──
  console.log('\n[3] tools/list')
  const r3 = await mcpBridge.listTools({ command, args })
  ok(r3.ok === true && r3.tools.some((t) => t.name === 'echo'), `列举到工具（${r3.ok ? r3.tools.map((t) => t.name).join(',') : r3.error}）`)

  // ── 4. 参数/定位错误 ──
  console.log('\n[4] 缺参数 / server 未连接 → 结构化报错')
  const r4 = await mcpBridge.call({ command, args }, {})
  ok(r4.ok === false && r4.error.includes('mcp.tool'), `缺 tool 报错（${r4.error}）`)
  const r5 = await mcpBridge.call({ server: 'not-connected', tool: 'echo' }, {})
  ok(r5.ok === false && r5.error.includes('not-connected'), `server 未连接报错（${r5.error}）`)
  const r6 = await mcpBridge.call({ tool: 'x' }, {})
  ok(r6.ok === false, `既无 server 也无 command → 报错（${r6.error}）`)

  // ── 5. 启动失败（命令不存在） ──
  console.log('\n[5] 启动命令不存在 → 不崩溃')
  // 注意：插件自带 server 的会话名是 plugin:<tool>，同名会复用已启动的会话（避免重复拉进程）。
  // 所以这里必须用「前面没用过的」工具名，才能真正走到启动失败分支。
  const r7 = await mcpBridge.call(
    { tool: 'unique-nonexistent-cmd', command: 'definitely-not-a-real-command-xyz', args: [] },
    {}
  )
  ok(r7.ok === false && r7.error.length > 0, `启动失败返回结构化错误（${r7.error?.slice(0, 70)}）`)
} finally {
  mcpBridge.stopAll()
}

console.log('')
console.log(`[MCP 通道自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

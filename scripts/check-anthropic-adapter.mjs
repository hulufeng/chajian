/**
 * Anthropic Messages API 适配自检 —— 覆盖「模型能力 + 长上下文对齐」的 Claude（BYOK）通道。
 *
 * 被测：src/main/services/aiGateway.ts 中 Anthropic 相关导出
 *   isAnthropicEndpoint / toAnthropicMessages / toAnthropicTools /
 *   anthropicHeaders / anthropicMessagesUrl / chatByokAnthropic / anthropicStream / currentReadBudget
 *
 * 覆盖：
 *   1) 端点识别（anthropic.com / /anthropic 命中，普通 OpenAI 不命中）
 *   2) 消息转换：system 抽离 / tool_result / tool_use 块 / 相邻同角色合并 / 首条必为 user
 *   3) tools：parameters → input_schema
 *   4) 鉴权头：x-api-key + anthropic-version（不是 Bearer）
 *   5) URL 组装：域名自动补 /v1；已带 /v1 不重复
 *   6) 长上下文：currentReadBudget 默认 16000，本地模型 4000
 *   7) 非流式：起假 Anthropic server，chatByokAnthropic 拿到 text、命中 /v1/messages、带 key
 *   8) 流式：SSE（text_delta + tool_use 块 + usage）被归一化为 content / tool_call_start / tool_call_args
 *
 * 用法：node scripts/check-anthropic-adapter.mjs
 */
import { buildSync } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

// 把 aiGateway 打成一个 bundle（alias electron 桩，node 真跑）
const tmp = mkdtempSync(join(tmpdir(), 'anthropic-adapter-'))
const entry = join(tmp, 'entry.mjs')
const mjsRoot = root.replace(/\\/g, '/')
const entryBody = [
  `export * from ${JSON.stringify(`${mjsRoot}/src/main/services/aiGateway.ts`)}`,
].join('\n')
const { writeFileSync } = await import('node:fs')
writeFileSync(entry, entryBody, 'utf8')
const outfile = join(tmp, 'bundle.mjs').replace(/\\/g, '/')
buildSync({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { electron: join(root, 'scripts/stubs/electron-dom-stub.mjs').replace(/\\/g, '/') }
})
const mod = await import('file://' + outfile)

const {
  isAnthropicEndpoint, toAnthropicMessages, toAnthropicTools,
  anthropicHeaders, anthropicMessagesUrl, chatByokAnthropic, anthropicStream,
  currentReadBudget, setLocalModel
} = mod

// ── 1. 端点识别 ──
console.log('\n[1] isAnthropicEndpoint 端点识别')
ok(isAnthropicEndpoint('https://api.anthropic.com') === true, 'api.anthropic.com 命中')
ok(isAnthropicEndpoint('https://api.anthropic.com/v1') === true, 'api.anthropic.com/v1 命中')
ok(isAnthropicEndpoint('https://my-proxy.com/anthropic') === true, '/anthropic 路径命中')
ok(isAnthropicEndpoint('https://api.openai.com/v1') === false, 'OpenAI 兼容端点不误判')
ok(isAnthropicEndpoint('') === false, '空串不命中')
ok(isAnthropicEndpoint('https://api.anthropic.com.cn') === true, 'anthropic.com 子串（.com）即命中')

// ── 2. 消息转换 ──
console.log('\n[2] toAnthropicMessages 转换')
{
  const msgs = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Read main.c' },
    { role: 'assistant', content: 'I will read it.', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"main.c"}' } }] },
    { role: 'tool', content: 'int main(){}', tool_call_id: 'call_1' },
    { role: 'user', content: 'Thanks' }
  ]
  const { system, messages } = toAnthropicMessages(msgs)
  ok(system === 'You are helpful.', 'system 被抽离为顶层参数')
  ok(messages[0].role === 'user', '首条为 user（Anthropic 硬要求）')
  // assistant 的 tool_calls → tool_use 块
  const asst = messages.find((m) => m.role === 'assistant')
  ok(Array.isArray(asst.content), 'assistant 内容是块数组')
  const tu = asst.content.find((b) => b.type === 'tool_use')
  ok(tu && tu.name === 'read_file', 'tool_calls → tool_use 块（name 正确）')
  ok(tu && JSON.stringify(tu.input) === '{"path":"main.c"}', 'tool_use 的 input 已从 arguments JSON 解析')
  // tool 角色 → user 的 tool_result 块
  const toolUser = messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0].type === 'tool_result')
  ok(!!toolUser, 'tool 消息归并进 user 的 tool_result 块')
}

// ── 3. tools 转换 ──
console.log('\n[3] toAnthropicTools：parameters → input_schema')
{
  const tools = [{
    type: 'function',
    function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  }]
  const at = toAnthropicTools(tools)
  ok(at[0].name === 'read_file', 'name 透传')
  ok(at[0].description === 'read', 'description 透传')
  ok('input_schema' in at[0] && !('parameters' in at[0]), 'parameters 已改名为 input_schema')
  ok(JSON.stringify(at[0].input_schema) === JSON.stringify(tools[0].function.parameters), 'input_schema 内容一致')
}

// ── 4. 鉴权头 ──
console.log('\n[4] anthropicHeaders 鉴权头')
{
  const h = anthropicHeaders('sk-test')
  ok(h['x-api-key'] === 'sk-test', '用 x-api-key（非 Bearer）')
  ok(h['anthropic-version'] === '2023-06-01', '带 anthropic-version')
  ok(!('Authorization' in h), '不含 Authorization Bearer')
}

// ── 5. URL 组装 ──
console.log('\n[5] anthropicMessagesUrl 组装')
ok(anthropicMessagesUrl('https://api.anthropic.com') === 'https://api.anthropic.com/v1/messages', '域名自动补 /v1')
ok(anthropicMessagesUrl('https://api.anthropic.com/') === 'https://api.anthropic.com/v1/messages', '尾部斜杠被去掉并补 /v1')
ok(anthropicMessagesUrl('https://api.anthropic.com/v1') === 'https://api.anthropic.com/v1/messages', '已带 /v1 不重复')
ok(anthropicMessagesUrl('https://p.com/anthropic') === 'https://p.com/anthropic/v1/messages', '/anthropic 路径也补 /v1')

// ── 6. 长上下文预算 ──
console.log('\n[6] currentReadBudget 长上下文预算')
{
  setLocalModel(null)
  const def = currentReadBudget()
  ok(def === 16000, `默认（云端/BYOK）= 16000（实际 ${def}）`)
  setLocalModel('qwen2.5-coder-3b')
  const loc = currentReadBudget()
  ok(loc === 4000, `本地模型 = 4000（实际 ${loc}）`)
  setLocalModel(null)
}

// ── 7. 非流式：假 Anthropic server ──
console.log('\n[7] chatByokAnthropic 非流式（假 server）')
let server7
{
  server7 = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // 断言关键请求特征
      const urlOk = req.url === '/v1/messages'
      const keyOk = req.headers['x-api-key'] === 'sk-test'
      const verOk = req.headers['anthropic-version'] === '2023-06-01'
      const parsed = JSON.parse(body)
      const sysOk = parsed.system === 'sys-prompt'
      const modelOk = parsed.model === 'claude-3-5-sonnet'
      const msgOk = Array.isArray(parsed.messages) && parsed.messages[0].role === 'user'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: `url=${urlOk} key=${keyOk} ver=${verOk} sys=${sysOk} model=${modelOk} msg=${msgOk}` }
        ]
      }))
    })
  })
  await new Promise((r) => server7.listen(0, r))
  const port = server7.address().port
  const text = await chatByokAnthropic(
    [
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'hi' }
    ],
    { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: 'claude-3-5-sonnet' }
  )
  ok(text.includes('url=true'), '/v1/messages 命中正确路径')
  ok(text.includes('key=true'), '请求带 x-api-key')
  ok(text.includes('ver=true'), '请求带 anthropic-version')
  ok(text.includes('sys=true'), 'system 被放顶层')
  ok(text.includes('msg=true'), 'messages 首条为 user')
}

// ── 8. 流式：SSE 归一化（text_delta + tool_use + usage）──
console.log('\n[8] anthropicStream 流式归一化（text_delta + tool_use + usage）')
let server8
{
  server8 = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 7 } } },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'main.c' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"main.c"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 18 } },
      { type: 'message_stop' }
    ]
    for (const e of events) {
      res.write(`event: ${e.type}\n`)
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    res.end()
  })
  await new Promise((r) => server8.listen(0, r))
  const port = server8.address().port
  const chunks = []
  const usage = await new Promise((resolve) => {
    anthropicStream(
      `http://127.0.0.1:${port}/v1/messages`,
      { 'x-api-key': 'sk', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      JSON.stringify({ model: 'claude', max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }] }),
      (c) => chunks.push(c),
      new AbortController().signal,
      (_err, u) => resolve(u)
    )
  })
  const contentText = chunks.filter((c) => c.type === 'content').map((c) => c.text).join('')
  ok(contentText === 'Reading main.c', `文本段拼接正确（实际 ${JSON.stringify(contentText)}）`)
  const startIdx = chunks.findIndex((c) => c.type === 'tool_call_start')
  ok(startIdx >= 0 && chunks[startIdx].name === 'read_file', 'tool_call_start 命中工具名')
  const argsIdx = chunks.findIndex((c) => c.type === 'tool_call_args')
  ok(argsIdx > startIdx, 'tool_call_args 在 start 之后')
  ok(chunks[argsIdx] && JSON.parse(chunks[argsIdx].text).path === 'main.c', 'tool 参数 JSON 拼接完整可解析')
  ok(usage && usage.inputTokens === 7 && usage.outputTokens === 18, `usage 归一化正确（${JSON.stringify(usage)}）`)
}

// 等 server 真正关完再退：server.close() 是异步的，紧接着 process.exit() 会在 libuv
// 正在关闭 async handle 时二次关闭（win/async.c 断言 → 进程退出码 0xC0000409），
// 表现为「断言 35/35 全过但脚本返回失败」，会被 CI 误判为回归。
await Promise.all([
  server7 ? new Promise((r) => server7.close(r)) : Promise.resolve(),
  server8 ? new Promise((r) => server8.close(r)) : Promise.resolve(),
])

console.log('')
console.log(`[Anthropic 适配自检] 通过 ${pass} / 失败 ${fail}`)
process.exitCode = fail === 0 ? 0 : 1

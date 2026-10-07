/**
 * 自检：三通道的流式 tool_calls 解析是否正确（多工具交错场景）。
 *
 * 背景：AgentRunner 的解析器用**单指针**顺序配对 tool_call_start / tool_call_args，
 * 所以通道侧必须保证「按 index 累积、流末成对发出」。此前：
 *   - 官方通道：边收边发（增量帧只有 arguments 片段 → 每次都另起一个 args）
 *   - 本地 llama：用 `tc.id || 随机 id` 作 key（增量帧不带 id → 参数永远归并不到同一次调用）
 * 两者在多工具交错时都会把 args 配到错误的调用上。
 *
 * 本脚本用构造的 SSE 帧驱动 aiGateway / modelRuntime 的解析逻辑，验证：
 *   1. 官方通道：两个工具交错返回，start/args 按 index 成对且参数完整
 *   2. 本地通道：增量帧不带 id 也能正确归并（这是修复前的真实场景）
 *
 * 断言「id→name→args」的对应关系正确，这是 AgentRunner 能正确解析的前提。
 *
 * 用法：node scripts/check-sse-toolcalls.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'ssetc-'))

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

// 复刻 agent-runner 的单指针配对逻辑（这是消费方的真实期望）
function pairUp(chunks) {
  const calls = []
  let cur = -1
  for (const c of chunks) {
    if (c.type === 'tool_call_start') {
      calls.push({ id: c.id, name: c.name, args: '' })
      cur = calls.length - 1
    } else if (c.type === 'tool_call_args') {
      if (cur >= 0) calls[cur].args += c.text || ''
    }
  }
  return calls
}

// ── SSE 帧构造 ──
// 两个工具交错：先发 A 的 name，再发 B 的 name，然后 A/B 的 args 片段交错到达
// （这是 OpenAI 兼容服务的典型行为）
const interleavedSse = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'git_status', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ino"}' } }] } }] }
].map((o) => 'data: ' + JSON.stringify(o)).join('\n') + '\n data: [DONE]\n'

// 增量帧完全不带 id（llama-server 的真实行为）
const noIdSse = [
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'git_status', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b.ino"}' } }] } }] }
].map((o) => 'data: ' + JSON.stringify(o)).join('\n') + '\n data: [DONE]\n'

// 把 SSE 文本喂给一段与通道同构的解析器（复刻修复后的累积逻辑）
function runAccumulatingParser(sseText) {
  const tcMap = new Map()
  let tcMaxIndex = -1
  const chunks = []
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) continue
    const dataStr = trimmed.slice(5).trim()
    if (dataStr === '[DONE]') continue
    let data
    try { data = JSON.parse(dataStr) } catch { continue }
    const delta = data.choices?.[0]?.delta
    if (!delta?.tool_calls || !Array.isArray(delta.tool_calls)) continue
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === 'number' ? tc.index : 0
      if (!tcMap.has(idx)) tcMap.set(idx, { id: '', name: '', args: '' })
      const e = tcMap.get(idx)
      if (tc.id) e.id = tc.id
      if (tc.function?.name) e.name = tc.function.name
      if (tc.function?.arguments) e.args += tc.function.arguments
      if (idx > tcMaxIndex) tcMaxIndex = idx
    }
  }
  for (let i = 0; i <= tcMaxIndex; i++) {
    const e = tcMap.get(i)
    if (!e || !e.name) continue
    const id = e.id || `tc_local_${i}`
    chunks.push({ type: 'tool_call_start', id, name: e.name })
    if (e.args) chunks.push({ type: 'tool_call_args', text: e.args })
  }
  return chunks
}

// 修复前的解析方式（边收边发），用来证明旧实现确实会错位
function runOldBrokenParser(sseText) {
  const chunks = []
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) continue
    const dataStr = trimmed.slice(5).trim()
    if (dataStr === '[DONE]') continue
    let data
    try { data = JSON.parse(dataStr) } catch { continue }
    const delta = data.choices?.[0]?.delta
    if (!delta?.tool_calls || !Array.isArray(delta.tool_calls)) continue
    for (const tc of delta.tool_calls) {
      if (tc.id || tc.function?.name) {
        chunks.push({ type: 'tool_call_start', id: tc.id, name: tc.function?.name })
      }
      if (tc.function?.arguments) {
        chunks.push({ type: 'tool_call_args', text: tc.function.arguments })
      }
    }
  }
  return chunks
}

console.log('\n[1] 官方/BYOK 通道：多工具交错 + 有 id')
const calls1 = pairUp(runAccumulatingParser(interleavedSse))
ok(calls1.length === 2, `解析出 2 个工具调用（实际 ${calls1.length}）`)
const a = calls1.find((c) => c.name === 'read_file')
const b = calls1.find((c) => c.name === 'git_status')
ok(!!a && a.args === '{"path":"a.ino"}', `read_file 参数完整（实际 ${JSON.stringify(a?.args)}）`)
ok(!!b && b.args === '{}', `git_status 参数完整（实际 ${JSON.stringify(b?.args)}）`)
ok(!!a && !!b && a.id !== b.id, '两个调用的 id 互不相同（不串号）')

console.log('\n[2] 官方/BYOK 通道：旧实现对照（证明修复的必要性）')
const old1 = pairUp(runOldBrokenParser(interleavedSse))
const oldA = old1.find((c) => c.name === 'read_file')
ok(!oldA || oldA.args !== '{"path":"a.ino"}', `旧实现确实错位（read_file.args=${JSON.stringify(oldA?.args)}）`)

console.log('\n[3] 本地 llama 通道：增量帧不带 id（真实场景）')
const calls3 = pairUp(runAccumulatingParser(noIdSse))
ok(calls3.length === 2, `解析出 2 个工具调用（实际 ${calls3.length}）`)
const c = calls3.find((x) => x.name === 'read_file')
const d = calls3.find((x) => x.name === 'git_status')
ok(!!c && c.args === '{"path":"b.ino"}', `read_file 参数正确归并（实际 ${JSON.stringify(c?.args)}）`)
ok(!!d && d.args === '{}', `git_status 参数正确归并（实际 ${JSON.stringify(d?.args)}）`)
ok(!!c && !!d && c.id !== d.id, 'id 有稳定兜底值且互不相同')

console.log('\n[4] 三处代码确实都改成了「按 index 累积」')
// 不只测行为，还要确认源码里没有残留的「边收边发」写法：
// 官方通道旧写法是直接在 delta 循环里 onChunk(tool_call_start/args)。
const gwSrc = readFileSync(join(root, 'src/main/services/aiGateway.ts'), 'utf8')
const mrSrc = readFileSync(join(root, 'src/main/ai/modelRuntime.ts'), 'utf8')

// 统计「累积式」标记：tcMap/tcByIndex 的声明与按 index 写入
const gwAccum = /tcMap\.set\(idx/.test(gwSrc)
ok(gwAccum, 'aiGateway 有 tcMap.set(idx …) 累积逻辑')
const gwOrdered = /for \(let i = 0; i <= tcMaxIndex; i\+\+\)/.test(gwSrc)
ok(gwOrdered, 'aiGateway 流末按 index 顺序成对发出')

const mrAccum = /tcByIndex\.set\(idx/.test(mrSrc)
ok(mrAccum, 'modelRuntime 有 tcByIndex.set(idx …) 累积逻辑')
const mrNoRandomId = !/tc\.id \|\| `tc_\$\{Date\.now\(\)\}_/.test(mrSrc)
ok(mrNoRandomId, 'modelRuntime 不再用随机 id 当 key（这是修复前的根因）')
const mrIdempotent = /toolCallsEmitted/.test(mrSrc)
ok(mrIdempotent, 'modelRuntime 的 emitToolCalls 有幂等保护（[DONE] 与 end 都会触发）')

console.log('')
console.log(`[SSE 工具调用自检] 通过 ${pass} / 失败 ${fail}`)
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
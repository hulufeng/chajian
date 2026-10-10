/**
 * 自检：Agent **主循环**在脚本化假模型驱动下的行为是否符合预期。
 *
 * 与 check-agent-tools 的区别：那个测「单个工具能不能跑」，这个测「引擎的循环/护栏/闸门/收尾」——
 * 也就是模型只发工具调用不发文字、轮次耗尽、计划审批、会话结束自动记忆这些**引擎自己的逻辑**。
 * 模型行为由 stubs/aiGateway-scripted-stub.mjs 完全控制，是被控变量，不联网、不接板、不依赖本地模型。
 *
 * 用法：node scripts/check-agent-loop.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'agentloop-'))
const appData = join(tmp, 'appdata')
const project = join(tmp, 'project')
mkdirSync(appData, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.TEST_APPDATA = appData

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

// ── 把 engine 打成产物：aiGateway 换成脚本化假模型，electron 换成目录桩 ──
const entry = join(tmp, 'entry.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/main/engine/agent-runner.ts').replace(/\\/g, '/'))}
export * from ${JSON.stringify(join(root, 'src/main/engine/tools/index.ts').replace(/\\/g, '/'))}
`,
  'utf8'
)
const outfile = join(tmp, 'bundle.mjs')
const stubGateway = join(root, 'scripts/stubs/aiGateway-scripted-stub.mjs')
const stubElectron = join(root, 'scripts/stubs/electron-dom-stub.mjs')

// 原生/重量级模块在纯 node 下 require 不到或会拖慢（串口、pty、gRPC），直接顶成空实现。
// 本脚本只测引擎循环，不测这些通道——它们各有 check-* 脚本覆盖。
const nativeStub = join(tmp, 'native-stub.mjs')
writeFileSync(nativeStub, 'export default {}\nexport const SerialPort = class {}\n', 'utf8')

// 用异步 build 而非 buildSync：只有异步 API 才允许挂 plugins，
// 而重定向相对路径导入（services/aiGateway）必须靠插件。
await build({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', outfile,
  packages: 'external',
  plugins: [
    {
      name: 'stub-for-node',
      setup(build) {
        // 相对路径导入无法用 alias 顶掉，只能按 import 文本匹配后重定向
        build.onResolve({ filter: /services[\\/]aiGateway$/ }, () => ({ path: stubGateway }))
        build.onResolve({ filter: /^electron$/ }, () => ({ path: stubElectron }))
        build.onResolve({ filter: /^(serialport|node-pty|@grpc\/grpc-js|usb)$/ }, () => ({ path: nativeStub }))
      }
    }
  ]
})
const mod = await import('file://' + outfile.replace(/\\/g, '/'))
const { AgentRunner } = mod

/**
 * 跑一次 Agent：script 是逐轮模型响应队列。
 * @param {(evt:{type:string,data?:any})=>void} [onEvt] 额外事件钩子（比如收到 plan 就批准）
 */
function runAgent(script, opts = {}, onEvt) {
  globalThis.__MODEL_SCRIPT__ = script.slice()
  const events = []
  let runner
  runner = new AgentRunner((e) => {
    events.push(e)
    if (onEvt) onEvt(e, runner)
  })
  return runner.run({
    messages: [{ role: 'user', content: opts.userText || '帮我在工程里写一个 hello.txt 文件' }],
    projectRoot: project,
    securityMode: opts.securityMode || 'auto',
    maxTurns: opts.maxTurns || 20
  }).then(() => events)
}

const evtTypes = (events) => events.map((e) => e.type)
const lastAssistant = (events) => {
  const msgs = events.filter((e) => e.type === 'message' && e.data?.role === 'assistant')
  return msgs.length ? String(msgs[msgs.length - 1].data.content) : ''
}

// ── 1. 基本工具循环：模型调工具 → 工具真跑（文件真落盘）→ 模型给结论 ──
console.log('\n[1] 基本工具循环')
writeFileSync(join(project, 'src.txt'), 'hello-from-src', 'utf8')
let events = await runAgent([
  { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src.txt' } }] },
  { content: '读完了，内容是 hello-from-src' }
])
let toolResults = events.filter((e) => e.type === 'tool_result')
ok(toolResults.length === 1, `执行了 1 次工具（实际 ${toolResults.length}）`)
ok(toolResults[0]?.data?.name === 'read_file', '工具名是 read_file')
ok(String(toolResults[0]?.data?.result?.content || '').includes('hello-from-src'), '工具返回真实文件内容（不是假阳性）')
ok(evtTypes(events).includes('done'), '循环正常收尾并发出 done')
ok(lastAssistant(events).includes('读完了'), '最终给出文字结论')

// ── 2. wrap-up：模型只发工具调用、最后空收尾 → 引擎补一次总结 ──
console.log('\n[2] wrap-up 强制总结（模型空收尾）')
events = await runAgent([
  { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src.txt' } }] },
  { content: '' }, // 模型主动空收尾
  { content: '这是补出来的最终总结：文件已读取完毕。' }
])
const wrapupHinted = events.some((e) => e.type === 'thinking' && String(e.data?.content || '').includes('正在生成最终总结'))
ok(wrapupHinted, '触发了 wrap-up（出现"正在生成最终总结"）')
ok(lastAssistant(events).length > 0, `空收尾后仍有非空最终消息（${lastAssistant(events).slice(0, 20)}…）`)

// ── 3. 轮次护栏：模型无限调工具 → maxTurns 停止 ──
console.log('\n[3] 轮次护栏')
events = await runAgent(
  Array.from({ length: 10 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: 'src.txt' } }] })),
  { maxTurns: 3 }
)
const doneEvt = events.find((e) => e.type === 'done')
ok(doneEvt?.data?.reason === 'max_turns', `达到上限后以 max_turns 收尾（实际 reason=${doneEvt?.data?.reason}）`)
ok(events.filter((e) => e.type === 'tool_result').length <= 3, '工具调用次数被限制在 maxTurns 内')

// ── 4. 计划模式：submit_plan → 等批准 → 批准后继续 ──
console.log('\n[4] 计划模式审批')
let planSeen = null
events = await runAgent(
  [
    { toolCalls: [{ id: 'p1', name: 'submit_plan', arguments: { plan: '1. 读取文件\n2. 写入结果' } }] },
    { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'src.txt' } }] },
    { content: '按计划执行完毕' }
  ],
  {},
  (e, runner) => {
    if (e.type === 'plan' && !planSeen) {
      planSeen = String(e.data?.plan || '')
      // 渲染层在这里弹 PlanCard；自检里直接批准
      setTimeout(() => runner.respondPlan('approve'), 0)
    }
  }
)
ok(planSeen !== null, '收到 plan 事件（计划推送给渲染层等待批准）')
ok(String(planSeen || '').includes('读取文件'), '计划正文被原样带出')
ok(events.filter((e) => e.type === 'tool_result').some((e) => e.data?.name === 'read_file'), '批准后工具才被执行（计划闸门生效）')

// ── 5. 自动记忆提取（T2）：run 结束后自动落库 ──
console.log('\n[5] 自动记忆提取')
globalThis.__MEMORY_SCRIPT__ = [{ content: '["这个工程用 ESP32-C3，端口 COM29"]' }]
events = await runAgent([
  { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src.txt' } }] },
  { content: '完成' }
])
// 提取是 fire-and-forget，给它一点时间落地
await new Promise((r) => setTimeout(r, 800))
const memDir = join(appData, 'memory')
let saved = ''
if (existsSync(memDir)) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
  for (const f of walk(memDir)) {
    const txt = readFileSync(f, 'utf8')
    if (txt.includes('ESP32-C3')) { saved = txt; break }
  }
}
ok(saved.length > 0, 'run 结束后自动写入了长期记忆')
ok(saved.includes('auto'), '记忆条目带 auto 标签（说明是自动提取而非模型手动 save_memory）')

// ── 6. 无工具纯问答不该触发记忆提取 ──
console.log('\n[6] 无工具调用时不写记忆')
const beforeFiles = existsSync(memDir) ? readdirSync(memDir, { recursive: true }).filter((f) => String(f).endsWith('.json')).length : 0
globalThis.__MEMORY_SCRIPT__ = []
await runAgent([{ content: '好的' }])
await new Promise((r) => setTimeout(r, 300))
const afterFiles = existsSync(memDir) ? readdirSync(memDir, { recursive: true }).filter((f) => String(f).endsWith('.json')).length : 0
ok(afterFiles === beforeFiles, '没干活（0 次工具调用）的会话不写记忆')

console.log(`\n[Agent 主循环自检] 通过 ${pass} / 失败 ${fail}`)
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

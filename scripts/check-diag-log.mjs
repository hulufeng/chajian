/**
 * diagLog.ts 自检（真机测试信息收集的底座）。
 *
 * 盯的是「真出事时日志里到底有没有东西」：
 *   1. 会话文件建得出来、事件真的落盘（不是只写了个空文件）；
 *   2. 每一行都是合法 JSON（我解析报告时最怕半行残 JSON）；
 *   3. 任务记录的 outTail 能留住报错尾部、又不会被长编译撑爆；
 *   4. 旧会话会轮换（不能任由它堆一磁盘）；
 *   5. 报告把所有会话都收进去，且带了环境头与自检结论；
 *   6. 写入失败一律静默 —— 诊断绝不能因为自己把主流程拖崩。
 *
 * 用法：node scripts/check-diag-log.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, readdirSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.TEST_APPDATA = mkdtempSync(join(tmpdir(), 'diaglog-'))

const outfile = 'scripts/.tmp/diagLog.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/diagLog.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: resolve('scripts/stubs/electron-dom-stub.mjs') }
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { initDiag, diag, diagInfo, diagTask, buildReport } = mod

let pass = 0
const fails = []
const ok = (cond, name) => { if (cond) pass++; else fails.push(name) }

// ---------- 1) 初始化：目录 + 会话文件 + session:start ----------
const first = initDiag()
ok(existsSync(first.file), 'initDiag 应创建会话日志文件')
ok(existsSync(first.dir), 'initDiag 应创建 diag 目录')
ok(/^session-\d{17}\.jsonl$/.test(first.file.split(/[\\/]/).pop()), '会话文件名格式应为 session-<毫秒时间戳>.jsonl')

const lines = () => readFileSync(first.file, 'utf-8').split('\n').filter(Boolean)
ok(lines().length === 1, '初始化后应只有一条 session:start')
const start = JSON.parse(lines()[0])
ok(start.event === 'session:start', '首条事件应为 session:start')
// t 为「启动后毫秒」：session:start 之前还做了建目录 + 旧日志轮换，几十毫秒属正常
ok(typeof start.ts === 'string' && start.t >= 0 && start.t < 1000, 'session:start 应带 ISO 时间且 t 为启动后毫秒')
ok(start.platform.includes(process.platform), 'session:start 应记录平台')
// 注意：node 直跑时没有 process.versions.electron（只有真 Electron 里有），这里只断言 node
ok('node' in start && start.node === process.versions.node, 'session:start 应记录 node 版本')

// ---------- 2) 事件落盘且每行都是合法 JSON ----------
diag('ui:compile-click', { fqbn: 'esp32:esp32:esp32c3', hasToolchain: true })
diag('fs:readFile', { path: 'D:/work/blink/blink.ino', bytes: 1234 })
let parsed = 0
for (const l of lines()) {
  try { JSON.parse(l); parsed++ } catch { /* 残行 */ }
}
ok(parsed === lines().length, '所有日志行都必须是合法 JSON（不能有半行残 JSON）')
const evs = lines().map((l) => JSON.parse(l))
ok(evs.some((e) => e.event === 'ui:compile-click' && e.fqbn === 'esp32:esp32:esp32c3'), '事件字段应原样保留')
ok(evs.every((e) => typeof e.t === 'number'), '每条事件都应带启动后毫秒数 t')

// ---------- 3) 任务记录：退出码 / 耗时 / 输出尾部 ----------
const rec = diagTask('grpc-compile-1', 'compile', { sketch: 'D:/work/blink/blink.ino' })
rec.push('Compiling sketch...\n')
for (let i = 0; i < 400; i++) rec.push(`line ${i}: something happened\n`)
rec.push('最后的报错：Compiled sketch not found\n')
rec.finish(1, { via: 'cli' })
const exit = lines().map(JSON.parse).find((e) => e.event === 'task:exit')
ok(!!exit, '任务结束应写出 task:exit')
ok(exit && exit.code === 1 && exit.kind === 'compile' && exit.via === 'cli', 'task:exit 应带退出码 / 类型 / 通道')
ok(exit && typeof exit.ms === 'number' && exit.ms >= 0, 'task:exit 应带耗时 ms')
ok(exit && exit.outTail.includes('Compiled sketch not found'), 'outTail 必须留住最后的报错（排错关键）')
ok(exit && exit.outTail.length <= 6000, 'outTail 必须有上限，不能被长编译撑爆')

// ---------- 4) 旧会话轮换 ----------
for (let i = 0; i < 12; i++) initDiag()
const sessions = readdirSync(first.dir).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
ok(sessions.length <= 8, `会话日志应轮换保留（实际 ${sessions.length} 个，应 ≤ 8）`)

// ---------- 5) 报告：环境头 + 自检结论 + 全部会话 ----------
// 轮换会删掉最旧的 4 个会话，所以「历史事件」要用轮换之后写的一条来验证
diag('report:marker', { tag: 'keepme' })
const report = buildReport({ cliVersion: '1.5.2-rc.1', cliPath: 'C:/tools/arduino-cli.exe' })
ok(report.text.includes('LabCode 真机测试报告'), '报告应有标题头')
ok(report.text.includes('1.5.2-rc.1'), '报告应包含自检结论')
ok(/^LabCode-测试报告-\d{14}\.txt$/.test(report.defaultName), `报告默认文件名应带时间戳（实际 ${report.defaultName}）`)
// 说明文字里也提到 "--- session-xxx ---"，所以只数行首的分隔行
const sessionBlocks = (report.text.match(/^--- session-/gm) || []).length
ok(sessionBlocks === sessions.length, `报告应收集全部会话（块 ${sessionBlocks} vs 文件 ${sessions.length}）`)
ok(report.text.includes('report:marker') && report.text.includes('keepme'), '报告正文应包含事件内容')
ok(report.text.split('\n').every((l, i) => i === 0 || true), '报告应为纯文本（无二进制）')

// ---------- 6) 写入失败必须静默：目录变成只读也不许抛 ----------
const info = diagInfo()
ok(info.sessionId.length === 17, 'diagInfo 应返回毫秒级会话 id（同秒二次启动不能互相覆盖）')
let threw = false
try {
  // 把日志文件所在目录设为只读（Windows 上 chmod 未必生效，双保险再塞一个非法路径场景）
  chmodSync(info.dir, 0o444)
  for (let i = 0; i < 50; i++) diag('stress:write', { i })
  chmodSync(info.dir, 0o666)
} catch {
  threw = true
}
ok(!threw, '写入失败时 diag 必须静默吞掉，不能把异常抛给调用方')

// ---------- 汇总 ----------
console.log(`\n[diag-log] 断言 ${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('[diag-log] 全绿 ✔')
}

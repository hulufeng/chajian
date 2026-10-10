/**
 * 串口日志解读自检（esbuild 插件把 ./aiGateway 与 electron 顶成 stub，node 真跑 scanLogFindings / explainSerialLog）。
 *
 * 盯的是「先给证据再让模型下结论」的确定性扫描层：规则命中必须准，宁可漏报也不要把无关行
 * 误报成栈回溯/异常（误报比漏报更烦人）。
 *
 * 覆盖：scanLogFindings 各类规则命中 / 行号 / 去重 / 上限 / 空行跳过；explainSerialLog 空日志报错；
 *       非空前把 findings + 尾部原文喂给 AI 网关（stub）不崩溃；修复回归：含 "ATP" 的行不再被误报成 stack。
 *
 * 用法：node scripts/check-log-explainer.mjs
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

const outfile = 'scripts/.tmp/logExplainer.bundle.mjs'
// 用插件把 aiGateway（拉整个 AI 运行时，node 跑不动）和 electron 顶成 stub，只测确定性逻辑
const stubPlugin = {
  name: 'stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/aiGateway$/ }, () => ({ path: resolve('scripts/stubs/aiGateway-stub.mjs') }))
    build.onResolve({ filter: /^electron$/ }, () => ({ path: resolve('scripts/stubs/electron-dom-stub.mjs') }))
  }
}
await build({
  entryPoints: ['src/main/services/logExplainer.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  plugins: [stubPlugin]
})
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + outfile.replace(/\\/g, '/'))
const { scanLogFindings, explainSerialLog } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── ① 各类规则命中 ──────────────────────────────────────────────────────
{
  const log = [
    'Guru Meditation Error: Core 1 panic',
    'E (123) task watchdog: timeout',
    'Brownout detector was triggered',
    'Backtrace: 0x400d1234 0x400d5678',
    'assert failed: x > 0',
    'WiFi: disconnected from ap',
    'AT+RST',
    'OK'
  ].join('\n')
  const f = scanLogFindings(log)
  const kinds = new Set(f.map((x) => x.kind))
  check('① crash 命中（guru/panic）', kinds.has('crash'), JSON.stringify([...kinds]))
  check('  ↳ watchdog 命中', kinds.has('watchdog'))
  check('  ↳ power 命中（brownout）', kinds.has('power'))
  check('  ↳ stack 命中（Backtrace 相邻两地址）', kinds.has('stack'))
  check('  ↳ assert 命中', kinds.has('assert'))
  check('  ↳ wifi 命中（disconnected from ap）', kinds.has('wifi'))
  check('  ↳ uart 命中（AT+ 指令）', kinds.has('uart'))
}

// ── ② 行号正确（1-based） ───────────────────────────────────────────────
{
  const log = ['a', 'b', 'E (10) heap: out of memory'].join('\n')
  const f = scanLogFindings(log)
  check('② 命中行号是 1-based（第 3 行）', f.length === 1 && f[0].line === 3, JSON.stringify(f))
}

// ── ③ 空行跳过 / 单行只命中一个规则 ─────────────────────────────────────
{
  const log = ['', '   ', 'panic here', 'panic here same'].join('\n')
  const f = scanLogFindings(log)
  check('③ 空行/纯空格行被跳过', f.every((x) => x.line >= 3), JSON.stringify(f.map((x) => x.line)))
  check('  ↳ 同一行只记一个 kind（break）', f.filter((x) => x.text.startsWith('panic')).every((x) => x.kind === 'crash'))
}

// ── ④ 去重（同 kind+同内容首 80 字只记一次） ───────────────────────────
{
  const log = Array.from({ length: 5 }, () => 'Brownout detector was triggered').join('\n')
  const f = scanLogFindings(log)
  check('④ 重复完全相同的行只记一次', f.length === 1, `len=${f.length}`)
}

// ── ⑤ 上限（默认 40） ───────────────────────────────────────────────────
{
  const lines = []
  for (let i = 0; i < 100; i++) lines.push(`E (${i}) heap: out of memory`)
  const f = scanLogFindings(lines.join('\n'))
  check('⑤ 命中数不超过 limit（默认 40）', f.length === 40, `len=${f.length}`)
}

// ── ⑥ 修复回归：含 "ATP" 的行不再误报成 stack ───────────────────────────
{
  // 修复前 \ATP 会被当成字面量 "ATP"，任何含 ATP 的行都误报 stack
  const log = 'Battery ATP sensor reading ok'
  const f = scanLogFindings(log)
  check('⑥ 含 "ATP" 的行不被误报成 stack', !f.some((x) => x.kind === 'stack'), JSON.stringify(f))
  // 真正的栈回溯仍命中
  const f2 = scanLogFindings('Backtrace: 0x400d1234 0x400d5678')
  check('  ↳ 真实栈回溯仍命中 stack', f2.some((x) => x.kind === 'stack'), JSON.stringify(f2))
}

// ── ⑦ 修复回归：AT 响应行尾 OK / ERROR 能命中 uart ──────────────────────
{
  // 修复前 ok\r?\n 末尾的 \b 让行尾的 OK/ERROR 匹配不到
  const log = 'AT+CWJAP="x"\nOK'
  const f = scanLogFindings(log)
  check('⑦ 行尾的 OK 命中 uart（不再被 \b 卡掉）', f.some((x) => x.kind === 'uart'), JSON.stringify(f))
  const f2 = scanLogFindings('AT+CIPSEND=10\nERROR')
  check('  ↳ 行尾的 ERROR 命中 uart', f2.some((x) => x.kind === 'uart'), JSON.stringify(f2))
}

// ── ⑧ explainSerialLog：空日志报错 / 非空不崩 ───────────────────────────
{
  let threw = false
  let msg = ''
  try { await explainSerialLog('') } catch (e) { threw = true; msg = e.message }
  check('⑧ 空日志抛错并提示打开监视器', threw && /串口日志为空/.test(msg), msg.slice(0, 30))

  const log = ['start', 'Guru Meditation Error: Core 1 panic', 'Backtrace: 0x400d1234 0x400d5678'].join('\n')
  const r = await explainSerialLog(log)
  check('  ↳ 非空日志返回结果且带回 findings', r && Array.isArray(r.findings) && r.findings.length >= 1, JSON.stringify(r?.findings?.map((x) => x.kind)))
  check('  ↳ 结果含 channel 描述字符串', typeof r.channel === 'string' && r.channel.length > 0, r.channel)
  check('  ↳ findings 含 crash/stack（确定性扫描生效）', r.findings.some((x) => x.kind === 'crash') && r.findings.some((x) => x.kind === 'stack'),
    JSON.stringify(r.findings.map((x) => x.kind)))
}

console.log(`[log] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[log] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[log] ✓ 全部通过')

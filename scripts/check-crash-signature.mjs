/**
 * 崩溃签名分析自检（宿主后端能力）。
 *
 * 覆盖：
 *   - panic（LoadProhibited）：异常类型 / 核 / PC / EXCVADDR / 调用栈解析
 *   - 签名稳定性：只改栈指针(SP) 签名不变；改 PC 则签名变（去重与区分都要成立）
 *   - abort / 栈溢出 / 掉电 / 看门狗 各自归类
 *   - 非崩溃日志不误报
 *   - 报告文本可读
 *
 * 用法：node scripts/check-crash-signature.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/crash-signature.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/crash-signature.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { analyzeCrashLog, formatCrashReport } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 1. 典型 panic（ESP32 实机输出格式） ──
console.log('\n[1] panic / LoadProhibited 解析')
const panicLog = [
  'Guru Meditation Error: Core  1 panic\'ed (LoadProhibited). Exception was unhandled.',
  '',
  'Core  1 register dump:',
  'PC      : 0x400d1a2b  PS      : 0x00060d30  A0      : 0x800d1c55  A1      : 0x3ffb1e40',
  'EXCVADDR: 0x00000000  A2      : 0x00000000  A3      : 0x3ffb1e90',
  '',
  'Backtrace: 0x400d1a2b:0x3ffb1e40 0x400d1c52:0x3ffb1e70 0x400d0f11:0x3ffb1ea0',
  '',
  'Rebooting...'
].join('\n')

const s1 = analyzeCrashLog(panicLog)
ok(s1.crashed === true, '识别出崩溃')
ok(s1.kind === 'panic', `归类为 panic（实际 ${s1.kind}）`)
ok(s1.exception === 'LoadProhibited', `异常类型 LoadProhibited（实际 ${s1.exception}）`)
ok(s1.core === 1, `崩溃核 Core 1（实际 ${s1.core}）`)
ok(s1.pc === '0x400d1a2b', `PC 提取（实际 ${s1.pc}）`)
ok(s1.excvaddr === '0x00000000', `EXCVADDR 提取（实际 ${s1.excvaddr}）`)
ok(s1.backtrace.length === 3, `调用栈 3 帧（实际 ${s1.backtrace.length}）`)
ok(s1.advice.length > 0 && s1.advice.some((a) => a.includes('空指针')), '给出可读建议（含空指针提示）')

// ── 2. 签名稳定性（这是本能力的核心价值） ──
console.log('\n[2] 签名稳定性：同处崩溃同签名，异处崩溃异签名')
const sameButDifferentSp = panicLog.replace(/0x3ffb1e40/g, '0x3ffb9e40').replace(/0x3ffb1e70/g, '0x3ffb9e70')
const s2 = analyzeCrashLog(sameButDifferentSp)
ok(s2.signature === s1.signature, '栈指针变化不影响签名（同处崩溃去重成立）')

const differentPc = panicLog.replace(/0x400d1a2b/g, '0x400d2b3c')
const s3 = analyzeCrashLog(differentPc)
ok(s3.signature !== s1.signature, 'PC 变化则签名不同（不同崩溃可区分）')
ok(!s1.signature.includes('0x3ffb1e40'), '签名不含栈指针（已归一化）')

// ── 3. 其他崩溃类型归类 ──
console.log('\n[3] 其他崩溃类型归类')
const abortLog = 'E (1234) task: something bad\nassert failed: x != 0 at main.c:42\nabort() was called at PC 0x400d1234 on core 0'
ok(analyzeCrashLog(abortLog).kind === 'abort', 'abort 归类')

const stackLog = '***ERROR*** A stack overflow in task loopTask has been detected.\nStack canary watchpoint triggered (loopTask)'
ok(analyzeCrashLog(stackLog).kind === 'stack-overflow', '栈溢出归类')

const brownoutLog = 'Brownout detector was triggered\n\nets Jun  8 2016 00:22:57'
const sb = analyzeCrashLog(brownoutLog)
ok(sb.kind === 'brownout', '掉电归类')
ok(sb.advice.some((a) => a.includes('供电') || a.includes('电源')), '掉电建议指向供电而非改代码')

const wdtLog = 'E (5000) task_wdt: Task watchdog got triggered. The following tasks did not reset the watchdog in time:'
ok(analyzeCrashLog(wdtLog).kind === 'watchdog', '看门狗归类')

const storeLog = "Guru Meditation Error: Core  0 panic'ed (StoreProhibited). Exception was unhandled.\nPC      : 0x400e1a10\nEXCVADDR: 0x00000004"
const sStore = analyzeCrashLog(storeLog)
ok(sStore.exception === 'StoreProhibited' && sStore.advice.some((a) => a.includes('写')), 'StoreProhibited 给出「写非法地址」建议')

// ── 4. 不误报 ──
console.log('\n[4] 非崩溃日志不误报')
ok(analyzeCrashLog('WiFi connected. IP: 192.168.1.10').crashed === false, '普通日志不误判为崩溃')
ok(analyzeCrashLog('').crashed === false, '空文本不崩溃、不误判')
ok(analyzeCrashLog('   ').crashed === false, '纯空白不误判')

// ── 5. 报告可读 ──
console.log('\n[5] 报告文本')
const report = formatCrashReport(s1)
ok(report.includes('崩溃签名'), '报告含签名字段')
ok(report.includes('排查建议'), '报告含建议段落')
ok(report.includes('LoadProhibited'), '报告含异常类型')

console.log('')
console.log(`[崩溃签名自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

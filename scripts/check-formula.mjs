/**
 * #10 公式校验 / errata 查询 自检（纯函数，esbuild 打包后 node 直跑真单测）。
 * 盯的是：分频可达性判定 + 误差(ppm) 计算正确 + errata 命中/未命中行为正确。
 * 用法：node scripts/check-formula.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'fck-'))
const outfile = join(out, 'formulaCheck.mjs')
buildSync({
  entryPoints: ['src/main/services/formulaCheck.ts', 'src/main/services/errataService.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: out,
})
const fc = await import('file://' + join(out, 'formulaCheck.js').replace(/\\/g, '/'))
const es = await import('file://' + join(out, 'errataService.js').replace(/\\/g, '/'))
rmSync(out, { recursive: true, force: true })

const { checkFormula } = fc
const { queryErrata } = es

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 波特率：80MHz APB，115200 标准采样 ──
{
  const r = checkFormula('baud', 115200, 80_000_000, { mode: 'standard' })
  check('baud 115200@80M 可达', r.achievable && r.withinTolerance, JSON.stringify({ a: r.actualHz, ppm: r.errorPpm }))
  check('  ↳ 给出 UART_CLKDIV 寄存器值', typeof r.registers?.UART_CLKDIV === 'number' && r.registers.UART_CLKDIV > 0, JSON.stringify(r.registers))
  check('  ↳ 实际波特率接近 115200', Math.abs(r.actualHz - 115200) < 200, r.actualHz)
}

// ── 波特率：16MHz 标准采样 115200 是真实边沿情况（误差 ~0.64%，超 0.2% 容差） ──
{
  const r = checkFormula('baud', 115200, 16_000_000, { mode: 'standard' })
  // 16MHz/16/115200=8.68 → 分频 8.625 → 实际 115942，误差 0.64%（6441ppm）
  check('baud 误差 ppm 计算有效且方向正确', Number.isFinite(r.errorPpm) && r.errorPpm > 0 && r.errorPpm < 50000, JSON.stringify({ a: r.actualHz, ppm: r.errorPpm }))
  check('  ↳ 16MHz 标准采样 115200 超出 0.2% 容差（工具应揭示此边沿）', !r.withinTolerance, `ppm=${r.errorPpm.toFixed(0)}`)
}

// ── 定时器：80MHz 出 1kHz ──
{
  const r = checkFormula('timer', 1000, 80_000_000)
  check('timer 1kHz@80M 可达', r.achievable && r.withinTolerance, JSON.stringify({ p: r.registers, a: r.actualHz, ppm: r.errorPpm }))
  check('  ↳ 预分频/重装落在 16 位范围内', (r.registers?.prescaler ?? 0) <= 65536 && (r.registers?.autoreload ?? 0) <= 65536, JSON.stringify(r.registers))
}

// ── 不可达目标：80MHz 想出 0.001Hz（超出 16 位定时器范围） ──
{
  const r = checkFormula('timer', 0.001, 80_000_000)
  check('timer 极低频超出范围 → 不达标', !r.withinTolerance, JSON.stringify({ a: r.actualHz, ppm: r.errorPpm }))
}

// ── PLL：40MHz XTAL → 240MHz（整数比 6:1） ──
{
  const r = checkFormula('pll', 240_000_000, 40_000_000)
  check('pll 40M→240M 整数比精确', r.withinTolerance && Math.abs(r.errorPpm) < 1, JSON.stringify({ a: r.actualHz, ppm: r.errorPpm }))
}

// ── errata：esp32 + adc 命中 ADC2/Wi-Fi 限制 ──
{
  const list = queryErrata('esp32', 'adc')
  check('errata esp32+adc 命中条目', list.length >= 1 && list.some((e) => e.id === 'esp32-adc2-wifi'), JSON.stringify(list.map((e) => e.id)))
  check('  ↳ 命中条目标 verified', list.every((e) => e.verified), '存在未核对条目')
}

// ── errata：种子库未收录的芯片返回空（不谎称无 errata） ──
{
  const list = queryErrata('stm32f4')
  check('errata stm32 未收录 → 空数组', Array.isArray(list) && list.length === 0, JSON.stringify(list))
}

console.log(`[formula] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[formula] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[formula] ✓ 全部通过')

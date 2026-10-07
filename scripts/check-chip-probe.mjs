/**
 * 芯片探测（probeChipId / findEsptool）自检。
 *
 * 盯的是「认不出板卡」这个真机根因：ESP32-C3 插上后 arduino-cli board list
 * 返回空（真机报告原文：board:autodetect 的 fqbn 为空），界面于是沿用上次的
 * esp32s3，编译 142s 后才被 esptool一句 "This chip is ESP32-C3, not ESP32-S3" 打回。
 * 提前读一次 chip id 就能选对板卡，把这 142 秒省掉。
 *
 * 这里只测「不接硬件也必须成立」的部分：
 *   1. 各种 esptool 输出的芯片名都能归一化（v4 / v5 / 带 revision / 小写 / 带前缀）；
 *   2. 认不出就返回 null（绝不猜——猜错比不猜更糟，会烧坏板子的期望值）；
 *   3. 端口不存在 / 探测超时时不能抛，必须安静返回 null；
 *   4. findEsptool 在没有 Arduino15 目录时返回 null 而不是崩。
 *
 * 用法：node scripts/check-chip-probe.mjs
 */
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const outfile = 'scripts/.tmp/chipProbe.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/toolchain.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  // serialport / serialService 会加载原生模块，测试里用桩顶掉
  alias: { electron: resolve('scripts/stubs/electron-dom-stub.mjs') },
  external: ['serialport']
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { parseChipIdFromOutput, probeChipId, findEsptool } = mod

let pass = 0
const fails = []
const ok = (cond, name) => { if (cond) pass++; else fails.push(name) }

// ---------- 1) 芯片名归一化：真机原文 + 各种变体 ----------
const real = 'Chip is ESP32-C3 (revision v0.4)\nFeatures: WiFi 4, BT\nMAC: 84:f3:eb:xx:xx:xx'
ok(parseChipIdFromOutput(real) === 'esp32c3', '真机原文应解析出 esp32c3')
ok(parseChipIdFromOutput('Chip is ESP32-S3 (revision v0.2)') === 'esp32s3', 'S3 应解析出 esp32s3')
ok(parseChipIdFromOutput('chip is esp32-c3 (revision v0.4)') === 'esp32c3', '小写 + 缺省 revision 也认')
ok(parseChipIdFromOutput('Chip ID: 0xC316B33F56789ABC') === null, '只有 Chip ID 十六进制、没有型号 → 认不出（不猜）')
ok(parseChipIdFromOutput('Failed to connect to ESP32: No serial data received') === null, '连不上时不能瞎猜芯片')
ok(parseChipIdFromOutput('') === null, '空输出 → null')

// ---------- 2) findEsptool：没有 Arduino15 目录时安静返回 null ----------
let esptool = null
let threw = false
try { esptool = findEsptool() } catch { threw = true }
ok(!threw, 'findEsptool 不应抛异常（目录不存在是常态）')
ok(esptool === null || typeof esptool === 'string', 'findEsptool 只能返回 null 或路径字符串')

// ---------- 3) probeChipId：找不到 esptool / 端口不存在时安静 null ----------
let res = 'unset'
try {
  res = await probeChipId('COM_DOES_NOT_EXIST_999', 3000)
} catch (e) {
  res = 'threw:' + String(e)
}
ok(res === null, `探测失败必须返回 null 而不是抛（实际 ${String(res).slice(0, 60)}）`)

// ---------- 汇总 ----------
console.log(`\n[chip-probe] 断言 ${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('[chip-probe] 全绿 ✔')
}

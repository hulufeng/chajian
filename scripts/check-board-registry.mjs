/**
 * 板卡注册表自检（纯数据 + 纯函数，不依赖 Electron）。
 *
 * 板卡注册表是「板卡唯一数据源」，UI / Agent / PlatformIO 生成都读它，
 * 加板子只改这一个文件 —— 所以这里要盯的是三条铁律：
 *   ① USB VID:PID → FQBN 的映射不能断（board 探测全靠它）；
 *   ② fqbn / pio board id 在表内唯一（查板靠线性匹配，重复会命中错的那条）；
 *   ③ 收录门槛：arduino-cli 能编译 / openocd 有 cfg / 有真实 USB ID。
 *
 * 用法：node scripts/check-board-registry.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'brg-'))
const outfile = join(out, 'boardRegistry.mjs')
buildSync({
  entryPoints: ['src/main/services/boardRegistry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const m = await import('file://' + outfile.replace(/\\/g, '/'))

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) { pass++ } else { fails.push(`${name}${detail ? '：' + detail : ''}`) }
}

const { BOARD_TARGETS, listTargets, findTarget, targetForFqbn, targetForPioBoard, targetForUsbId, targetsForUsbId, primaryBuild, buildPlatformioIni } = m

// ① 踩过的坑一：ESP32-S3 原生 USB 的 303a:1001 必须能认到 esp32s3，
//    arduino-cli 的 `board list` 在 Windows 上认不到这个 VID:PID（只能靠 serialport）。
const s3 = targetForUsbId('303a:1001')
check('0x303a:1001 → ESP32-S3', !!s3, '没认出来')
check('  ↳ FQBN 必须是 esp32:esp32:esp32s3', s3 && s3.fqbn === 'esp32:esp32:esp32s3', s3 && s3.fqbn)
check('  ↳ 主选构建路径是 arduino-cli', s3 && primaryBuild(s3).path === 'arduino-cli', s3 && primaryBuild(s3).path)
check('  ↳ 同时留了 PlatformIO 退路', s3 && s3.build.some((b) => b.path === 'platformio'))
check('  ↳ 有 pioBoard（PlatformIO 路径要用）', s3 && s3.pioBoard === 'esp32-s3-devkitc-1', s3 && s3.pioBoard)

// ①-2 踩过的坑二（这次真炸出来的）：表里存 '0x303a:0x1001'（带 0x），
//    targetForUsbId 原来只做 trim+toLowerCase 全串比，传 '303A:1001' 必然 undefined。
//    表内/表外两种写法都得认，写法差异不能变成"认得到/认不到"。
const bare = targetForUsbId('303A:1001')
const prefixed = targetForUsbId('0x303A:0x1001')
check("不带 0x 的 '303A:1001' 也能反查到", !!bare, '归一化没生效')
check("带 0x 的 '0x303A:0x1001' 也能反查到", !!prefixed, '归一化没生效')
check('  ↳ 两种写法落到同一块板', !!bare && !!prefixed && bare.id === prefixed.id, `${bare && bare.id} vs ${prefixed && prefixed.id}`)
check('  ↳ 认到的确实是 S3', bare && bare.id === 'esp32-s3-devkitc-1', bare && bare.id)

// ①-3 真实硬件限制：S3 / C3 / P4 三块板原生 USB 共用 303a:1001（Espressif USB JTAG/serial
//    就这一个 VID:PID，物理上分不开）。targetForUsbId 只取第一条，但候选必须摊出来，
//    否则插 C3 会在界面上被认成 S3。
const cands = targetsForUsbId('0x303a:0x1001')
check('共用 VID:PID 的板能被全部列出（≥3）', cands.length >= 3, `实际 ${cands.length}`)
check('  ↳ 候选里含 S3 / C3 / P4', ['esp32-s3-devkitc-1', 'esp32-c3-supermini', 'esp32-p4-function-ev'].every((id) => cands.some((t) => t.id === id)),
  cands.map((t) => t.id).join(','))
check('  ↳ 别一块板被两个 VID:PID 重复计数', targetsForUsbId('0x303a:0x1001').filter((t) => t.id === 'esp32-s3-devkitc-1').length === 1)
check('  ↳ 认不出的 USB ID 返回空数组而不是抛错', Array.isArray(targetsForUsbId('ffff:9999')) && targetsForUsbId('ffff:9999').length === 0)

// 板卡总数与构成：注册表当前 10 款（ESP32 5 + STM32 5）。
// 之前记成「17 款（ESP32 10 + STM32 7）」是错的 —— 以代码为准，这里给下限当回归护栏，
// 以后加板子不会红，但误删板子会立刻红。
check('板卡总数 ≥ 10', BOARD_TARGETS.length >= 10, `实际 ${BOARD_TARGETS.length}`)
const esp = listTargets('esp32')
const stm = listTargets('stm32')
check('ESP32 至少 5 款', esp.length >= 5, `实际 ${esp.length}`)
check('STM32 至少 5 款', stm.length >= 5, `实际 ${stm.length}`)
check('family 与分类列表一致', BOARD_TARGETS.every((t) =>
  t.family === (stm.includes(t) ? 'stm32' : 'esp32')))

// ② 唯一性（注意：STM32 没有 fqbn 只有 pioBoard，别把 undefined 当重复值去比）
const fqbns = BOARD_TARGETS.map((t) => t.fqbn).filter(Boolean)
check('FQBN 无重复（有登记的都得写全）', new Set(fqbns).size === fqbns.length && fqbns.length >= 4,
  fqbns.filter((f, i) => fqbns.indexOf(f) !== i).join(','))
const pios = BOARD_TARGETS.map((t) => t.pioBoard).filter(Boolean)
check('pio board id 无重复', new Set(pios).size === pios.length,
  pios.filter((f, i) => pios.indexOf(f) !== i).join(','))
const ids = BOARD_TARGETS.map((t) => t.id)
check('id 无重复', new Set(ids).size === ids.length)

// ③ 收录门槛：构建路径 / USB ID 齐备
const noBuild = BOARD_TARGETS.filter((t) => !t.build || !t.build.length)
check('每块板都至少有一条构建路径', noBuild.length === 0, noBuild.map((t) => t.id).join(','))
const noUsb = BOARD_TARGETS.filter((t) => !t.usbIds || !t.usbIds.length)
check('每块板都有真实 USB ID', noUsb.length === 0, noUsb.map((t) => t.id).join(','))
const badPio = stm.filter((t) => !t.build.some((b) => b.path === 'platformio'))
check('STM32 每块都有 PlatformIO 路径（arduino-cli 不支持 STM32）', badPio.length === 0, badPio.map((t) => t.id).join(','))
// 收录标准允许「只有 PlatformIO 一条路」—— ESP32-P4 就是这么进来的
// （板上明写「P4 无 arduino-cli 官方 core」），所以这里只要求多数 ESP32 有 FQBN。
const withFqbn = esp.filter((t) => t.fqbn).length
check('ESP32 多数有 arduino-cli FQBN（P4 这类仅 PlatformIO 的合法）', withFqbn >= esp.length - 1,
  `${withFqbn}/${esp.length}`)
// 调试链路字段是 debug.link / debug.cfg（不是 debugLink）
const noDbg = BOARD_TARGETS.filter((t) => !t.debug || !t.debug.link || !t.debug.cfg?.length)
check('每块板都有 openocd 调试链路', noDbg.length === 0, noDbg.map((t) => t.id).join(','))
// SVD：ESP32 靠 espressif/svd 官方源下载，主战板必须有；P4 显式 null 是已知情况
const noSvd = BOARD_TARGETS.filter((t) => t.family === 'esp32' && !t.svdChip && t.id !== 'esp32-p4-function-ev')
check('ESP32（P4 除外）都有 SVD 芯片名（寄存器面板靠它下载）', noSvd.length === 0, noSvd.map((t) => t.id).join(','))

// ④ 反查函数自洽：表内登记过的标识都能被对应反查函数命中
const missFqbn = BOARD_TARGETS.filter((t) => t.fqbn && !targetForFqbn(t.fqbn))
check('带 fqbn 的都能被 targetForFqbn 反查到', missFqbn.length === 0, missFqbn.map((t) => t.id).join(','))
const missPio = BOARD_TARGETS.filter((t) => t.pioBoard && !targetForPioBoard(t.pioBoard))
check('带 pioBoard 的都能被 targetForPioBoard 反查到', missPio.length === 0, missPio.map((t) => t.id).join(','))
const missUsb = BOARD_TARGETS.filter((t) => !t.usbIds.some((u) => targetsForUsbId(u).length > 0))
check('每条的 USB ID 都能被 targetsForUsbId 反查到', missUsb.length === 0, missUsb.map((t) => t.id).join(','))

// ⑤ 生成的 platformio.ini 能直接吃
const ini = buildPlatformioIni(s3, { monitorSpeed: 115200 })
check('platformio.ini 有 [env:]', /\[env:/.test(ini), ini.slice(0, 80).replace(/\n/g, ' | '))
check('platformio.ini 带 board 行', /board\s*=/.test(ini))
check('platformio.ini 带 monitor_speed', /monitor_speed\s*=/.test(ini))
check('primaryBuild 能给出路径', !!primaryBuild(s3) && !!primaryBuild(s3).path, JSON.stringify(primaryBuild(s3)))

rmSync(out, { recursive: true, force: true })

console.log(`[registry] 板卡 ${BOARD_TARGETS.length} 款（ESP32 ${esp.length} + STM32 ${stm.length}）`)
console.log(`[registry] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[registry] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[registry] ✓ 全部通过')

/**
 * wiringService.ts 自检（接线图自动生成；纯解析 + SVG 生成 + 找主 sketch）。
 *
 * 盯的是「注释里的 pinMode 被误判成真实接线（误报）」和「外设/引脚解析错漏」。
 * 覆盖：LED/按键/模拟/中断引脚角色、I2C(SPI/UART)外设识别、注释/块注释不误报、
 *       变量引脚（已知限制，不误报为真）、Wire.begin 自定义引脚、generateWiringDiagram
 *       产出 SVG、空代码兜底、findMainSketch 文件定位。
 *
 * 用法：node scripts/check-wiring.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = 'scripts/.tmp/wiringService.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/wiringService.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { analyzeSketchPins, generateWiringDiagram, findMainSketch } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}
const pinOf = (r, n) => r.pins.find((p) => p.pin === n)
const hasComp = (r, kind) => r.components.some((c) => c.kind === kind)

const tmp = mkdtempSync(join(tmpdir(), 'wiring-'))
const teardown = () => rmSync(tmp, { recursive: true, force: true })
try {
  // ── ① LED 输出引脚角色 ─────────────────────────────────────────────
  const led = analyzeSketchPins('void setup(){ pinMode(2, OUTPUT); digitalWrite(2, HIGH); }')
  check('① LED pinMode(2,OUTPUT) 识别为输出', pinOf(led, 2) && pinOf(led, 2).role.includes('输出'), pinOf(led, 2)?.role)
  check('① pin 2 只出现一次', led.pins.filter((p) => p.pin === 2).length === 1)

  // ── ② 按键输入角色 ─────────────────────────────────────────────────
  const btn = analyzeSketchPins('pinMode(4, INPUT_PULLUP);\nvoid loop(){ digitalRead(4); }')
  check('② INPUT_PULLUP 识别为输入', pinOf(btn, 4) && pinOf(btn, 4).role.includes('输入'), pinOf(btn, 4)?.role)

  // ── ③ 模拟输入 ─────────────────────────────────────────────────────
  const ana = analyzeSketchPins('int v = analogRead(34);')
  check('③ analogRead(34) 识别为模拟输入', pinOf(ana, 34) && pinOf(ana, 34).role.includes('模拟'), pinOf(ana, 34)?.role)

  // ── ④ 行注释里的 pinMode 不得误报 ──────────────────────────────────
  const comLine = analyzeSketchPins('// pinMode(13, OUTPUT)\nvoid setup(){}')
  check('④ 行注释 pinMode(13) 不误报', !pinOf(comLine, 13), JSON.stringify(comLine.pins.map((p) => p.pin)))

  // ── ⑤ 块注释里的 pinMode 不得误报 ──────────────────────────────────
  const comBlock = analyzeSketchPins('/* 旧的 pinMode(13, OUTPUT) 接线 */\nvoid setup(){}')
  check('⑤ 块注释 pinMode(13) 不误报', !pinOf(comBlock, 13))

  // ── ⑥ 字符串里的 pinMode 不得误报 ──────────────────────────────────
  const inStr = analyzeSketchPins('Serial.println("pinMode(13, OUTPUT)");')
  check('⑥ 字符串内 pinMode(13) 不误报', !pinOf(inStr, 13))

  // ── ⑦ Wire.begin(8,9) 自定义 I2C 引脚 ─────────────────────────────
  const i2c = analyzeSketchPins('Wire.begin(8, 9);')
  const i2cC = i2c.components.find((c) => c.kind === 'i2c')
  check('⑦ Wire.begin(8,9) 识别 I2C', !!i2cC)
  check('⑦ I2C SDA=8 SCL=9', i2cC && i2cC.pins.some((p) => p.label === 'SDA' && p.pin === 8) && i2cC.pins.some((p) => p.label === 'SCL' && p.pin === 9))

  // ── ⑧ I2C 屏幕库（无 Wire.begin → 默认引脚）────────────────────────
  const oled = analyzeSketchPins('#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 disp;')
  check('⑧ Adafruit_SSD1306 识别 I2C', hasComp(oled, 'i2c'))
  check('⑧ 默认 SDA=21 SCL=22', oled.components.find((c) => c.kind === 'i2c').pins.some((p) => p.pin === 21) && oled.components.find((c) => c.kind === 'i2c').pins.some((p) => p.pin === 22))

  // ── ⑨ SPI ─────────────────────────────────────────────────────────
  const spi = analyzeSketchPins('#include <SPI.h>\nSPI.begin();')
  check('⑨ <SPI.h> 识别 SPI', hasComp(spi, 'spi'))

  // ── ⑩ UART Serial2 ────────────────────────────────────────────────
  const uart = analyzeSketchPins('Serial2.begin(9600);')
  check('⑩ Serial2.begin 识别 UART', uart.components.some((c) => c.kind === 'uart' && c.name.includes('Serial2')))

  // ── ⑪ 中断引脚 ────────────────────────────────────────────────────
  const irq = analyzeSketchPins('attachInterrupt(digitalPinToInterrupt(5), isr, FALLING);')
  check('⑪ digitalPinToInterrupt(5) 识别引脚 5', !!pinOf(irq, 5))

  // ── ⑫ 变量引脚（已知限制：不解析变量，不得误报为真）──────────────
  const varPin = analyzeSketchPins('const int p = 3;\nvoid setup(){ pinMode(p, OUTPUT); }')
  check('⑫ 变量引脚 p(=3) 不被误报为真引脚', !pinOf(varPin, 3), JSON.stringify(varPin.pins.map((p) => p.pin)))

  // ── ⑬ generateWiringDiagram 产出 SVG ──────────────────────────────
  const diag = generateWiringDiagram('esp32:esp32:esp32s3', 'void setup(){ pinMode(2, OUTPUT); }')
  check('⑬ SVG 含 <svg 根', diag.svg.startsWith('<svg') && diag.svg.includes('</svg>'))
  check('⑬ 板子标签取 fqbn 末段 esp32s3', diag.svg.includes('esp32s3'))

  // ── ⑭ 空代码兜底 ──────────────────────────────────────────────────
  const empty = generateWiringDiagram('esp32:esp32:esp32', '')
  check('⑭ 空代码不崩，components 为空', empty.components.length === 0 && empty.pins.length === 0)
  check('⑭ 空代码提示“未检测到明显外设”', empty.svg.includes('未检测到明显外设'))

  // ── ⑮ findMainSketch 文件定位 ─────────────────────────────────────
  const proj = join(tmp, 'proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'sketch.ino'), 'void setup(){}')
  check('⑮ 找到 .ino 主 sketch', findMainSketch(proj) === join(proj, 'sketch.ino'))
  const proj2 = join(tmp, 'proj2')
  mkdirSync(proj2, { recursive: true })
  writeFileSync(join(proj2, 'notes.txt'), 'x')
  check('⑮ 无 .ino 返回 null', findMainSketch(proj2) === null)
  const proj3 = join(tmp, 'proj3', 'src')
  mkdirSync(proj3, { recursive: true })
  writeFileSync(join(proj3, 'main.cpp'), 'void setup(){}')
  check('⑮ PlatformIO src/main.cpp 被识别', findMainSketch(join(tmp, 'proj3')) === join(tmp, 'proj3', 'src', 'main.cpp'))
} finally {
  teardown()
}

console.log(`\n[check-wiring] ${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}

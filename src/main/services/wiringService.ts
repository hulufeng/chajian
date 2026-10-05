/**
 * 接线图自动生成服务。
 *
 * 从当前 sketch 源码中解析用到的引脚 / 外设（LED、按键、I2C、SPI、UART、传感器等），
 * 结合板卡引脚定义，自动生成一张 SVG 接线示意图，降低 ESP32 小白的接线门槛。
 *
 * 不依赖 Electron，可在主进程 / Agent 工具 / 测试中直接调用。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BoardPinout {
  /** 推荐 I2C 引脚（可在代码/开发板文档中修改） */
  sda: number
  scl: number
  spi: { sck: number; mosi: number; miso: number; ss: number }
  uart: { tx: number; rx: number }
  led: number
  /** 板载说明，仅用于展示 */
  note?: string
}

const BOARD_PINOUTS: Record<string, BoardPinout> = {
  'esp32:esp32:esp32s3': {
    sda: 8,
    scl: 9,
    spi: { sck: 7, mosi: 11, miso: 13, ss: 10 },
    uart: { tx: 43, rx: 44 },
    led: 2,
    note: 'ESP32-S3 DevKitC 推荐引脚'
  },
  'esp32:esp32:esp32c3': {
    sda: 8,
    scl: 9,
    spi: { sck: 4, mosi: 6, miso: 5, ss: 7 },
    uart: { tx: 21, rx: 20 },
    led: 8,
    note: 'ESP32-C3 DevKitM 推荐引脚'
  },
  'esp32:esp32:esp32': {
    sda: 21,
    scl: 22,
    spi: { sck: 18, mosi: 23, miso: 19, ss: 5 },
    uart: { tx: 1, rx: 3 },
    led: 2,
    note: 'ESP32 DevKit / WROOM 推荐引脚'
  }
}

function pinoutFor(fqbn: string): BoardPinout {
  if (BOARD_PINOUTS[fqbn]) return BOARD_PINOUTS[fqbn]
  // 模糊匹配：只要是 esp32 系列，退回通用 ESP32 引脚
  if (fqbn.includes('esp32')) return BOARD_PINOUTS['esp32:esp32:esp32']
  // 其它架构暂退回通用 ESP32 推荐（仅作示意，用户需按实际板卡调整）
  return BOARD_PINOUTS['esp32:esp32:esp32']
}

export interface PinUsage {
  pin: number
  role: string
  detail: string
}

export interface ComponentInfo {
  name: string
  pins: Array<{ pin: number; label: string }>
  kind: 'gpio' | 'i2c' | 'spi' | 'uart'
}

function toInt(v: string): number | null {
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 sketch 源码，提取引脚用途与外设类型。
 */
export function analyzeSketchPins(code: string): {
  pins: PinUsage[]
  components: ComponentInfo[]
} {
  const pinUsages = new Map<number, PinUsage>()
  const addPin = (pin: number, role: string, detail: string) => {
    if (!Number.isFinite(pin)) return
    if (!pinUsages.has(pin)) pinUsages.set(pin, { pin, role, detail })
    else if (!pinUsages.get(pin)!.detail.includes(detail)) pinUsages.get(pin)!.detail += `；${detail}`
  }

  const pinRe = /\b(?:pinMode|digitalRead|digitalWrite|analogRead|analogWrite|tone|pulseIn|attachInterrupt|digitalPinToInterrupt)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/g
  let m: RegExpExecArray | null
  while ((m = pinRe.exec(code))) {
    const raw = m[1]
    const num = toInt(raw)
    const fn = m[0].replace(/\s*\([^]*$/, '')
    if (num !== null) {
      let role = 'GPIO'
      if (/pinMode/.test(fn)) {
        const modeMatch = code.slice(m.index).match(/pinMode\s*\(\s*\d+\s*,\s*(INPUT_PULLUP|INPUT|OUTPUT)/)
        role = modeMatch ? (modeMatch[1] === 'OUTPUT' ? '输出(LED/继电器)' : '输入(按键/传感器)') : 'GPIO'
      } else if (/analogRead/.test(fn)) role = '模拟输入(传感器)'
      else if (/analogWrite|tone/.test(fn)) role = 'PWM/输出'
      else if (/digitalRead/.test(fn)) role = '数字输入'
      else if (/attachInterrupt/.test(fn)) role = '中断输入'
      addPin(num, role, fn)
    }
  }

  // I2C：Wire.begin(SDA, SCL) 或常见 I2C 屏幕/液晶库
  let sda = pinoutFor('esp32:esp32:esp32').sda
  let scl = pinoutFor('esp32:esp32:esp32').scl
  const wireBegin = code.match(/Wire\s*\.\s*begin\s*\(\s*(\d+)\s*,\s*(\d+)/)
  if (wireBegin) {
    sda = Number(wireBegin[1])
    scl = Number(wireBegin[2])
  }
  const hasI2cLib = /Adafruit_SSD1306|LiquidCrystal_I2C|Adafruit_SH1106|Wire\s*\.\s*begin/i.test(code)
  const components: ComponentInfo[] = []
  if (hasI2cLib || wireBegin) {
    components.push({ name: 'I2C 设备（OLED/液晶/传感器）', kind: 'i2c', pins: [{ pin: sda, label: 'SDA' }, { pin: scl, label: 'SCL' }] })
  }

  // SPI
  const hasSpi = /SPI\s*\.\s*begin|<SPI\.h>|Adafruit_ILI9341|Adafruit_ST7735/i.test(code)
  if (hasSpi) {
    const po = pinoutFor('esp32:esp32:esp32').spi
    components.push({ name: 'SPI 设备（TFT/SD 卡）', kind: 'spi', pins: [{ pin: po.sck, label: 'SCK' }, { pin: po.mosi, label: 'MOSI' }, { pin: po.miso, label: 'MISO' }] })
  }

  // UART（Serial1/2）
  const serialMatch = code.match(/Serial([12])\s*\.\s*begin/)
  if (serialMatch) {
    const po = pinoutFor('esp32:esp32:esp32').uart
    components.push({ name: `额外串口设备（Serial${serialMatch[1]}）`, kind: 'uart', pins: [{ pin: po.tx, label: 'TX' }, { pin: po.rx, label: 'RX' }] })
  }

  // 每个用到的 GPIO 作为一个通用外设节点
  for (const u of pinUsages.values()) {
    components.push({ name: `外设（引脚 ${u.pin}）`, kind: 'gpio', pins: [{ pin: u.pin, label: `GPIO${u.pin}` }] })
  }

  return { pins: [...pinUsages.values()], components }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 生成接线图 SVG。返回 { svg, components, pins }。
 */
export function generateWiringDiagram(fqbn: string, code: string): {
  svg: string
  components: ComponentInfo[]
  pins: PinUsage[]
} {
  const po = pinoutFor(fqbn)
  const { pins, components } = analyzeSketchPins(code)

  const W = 780
  const boardX = 24
  const boardW = 250
  const compX = 470
  const compW = 286
  const rowH = 34
  const headH = 46
  const compH = 64
  const gap = 18
  const boardRows = Math.max(4, pins.length + 2) // 至少展示 LED/I2C/SPI/UART 提示
  const boardH = headH + boardRows * rowH + 16
  const contentH = Math.max(boardH, components.length * (compH + gap) + 20)
  const H = contentH + 24

  const boardLines: string[] = []
  boardLines.push(`<rect x="${boardX}" y="12" width="${boardW}" height="${boardH}" rx="10" fill="#1f2933" stroke="#0b1015" stroke-width="2"/>`)
  boardLines.push(`<text x="${boardX + 14}" y="38" fill="#fff" font-size="15" font-weight="bold">开发板 ${esc(fqbn.split(':').pop() || fqbn)}</text>`)
  boardLines.push(`<text x="${boardX + 14}" y="56" fill="#9fb3c8" font-size="11">${esc(po.note || '')}</text>`)

  // 板子引脚列表：先列已用 GPIO，再列关键外设引脚
  const usedSet = new Set(pins.map((p) => p.pin))
  let row = 0
  const pinY = (i: number) => 12 + headH + i * rowH + rowH / 2
  for (const u of pins) {
    const y = pinY(row++)
    const color = u.role.includes('输入') ? '#5ad1a0' : '#ffb454'
    boardLines.push(`<circle cx="${boardX + 16}" cy="${y}" r="6" fill="${color}"/>`)
    boardLines.push(`<text x="${boardX + 30}" y="${y + 4}" fill="#e6edf3" font-size="12">GPIO${u.pin} · ${esc(u.role)}</text>`)
  }
  // 关键外设引脚（始终展示，便于接线参考）
  const extras: Array<[string, number]> = [
    ['LED_BUILTIN', po.led],
    ['I2C SDA', po.sda],
    ['I2C SCL', po.scl],
    ['SPI SCK', po.spi.sck],
    ['SPI MOSI', po.spi.mosi],
    ['UART TX', po.uart.tx],
    ['UART RX', po.uart.rx]
  ]
  for (const [label, pin] of extras) {
    if (usedSet.has(pin)) continue
    const y = pinY(row++)
    boardLines.push(`<circle cx="${boardX + 16}" cy="${y}" r="6" fill="#6b7a8d"/>`)
    boardLines.push(`<text x="${boardX + 30}" y="${y + 4}" fill="#9fb3c8" font-size="12">${label} (${pin})</text>`)
  }

  // 组件 + 连线
  const compLines: string[] = []
  const linkLines: string[] = []
  components.forEach((c, i) => {
    const y = 24 + i * (compH + gap)
    const color = c.kind === 'i2c' ? '#7aa2f7' : c.kind === 'spi' ? '#bb9af7' : c.kind === 'uart' ? '#e0af68' : '#9ece6a'
    compLines.push(`<rect x="${compX}" y="${y}" width="${compW}" height="${compH}" rx="10" fill="#0f1b2d" stroke="${color}" stroke-width="2"/>`)
    compLines.push(`<text x="${compX + 14}" y="${y + 24}" fill="#fff" font-size="13" font-weight="bold">${esc(c.name)}</text>`)
    const pinText = c.pins.map((p) => `${p.label}=${p.pin}`).join('  ')
    compLines.push(`<text x="${compX + 14}" y="${y + 46}" fill="#9fb3c8" font-size="11">${esc(pinText)}</text>`)
    // 连线：板子右侧中点 → 组件左侧中点
    const boardAnchorX = boardX + boardW
    const boardAnchorY = 12 + boardH / 2
    const compAnchorX = compX
    const compAnchorY = y + compH / 2
    linkLines.push(`<path d="M ${boardAnchorX} ${boardAnchorY} C ${(boardAnchorX + compAnchorX) / 2} ${boardAnchorY}, ${(boardAnchorX + compAnchorX) / 2} ${compAnchorY}, ${compAnchorX} ${compAnchorY}" fill="none" stroke="${color}" stroke-width="2"/>`)
    linkLines.push(`<circle cx="${boardAnchorX}" cy="${boardAnchorY}" r="3" fill="${color}"/>`)
    linkLines.push(`<circle cx="${compAnchorX}" cy="${compAnchorY}" r="3" fill="${color}"/>`)
  })

  if (components.length === 0) {
    compLines.push(`<text x="${compX}" y="${24 + compH / 2}" fill="#9fb3c8" font-size="13">未检测到明显外设，仅展示板载引脚参考。</text>`)
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#f5f7fa"/>` +
    linkLines.join('') +
    boardLines.join('') +
    compLines.join('') +
    `<text x="24" y="${H - 4}" fill="#8a97a8" font-size="11">自动生成 · 引脚为推荐值，实际接线请以开发板丝印与代码为准</text>` +
    `</svg>`

  return { svg, components, pins }
}

/**
 * 在项目目录里找主 sketch（.ino 优先，其次 .cpp）。找不到返回 null。
 */
export function findMainSketch(projectRoot: string): string | null {
  if (!projectRoot || !existsSync(projectRoot)) return null
  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true })
    const ino = entries.find((e) => e.isFile() && e.name.endsWith('.ino'))
    if (ino) return join(projectRoot, ino.name)
    const cpp = entries.find((e) => e.isFile() && (e.name.endsWith('.cpp') || e.name.endsWith('.c')))
    if (cpp) return join(projectRoot, cpp.name)
    // 子目录 src/main.* (PlatformIO)
    const src = entries.find((e) => e.isDirectory() && e.name === 'src')
    if (src) {
      const sub = readdirSync(join(projectRoot, 'src'))
      const m = sub.find((n) => /^main\.(ino|cpp|c)$/.test(n))
      if (m) return join(projectRoot, 'src', m)
    }
  } catch {
    /* 忽略 */
  }
  return null
}

export function readSketchCode(projectRoot: string): string | null {
  const f = findMainSketch(projectRoot)
  if (!f) return null
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return null
  }
}

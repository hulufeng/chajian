// transpiler.ts — 把 Arduino .ino 代码转成 VirtualRuntime 可执行的 JS
// 支持: pinMode/digitalWrite/digitalRead/analogRead/analogWrite/Serial/delay/millis/for/if

export interface TranspileResult {
  setup: (rt: any) => Promise<void>
  loop: (rt: any) => Promise<void>
  warnings: string[]
  needsFlash: boolean
}

export function transpile(inoCode: string): TranspileResult {
  const warnings: string[] = []
  let needsFlash = false

  // 1. 检测是否需要真实硬件
  const flashIncludes = [
    'WiFi.h', 'WiFiClient.h', 'WebServer.h', 'HTTPClient.h',
    'BLEDevice.h', 'Adafruit_NeoPixel.h', 'ESPmDNS.h',
  ]
  for (const inc of flashIncludes) {
    if (inoCode.includes(`#include <${inc}>`)) {
      needsFlash = true
      warnings.push(`#include <${inc}> 需要真实硬件，将走烧录模式`)
    }
  }

  // 2. 预处理：提取全局 #define
  const defines: string[] = []
  let code = inoCode.replace(/#define\s+(\w+)\s+(.+)/g, (_, name, val) => {
    defines.push(`const ${name} = ${val.trim()};`)
    return ''
  })

  // 3. 常量替换
  code = code.replace(/\bHIGH\b/g, '1')
  code = code.replace(/\bLOW\b/g, '0')
  code = code.replace(/\bOUTPUT\b/g, "'OUTPUT'")
  code = code.replace(/\bINPUT_PULLUP\b/g, "'INPUT_PULLUP'")
  code = code.replace(/\bINPUT\b/g, "'INPUT'")

  // 4. Arduino API → rt.xxx
  code = code.replace(/Serial\.begin\(([^)]+)\)/g, 'rt.uart.begin($1)')
  code = code.replace(/Serial\.print\(([^)]+)\)/g, 'rt.uart.print($1)')
  code = code.replace(/Serial\.println\(([^)]*)\)/g, 'rt.uart.println($1)')
  code = code.replace(/Serial\.printf\(([^)]+)\)/g, 'rt.uart.printf($1)')
  code = code.replace(/pinMode\(([^)]+)\)/g, 'rt.gpio.pinMode($1)')
  code = code.replace(/digitalWrite\(([^)]+)\)/g, 'rt.gpio.digitalWrite($1)')
  code = code.replace(/digitalRead\(([^)]+)\)/g, 'rt.gpio.digitalRead($1)')
  code = code.replace(/analogRead\(([^)]+)\)/g, 'rt.adc.read($1)')
  code = code.replace(/analogWrite\(([^)]+)\)/g, 'rt.pwm.analogWrite($1)')
  code = code.replace(/millis\(\)/g, 'rt.millis()')

  // 4b. 传感器 / OLED 教学支持
  // DHT11/DHT22/SimpleDHT：dht.readTemperature() / dht.readHumidity() → rt.env
  code = code.replace(/([A-Za-z_]\w*)\.readTemperature\(\)/g, 'rt.env.readTemperature()')
  code = code.replace(/([A-Za-z_]\w*)\.readHumidity\(\)/g, 'rt.env.readHumidity()')
  // 传感器/总线空参 begin()（如 dht.begin() / Wire.begin()）直接移除
  code = code.replace(/([A-Za-z_]\w*|Wire)\.begin\(\)/g, '')
  // OLED 库：display/oled/ssd1306/u8g2/screen 的 print/println/printf → 屏幕文本
  code = code.replace(/clearDisplay\(\)/g, 'rt.wire.oledClear()')
  code = code.replace(/([A-Za-z_]\w*)\.setCursor\(([^)]+)\)/g, '')
  code = code.replace(/([A-Za-z_]\w*)\.(print|println|printf)\(([^)]+)\)/g, 'rt.wire.printToOled($3)')

  // 5. delay → await rt.delay（必须在其他替换之后）
  code = code.replace(/delay\(([^)]+)\)/g, 'await rt.delay($1)')

  // 6. 提取 setup() 和 loop()
  const setupMatch = code.match(/void\s+setup\s*\(\s*\)\s*\{([\s\S]*?)\n\}/)
  const loopMatch = code.match(/void\s+loop\s*\(\s*\)\s*\{([\s\S]*?)\n\}/)

  const setupBody = setupMatch ? setupMatch[1] : ''
  const loopBody = loopMatch ? loopMatch[1] : ''

  const globalDefs = defines.join('\n')

  // 7. 生成可执行函数（body 含 await rt.delay(...)，必须包进 async 作用域；new Function 本身只能创建普通函数）
  const setup = async (rt: any) => {
    const fn = new Function('rt', `return (async () => {\n${globalDefs}\n${setupBody}\n})()`)
    await fn(rt)
  }

  const loop = async (rt: any) => {
    const fn = new Function('rt', `return (async () => {\n${globalDefs}\n${loopBody}\n})()`)
    await fn(rt)
  }

  return { setup, loop, warnings, needsFlash }
}

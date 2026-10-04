export { VirtualRuntime } from './VirtualRuntime'
export type { RuntimeEvents } from './VirtualRuntime'
export { GPIOBank } from './GPIOBank'
export { UARTPort } from './UARTPort'
export { I2CBus } from './I2CBus'
export { ADCPeripheral } from './ADCPeripheral'
export { PWMPeripheral } from './PWMPeripheral'
export { transpile } from './transpiler'
export type { TranspileResult } from './transpiler'
export { drawText, clearRam } from './font5x7'

export function detectMode(code: string): 'simulate' | 'flash' {
  const flashIncludes = [
    'WiFi.h', 'WiFiClient.h', 'WebServer.h', 'HTTPClient.h',
    'BLEDevice.h', 'Adafruit_NeoPixel.h', 'ESPmDNS.h',
  ]
  const flashAPIs = [
    /WiFi\./, /BLEDevice/, /ESP\.get/, /getCpuFrequencyMhz/,
    /neopixelWrite/, /rmtWrite/, /esp_deep_sleep/,
  ]
  for (const inc of flashIncludes) {
    if (code.includes(`#include <${inc}>`)) return 'flash'
  }
  for (const re of flashAPIs) {
    if (re.test(code)) return 'flash'
  }
  return 'simulate'
}

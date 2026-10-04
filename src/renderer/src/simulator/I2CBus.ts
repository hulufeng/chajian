// I2CBus.ts — ESP32 I2C 总线 + SSD1306 OLED + SHT30
import { drawText, clearRam } from './font5x7'
export class I2CBus {
  private onOledRam: (ram: Uint8Array) => void
  private onSht30?: (temp: number, humi: number) => void

  // SSD1306
  private oledRam = new Uint8Array(1024)
  private oledCmdMode = true
  private oledPage = 0
  private oledCol = 0
  private textRow = 0

  // SHT30
  private shtTemp = 25.5
  private shtHumi = 60.0
  private shtReadBuf: number[] = []
  private shtReadIdx = 0

  private currentAddr = 0
  private currentWrite = false

  constructor(onOledRam: (ram: Uint8Array) => void) {
    this.onOledRam = onOledRam
  }

  setSHT30Callback(cb: (temp: number, humi: number) => void) {
    this.onSht30 = cb
  }

  begin() { /* noop */ }

  beginTransmission(addr: number) {
    this.currentAddr = addr
    this.currentWrite = true
  }

  write(data: number) {
    if (this.currentAddr === 0x3C && this.currentWrite) {
      if (data === 0x00) { this.oledCmdMode = true; return }
      if (data === 0x40) { this.oledCmdMode = false; return }
      if (this.oledCmdMode) {
        if (data >= 0xB0 && data <= 0xB7) this.oledPage = data - 0xB0
      } else {
        this.oledRam[this.oledPage * 128 + this.oledCol] = data
        this.oledCol = (this.oledCol + 1) % 128
        if (this.oledCol === 0) this.oledPage = (this.oledPage + 1) % 8
        this.onOledRam(this.oledRam)
      }
    }
  }

  endTransmission() {
    this.currentAddr = 0
  }

  requestFrom(addr: number, len: number): number {
    this.currentAddr = addr
    this.currentWrite = false
    if (addr === 0x44) {
      const rawT = Math.round(((this.shtTemp + 45) * 65535) / 175)
      const rawH = Math.round((this.shtHumi * 65535) / 100)
      this.shtReadBuf = [
        (rawT >> 8) & 0xFF, rawT & 0xFF, 0xBE,
        (rawH >> 8) & 0xFF, rawH & 0xFF, 0x5C,
      ]
      this.shtReadIdx = 0
    }
    return len
  }

  available(): number {
    if (this.currentAddr === 0x44) return 6 - this.shtReadIdx
    return 0
  }

  read(): number {
    if (this.currentAddr === 0x44) {
      const v = this.shtReadBuf[this.shtReadIdx] ?? 0
      this.shtReadIdx++
      return v
    }
    return 0xFF
  }

  setEnvironment(temp: number, humi: number) {
    this.shtTemp = temp
    this.shtHumi = humi
  }

  // ── SSD1306 文本绘制（教学演示：直接向屏幕写文字）──
  /** 清屏 */
  oledClear() {
    clearRam(this.oledRam)
    this.textRow = 0
    this.onOledRam(this.oledRam)
  }

  /** 在 (x, y) 画一行 ASCII 文本（5x7 字模） */
  drawText(x: number, y: number, text: string) {
    drawText(this.oledRam, x, y, String(text))
    this.onOledRam(this.oledRam)
  }

  /** 兼容常见 OLED 库 print 调用：`display.print("...")` → 自动换行排布 */
  printToOled(...args: unknown[]) {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join('')
    const row = (this.textRow * 8) % 64
    this.drawText(0, row, text)
    this.textRow = (this.textRow + 1) % 8
  }
}

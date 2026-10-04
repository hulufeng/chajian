// ADCPeripheral.ts — ESP32 ADC 12-bit (0-4095, 0-3.3V)
export class ADCPeripheral {
  private channels: Map<number, number> = new Map()

  constructor() {
    // 默认 GPIO0 (ADC_CH0) = 1.65V
    this.channels.set(0, Math.round(1.65 / 3.3 * 4095))
  }

  setMillivolts(pin: number, mv: number) {
    this.channels.set(pin, Math.max(0, Math.min(4095, Math.round(mv / 3300 * 4095))))
  }

  read(pin: number): number {
    return this.channels.get(pin) ?? 0
  }

  readVoltage(pin: number): number {
    return (this.read(pin) / 4095) * 3.3
  }
}

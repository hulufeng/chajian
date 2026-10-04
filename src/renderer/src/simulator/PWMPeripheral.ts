// PWMPeripheral.ts — ESP32 LEDC PWM 模拟 (0-255)
export class PWMPeripheral {
  private onPwm: (pin: number, duty: number) => void
  private channels: Map<number, number> = new Map()

  constructor(onPwm: (pin: number, duty: number) => void) {
    this.onPwm = onPwm
  }

  analogWrite(pin: number, duty: number) {
    const d = Math.max(0, Math.min(255, duty))
    this.channels.set(pin, d)
    this.onPwm(pin, d)
  }

  read(pin: number): number {
    return this.channels.get(pin) ?? 0
  }
}

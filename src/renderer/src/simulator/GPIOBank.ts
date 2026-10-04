// GPIOBank.ts — ESP32 GPIO 模拟
export type PinMode = 'INPUT' | 'OUTPUT' | 'INPUT_PULLUP' | 'OUTPUT_OPEN_DRAIN'

type PinState = { mode: PinMode; value: 0 | 1 }

export class GPIOBank {
  private pins: Map<number, PinState> = new Map()
  private onPinChange: (pin: number, value: 0 | 1) => void
  private onInput?: (pin: number) => void

  constructor(onPinChange: (pin: number, value: 0 | 1) => void) {
    this.onPinChange = onPinChange
    for (let i = 0; i <= 48; i++) {
      this.pins.set(i, { mode: 'INPUT', value: 0 })
    }
  }

  pinMode(pin: number, mode: PinMode) {
    const p = this.pins.get(pin)!
    p.mode = mode
    if (mode === 'INPUT_PULLUP') p.value = 1
  }

  digitalWrite(pin: number, val: 0 | 1) {
    this.pins.get(pin)!.value = val
    this.onPinChange(pin, val)
  }

  digitalRead(pin: number): 0 | 1 {
    return this.pins.get(pin)!.value
  }

  setExternal(pin: number, val: 0 | 1) {
    this.pins.get(pin)!.value = val
  }
}

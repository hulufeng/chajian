// VirtualRuntime.ts — ESP32 虚拟硬件运行时核心
import { GPIOBank } from './GPIOBank'
import { UARTPort } from './UARTPort'
import { I2CBus } from './I2CBus'
import { ADCPeripheral } from './ADCPeripheral'
import { PWMPeripheral } from './PWMPeripheral'

export interface RuntimeEvents {
  onPinChange: (pin: number, value: 0 | 1) => void
  onPwmChange: (pin: number, duty: number) => void
  onSerialData: (data: string) => void
  onOledRam: (ram: Uint8Array) => void
}

/** 环境模拟器：DHT11/DHT22 温湿度 + SHT30 共用一套环境值 */
export class EnvironmentSimulator {
  private temp = 25.5
  private humi = 60.0

  setEnvironment(temp: number, humi: number) {
    this.temp = temp
    this.humi = humi
  }

  readTemperature(): number {
    return this.temp
  }

  readHumidity(): number {
    return this.humi
  }
}

export class VirtualRuntime {
  readonly gpio: GPIOBank
  readonly uart: UARTPort
  readonly wire: I2CBus
  readonly adc: ADCPeripheral
  readonly pwm: PWMPeripheral
  readonly env: EnvironmentSimulator

  private events: RuntimeEvents
  private running = false
  private startTime = 0
  private timers: Set<ReturnType<typeof setTimeout>> = new Set()

  constructor(events: RuntimeEvents) {
    this.events = events
    this.gpio = new GPIOBank(events.onPinChange)
    this.uart = new UARTPort(events.onSerialData)
    this.wire = new I2CBus(events.onOledRam)
    this.adc = new ADCPeripheral()
    this.pwm = new PWMPeripheral(events.onPwmChange)
    this.env = new EnvironmentSimulator()
  }

  setEnvironment(temp: number, humi: number) {
    this.env.setEnvironment(temp, humi)
    this.wire.setEnvironment(temp, humi)
  }

  async run(setup: (rt: VirtualRuntime) => Promise<void>, loop: (rt: VirtualRuntime) => Promise<void>): Promise<void> {
    this.running = true
    this.startTime = Date.now()
    await setup(this)
    while (this.running) {
      await loop(this)
    }
  }

  stop(): void {
    this.running = false
    this.timers.forEach(t => clearTimeout(t))
    this.timers.clear()
  }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const id = setTimeout(() => {
        this.timers.delete(id)
        resolve()
      }, ms)
      this.timers.add(id)
    })
  }

  millis(): number { return Date.now() - this.startTime }
  micros(): number { return (Date.now() - this.startTime) * 1000 }
}

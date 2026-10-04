// UARTPort.ts — ESP32 UART0 模拟
export class UARTPort {
  private onData: (data: string) => void
  private inputBuf: string[] = []
  baudRate = 115200

  constructor(onData: (data: string) => void) {
    this.onData = onData
  }

  begin(baud: number) { this.baudRate = baud }

  print(s: string | number) { this.onData(String(s)) }
  println(s: string | number = '') { this.onData(String(s) + '\r\n') }
  printf(fmt: string, ...args: any[]) {
    let i = 0
    this.onData(fmt.replace(/%[.\d]*[dfsx]/g, () => String(args[i++])))
  }

  available(): number { return this.inputBuf.length }
  read(): string { return this.inputBuf.shift() ?? '' }
  userInput(data: string) { this.inputBuf.push(data) }
}

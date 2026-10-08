// Day 23: 第二串口 (UART2) —— 接 GPS 模块或其他串口设备
// ESP32 有 3 个 UART: UART0(USB调试), UART1(SD卡用), UART2(自由用)
// 接线: UART2 TX=GPIO17 -> 设备 RX, UART2 RX=GPIO16 -> 设备 TX

HardwareSerial UART2(2);

void setup() {
  Serial.begin(115200);      // UART0: USB 调试
  UART2.begin(9600, SERIAL_8N1, 16, 17);  // UART2: RX=16, TX=17
  Serial.println("双串口示例: UART0=115200, UART2=9600");
}

void loop() {
  // 从 USB 串口收到的数据,转发到 UART2
  while (Serial.available()) {
    UART2.write(Serial.read());
  }
  // 从 UART2 收到的数据,转发到 USB 串口
  while (UART2.available()) {
    Serial.write(UART2.read());
  }
}

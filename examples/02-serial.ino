// Day 2: 串口日志调试
// 打开串口监视器，波特率 115200

void setup() {
  Serial.begin(115200);
  delay(1000);  // 等串口就绪
  Serial.println("===== ESP32 串口调试 =====");
  Serial.printf("芯片: ESP32, 核心数: %d\n", ESP.getChipCores());
  Serial.printf("CPU 频率: %d MHz\n", getCpuFrequencyMhz());
  Serial.printf("Flash 大小: %d MB\n", ESP.getFlashChipSize() / 1024 / 1024);
  Serial.printf("可用堆内存: %d bytes\n", ESP.getFreeHeap());
}

void loop() {
  static int count = 0;
  Serial.printf("[%lu] 心跳 #%d, 已运行 %lu 秒\n",
                millis() / 1000, count++, millis() / 1000);
  delay(2000);
}

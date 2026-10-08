// Day 24: ESP32 内置温度传感器
// 无需外接任何传感器,读芯片内部温度
// 注意: 这个读数偏粗略,适合做温度趋势参考,不适合精密测温

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("内置温度传感器示例");
}

void loop() {
  // ESP32 内部温度传感器 (Core 附近)
  float temp = temperatureRead();  // Arduino ESP32 core 3.0+
  Serial.printf("芯片内部温度: %.1f °C\n", temp);

  // CPU 频率
  Serial.printf("CPU 频率: %d MHz\n", getCpuFrequencyMhz());
  Serial.printf("堆剩余: %d bytes\n\n", ESP.getFreeHeap());

  delay(2000);
}

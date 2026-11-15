#include <Arduino.h>

// ESP32-S3-DevKitC-1 板载 LED 接在 GPIO2（少数衍生板在 GPIO48，按需调整）
#ifndef LED_PIN
#define LED_PIN 2
#endif

// 仅在 PlatformIO 构建时提供 setup/loop 入口，避免与根目录 esp32-s3-blink.ino 重复定义。
// BubaiCode / arduino-cli 编译根目录 .ino 时不定义 PLATFORMIO 宏，此处跳过，仅 .ino 提供入口；
// 这样同一项目同时兼容 PlatformIO(pio run) 与 BubaiCode/arduino-cli 两种工具链。
#ifdef PLATFORMIO
void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }
  pinMode(LED_PIN, OUTPUT);
  Serial.println("ESP32-S3 LED Blink 已启动");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);   // 点亮
  delay(500);
  digitalWrite(LED_PIN, LOW);    // 熄灭
  delay(500);
  // 每秒翻转一次，串口可观察心跳
}
#endif

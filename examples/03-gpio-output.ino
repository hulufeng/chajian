// Day 3: GPIO 输出 - 控制外接 LED
// 接线：LED 长脚 -> GPIO5, 短脚 -> 220欧电阻 -> GND

#define LED_PIN 5

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // 渐亮
  for (int i = 0; i < 256; i++) {
    analogWrite(LED_PIN, i);
    delay(5);
  }
  // 渐灭
  for (int i = 255; i >= 0; i--) {
    analogWrite(LED_PIN, i);
    delay(5);
  }
}

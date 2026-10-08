// Day 26: LEDC 多通道 PWM —— 同时控制 RGB LED
// ESP32 有 16 路 LEDC 通道,可以独立调光
// 接线: R=GPIO13, G=GPIO14, B=GPIO15 (共阴 RGB LED)

#define R_PIN 13
#define G_PIN 14
#define B_PIN 15

void setup() {
  Serial.begin(115200);
  ledcSetup(0, 5000, 8);  // 通道0: 5kHz, 8位分辨率
  ledcSetup(1, 5000, 8);
  ledcSetup(2, 5000, 8);
  ledcAttachPin(R_PIN, 0);
  ledcAttachPin(G_PIN, 1);
  ledcAttachPin(B_PIN, 2);
  Serial.println("RGB PWM 启动");
}

void loop() {
  // 彩虹渐变色
  for (int i = 0; i < 256; i++) {
    ledcWrite(0, i);         // R 渐亮
    ledcWrite(1, 255 - i);   // G 渐暗
    ledcWrite(2, 128);       // B 固定
    delay(5);
  }
  for (int i = 0; i < 256; i++) {
    ledcWrite(0, 255 - i);
    ledcWrite(1, i);
    ledcWrite(2, 255 - i);
    delay(5);
  }
}

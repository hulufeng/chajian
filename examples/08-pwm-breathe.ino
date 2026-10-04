// Day 8: PWM 呼吸灯
// LED 接 GPIO5，LEDC 通道 0

#define LED_PIN 5
#define LEDC_CHANNEL 0
#define LEDC_FREQ 5000
#define LEDC_RES 10  // 10-bit = 0~1023

void setup() {
  ledcSetup(LEDC_CHANNEL, LEDC_FREQ, LEDC_RES);
  ledcAttachPin(LED_PIN, LEDC_CHANNEL);
}

void loop() {
  // 渐亮
  for (int duty = 0; duty <= 1023; duty += 5) {
    ledcWrite(LEDC_CHANNEL, duty);
    delay(5);
  }
  // 渐灭
  for (int duty = 1023; duty >= 0; duty -= 5) {
    ledcWrite(LEDC_CHANNEL, duty);
    delay(5);
  }
}

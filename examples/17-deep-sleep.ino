// Day 17: 深度睡眠 —— 低功耗省电
// 睡 10 秒后自动唤醒,重复循环
// 接线: GPIO0 接 GND 可手动唤醒(可选)

#define WAKEUP_PIN 0  // BOOT 按钮

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("=== 唤醒 ===");
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  switch (cause) {
    case ESP_SLEEP_WAKEUP_TIMER:  Serial.println("原因: 定时器"); break;
    case ESP_SLEEP_WAKEUP_EXT0:    Serial.println("原因: 按钮(GPIO0)"); break;
    default:                        Serial.println("原因: 首次开机"); break;
  }

  // 模拟工作: 闪 3 次 LED
  pinMode(2, OUTPUT);
  for (int i = 0; i < 3; i++) {
    digitalWrite(2, HIGH); delay(200);
    digitalWrite(2, LOW);  delay(200);
  }

  Serial.println("进入深度睡眠 10 秒...\n");
  esp_sleep_enable_timer_wakeup(10ULL * 1000000);  // 10 秒
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_0, 0);       // BOOT 按钮也能唤醒
  esp_deep_sleep_start();
}

void loop() {
  // 不会执行到这里
}

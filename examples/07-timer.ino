// Day 7: 硬件定时器
// 不使用 delay()，用定时器精确控制 LED 闪烁频率

#define LED_PIN 2
hw_timer_t *timer = NULL;
volatile bool ledState = false;

void IRAM_ATTR onTimer() {
  ledState = !ledState;
  digitalWrite(LED_PIN, ledState);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  // ESP32 有 4 个定时器，分频 80 -> 1MHz 计数
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, 500000, true);  // 每 500ms 触发一次
  timerAlarmEnable(timer);
  Serial.println("定时器启动，500ms 翻转一次 LED");
}

void loop() {
  // loop 里可以做别的事，不阻塞
  delay(1000);
  Serial.printf("loop 心跳: %lu ms\n", millis());
}

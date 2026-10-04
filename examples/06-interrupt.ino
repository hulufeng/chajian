// Day 6: 外部中断
// 按键按下时触发中断，不用 loop 轮询

#define BTN_PIN 4
#define LED_PIN 2

volatile bool buttonPressed = false;

void IRAM_ATTR onButton() {
  buttonPressed = true;  // 中断里只设标志，不做耗时操作
}

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(BTN_PIN), onButton, FALLING);
  Serial.begin(115200);
  Serial.println("中断就绪，按按键触发");
}

void loop() {
  if (buttonPressed) {
    buttonPressed = false;
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    Serial.printf("中断触发! 时间 %lu ms\n", millis());
    delay(50);  // 简单消抖
  }
}

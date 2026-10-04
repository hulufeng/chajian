// Day 4: GPIO 输入 - 读取按键
// 接线：按键一脚 -> GPIO4, 另一脚 -> GND
// 使用内部上拉，按下时读到 LOW

#define BTN_PIN 4
#define LED_PIN 2

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);  // 内部上拉
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  int val = digitalRead(BTN_PIN);
  if (val == LOW) {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("按键按下");
  } else {
    digitalWrite(LED_PIN, LOW);
  }
  delay(50);
}

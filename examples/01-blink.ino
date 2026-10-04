// Day 1: Blink - 让板载 LED 闪烁
// 板载 LED 引脚：ESP32 Dev Module 通常是 GPIO2（或 GPIO13，看板子丝印）

#define LED_PIN 2

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Day1 Blink 启动");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED ON");
  delay(1000);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED OFF");
  delay(1000);
}

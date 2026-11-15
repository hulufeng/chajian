// ESP32-S3-DevKitC-1 板载 LED 接在 GPIO2（少数衍生板在 GPIO48，按需调整）
#ifndef LED_PIN
#define LED_PIN 2
#endif

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

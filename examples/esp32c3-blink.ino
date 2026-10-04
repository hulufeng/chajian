// ESP32-C3 板载 LED 闪烁
// 开发板: ESP32-C3-DevKitM-1
// 板载 LED: GPIO8 (蓝色)

#define LED_PIN 8

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("=== ESP32-C3 Blink ===");
  Serial.printf("CPU: %d MHz\n", getCpuFrequencyMhz());
  Serial.printf("Flash: %d KB\n", ESP.getFlashChipSize() / 1024);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED ON");
  delay(500);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}

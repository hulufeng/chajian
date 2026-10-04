// Day 9: ADC 读取电位器
// 电位器中间脚接 GPIO34 (ADC1_CH6)，两侧接 3.3V 和 GND

#define POT_PIN 34

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);  // 0~4095
}

void loop() {
  int raw = analogRead(POT_PIN);
  float voltage = raw * 3.3 / 4095.0;
  int percent = raw * 100 / 4095;
  Serial.printf("ADC=%4d  电压=%.2fV  旋钮=%d%%\n", raw, voltage, percent);
  delay(200);
}

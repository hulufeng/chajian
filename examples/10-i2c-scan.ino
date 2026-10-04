// Day 10: I2C 总线扫描
// 扫描 I2C 总线上所有设备地址
// SDA=GPIO21, SCL=GPIO22 (ESP32 默认 I2C)

#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Serial.println("I2C 总线扫描开始...");
}

void loop() {
  byte count = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("发现设备: 0x%02X\n", addr);
      count++;
    }
  }
  if (count == 0) Serial.println("未发现 I2C 设备");
  else Serial.printf("共发现 %d 个设备\n", count);
  Serial.println("--- 5 秒后重新扫描 ---");
  delay(5000);
}

// SHT30 温湿度传感器读取 (I2C 0x44)
// 接线: SDA=A4, SCL=A5
#include <Wire.h>

void sht30Init() {
  Wire.begin();
  // 单次测量, no clock stretching
  Wire.beginTransmission(0x44);
  Wire.write(0x24);
  Wire.write(0x00);
  Wire.endTransmission();
}

bool sht30Read(float &temp, float &humi) {
  Wire.requestFrom(0x44, 6);
  if (Wire.available() < 6) return false;

  uint16_t rawT = (Wire.read() << 8) | Wire.read();
  Wire.read(); // CRC
  uint16_t rawH = (Wire.read() << 8) | Wire.read();
  Wire.read(); // CRC

  temp = -45.0 + 175.0 * rawT / 65535.0;
  humi = 100.0 * rawH / 65535.0;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("SHT30 Temperature/Humidity Sensor");
  Serial.println("Use the sliders in the simulator panel to change values.");
}

void loop() {
  sht30Init();
  delay(20);

  float temp, humi;
  if (sht30Read(temp, humi)) {
    Serial.printf("Temp: %.1f C   Humi: %.1f %%\n", temp, humi);
  } else {
    Serial.println("Sensor read failed!");
  }
  delay(1000);
}

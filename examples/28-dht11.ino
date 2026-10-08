// Day 28: DHT11 温湿度传感器
// DHT11 比 DHT22 便宜但精度低,接线一样: DATA=GPIO4
#include <DHT.h>

#define DHT_PIN 4
#define DHT_TYPE DHT11   // 如果是 DHT22 就改成 DHT22
DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
  Serial.println("DHT11 启动");
}

void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("读取失败,检查接线");
  } else {
    Serial.printf("温度: %.1f °C, 湿度: %.1f %%\n", t, h);
  }
  delay(2000);
}

<!--
id: dht
keywords: dht,dht11,dht22,温湿度,温度,湿度,aht20
-->
### DHT11/DHT22 温湿度传感器
读取温湿度用 DHT 库（库管理器搜 DHT sensor library + Adafruit Unified Sensor）：
```cpp
#include <DHT.h>
#define DHTPIN 6
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);
void setup() { Serial.begin(115200); dht.begin(); }
void loop() {
  float t = dht.readTemperature();   // ℃
  float h = dht.readHumidity();      // %
  if (isnan(t) || isnan(h)) { Serial.println("读取失败"); }
  else Serial.printf("温度 %.1f℃ 湿度 %.1f%%\\n", t, h);
  delay(2000);                        // DHT 采样间隔至少 1-2 秒
}
```
接线：VCC→3.3V, GND→GND, DATA→GPIO6。
常见坑：DHT 是单总线时序协议，只能用普通 GPIO 不能用 ADC 脚；连续读太快会返回 NaN；线太长或接触不良读数失败。

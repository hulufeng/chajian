<!--
id: wifi-basics
keywords: wifi,连接网络,wifi.begin,wifi 联网,局域网
-->
### ESP32 WiFi 连接（基础）
```cpp
#include <WiFi.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("你的WiFi名", "密码");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\\n已连接，IP: %s\\n", WiFi.localIP().toString().c_str());
}
void loop() {}
```
要点：WiFi.begin 后轮询 WiFi.status() 直到 WL_CONNECTED；连接失败常见原因：SSID/密码错误、2.4G 频段（ESP32 不支持 5G）、距离远信号弱。
常见坑：WiFi 连接期间 ADC2 不可用（模拟读取会失败）；大电流瞬变导致重启时加电容；连不上时先检查是不是 5G 网络或开启了访客隔离。

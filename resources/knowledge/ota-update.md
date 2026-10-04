<!--
id: ota-update
keywords: ota,远程升级,无线烧录,arduinoota,空中升级,更新固件,web更新,esp_ota
-->
### OTA 空中升级
让设备通过 Wi-Fi 无线更新固件，不用每次插 USB。Arduino 内置 ArduinoOTA（局域网）：
```cpp
#include <WiFi.h>
#include <ArduinoOTA.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("ssid","pass"); while(WiFi.status()!=WL_CONNECTED) delay(300);
  ArduinoOTA.setPassword("admin");
  ArduinoOTA.onStart([](){ Serial.println("start"); });
  ArduinoOTA.onProgress([](unsigned p,unsigned t){ Serial.printf("%u%%\r",p/t*100); });
  ArduinoOTA.onEnd([](){ Serial.println("\ndone"); });
  ArduinoOTA.begin();
}
void loop() { ArduinoOTA.handle(); }
```
然后在 Arduino IDE「端口」里会出现网络端口，直接无线上传。
要点：loop 里要持续 `ArduinoOTA.handle()`；分区表必须选带 OTA 的（默认 default 有两个 OTA app 分区）；更工程化的方案是 HTTP 网页上传或访问 HTTPS 固件 URL 自更新（`Update.h` / ESP-IDF esp_https_ota），配合版本号实现自动升级。

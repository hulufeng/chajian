<!--
id: wifi-softap
keywords: softap,热点,ap,wifi热点,软ap,softapip,手机直连,配网,access point
-->
### Soft-AP 热点模式
不依赖路由器，让 ESP32 自己发出热点，手机/电脑直接连上去（常用于配网、局域网控制）：
```cpp
#include <WiFi.h>
WebServer server(80);
void setup() {
  Serial.begin(115200);
  WiFi.softAP("LabCode-Device", "12345678"); // 名称, 密码(至少8位)
  Serial.print("AP IP: "); Serial.println(WiFi.softAPIP()); // 固定 192.168.4.1
  server.on("/", [](){ server.send(200, "text/plain", "hello"); });
  server.begin();
}
void loop() { server.handleClient(); }
```
要点：连上热点后访问 `192.168.4.1`；不设密码可传 `NULL`（开放网络）；可用 `WiFi.softAP(ssid, pass, channel, hidden, max_connection)` 限制连接数；AP 模式下设备本身不能上网，需要同时上网用 AP+STA 模式。

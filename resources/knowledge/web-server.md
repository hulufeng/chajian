<!--
id: web-server
keywords: web服务器,webserver,网页,server.on,handleclient,浏览器控制,http server,路由,80端口
-->
### 内置 Web 服务器
连上 Wi-Fi 后用 `WebServer` 提供网页，手机/电脑浏览器访问 ESP32 的 IP，可显示数据或控制设备：
```cpp
#include <WiFi.h>
#include <WebServer.h>
WebServer server(80);
void handleRoot() {
  String html = "<h1>LabCode</h1>";
  html += "<a href='/on'>ON</a> <a href='/off'>OFF</a>";
  server.send(200, "text/html", html);
}
void setup() {
  Serial.begin(115200);
  WiFi.begin("ssid", "pass");
  while (WiFi.status() != WL_CONNECTED) delay(300);
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.on("/on", [](){ digitalWrite(2, HIGH); server.send(200,"text/plain","on"); });
  server.on("/off", [](){ digitalWrite(2, LOW); server.send(200,"text/plain","off"); });
  server.begin();
}
void loop() { server.handleClient(); } // 必须在 loop 里持续处理
```
要点：`server.on(path, handler)` 注册路由，`server.send(code, type, body)` 响应；loop 里必须调用 `handleClient()`；带参数用 `server.arg("name")`；需要大量并发/长连接可用异步库 ESPAsyncWebServer。

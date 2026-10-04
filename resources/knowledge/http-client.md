<!--
id: http-client
keywords: http客户端,httpclient,get,post,请求api,获取网页,weather,rest,json,联网请求
-->
### HTTP 客户端（请求外部 API）
ESP32 作为客户端用 `HTTPClient` 访问云接口、获取数据或上报，配合 ArduinoJson 解析返回：
```cpp
#include <WiFi.h>
#include <HTTPClient.h>
void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin("http://httpbin.org/get"); // https 用 https:// 并注意证书/时间
    int code = http.GET();               // 200 成功
    if (code == 200) {
      String payload = http.getString();
      Serial.println(payload);
    } else Serial.printf("HTTP fail: %d\n", code);
    http.end();
  }
  delay(10000);
}
```
POST：`http.addHeader("Content-Type","application/json"); http.POST("{\"a\":1}");`
要点：用完必须 `http.end()` 释放；HTTPS 可用 `http.begin(url, cert)` 传根证书，或临时 `http.setInsecure()`（不校验，仅调试）；NTP 未同步时 TLS 证书校验常失败。

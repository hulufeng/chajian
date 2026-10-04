<!--
id: wifi-reconnect-scan
keywords: 重连,自动重连,断线,扫描,scan,scanNetworks,setAutoReconnect,掉线,wifi断开,信号
-->
### Wi-Fi 自动重连与扫描
设备长期运行要处理掉线：开启自动重连，并在 loop 里检测状态；也可扫描周围网络：
```cpp
void setup() {
  Serial.begin(115200);
  WiFi.begin("ssid", "pass");
  WiFi.setAutoReconnect(true);   // 底层自动重连
  WiFi.persistent(true);
  while (WiFi.status() != WL_CONNECTED) delay(300);
  Serial.println(WiFi.localIP());
}
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("reconnect...");
    WiFi.disconnect(); WiFi.begin("ssid", "pass");
    int n = 0; while (WiFi.status() != WL_CONNECTED && n++ < 20) delay(500);
  }
  delay(3000);
}
```
扫描：`int n = WiFi.scanNetworks();` 后用 `WiFi.SSID(i)`、`WiFi.RSSI(i)`（信号 dBm，越接近 0 越好）、`WiFi.encryptionType(i)` 遍历；扫描较耗时（数百毫秒到数秒），别在高频循环里调用。

<!--
id: esp-now
keywords: esp-now,espnow,点对点,无路由器,mac地址,peer,无线直连,低延迟,一对多
-->
### ESP-NOW 点对点通信
乐鑫自研无连接协议，两块 ESP32 不经路由器直接通信，延迟低、可一对多，适合遥控器、节点直连：
```cpp
#include <WiFi.h>
#include <esp_now.h>
typedef struct { int led; float temp; } Packet;
Packet out;
uint8_t peerMac[] = {0x24,0x6F,0x28,0x12,0x34,0x56};
void onSent(const uint8_t* mac, esp_now_send_status_t st) { Serial.println(st==ESP_NOW_SEND_SUCCESS); }
void setup() {
  Serial.begin(115200); WiFi.mode(WIFI_STA);
  Serial.println(WiFi.macAddress()); // 先打印本机MAC给对端
  esp_now_init();
  esp_now_register_send_cb(onSent);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, peerMac, 6);
  esp_now_add_peer(&peer);
}
void loop() {
  out.led = !out.led; out.temp = analogRead(34);
  esp_now_send(peerMac, (uint8_t*)&out, sizeof(out));
  delay(1000);
}
```
接收端：`esp_now_register_recv_cb(onRecv)`，回调里 `memcpy(&in, data, len)`；两端结构体定义必须一致；可用 `WiFi.mode(WIFI_AP_STA)` 与 Wi-Fi 共存。

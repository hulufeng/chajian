// Day 27: Wi-Fi UDP 通信 —— 局域网内发消息
#include <WiFi.h>
#include <WiFiUdp.h>

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-password";

WiFiUDP udp;
const uint16_t PORT = 4210;

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  Serial.print("已连接, IP=");
  Serial.println(WiFi.localIP());
  udp.begin(PORT);
  Serial.printf("UDP 监听端口 %d, 等待数据...\n", PORT);
}

void loop() {
  int packetSize = udp.parsePacket();
  if (packetSize) {
    char buf[256];
    int len = udp.read(buf, sizeof(buf) - 1);
    buf[len] = 0;
    Serial.printf("收到来自 %s 的消息: %s\n",
      udp.remoteIP().toString().c_str(), buf);

    // 回复
    udp.beginPacket(udp.remoteIP(), udp.remotePort());
    udp.printf("收到: %s", buf);
    udp.endPacket();
  }
  delay(10);
}

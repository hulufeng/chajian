// Day 14: Wi-Fi 连接
// 把下面 SSID 和密码改成你自己的路由器
#include <WiFi.h>

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-password";

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("连接 Wi-Fi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n已连接!");
    Serial.print("IP 地址: ");
    Serial.println(WiFi.localIP());
    Serial.print("信号强度(RSSI): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n连接失败,检查 SSID/密码");
  }
}

void loop() {
  // 每 10 秒打印一次连接状态
  delay(10000);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("在线, IP=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi 断开,重连中...");
    WiFi.reconnect();
  }
}

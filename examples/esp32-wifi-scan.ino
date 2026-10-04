// ESP32 WiFi 扫描示例
// 支持 ESP32 / ESP32-C3 / ESP32-S3

#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("=== WiFi Scanner ===");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
}

void loop() {
  Serial.println("扫描中...");
  int n = WiFi.scanNetworks();
  Serial.printf("找到 %d 个网络:\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  %2d: %-32s  Ch:%2d  RSSI:%4d  %s\n",
      i + 1,
      WiFi.SSID(i).c_str(),
      WiFi.channel(i),
      WiFi.RSSI(i),
      (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "开放" : "加密");
  }
  Serial.println();
  delay(5000);
}

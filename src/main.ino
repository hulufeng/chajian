void setup() { Serial.begin(115200); dht.begin(); }
void loop() {
  float t = dht.readTemperature();   // ℃
  float h = dht.readHumidity();      // %
  if (isnan(t) || isnan(h)) { Serial.println("读取失败"); }
  else Serial.printf("温度 %.1f℃ 湿度 %.1f%%
", t, h);
  delay(2000);                        // DHT 采样间隔至少 1-2 秒
}
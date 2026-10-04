<!--
id: ldr
keywords: 光敏,光敏电阻,ldr,光传感器,亮度检测,photoresistor
-->
### 光敏电阻（测光）
光敏电阻阻值随光照变化，配固定电阻组成分压，再用 ADC 读取：
```cpp
void setup() { Serial.begin(115200); }
void loop() {
  int light = analogRead(4);   // ESP32-C3: ADC 脚 GPIO4
  Serial.println(light);       // 光越强值越大（阻值越小）
  delay(300);
}
```
接线：光敏电阻一端接 3.3V，另一端接 GPIO4 并同时接一个 10k 电阻到 GND（分压）。
常见坑：分压电阻选择影响灵敏度（10k 常用）；光线变化快时读数波动，可多次采样取平均。

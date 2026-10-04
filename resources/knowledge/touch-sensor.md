<!--
id: touch-sensor
keywords: 触摸,touchread,触摸传感器,touch
-->
### 触摸感应（ESP32 特色，无需传感器）
ESP32 部分引脚支持电容触摸，人手靠近即可检测：
```cpp
void setup() { Serial.begin(115200); }
void loop() {
  int t = touchRead(4);      // ESP32-C3: GPIO4 支持触摸
  if (t < 30) Serial.println("触摸到!");  // 值越小=越接近
  delay(100);
}
```
原理：手指靠近改变电容，读数变小。不同板卡/湿度下基准值不同，建议先 Serial 打印原始值确定阈值。
常见坑：触摸脚不能接长导线（灵敏度下降）；C3 的触摸引脚只有部分（GPIO4/5 等，查数据手册）；环境湿度影响读数，阈值要留余量。

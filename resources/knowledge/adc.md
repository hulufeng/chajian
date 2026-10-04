<!--
id: adc
keywords: adc,模拟,analogread,电位器,传感器模拟,电压
-->
### 模拟输入 ADC
读取电位器等模拟电压用 `analogRead()`，ESP32 的 ADC 返回 0-4095（12 位），对应 0-3.3V：
```cpp
void setup() { Serial.begin(115200); }
void loop() {
  int v = analogRead(1);          // ESP32-C3 的 ADC1_CH1 ≈ GPIO1
  Serial.printf("raw=%d voltage=%.2fV\\n", v, v * 3.3 / 4095.0);
  delay(300);
}
```
接线：电位器中间脚接 GPIO（ADC 脚），两外脚分别接 3.3V 和 GND。
常见坑：ESP32-C3 只有 ADC1（GPIO0-4），ADC2 与 WiFi 共用不可用；GPIO5/18 等内部有 ADC 但不同型号引脚不同，先查引脚图；测量范围超 3.3V 会烧 ADC，必须分压。

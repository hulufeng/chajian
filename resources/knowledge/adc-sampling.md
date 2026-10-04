<!--
id: adc-sampling
keywords: 采样,多次采样,平均,滤波,噪声,抖动,smooth
-->
### ADC 读数滤波（多次采样平均）
模拟读数有噪声，多次采样平均更稳定：
```cpp
int readAvg(int pin, int n = 10) {
  long sum = 0;
  for (int i = 0; i < n; i++) { sum += analogRead(pin); delayMicroseconds(100); }
  return sum / n;
}
void setup() { Serial.begin(115200); }
void loop() { Serial.println(readAvg(1)); delay(200); }
```
要点：采样间隔留 100us 让 ADC 稳定；平均次数越多越平滑但响应越慢；可配合 map 归一化。
常见坑：WiFi 开启时 ADC2 通道全不可用（返回异常值）；供电纹波大时读数跳动，加 100nF 电容到 ADC 脚；median 中值滤波对尖峰更鲁棒。

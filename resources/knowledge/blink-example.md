<!--
id: blink-example
keywords: blink,闪烁,点灯,led 闪,第一个程序
-->
### 第一个程序：LED 闪烁（Blink）
```cpp
// 大部分 ESP32-C3 开发板板载 LED 在 GPIO2（低电平点亮）
#define LED 2
void setup() { pinMode(LED, OUTPUT); }
void loop() {
  digitalWrite(LED, HIGH);   // 亮
  delay(500);
  digitalWrite(LED, LOW);    // 灭
  delay(500);
}
```
若板载 LED 是"高电平点亮"（看丝印/原理图），把 HIGH/LOW 对调。
接线外接 LED：GPIO2 → 220Ω → LED 正极(长脚)，LED 负极(短脚) → GND。
验证：上传后 LED 以 0.5s 间隔闪烁；不闪先查端口/板卡选择，再用串口监视器确认程序在跑。

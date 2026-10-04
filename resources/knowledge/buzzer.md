<!--
id: buzzer
keywords: 蜂鸣器,buzzer,tone,音乐,喇叭
-->
### 蜂鸣器（发声）
无源蜂鸣器需要 PWM 频率驱动，用 tone()：
```cpp
void setup() { pinMode(3, OUTPUT); }
void loop() {
  tone(3, 1000); delay(500);    // 1kHz 响 0.5s
  noTone(3); delay(500);
}
```
接线：蜂鸣器正极→GPIO3，负极→GND（有源蜂鸣器直接 HIGH/LOW 即可响）。
常见坑：有源/无源蜂鸣器驱动方式不同（有源给电平、无源给频率）；tone 一次只能一个引脚；大功率蜂鸣器需要三极管驱动。

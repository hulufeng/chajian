<!--
id: digital-input
keywords: digitalread,数字输入,按键,按钮,button,上拉,下拉,pullup,pulldown
-->
### 数字输入与按键
读取按键等数字信号用 `digitalRead()`。按键按下时引脚电平变化，通常需要内部上拉电阻：
```cpp
void setup() { Serial.begin(115200); pinMode(9, INPUT_PULLUP); } // ESP32-C3 上 GPIO9 带板载上拉
void loop() {
  if (digitalRead(9) == LOW) Serial.println("按键按下"); // 上拉时按下为 LOW
  delay(50);
}
```
接线：按键一端接 GPIO，另一端接 GND（配 INPUT_PULLUP）；或一端接 3.3V（配 INPUT_PULLDOWN）。
常见坑：不加上拉/下拉时引脚悬空，读数随机跳动；机械按键有抖动，需 delay(50) 或软件消抖后再判断。

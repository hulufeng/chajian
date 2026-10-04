<!--
id: button-debounce
keywords: 消抖,debounce,抖动,按键检测,long press,长按
-->
### 按键消抖与长按检测
机械按键按下瞬间会抖动，直接判断会误触发多次。软件消抖：
```cpp
const int btn = 9; int last = HIGH; unsigned long lastT = 0;
void setup() { pinMode(btn, INPUT_PULLUP); Serial.begin(115200); }
void loop() {
  int cur = digitalRead(btn);
  if (cur != last) { lastT = millis(); last = cur; }   // 记录变化时刻
  if (cur == LOW && millis() - lastT > 50) {           // 稳定 50ms 才算按下
    Serial.println("按下");
    while (digitalRead(btn) == LOW) delay(10);         // 等待松开（防连发）
  }
}
```
长按：按下后持续计时，超过阈值（如 1s）触发长按事件。
常见坑：消抖时间太短（<20ms）无效；阻塞式等待松开会卡住其他逻辑，复杂程序用状态机或 millis 方案。

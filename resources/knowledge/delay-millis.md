<!--
id: delay-millis
keywords: delay,millis,阻塞,非阻塞,定时,计时
-->
### delay 与 millis：阻塞与非阻塞
delay(ms) 会暂停整个程序，期间无法响应按键等输入。需要"同时做多件事"时用 millis() 计时：
```cpp
unsigned long last = 0;
void setup() { pinMode(2, OUTPUT); }
void loop() {
  if (millis() - last >= 500) {       // 每 500ms 翻转一次（非阻塞）
    last = millis();
    digitalWrite(2, !digitalRead(2));
  }
  // 这里可以同时做按键检测等其他事
}
```
常见坑：millis() 返回 unsigned long，比较要写 `millis() - last >= 间隔`（自动处理溢出），不要写 `millis() >= last + 间隔`。

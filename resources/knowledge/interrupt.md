<!--
id: interrupt
keywords: 中断,interrupt,attachinterrupt,isr
-->
### 外部中断
需要"一有变化立刻响应"（如计脉冲、急停）用中断，而不是轮询：
```cpp
volatile int count = 0;
void IRAM_ATTR onPulse() { count++; }        // ISR 要快、短，不能 delay
void setup() { pinMode(9, INPUT_PULLUP); attachInterrupt(9, onPulse, FALLING); Serial.begin(115200); }
void loop() { Serial.println(count); delay(1000); }
```
常见坑：ISR 里禁止 delay/Serial.print（非中断安全），只改 volatile 变量；ESP32 任意 GPIO 都支持中断；模式 FALLING/RISING/CHANGE/LOW。

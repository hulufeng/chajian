<!--
id: state-machine
keywords: 状态机,多任务,同时,并发,状态切换,多个任务
-->
### 状态机与"同时做多件事"
LED 呼吸 + 按键检测 + 串口输出同时进行，用状态变量 + millis 分时处理：
```cpp
int state = 0; unsigned long last = 0;
void setup() { pinMode(2, OUTPUT); pinMode(9, INPUT_PULLUP); Serial.begin(115200); }
void loop() {
  // 任务1：每 500ms 切换 LED 状态
  if (millis() - last > 500) { last = millis(); digitalWrite(2, !digitalRead(2)); }
  // 任务2：实时检测按键
  if (digitalRead(9) == LOW) { state = 1; Serial.println("按键触发,state=1"); delay(100); }
  // 状态机：根据 state 做不同事
  switch (state) { case 1: /* 状态1逻辑 */ break; }
}
```
常见坑：多个 delay 会让任务互相卡死，复杂程序全部改 millis 轮询；状态切换要处理进入/退出动作（如初始化一次）。

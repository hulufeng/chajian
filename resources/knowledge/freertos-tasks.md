<!--
id: freertos-tasks
keywords: freertos,任务,多任务,xtaskcreate,vtaskdelay,task,并行,并发,调度
-->
### FreeRTOS 多任务
ESP32 跑 FreeRTOS，可用 `xTaskCreate` 把独立功能拆成任务并行运行（替代在一个 loop 里塞所有逻辑）：
```cpp
void blinkTask(void *pv) {
  pinMode(2, OUTPUT);
  while (1) { digitalWrite(2, !digitalRead(2)); vTaskDelay(pdMS_TO_TICKS(500)); }
}
void setup() {
  Serial.begin(115200);
  // 函数, 任务名, 栈(字节), 参数, 优先级(0最低), 句柄
  xTaskCreate(blinkTask, "blink", 2048, NULL, 1, NULL);
}
void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); } // loop 本身也是一个任务
```
要点：任务函数必须是 `void f(void*)` 且内含无限循环；延时用 `vTaskDelay(pdMS_TO_TICKS(ms))`（让出 CPU），不要用死循环空转；栈不够会栈溢出重启，普通任务给 2048~4096 字节，用 String/printf/浮点较多给 4096~8192。

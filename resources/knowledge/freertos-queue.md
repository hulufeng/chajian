<!--
id: freertos-queue
keywords: 队列,queue,xqueuecreate,xqueuesend,xqueuereceive,任务间,传数据,通信
-->
### FreeRTOS 队列（任务间传数据）
任务间不要用全局变量裸传（有竞态），用队列 `QueueHandle_t` 做线程安全的数据传递：采集任务发、处理任务收：
```cpp
QueueHandle_t q;
void sensorTask(void *pv) {
  while (1) { int v = analogRead(34); xQueueSend(q, &v, portMAX_DELAY); vTaskDelay(pdMS_TO_TICKS(100)); }
}
void printTask(void *pv) {
  int v;
  while (1) { if (xQueueReceive(q, &v, portMAX_DELAY)) Serial.println(v); }
}
void setup() {
  Serial.begin(115200);
  q = xQueueCreate(10, sizeof(int)); // 队列长度10，每项大小
  xTaskCreate(sensorTask, "sens", 2048, NULL, 2, NULL);
  xTaskCreate(printTask, "print", 2048, NULL, 1, NULL);
}
void loop() {}
```
要点：`xQueueSend` 第3参数为满时等待时间（`portMAX_DELAY` 一直等、0 不等）；队列按值拷贝，传结构体把 `int` 换成结构体类型；也可传指针但要保证生命周期。

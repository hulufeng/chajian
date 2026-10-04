<!--
id: freertos-semaphore-mutex
keywords: 信号量,互斥锁,mutex,semaphore,xsemaphorecreate,xsemaphoretake,xsemaphoregive,共享资源,临界区
-->
### 信号量与互斥锁
多个任务访问同一硬件/全局数据（如同时 Serial、I2C、写同一变量）要用互斥锁串行化，否则数据错乱：
```cpp
SemaphoreHandle_t mtx;
void taskA(void *pv) {
  while (1) {
    xSemaphoreTake(mtx, portMAX_DELAY);   // 加锁
    Serial.print("A owns it, shared="); Serial.println(millis());
    xSemaphoreGive(mtx);                  // 解锁（务必配对）
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}
void setup() {
  Serial.begin(115200);
  mtx = xSemaphoreCreateMutex();
  xTaskCreate(taskA, "A", 2048, NULL, 1, NULL);
  xTaskCreate(taskA, "B", 2048, NULL, 1, NULL);
}
void loop() {}
```
要点：Mutex（`xSemaphoreCreateMutex`）用于保护共享资源，take/give 必须配对，忘记 give 会死锁；二值信号量（`xSemaphoreCreateBinary`）多用于中断与任务间同步，ISR 里要用 `xSemaphoreGiveFromISR`。

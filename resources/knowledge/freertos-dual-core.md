<!--
id: freertos-dual-core
keywords: 双核,核心,core,xtaskcreatepinnedtocore,core0,core1,cpu,亲和,pinned
-->
### 双核任务分配
ESP32 经典款有两个核：Core0（PRO_CPU，默认跑 Wi-Fi/蓝牙协议栈）、Core1（APP_CPU，默认跑 Arduino 的 setup/loop）。用 `xTaskCreatePinnedToCore` 指定任务跑在哪个核：
```cpp
void netTask(void *pv) { while (1) { /* 网络相关 */ vTaskDelay(pdMS_TO_TICKS(10)); } }
void calcTask(void *pv) { while (1) { /* 重计算 */ vTaskDelay(pdMS_TO_TICKS(10)); } }
void setup() {
  xTaskCreatePinnedToCore(netTask,  "net",  4096, NULL, 1, NULL, 0); // 网络放 core0
  xTaskCreatePinnedToCore(calcTask, "calc", 4096, NULL, 1, NULL, 1); // 计算放 core1
}
void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }
```
要点：不指定核用 `xTaskCreate`（由调度器安排）；别让重计算阻塞 core0，否则会拖累 Wi-Fi/蓝牙导致掉线；ESP32-C3 是**单核**，没有该函数；S3 也是双核。

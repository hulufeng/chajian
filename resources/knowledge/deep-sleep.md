<!--
id: deep-sleep
keywords: 深度睡眠,deep sleep,低功耗,休眠,唤醒,esp_sleep,wakeup,ext0,电池,省电,light sleep
-->
### 深度睡眠与唤醒
电池供电、周期性采集上报的节点用 deep sleep：干完活后睡，定时或按键唤醒。唤醒后相当于复位、重新跑 setup：
```cpp
#define SECONDS 60
RTC_DATA_ATTR int bootCount = 0; // RTC 内存变量，深睡后保留
void setup() {
  Serial.begin(115200); delay(200);
  ++bootCount;
  Serial.printf("wake #%d reason=%d\n", bootCount, esp_sleep_get_wakeup_cause());
  // ...读传感器、上报...
  esp_sleep_enable_timer_wakeup(SECONDS * 1000000ULL); // 定时唤醒(微秒)
  esp_deep_sleep_start();
}
void loop() {}
```
GPIO 唤醒：`esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, LOW)`（按键接 RTC 引脚到 GND）。
功耗对比：Active 约 40~240mA，Light-sleep 约 0.8mA（内存/外设保持、可被快速唤醒），Deep-sleep 约 10µA，Hibernation 约 2.5µA。需深睡保留数据用 `RTC_DATA_ATTR`；更复杂的低功耗采集可用 ULP 协处理器。

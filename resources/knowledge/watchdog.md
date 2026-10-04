<!--
id: watchdog
keywords: 看门狗,watchdog,wdt,重启,复位,twdt,喂狗,panic,aborting,rst cause,卡顿死机
-->
### 看门狗与莫名重启
ESP32 有任务看门狗（TWDT，Arduino loop 任务默认约 5 秒）。当任务长时间占着 CPU 不 yield（死循环、长时间阻塞/忙等），看门狗触发后打印 `Task watchdog got wdt trigger` 并复位：
```cpp
void loop() {
  while (someCondition) {
    // 长时间循环里必须让出 CPU，否则触发看门狗
    vTaskDelay(pdMS_TO_TICKS(1)); // 或 delay(1)/yield()，会喂狗
  }
}
```
要点：Arduino 的 `delay()/yield()/vTaskDelay()` 内部会喂 TWDT，所以单纯 `delay(10000)` 不会复位；真正触发是**不带任何 yield 的死循环或长时间阻塞调用**。查复位原因用 `esp_reset_reason()` / `rtc_get_reset_reason(0)`；中断看门狗（IWDT）多因 ISR 里做了太多事、或关中断太久，ISR 要尽量短。

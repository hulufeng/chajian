<!--
id: esp-idf-vs-arduino
keywords: esp-idf,idf,arduino,框架,app_main,cmake,menuconfig,idf.py,sdkconfig,区别,原生
-->
### ESP-IDF 与 Arduino 框架
Arduino-ESP32 本身构建在 ESP-IDF 之上，把底层封装成 `setup/loop`、`digitalWrite` 等 Wiring API；ESP-IDF 是乐鑫官方原生框架，功能最全、可控性最高：
```c
// ESP-IDF 入口（没有 setup/loop）
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
void app_main(void) {
    gpio_configure(...);
    while (1) { vTaskDelay(pdMS_TO_TICKS(1000)); }
}
```
对比：ESP-IDF 用 `app_main()` 入口、`CMakeLists.txt` 组织组件、`idf.py build/flash/monitor` 构建、`idf.py menuconfig` 生成 sdkconfig 配置；Arduino 上手快、库多，适合快速原型。需要 FreeRTOS 精细控制、TWAI/USB/电源管理等新特性时选 ESP-IDF；两者也可在 PlatformIO 里混用。

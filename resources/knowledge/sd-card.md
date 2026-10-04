<!--
id: sd-card
keywords: sd卡,sd,microsd,数据记录,logger,csv,大容量存储,sdmmc
-->
### SD 卡与数据记录
大量数据（历史日志、CSV、音频）用 microSD。Arduino `SD` 库走 SPI 模式（接线简单、兼容好）：
```cpp
#include <SPI.h>
#include <SD.h>
File log;
void setup() {
  Serial.begin(115200);
  if (!SD.begin(5)) { Serial.println("SD init fail"); return; } // CS=5
  log = SD.open("/datalog.csv", FILE_APPEND);
  if (log) { log.print(millis()); log.print(","); log.println(analogRead(34)); log.close(); }
}
void loop() {}
```
要点：模块多为 5V 供电但信号 3.3V 可直接接；`SD.open(path, FILE_WRITE/FILE_APPEND)`，记得 `close()` 才真正落盘；ESP-IDF 用 SDMMC 4 线模式速度更快；频繁记录用追加模式并批量 flush，减少写卡次数。

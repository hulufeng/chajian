<!--
id: littlefs-filesystem
keywords: littlefs,spiffs,文件系统,读写文件,flash文件,fs,目录,data,保存日志
-->
### LittleFS 文件系统
在板载 flash 上读写文件（存网页、配置、日志、数据记录），新版推荐 LittleFS（掉电安全，SPIFFS 已弃用）：
```cpp
#include <LittleFS.h>
void setup() {
  Serial.begin(115200);
  LittleFS.begin(true); // true=不存在则格式化
  // 写文件
  File f = LittleFS.open("/log.txt", "w");
  f.println("hello"); f.close();
  // 读文件
  File r = LittleFS.open("/log.txt", "r");
  while (r.available()) Serial.write(r.read());
  r.close();
}
void loop() {}
```
要点：上传文件系统镜像用 Arduino 的「Upload LittleFS Image」工具；模式 `"w"` 覆盖写、`"a"` 追加、`"r"` 读；Web 服务器可用 `server.serveStatic("/", LittleFS, "/index.htm")` 直接托管网页；空间受分区表大小限制。

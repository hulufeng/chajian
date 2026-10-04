<!--
id: preferences-nvs
keywords: preferences,nvs,掉电保存,保存配置,持久化,键值,存储设置,记住,非易失
-->
### Preferences（NVS 键值存储）
要把配置/计数在断电后保留（如阈值、设备名、累计次数），用 Preferences 写入 NVS（基于 flash 的键值库），比手撸 EEPROM 方便：
```cpp
#include <Preferences.h>
Preferences prefs;
void setup() {
  Serial.begin(115200);
  prefs.begin("cfg", false);          // 命名空间, false=可读写
  int boot = prefs.getInt("boot", 0); // 键, 默认值
  prefs.putInt("boot", boot + 1);
  Serial.printf("boot count=%d\n", boot + 1);
  if (!prefs.isKey("name")) prefs.putString("name", "labcode");
  prefs.end();
}
void loop() {}
```
要点：支持 put/get 的 Bool/Int/UnsignedInt/Long/Float/Double/String/Bytes；`begin(name,false)` 才是可写，`true` 只读；写 flash 有寿命（约 10 万次），别在高频循环里频繁写；清空用 `clear()`。

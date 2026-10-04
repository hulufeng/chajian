<!--
id: seven-seg
keywords: 数码管,seven,segment,tm1637,显示数字
-->
### 数码管（TM1637 四位数码管）
用 TM1637 库（库管理器搜 TM1637），两根线驱动 4 位数字：
```cpp
#include <TM1637Display.h>
#define CLK 3
#define DIO 4
TM1637Display display(CLK, DIO);
void setup() { display.setBrightness(7); }
void loop() {
  display.showNumberDec(1234); delay(1000);
  display.showNumberDec(millis() / 1000, true);  // 带前导0显示秒数
}
```
接线：CLK→GPIO3，DIO→GPIO4，VCC→3.3V/5V，GND→GND。
常见坑：CLK/DIO 接反不显示；段码（显示字母）需查库的段码表；亮度 setBrightness 0-7。

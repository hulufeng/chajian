<!--
id: i2c
keywords: i2c,wire,wire.begin,sda,scl,oled,ssd1306,aht20,iic
-->
### I2C 总线（OLED、温湿度传感器）
I2C 用两根线（SDA 数据、SCL 时钟）挂多个设备，ESP32-C3 上 SDA=GPIO8、SCL=GPIO9：
```cpp
#include <Wire.h>
void setup() { Wire.begin(8, 9); Serial.begin(115200); }
void loop() {
  Wire.beginTransmission(0x3C);    // 常见 OLED 地址
  if (Wire.endTransmission() == 0) Serial.println("设备在线");
  delay(1000);
}
```
常见坑：SDA/SCL 引脚不能接反；地址（0x3C/0x3D/0x38）不同设备不同，I2C 扫描才能确定；总线要共地；上拉电阻一般已内置于模块，无模块时才需外接 4.7k。

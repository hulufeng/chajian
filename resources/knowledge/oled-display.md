<!--
id: oled-display
keywords: oled,display,ssd1306,u8g2,adafruit_ssd1306,显示文字
-->
### OLED 显示屏（SSD1306，I2C）
显示文字用 Adafruit_SSD1306 库（需安装，Arduino 库管理器搜 SSD1306）：
```cpp
#include <Wire.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
void setup() {
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);   // 地址 0x3C
  oled.clearDisplay();
  oled.setTextSize(2); oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0); oled.print("Hello ESP32");
  oled.display();                            // 必须调用 display() 才上屏
}
void loop() {}
```
接线：VCC→3.3V, GND→GND, SDA→GPIO8, SCL→GPIO9（ESP32-C3）。
常见坑：不调用 display() 屏幕空白；中文需要取模字库（默认库只支持 ASCII）；地址不对就扫描 I2C。

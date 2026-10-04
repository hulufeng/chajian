<!--
id: st7789-tft
keywords: st7789,tft,彩屏,彩色显示,ili9341,spi屏幕,lcd,240x320
-->
### ST7789 彩色 TFT
ST7789（240×240/240×320）用 SPI 驱动彩色屏，比 OLED 能显示彩色图形/界面（ILI9341 同类），用 TFT_eSPI：
```cpp
#include <TFT_eSPI.h>
TFT_eSPI tft = TFT_eSPI();
void setup() {
  tft.init(); tft.setRotation(1); tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE,TFT_BLACK); tft.setTextSize(2);
  tft.setCursor(0,0); tft.println("LabCode");
}
void loop() { tft.fillCircle(50,50,10,TFT_RED); delay(500); tft.fillCircle(50,50,10,TFT_BLUE); delay(500); }
```
接线：SCL=SCK、SDA=MOSI、RES=RST、DC、CS（部分模块 CS 可固定）、BL 背光。
要点：TFT_eSPI 需在 `User_Setup.h`（或 PlatformIO build flags）选驱动型号和引脚，否则不亮；刷屏数据量大，用 SPI 并减少全屏重绘；触摸款（CYD）另有 XPT2046 触摸。

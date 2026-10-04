<!--
id: rgb-led
keywords: rgb,rgb led,ws2812,neopixel,灯带,彩灯,adafruit_neopixel
-->
### RGB LED 与 WS2812 灯带
普通 RGB LED 是 4 脚（共阳/共阴），WS2812 灯带是单线协议、可串联无数颗：
```cpp
#include <Adafruit_NeoPixel.h>
#define PIN 6
#define NUMPIXELS 8
Adafruit_NeoPixel strip(NUMPIXELS, PIN, NEO_GRB + NEO_KHZ800);
void setup() { strip.begin(); strip.show(); }
void loop() {
  for (int i = 0; i < NUMPIXELS; i++) { strip.setPixelColor(i, strip.Color(255, 0, 0)); }
  strip.show(); delay(500);
  strip.clear(); strip.show(); delay(500);
}
```
接线：WS2812 DIN→GPIO，VCC→5V，GND→GND（灯带长时需外接电源）。
常见坑：WS2812 单线时序敏感，用库驱动别手拼；颜色顺序常见 GRB（也有 RGB），不对时改 `NEO_GRB/RGB`；每颗满白约 60mA，灯带超过十几颗必须独立 5V 供电并与 ESP32 共地，不能从板载 5V/USB 取；改色后必须 `show()` 才刷新。普通 4 脚 RGB LED（共阳/共阴）则用三路 PWM 分别调 R/G/B，不需要数据协议。

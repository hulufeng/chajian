<!--
id: esp32-builtin-led
keywords: 板载led,内置led,led_builtin,rgb,内置灯,wifi指示灯
-->
### ESP32 板载 LED（不同板卡不同）
- 经典 ESP32 DevKit：GPIO2（高电平点亮，有的板是 GPIO5）
- ESP32-C3 超级迷你：GPIO2（**低电平点亮**，部分板 GPIO8）
- ESP32-S3：多为 **GPIO48 或板载 RGB WS2812**（GPIO9/48，需 NeoPixel 库）
```cpp
#define LED 2
void setup() { pinMode(LED, OUTPUT); }
void loop() { digitalWrite(LED, LOW); delay(500); digitalWrite(LED, HIGH); delay(500); }
```
常见坑：LED_BUILTIN 宏在不同核心可能未定义或值不对；C3 板载 LED 低电平点亮（HIGH=灭），与经典板相反，点不亮先对调 HIGH/LOW。

// ESP32-S3 板载 RGB LED (WS2812) 彩虹灯
// 开发板: ESP32-S3-DevKitC-1
// 板载 RGB: GPIO48 (WS2812)

#include <Adafruit_NeoPixel.h>

#define RGB_PIN 48
#define RGB_COUNT 1

Adafruit_NeoPixel pixels(RGB_COUNT, RGB_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("=== ESP32-S3 RGB LED ===");
  pixels.begin();
  pixels.setBrightness(30);
  pixels.clear();
}

void loop() {
  // 红 -> 橙 -> 黄 -> 绿 -> 青 -> 蓝 -> 紫
  for (int hue = 0; hue < 65536; hue += 256) {
    pixels.setPixelColor(0, pixels.gamma32(pixels.ColorHSV(hue)));
    pixels.show();
    delay(20);
  }
}

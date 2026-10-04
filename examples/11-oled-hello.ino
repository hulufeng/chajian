// OLED SSD1306 Hello World
// 接线: SDA=A4, SCL=A5
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("OLED init...");

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED not found!");
    while (true) delay(1000);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("CodeLab OLED");
  display.println("Hello!");
  display.println("");
  display.printf("Uptime: %lu s", millis() / 1000);
  display.display();
  Serial.println("OLED ready");
}

void loop() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("CodeLab Simulator");
  display.println("");
  display.printf("Time: %lu s", millis() / 1000);
  display.printf("\nADC A0: %d", analogRead(A0));
  display.display();
  delay(1000);
}

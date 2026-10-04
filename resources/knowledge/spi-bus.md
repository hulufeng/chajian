<!--
id: spi-bus
keywords: spi,spi总线,mosi,miso,sck,cs,片选,spi设备,高速总线
-->
### SPI 总线
SPI 用于高速外设：TFT 彩屏、SD 卡、部分 ADC/传感器。四根线 SCK/MOSI/MISO + 每设备独立 CS：
```cpp
#include <SPI.h>
#define CS 5
void setup() {
  Serial.begin(115200);
  SPI.begin(18, 19, 23, 5); // SCK,MISO,MOSI,CS（默认 VSPI: 18/19/23）
  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);
}
uint8_t spiXfer(uint8_t cmd) {
  digitalWrite(CS, LOW);
  uint8_t r = SPI.transfer(cmd); // 全双工收发一字节
  digitalWrite(CS, HIGH);
  return r;
}
void loop() { Serial.println(spiXfer(0x9F)); delay(1000); }
```
要点：ESP32 有 VSPI/HSPI 两组；多设备共用 SCK/MOSI/MISO、各接一个 CS，通信时拉低自己的 CS；`SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0))` 设速率/模式，结束 `endTransaction()`；大多数库（TFT_eSPI、SD）已封装好底层。

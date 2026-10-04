<!--
id: esp32-s3-pins
keywords: esp32-s3,esp32s3,引脚图,开发板
-->
### ESP32-S3 常用引脚
- GPIO1-4：ADC1 通道（模拟输入）
- GPIO5-6：常用 GPIO（部分板型接 USB 相关，慎用）
- GPIO7/8：USB OTG 相关（接 Type-C 的板子）
- GPIO8：部分板卡带 RGB LED（WS2812，需 NeoPixel 库）
- GPIO9：板载 RGB LED（部分）
- GPIO35-37：GPIO 输出专用（部分核心）
- GPIO38-42：ADC 通道（模拟输入）
- GPIO47/48：RGB LED / PSram 相关（n8r8 等型号）
- 3V3 / 5V / GND
常见坑：S3 引脚复用多（USB/PSram/ADC），**接外设前先查你手里板卡的丝印与原理图**；部分 GPIO 出厂接板载器件（LED/按键），直接驱动外部器件会冲突。

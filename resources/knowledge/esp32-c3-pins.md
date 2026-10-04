<!--
id: esp32-c3-pins
keywords: esp32-c3,esp32c3,引脚图,板载led,内置led,gpio8,gpio9,超级迷你
-->
### ESP32-C3 常用引脚（超级迷你/开发板）
- GPIO0：ADC1_CH0，可做模拟输入
- GPIO1：ADC1_CH1
- GPIO2：ADC1_CH2，一般开发板**板载 LED**（低电平点亮，digitalWrite(2, LOW) 亮）
- GPIO3：ADC1_CH3
- GPIO4：ADC1_CH4
- GPIO6：SPI SCK / 可做普通 IO
- GPIO7：SPI MOSI
- GPIO8：**I2C SDA**
- GPIO9：**I2C SCL**（部分板型带板载按键，注意按下会拉低）
- GPIO10：串口 RX（USB 串口复用）
- GPIO18/19：USB 相关，尽量别用
- 3V3 / 5V / GND / 3.3V 电源引脚
常见坑：GPIO9 板载按键/上拉会影响外部使用；ADC2 通道与 WiFi 冲突不可用于模拟读取；GPIO18/19 接 USB 转串口芯片，用作普通 IO 可能干扰下载。

<!--
id: gpio
keywords: gpio,引脚,pinmode,digitalwrite,digitalread,输出引脚,输入引脚
-->
### GPIO 引脚是什么
GPIO（General Purpose Input/Output）是芯片上可以编程控制的引脚，既能输出高/低电平，也能读取外部电平。
- 输出：用 `pinMode(pin, OUTPUT)` 设为输出，`digitalWrite(pin, HIGH/LOW)` 输出 3.3V/0V
- 输入：用 `pinMode(pin, INPUT)` 设为输入，`digitalRead(pin)` 读回 HIGH/LOW
示例（LED 闪烁）：
```cpp
void setup() { pinMode(2, OUTPUT); }
void loop() { digitalWrite(2, HIGH); delay(500); digitalWrite(2, LOW); delay(500); }
```
接线：LED 正极（长脚）接 GPIO2，负极串一个 220Ω 电阻接 GND。
常见坑：ESP32 引脚是 3.3V 电平，不能直接接 5V 器件；GPIO 输出电流约 40mA，驱动 LED 必须串限流电阻。

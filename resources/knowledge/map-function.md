<!--
id: map-function
keywords: map(,映射,转换范围,constrain,analogread 转换
-->
### map() 与 constrain()
把 ADC 值(0-4095)映射到常用范围：
```cpp
int raw = analogRead(1);                 // 0-4095
int percent = map(raw, 0, 4095, 0, 100); // 0-100
int pwm = map(raw, 0, 4095, 0, 255);     // 0-255（LED 亮度）
pwm = constrain(pwm, 0, 255);            // 防越界
```
- map(value, fromLow, fromHigh, toLow, toHigh)：线性映射
- constrain(value, min, max)：把值限制在范围内
常见坑：map 只做线性映射，温度等非线性传感器不要直接用；输入超出范围时 map 会越界输出，配合 constrain 使用。

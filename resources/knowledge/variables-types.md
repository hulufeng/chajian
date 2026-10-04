<!--
id: variables-types
keywords: 变量,int,float,byte,类型,unsigned long,数据类型
-->
### 常用数据类型
- int：整数，16 位（-32768~32767），存 analogRead 结果足够
- unsigned long：0~42亿，**必须用于 millis() 返回值**和长时间计数
- float：小数（温度 25.5），打印用 %f
- byte：0-255，存 LED 亮度/PWM 值
- bool：true/false，存开关状态
- String：文本（慎用，会碎片化内存）
- char[]：字符数组（C 风格，内存可控）
常见坑：int 溢出（计数器超过 32767 变负数）；millis() 必须用 unsigned long 存，用 int 会在 32 秒后出错；String 大量拼接会造成内存碎片，长期运行程序优先用 char[]。

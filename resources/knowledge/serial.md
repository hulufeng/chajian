<!--
id: serial
keywords: serial,串口,serial.begin,serial.print,serial.println,波特率
-->
### 串口输出（调试基础）
Serial 串口是把数据发给电脑看的最常用调试手段：
```cpp
void setup() { Serial.begin(115200); }        // 波特率必须与串口监视器一致
void loop() { Serial.println("hello"); Serial.println(millis()); delay(1000); }
```
使用要点：
- Serial.begin(115200) 只写一次，波特率要和软件串口监视器完全一致
- Serial.print 不换行，println 换行；printf 支持格式化：Serial.printf("v=%d\\n", v)
- 中文乱码一般是波特率不一致，或串口监视器编码选错
常见坑：Serial.begin 后立即 println 可能丢前几条（缓冲区未就绪），可加 delay(100)；USB 转串口芯片驱动没装会找不到端口。

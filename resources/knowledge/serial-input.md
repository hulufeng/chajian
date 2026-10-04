<!--
id: serial-input
keywords: serial.read,串口输入,接收数据,serial.available,串口控制,上位机
-->
### 串口接收数据（电脑控制开发板）
用 Serial.available() 检查是否有数据，Serial.read() 读取：
```cpp
void setup() { Serial.begin(115200); pinMode(2, OUTPUT); }
void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == '1') digitalWrite(2, HIGH);   // 发 1 点亮
    if (c == '0') digitalWrite(2, LOW);    // 发 0 熄灭
    Serial.println("收到指令");
  }
}
```
要点：available() 返回待读字节数；read() 每次读一个字节；多字节指令需自己组帧（如以换行结束）。
常见坑：read() 读的是 ASCII 码（'1' 是字符 49，不是数字 1）；接收中文需处理编码；串口缓冲区默认 256 字节，数据量大会溢出丢失。

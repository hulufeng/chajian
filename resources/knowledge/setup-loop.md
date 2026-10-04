<!--
id: setup-loop
keywords: setup,loop,主程序,arduino 结构,初始化,arduino框架
-->
### Arduino/ESP32 程序结构
任何 Arduino 程序只有两个必需函数：
```cpp
void setup() {
  // 上电只执行一次：初始化引脚、串口、传感器
  pinMode(2, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  // 上电后无限循环执行
  digitalWrite(2, HIGH); delay(500); digitalWrite(2, LOW); delay(500);
}
```
要点：setup 里做初始化，loop 里做反复执行的事；全局变量定义在 setup 之前；loop 结束时自动从头再来。
常见坑：把初始化写进 loop 会导致反复初始化（如 Serial.begin 反复调用）；delay 让 loop 变慢时改用 millis。

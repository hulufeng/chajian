<!--
id: pir-motion
keywords: pir,人体红外,人体感应,运动检测,hc-sr501,有人,感应灯,存在
-->
### PIR 人体红外感应
PIR（如 HC-SR501）检测移动的人体（红外温度变化），输出 HIGH 一段时间，用于感应灯、安防：
```cpp
#define PIR 27
void setup() {
  Serial.begin(115200);
  pinMode(PIR, INPUT); pinMode(2,OUTPUT);
}
void loop() {
  if (digitalRead(PIR)==HIGH) {
    Serial.println("有人"); digitalWrite(2,HIGH);
  } else digitalWrite(2,LOW);
  delay(100);
}
```
要点：只能检测**移动**的热源，静止不动检测不到（要静态存在检测用 mmWave 毫米波雷达）；模块上电后有约 30~60 秒预热；板上两个电位器调灵敏度和延时；HC-SR501 多为 5V 供电，信号 3.3V 可接；避免正对暖气、阳光、空调出风口以免误触发。

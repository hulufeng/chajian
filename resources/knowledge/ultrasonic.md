<!--
id: ultrasonic
keywords: 超声波,ultrasonic,hcsr04,hc-sr04,测距,距离
-->
### 超声波测距 HC-SR04
发射超声波并测回波时间算距离，只需普通 GPIO：
```cpp
#define TRIG 7
#define ECHO 10
void setup() { pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); Serial.begin(115200); }
void loop() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH);          // 回波时间(微秒)
  float cm = us / 58.0;                    // 声速换算
  Serial.printf("距离 %.1f cm\\n", cm);
  delay(500);
}
```
接线：VCC→5V（模块需要 5V），TRIG→GPIO7，ECHO→GPIO10（用分压到 3.3V 更稳妥），GND→GND。
常见坑：ECHO 回 5V 电平，直接接 3.3V GPIO 长期有风险（建议分压/电平转换）；测量死角：小于 2cm 不准确、大于 4m 超量程；pulseIn 超时返回 0。

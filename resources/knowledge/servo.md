<!--
id: servo
keywords: 舵机,servo,servo.write,角度
-->
### 舵机（角度控制）
舵机用 PWM 控制角度（0-180°），用内置 Servo 库：
```cpp
#include <Servo.h>
Servo myservo;
void setup() { myservo.attach(5); }   // 信号线接 GPIO5
void loop() {
  myservo.write(0); delay(1000);
  myservo.write(90); delay(1000);
  myservo.write(180); delay(1000);
}
```
接线：舵机三根线：棕/黑=GND，红=5V（外部供电），橙/黄=信号→GPIO。
常见坑：舵机堵转会烧；多个舵机电流大需外部 5V 供电并共地，不能全接板载 3.3V；Servo.attach 后第一下 write 会猛转，先写当前角度。

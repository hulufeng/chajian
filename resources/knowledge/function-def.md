<!--
id: function-def
keywords: 函数,自定义函数,封装,返回值,void,参数
-->
### 自定义函数
把重复代码封装成函数，程序更清晰：
```cpp
void blinkLed(int pin, int times) {      // 参数：引脚、次数
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH); delay(200); digitalWrite(pin, LOW); delay(200);
  }
}
float celsius(int raw) { return raw * 3.3 / 4095.0 * 100.0; }  // 返回计算值
void setup() { pinMode(2, OUTPUT); }
void loop() { blinkLed(2, 3); delay(1000); }
```
要点：无返回值用 void；有返回值写类型（int/float/bool）；函数定义在使用之前（或声明原型）。
常见坑：函数里 delay 会阻塞全局；参数传值不传引用（改外部变量要传指针/引用，或用返回值）；float 比较不要用 ==（精度问题）。

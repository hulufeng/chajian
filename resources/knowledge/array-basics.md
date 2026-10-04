<!--
id: array-basics
keywords: 数组,array,[],元素,遍历
-->
### 数组
存放一组同类数据（如多个引脚、音符）：
```cpp
int pins[] = {2, 3, 4, 5};          // 4 个 LED 引脚
void setup() {
  for (int i = 0; i < 4; i++) pinMode(pins[i], OUTPUT);
}
void loop() {
  for (int i = 0; i < 4; i++) { digitalWrite(pins[i], HIGH); delay(200); digitalWrite(pins[i], LOW); }
}
```
- 下标从 0 开始：pins[0] 是第一个元素
- 遍历用 for + 数组长度；获取长度 sizeof(arr)/sizeof(arr[0])
常见坑：下标越界（访问 pins[4]）会导致程序崩溃/重启，不报错！用 sizeof 计算长度而不是写死数字；声明时可不写大小但必须初始化。

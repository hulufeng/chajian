<!--
id: if-switch
keywords: if,else,switch,case,判断,条件
-->
### if/else 与 switch 判断
```cpp
int mode = 2;
if (mode == 1) { Serial.println("模式1"); }
else if (mode == 2) { Serial.println("模式2"); }
else { Serial.println("其他"); }
switch (mode) {
  case 1: Serial.println("模式1"); break;
  case 2: Serial.println("模式2"); break;
  default: Serial.println("其他");
}
```
要点：比较用 ==（不是 =）；判断多个互斥条件用 else if；分支多时 switch 更清晰。
常见坑：把 = 写成 ==（赋值永远为真）；忘记 break 会顺序执行后续 case；浮点数不要用 == 比较。

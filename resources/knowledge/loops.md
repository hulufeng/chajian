<!--
id: loops
keywords: for,while,循环,死循环,break,continue
-->
### for / while 循环
```cpp
for (int i = 0; i < 10; i++) { Serial.println(i); }   // 0-9
int n = 0;
while (n < 5) { Serial.println("x"); n++; }           // 5 次
```
- for(初始化; 条件; 步进)：最常用
- while(条件)：条件不满足就退出
- break 跳出循环，continue 跳过本次
常见坑：忘记更新循环变量导致死循环（程序卡死）；while 条件永远为真=死循环，谨慎用 while(1)；循环里 delay 太长会让其他功能响应慢。

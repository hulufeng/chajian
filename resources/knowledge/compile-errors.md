<!--
id: compile-errors
keywords: 编译错误,编译报错,error,未声明,undeclared,not declared,was not declared,找不到库,库,include,编译失败
-->
### 常见编译错误
| 报错 | 原因 | 解决 |
|---|---|---|
| 'xxx' was not declared | 函数/变量未定义或头文件没包含 | 加 #include 对应库；检查拼写大小写 |
| No such file or directory (库名) | 库没安装 | 工具→管理库→搜索安装（如 DHT、Adafruit SSD1306） |
| Multiple libraries were found | 装了多个同名库冲突 | 卸载多余的，或指定版本 |
| 'Serial' was not declared | 没包含框架头 | Arduino IDE 自动加，PlatformIO 需 #include <Arduino.h> |
| exit status 1 | 编译失败统称 | 看上面具体错误行，从第一处 error 开始修 |
| Sketch too large | 程序超内存 | 删无用库/优化代码；选更大的分区方案 |
常见坑：报错信息要看**第一个 error**（后面的往往是连带）；中文路径/中文项目名会导致部分工具链失败，项目目录用英文。

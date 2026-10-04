<!--
id: strapping-pins
keywords: strapping,启动引脚,不能用的引脚,gpio0,gpio12,引脚禁忌,仅输入,34 35 36 39,启动模式
-->
### Strapping 引脚与引脚禁忌
ESP32 经典款部分引脚在**上电/复位瞬间**的电平决定启动模式，接错外设可能导致无法启动/下载：
- Strapping：GPIO0（下载/启动模式，BOOT 键）、GPIO2、GPIO12（MTDI，决定 flash 电压，上电必须低）、GPIO15（MTDO）。
- 仅输入：GPIO34/35/36/39，无内部上拉下拉，**不能 digitalWrite / 作输出/PWM/I2C**，适合做模拟/输入。
- GPIO6~11：连接内置 flash，**不可使用**。

要点：上电失败/反复重启先排查 GPIO12、GPIO0 上外设是否把电平拉高；上电后这些 strapping 脚可作普通用，但要保证启动瞬间电平正确；输入专用脚接模拟传感器时注意外部电平。

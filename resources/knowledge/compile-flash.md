<!--
id: compile-flash
keywords: 编译,烧录,上传,upload,compile,arduino-cli,platformio,端口,选择端口
-->
### 编译与烧录（上传）流程
1. **选择板卡**：工具→开发板→ESP32-C3/S3（对应你的型号）
2. **选择端口**：设备管理器→端口(COM 和 LPT) 找到 COM 号（如 COM3），插拔板子对比变化
3. **编译**：点击编译（✓），输出区出现"Sketch uses X bytes"即成功
4. **烧录**：点击上传，烧录时**部分板子需按住 BOOT 键**直到出现"Connecting..."再松开
5. **验证**：打开串口监视器，波特率选代码里 Serial.begin 的值（常用 115200）
常见坑：端口没识别=驱动没装（CH340/CP210x）；烧录失败 "Connecting... 超时"=按住 BOOT 再试；上传时板子被占用（串口监视器开着）会失败，先关监视器。

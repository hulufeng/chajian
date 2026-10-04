<!--
id: pwm
keywords: pwm,analogwrite,呼吸灯,ledc,pwm通道,占空比,亮度
-->
### PWM 输出（LED 亮度/舵机）
PWM 是快速切换高低的方波，通过改变占空比控制平均电压（如 LED 亮度）。
ESP32 用 LEDC 硬件通道（Arduino 的 analogWrite 在较新核心上自动映射）：
```cpp
void setup() { ledcAttach(2, 5000, 8); }      // GPIO2, 5kHz, 8位(0-255)
void loop() {
  for (int i = 0; i <= 255; i++) { ledcWrite(2, i); delay(5); } // 渐亮
  for (int i = 255; i >= 0; i--) { ledcWrite(2, i); delay(5); } // 渐灭
}
```
常见坑：analogWrite 在部分旧版 ESP32 核心不生效，优先用 ledcAttach/ledcWrite；PWM 频率选 5kHz 以上避免 LED 闪烁可见。

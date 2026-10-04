<!--
id: ledc-note
keywords: ledc,ledcsetup,ledcattach,ledcwrite,pwm通道,占空比
-->
### ESP32 LEDC PWM 通道详解
ESP32 的 PWM 用 LEDC 硬件通道（不是 Arduino 的 analogWrite）：
```cpp
void setup() {
  ledcAttach(2, 5000, 8);            // 引脚2, 频率5kHz, 分辨率8位
  ledcWrite(2, 128);                 // 占空比 50%（0-255）
}
void loop() {}
```
- ledcAttach(pin, freq, resolution)：resolution 8 对应 0-255，10 对应 0-1023
- 新版本核心（esp32-arduino 3.x）用 ledcAttach/ledcWrite；旧版用 ledcSetup/ledcAttachPin/ledcWrite
- 改变亮度/频率直接再调 ledcWrite 即可
常见坑：分辨率越高支持的频率范围越窄（8 位可到几十 kHz，16 位只有低频）；不同核心版本 API 不同，报错未声明时查核心版本。

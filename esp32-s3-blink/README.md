# ESP32-S3 LED 闪烁示例

用 PlatformIO + Arduino 框架在 ESP32-S3-DevKitC-1 上跑通点灯，作为 BubaiCode 的 agent 能力测试用例。

## 硬件
- 开发板：ESP32-S3-DevKitC-1
- 板载 LED：GPIO2（部分衍生板为 GPIO48，见 `src/main.cpp` 顶部 `LED_PIN` 宏）

## 接线（外接 LED 时用，板载 LED 可跳过）
```
ESP32-S3          LED
GPIO2    ──┬── 220Ω 电阻 ──┬── LED 阳极(长脚)
           │                │
GND      ─────────────────── LED 阴极(短脚)
```

## 使用
```bash
# 安装依赖并编译
pio run
# 烧录（接好 USB）
pio run -t upload
# 串口监视
pio device monitor
```
监控中应每秒看到一次 `ESP32-S3 LED Blink 已启动` 心跳，板载 LED 以 1Hz 闪烁。

## 在 BubaiCode 中
- 用 BubaiCode 打开本目录即可识别为 PlatformIO 工程。
- 若已配置模型 API Key，可直接让 agent 在此工程上扩展（如改为 PWM 呼吸灯、增加按键、接入 WiFi 等）。

<!--
id: relay
keywords: 继电器,relay,大功率,开关,220v
-->
### 继电器（控制大功率电器）
继电器是电控开关，用 GPIO 给线圈通断控制负载：
```cpp
#define RELAY 8
void setup() { pinMode(RELAY, OUTPUT); }
void loop() { digitalWrite(RELAY, HIGH); delay(2000); digitalWrite(RELAY, LOW); delay(2000); }
```
接线：模块 VCC→5V（线圈需要 5V），IN→GPIO8，GND→GND；负载回路（如灯泡）串在继电器 COM 与 NO 之间，**绝不能把 220V 直接接到 ESP32 引脚**。
常见坑：继电器线圈电流大，直接用 GPIO 可能带不动（选低电平触发模块或用三极管驱动）；通断大负载时火花干扰会导致 ESP32 重启，需加续流二极管/光耦隔离。

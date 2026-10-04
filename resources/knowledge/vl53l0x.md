<!--
id: vl53l0x
keywords: vl53l0x,激光测距,tof,飞行时间,红外测距,vl53,距离,短距
-->
### VL53L0X 激光 ToF 测距
VL53L0X 用激光飞行时间（ToF）测距离（约 30~2000mm），I2C 输出，精度高、不受被测物颜色/表面影响（比超声波小而准）：
```cpp
#include <Wire.h>
#include <VL53L0X.h>
VL53L0X sensor;
void setup() {
  Serial.begin(115200); Wire.begin();
  sensor.init(); sensor.setTimeout(500);
  sensor.startContinuous();
}
void loop() {
  Serial.print(sensor.readRangeContinuousMillimeters()); Serial.println(" mm");
  if (sensor.timeoutOccurred()) Serial.print("timeout");
  delay(100);
}
```
要点：默认地址 0x29，多个用 `sensor.setAddress()` 改；远距离/强光下读数可能跳变，结合超时与中值滤波；长距可选 VL53L1X（4m）/VL53L4CD；注意激光窗口不要被遮挡、玻璃会反射。

<!--
id: can-twai
keywords: can,twai,汽车总线,can总线,车载,工业总线,can收发器,标准帧
-->
### TWAI / CAN 总线
ESP32 的 TWAI（即 CAN）控制器用于汽车、工业设备通信，需外接 CAN 收发器（如 TJA1050/SN65HVD230）把 TX/RX 转差分 CAN_H/CAN_L：
```cpp
#include <driver/twai.h>
void setup() {
  Serial.begin(115200);
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(5,4,TWAI_MODE_NORMAL); // TX,RX
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  twai_driver_install(&g,&t,&f); twai_start();
}
void loop() {
  twai_message_t msg;
  if (twai_receive(&msg,pdMS_TO_TICKS(100))==ESP_OK) Serial.println(msg.identifier);
}
```
发送：填 `twai_message_t{.identifier,.data_length_code,.data}` 用 `twai_transmit`。
要点：ESP32 只提供控制器，**必须外接收发器**和正确终端电阻（总线两端 120Ω）；Arduino 可用 ESP32CAN 库；汽车 OBD-II 用标准帧 11bit ID、速率多为 500kbps/250kbps。

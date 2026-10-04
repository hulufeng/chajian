<!--
id: ir-remote
keywords: 红外,ir,遥控器,irremote,红外接收,红外发射,nec,空调遥控
-->
### 红外遥控收发
用红外遥控器控制设备，或让 ESP32 发射红外（控制家电）。用 IRremoteESP8266 库：
```cpp
#include <IRremote.hpp>
#define RECV 15
void setup() {
  Serial.begin(115200);
  IrReceiver.begin(RECV, ENABLE_LED_FEEDBACK); // 接收
}
void loop() {
  if (IrReceiver.decode()) {
    Serial.print(IrReceiver.decodedIRData.protocol);
    Serial.print(" code=0x"); Serial.println(IrReceiver.decodedIRData.decodedRawData, HEX);
    IrReceiver.resume(); // 收下一个
  }
}
```
发射：`IrSender.begin(4); IrSender.sendNEC(0x10,0x20,32);`
要点：收到后必须 `resume()`；空调等复杂协议用 `IRac` 类并先 `sendAc`/`capture` 原始码；接收头常见 VS1838B（38kHz），注意供电与环境光干扰。

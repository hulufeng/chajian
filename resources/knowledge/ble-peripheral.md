<!--
id: ble-peripheral
keywords: ble,蓝牙低功耗,bluetooth,从机,peripheral,service,characteristic,特征值,notify,uuid,nrf
-->
### BLE 蓝牙低功耗（从机）
BLE 适合小数据、低功耗、手机直连。ESP32 作外设（Peripheral），创建 Service / Characteristic，手机用 nRF Connect 连接、读写、订阅 Notify：
```cpp
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
BLECharacteristic* chr;
bool connected = false;
class SrvCb : public BLEServerCallbacks {
  void onConnect(BLEServer*){ connected=true; }
  void onDisconnect(BLEServer*){ connected=false; BLEDevice::startAdvertising(); }
};
void setup() {
  Serial.begin(115200);
  BLEDevice::init("LabCode-BLE");
  BLEServer* srv = BLEDevice::createServer();
  srv->setCallbacks(new SrvCb());
  BLEService* svc = srv->createService("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
  chr = svc->createCharacteristic("beb5483e-36e1-4688-b7f5-ea07361b26a8",
        BLECharacteristic::PROPERTY_READ|BLECharacteristic::PROPERTY_WRITE|BLECharacteristic::PROPERTY_NOTIFY);
  chr->addDescriptor(new BLE2902()); // 使能 Notify
  svc->start();
  BLEDevice::startAdvertising();
}
void loop() {
  if (connected) { chr->setValue(String(millis())); chr->notify(); delay(1000); }
}
```
要点：手机写入可在 Characteristic 的 `onWrite` 回调里 `getValue()` 取命令；断开后要重新 `startAdvertising()`；ESP32 经典蓝牙（SPP）与 BLE 是两套，Arduino 用 `BluetoothSerial` 走经典串口。

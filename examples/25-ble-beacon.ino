// Day 25: BLE 蓝牙广播 (Beacon)
// 用手机 nRF Connect App 可以扫到这个设备
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>

void setup() {
  Serial.begin(115200);
  Serial.println("BLE 广播启动...");

  BLEDevice::init("CodeLab-ESP32");
  BLEServer *pServer = BLEDevice::createServer();
  BLEAdvertising *pAdv = BLEDevice::getAdvertising();
  pAdv->setName("CodeLab-ESP32");
  pAdv->start();

  Serial.println("BLE 已广播,用 nRF Connect 搜索 'CodeLab-ESP32'");
}

void loop() {
  Serial.printf("运行时间: %lu s, BLE 正在广播\n", millis() / 1000);
  delay(5000);
}

<!--
id: memory-debug
keywords: 内存,heap,freeheap,栈溢出,内存泄漏,堆,重启原因,getfreeheap,内存不足,psram
-->
### 内存排查与泄漏
莫名重启、跑一段时间后异常，先监控堆内存：
```cpp
void loop() {
  Serial.printf("free=%u max=%u min=%u\n",
    ESP.getFreeHeap(), ESP.getMaxAllocHeap(), ESP.getMinFreeHeap());
  delay(2000);
}
```
判断：free heap 持续下降且不回升 = 内存泄漏（常见：`new`/`malloc` 没释放、打开 File/Client 没 close、String 反复拼接碎片）。
要点：任务栈太小会栈溢出复位，用 `uxTaskGetStackHighWaterMark()` 看任务剩余栈；大缓冲优先 `ps_malloc`（有 PSRAM 时）；`ESP.getResetReason()` / `esp_reset_reason()` 区分上电/看门狗/异常复位；String 在高频循环里拼接易产生碎片，用固定 char 缓冲。

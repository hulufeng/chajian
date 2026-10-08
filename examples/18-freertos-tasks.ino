// Day 18: FreeRTOS 多任务 —— 两个任务并行跑
// Task1: 每 500ms 闪 LED
// Task2: 每 1000ms 打印串口消息

#define LED_PIN 2

void taskLED(void *pv) {
  pinMode(LED_PIN, OUTPUT);
  while (true) {
    digitalWrite(LED_PIN, HIGH);
    vTaskDelay(pdMS_TO_TICKS(250));
    digitalWrite(LED_PIN, LOW);
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

void taskSerial(void *pv) {
  int count = 0;
  while (true) {
    Serial.printf("[任务2] 计数: %d, 运行时间: %lu ms\n", count++, millis());
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("FreeRTOS 多任务启动");

  xTaskCreatePinnedToCore(taskLED, "LED",  1024, NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(taskSerial, "Serial", 2048, NULL, 1, NULL, 1);
}

void loop() {
  // 两个任务在后台并行跑,loop 空闲
  vTaskDelay(pdMS_TO_TICKS(5000));
  Serial.printf("[主循环] 空闲, 堆剩余: %d bytes\n", uxPortGetFreeHeapSize());
}

// Day 20: 电容触摸传感器 —— ESP32 内置
// 无需外接电阻,直接读触摸引脚的电容变化
// 接线: 手指或金属片接触 T0=GPIO4

#define TOUCH_PIN T0  // GPIO4

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("触摸传感器示例");
  Serial.println("用手指碰一下 GPIO4");
}

void loop() {
  int val = touchRead(TOUCH_PIN);
  Serial.printf("触摸值: %d", val);

  // 碰到时电容变化,数值会显著下降
  if (val < 30) {
    Serial.println("  <-- 碰到了!");
  } else {
    Serial.println();
  }
  delay(200);
}

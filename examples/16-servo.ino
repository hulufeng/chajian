// Day 16: 舵机控制 (LEDC PWM)
// ESP32 没有 Servo 库的默认实现,用 LEDC 输出 50Hz PWM
// 接线: 舵机信号线 -> GPIO18, VCC -> 5V, GND -> GND

#define SERVO_PIN 18
#define CHANNEL   0
#define FREQ      50
#define RESOLUTION 14

// 角度 -> 占空比 (0-180 度对应 500-2500us 脉冲)
int angleToDuty(int angle) {
  return map(angle, 0, 180, 500, 2500) * (1 << RESOLUTION) / 20000;
}

void setup() {
  Serial.begin(115200);
  ledcSetup(CHANNEL, FREQ, RESOLUTION);
  ledcAttachPin(SERVO_PIN, CHANNEL);
  Serial.println("舵机初始化完成");
}

void loop() {
  for (int a = 0; a <= 180; a += 10) {
    ledcWrite(CHANNEL, angleToDuty(a));
    Serial.printf("角度: %d\n", a);
    delay(300);
  }
  for (int a = 180; a >= 0; a -= 10) {
    ledcWrite(CHANNEL, angleToDuty(a));
    Serial.printf("角度: %d\n", a);
    delay(300);
  }
}

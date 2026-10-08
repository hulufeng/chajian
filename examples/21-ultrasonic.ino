// Day 21: 超声波测距 HC-SR04
// 接线: Trig=GPIO5, Echo=GPIO18, VCC=5V, GND=GND

#define TRIG_PIN 5
#define ECHO_PIN 18

long measureDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);  // 30ms 超时
  return duration * 0.034 / 2;  // 声速 340m/s -> cm
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("超声波测距启动");
}

void loop() {
  long cm = measureDistance();
  if (cm > 0 && cm < 400) {
    Serial.printf("距离: %d cm\n", cm);
  } else {
    Serial.println("无信号(超范围)");
  }
  delay(500);
}

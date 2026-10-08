// Day 22: 继电器控制 —— 用小电流控制大电流
// 接线: IN=GPIO13, VCC=5V, GND=GND
// 注意: 继电器控制 220V 强电时务必注意绝缘!

#define RELAY_PIN 13

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);  // 初始断开
  Serial.println("继电器控制示例");
}

void loop() {
  Serial.println("继电器 闭合(通电)");
  digitalWrite(RELAY_PIN, HIGH);
  delay(2000);

  Serial.println("继电器 断开(断电)");
  digitalWrite(RELAY_PIN, LOW);
  delay(2000);
}

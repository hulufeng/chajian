// ADC 电位器读取
// 拖动仿真器上的 A0 滑块，观察串口输出和 LED 亮度变化

const int potPin = A0;
const int ledPin = 9;  // PWM 引脚

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  delay(100);
  Serial.println("ADC Potentiometer Test");
  Serial.println("Move the slider in the simulator panel...");
}

void loop() {
  int potValue = analogRead(potPin);
  float voltage = potValue * (5.0 / 1023.0);

  Serial.printf("A0: %4d  |  %.2fV\n", potValue, voltage);

  // 用电位器控制 LED 亮度 (PWM)
  analogWrite(ledPin, potValue / 4);

  delay(200);
}

// Day 5: 按键消抖
// 机械按键按下/松开时会抖动，需要延时过滤

#define BTN_PIN 4
#define LED_PIN 2

int lastState = HIGH;
int currentState;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;  // 50ms 消抖

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  int reading = digitalRead(BTN_PIN);
  if (reading != lastState) {
    lastDebounceTime = millis();
  }
  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading != currentState) {
      currentState = reading;
      if (currentState == LOW) {
        Serial.println("按键按下（消抖后）");
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));  // 翻转 LED
      }
    }
  }
  lastState = reading;
}

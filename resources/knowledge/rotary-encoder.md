<!--
id: rotary-encoder
keywords: 旋转编码器,编码器,rotary,encoder,旋钮,ky-040,菜单选择,pcnt
-->
### 旋转编码器
旋转编码器（如 KY-040）做旋钮输入（菜单选择、数值加减），CLK/DT 两相输出正交脉冲判断方向，SW 是按键：
```cpp
#define CLK 34
#define DT  35
#define SW  32
int lastClk, count;
void setup() {
  Serial.begin(115200);
  pinMode(CLK,INPUT); pinMode(DT,INPUT); pinMode(SW,INPUT_PULLUP);
  lastClk = digitalRead(CLK);
}
void loop() {
  int clk = digitalRead(CLK);
  if (clk != lastClk && clk == LOW) {
    if (digitalRead(DT) != clk) count++; else count--; // 方向
    Serial.println(count);
  }
  lastClk = clk;
  if (!digitalRead(SW)) { count=0; delay(50); } // 按下归零(需防抖)
}
```
要点：机械抖动会误计，软件去抖或用硬件 PCNT 脉冲计数器（ESP-IDF）；高速旋转要在中断里处理或加 RC 滤波；常用于 OLED 菜单交互。

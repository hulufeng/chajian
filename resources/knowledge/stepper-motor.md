<!--
id: stepper-motor
keywords: 步进电机,stepper,28byj,uln2003,精确位置,角度,步进,减速
-->
### 步进电机（28BYJ-48 + ULN2003）
步进电机可精确控制转角/位置（云台、阀门、滑台）。28BYJ-48 配 ULN2003 驱动板，按 4 相 8 拍时序给 IN1~IN4 通电：
```cpp
const int pins[4] = {19,23,18,5};
const uint8_t seq[8][4] = {
 {1,0,0,0},{1,1,0,0},{0,1,0,0},{0,1,1,0},
 {0,0,1,0},{0,0,1,1},{0,0,0,1},{1,0,0,1}};
int step = 0;
void setup() { for (int i=0;i<4;i++) pinMode(pins[i],OUTPUT); }
void moveOne() {
  for (int p=0;p<4;p++) digitalWrite(pins[p], seq[step][p]);
  step = (step+1)%8;
  delay(2); // 越小越快，太快会失步
}
void loop() { for (int i=0;i<512;i++) moveOne(); delay(500); }
```
要点：28BYJ-48 减速比约 64:1，512 拍约一圈（实际约 4096 全步）；延迟太小会失步堵转；大电流两相步进用 A4988/DRV8825（脉冲+方向 STEP/DIR），可用 AccelStepper 库加减速。

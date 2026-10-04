<!--
id: mq-gas-sensor
keywords: mq,气体传感器,mq2,mq135,烟雾,酒精,可燃气体,空气质量,mq-3,mq-7,co2
-->
### MQ 系列气体传感器
MQ 系列用加热金属氧化物测气体，输出模拟电压（AO）+ 数字阈值（DO），成本低，用于烟雾/可燃气/酒精等定性检测：
```cpp
#define AO 34
#define DO 27
void setup() { Serial.begin(115200); pinMode(DO,INPUT); }
void loop() {
  int raw = analogRead(AO);
  Serial.printf("raw=%d alarm=%d\n", raw, digitalRead(DO)==LOW);
  delay(500);
}
```
选型：MQ-2 烟雾/可燃气、MQ-3 酒精、MQ-4 天然气、MQ-7 一氧化碳、MQ-8 氢气、MQ-135 综合空气质量。
要点：模块多为 5V、加热耗电较大（约 800mA 峰值）；上电需预热数十秒才稳定；输出是相对值，要 ppm 浓度需查灵敏度曲线多点标定，做不到精确；精确 CO2 用 MH-Z19/SCD41（NDIR），别用 MQ 冒充。

# CodeLab ESP32 仿真器 — 下一步开发规划

> 日期: 2026-09-29  
> 基于: `.handoff/HANDOFF.md` 当前状态

---

## 阶段一：修复现有示例（预计 2 小时）

### 1.1 修复 OLED 示例（05-oled）

**问题**：当前 05-oled 的 loop 只是 delay(1000)，OLED 屏幕是空的。

**要做**：
- 在 I2CBus 里加一个简化的 OLED 文本绘制 API（不需要 Adafruit_GFX）
- `oledDrawText(ram, x, y, text, size)` — 用 5x7 字体把文字画到显存
- 05-oled 的 loop 每秒写一行字到 OLED：
  ```
  第 1 行: "CodeLab ESP32"
  第 2 行: "Temp: 25.5C"
  第 3 行: "ADC: 1.65V"
  ```
- 字体用内置 5x7 ASCII 字模（存在 TS 文件里）

**涉及文件**：
- `simulator/I2CBus.ts` — 加 drawText 方法
- `simulator/builtinExamples.ts` — 改 05-oled 的 loop
- 新建 `simulator/font5x7.ts` — ASCII 字模

### 1.2 修复 SHT30 示例（07-sht30）

**问题**：loop 只是 delay，没有读温湿度。

**要做**：
- loop 里每秒调用 `rt.wire.requestFrom(0x44, 6)` 读数据
- 解析温度/湿度，通过 `rt.uart.printf` 打印
- 同时在 OLED 上显示（和 1.1 联动）

### 1.3 修复 ADC 示例（06-adc）

**问题**：已经能读，但可以更直观——拖动电位器滑块时串口实时变化。

**要做**：
- 当前已经是 300ms 打印一次，OK
- 加一个虚拟电压表 UI（大数字显示电压）

---

## 阶段二：UI 完善（预计 2 小时）

### 2.1 OLED 文本显示

按 1.1 做完后，OLED 上能看到实时文字。

### 2.2 示例列表面板

当前是下拉框选示例。改成左侧列表：
- 显示所有 7 个示例
- 当前运行的高亮
- 点示例自动停止当前运行

### 2.3 串口输入

串口监视器底部加输入框，用户输入的内容通过 `rt.uart.userInput()` 送进模拟串口。

### 2.4 模式切换

顶部加两个 Tab：
- **模拟模式**（默认）：跑内置 JS 示例
- **烧录模式**：显示 arduino-cli 编译输出和串口

---

## 阶段三：真实烧录打通（预计 2 小时）

### 3.1 串口检测

- 启动时自动列出 COM 口
- 下拉选择

### 3.2 编译烧录

- 点"编译并烧录"→ 调 `window.api.grpc.compile` + `upload`
- 进度显示在输出面板

### 3.3 烧录后串口桥接

- 烧录完成后自动连接串口监视器
- 板子真实输出显示在串口监视器

---

## 阶段四：更多示例（预计 2 小时）

加 5 个示例：
- 08-interrupt — GPIO4 外部中断
- 09-pwm-servo — 舵机角度滑块（PWM 模拟）
- 10-serial-input — 串口输入控制 LED
- 11-oled-adc — OLED 上画 ADC 波形
- 12-dht22 — 温湿度（模拟 DHT22 单总线协议）

---

## 阶段五：Tauri 同步（预计 1 小时）

- 把 simulator/ 目录复制到 Tauri 版
- 确认没有 Electron 专属 API 依赖
- 测试 Tauri 下 VirtualRuntime 正常跑

---

## 阶段六：esp32emu 验证（研究项，不阻塞）

```
1. npm install esp32emu
2. 写一个最小测试：编译 blink.ino → .bin → esp32emu 加载
3. 看 GPIO 输出能不能 hook
4. 如果能 → 二期替换内置 JS 示例，跑真实 .ino
5. 如果不能 → 继续用自研方案
```

---

## 优先级排序

| 优先级 | 任务 | 时间 |
|--------|------|------|
| P0 | 1.1 OLED 文本绘制 | 1h |
| P0 | 1.2 SHT30 读取打印 | 0.5h |
| P0 | 1.3 ADC 示例完善 | 0.5h |
| P1 | 2.2 示例列表 UI | 0.5h |
| P1 | 2.3 串口输入 | 0.5h |
| P1 | 3.1-3.3 烧录打通 | 2h |
| P2 | 阶段四 5 个新示例 | 2h |
| P2 | Tauri 同步 | 1h |
| P3 | esp32emu 验证 | 不阻塞 |

**总开发量：约 8 小时**

---

## 立即开始的第一步

从 P0 开始：写 `font5x7.ts` 字模 + 在 I2CBus 加 drawText + 改 05-oled 示例。

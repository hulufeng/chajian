# Velxio 实际操作与生态参考报告（codelab 仿真器对标）

> 日期：2026-10-01 ｜ 性质：GitHub 生态调研 + 在线版实际操作实录
> 用途：为 codelab-desktop 自研 VirtualRuntime 仿真器提供功能/架构/商业化对标
> 约束：velxio 为 AGPLv3 + 商业双许可，**仅学习参考，代码不得引入交付物**（用户已确认"参考功能列表自己写，作为插件用"）

---

## 一、实际操作实录（velxio.dev 在线版）

实际操作链路：打开 velxio.dev → 进入编辑器 → 选择 ESP32 DevKit V1（QEMU）→ 加载内置 Blink 示例 → 点 Run → 编译成功 → 仿真运行 → 串口监视器实时输出。

### 1.1 验证结果

| 步骤 | 结果 | 证据 |
|---|---|---|
| 打开首页 | ✅ 35 块板卡、6 种 CPU 架构（AVR8/ARM-M/ARM-A/RISC-V/Xtensa/Linux） | velxio.dev 首页 |
| 进入编辑器 | ✅ Monaco 编辑器 + 工作区 + 画布 + AI 侧栏 | /editor/ |
| 选板 ESP32 DevKit V1 | ✅ 语言可选 Arduino C++ / MicroPython / ESP-IDF | 编辑器 select 控件 |
| 运行 Blink 示例 | ✅ **00:05:43 Compilation successful** | 底部 OUTPUT 面板 |
| 串口监视器 | ✅ **115200 baud，实时滚动 `LED ON / LED OFF / LED ON...`** | OUTPUT → ESP32 tab |
| 电路画布 | ✅ GPIO2→内置 LED、GPIO4→电阻→外部 LED，SPICE 4 nets 实时求解 | 画布区 |
| AI 面板 | 未登录态提示：免费 20 条/天，升级解锁更多 | 右侧栏 |

### 1.2 界面结构（与 codelab 对照）

```
┌─────────────────────────────────────────────────────────┐
│ 菜单栏 File/Edit/View/Account/Help                       │
│ 工具栏 Compile / Run / Stop / Reset / 库 / 输出 / 主题    │
├──────────┬──────────────────────────┬───────────────────┤
│ WORKSPACE│  Monaco 代码编辑区        │  Velxio AI 侧栏    │
│ ESP32    │  ① 代码                    │  （聊天助手）      │
│ sketch.ino│ ② 电路画布（GPIO连线/元件）│  free: 20 msg/天  │
│ libraries│  ③ SPICE 求解状态          │                  │
├──────────┴──────────────────────────┴───────────────────┤
│ OUTPUT 面板（All/ESP32 tab：编译日志 + 串口 115200 + 输入框）│
└─────────────────────────────────────────────────────────┘
```

**对 codelab 的启发**：这正是用户已拍板的布局方向——仿真画布+串口不遮挡主编辑区（velxio 是画布在编辑区下方、AI 在右侧栏，codelab 可做右侧停靠仿真面板）。

---

## 二、velxio 技术架构（源码 README 研读）

### 2.1 仿真内核分层

| CPU 家族 | 板卡 | 运行位置 | 内核 |
|---|---|---|---|
| AVR8 | Uno/Nano/Mega/ATtiny85 | 浏览器内 | **avr8js**（~60 FPS, requestAnimationFrame） |
| ARM Cortex-M | RP2040/Pico W 等 | 浏览器内 | **rp2040js / rp2350js** |
| Xtensa LX6/LX7 | ESP32/ESP32-S3 | 服务端（QEMU） | **espressif/qemu fork** |
| RISC-V | ESP32-C3/C6 | 服务端（QEMU） | espressif/qemu |
| ARM Cortex-A Linux | Raspberry Pi 3/4/5 | 服务端（QEMU，仅付费在线） | QEMU 机器仿真 |
| STM32 | Blue/Black Pill 等 | 服务端（QEMU，仅付费在线） | QEMU |

关键结论：**ESP32 系（Xtensa/RISC-V）在浏览器里没有纯 JS 内核，velxio 也走 QEMU 服务端**。这与 codelab 现状一致——自研 VirtualRuntime 若想支持 ESP32 指令级仿真，唯一现实路径是 QEMU（espressif fork）或近似方案；纯 JS 解释 Xtensa 指令集不现实。

### 2.2 编译链

- **arduino-cli** 编译 sketch → .hex/.bin（AVR/RP2040）
- **ESP-IDF v5.5.4 + arduino-esp32 3.3.10** 编译 ESP32 系（Docker 内置，ccache + 增量 ninja 缓存，未改动重编译 2-5 秒）
- 库管理：Library Manager（~100MB 存储，免费层）

### 2.3 电路/外设层

- 150+ 交互组件（传感器/显示/电机/逻辑 IC/模拟件/面包板/品牌模块）
- **SPICE 模拟**：ngspice 编译为 WebAssembly，~60 次/秒节点分析，GPIO 驱动真实网络，ADC 读求解后的节点电压，探针报 RMS/DC/电流
- 自定义芯片：写 C → 编译 WASM → 拖上画布（可编程传感器 + 滑块驱动）
- WiFi 仿真：ESP32 加入虚拟 AP，拿 IP，走公共 MQTT broker 收发消息
- 示波器：任意引脚追踪，RP2040 端 ~8ns 分辨率时间戳

### 2.4 双许可（对 codelab 的法律参考）

| 用途 | 许可 | 费用 |
|---|---|---|
| 个人/教育/开源（AGPLv3 合规） | AGPLv3 | 免费 |
| 闭源商业产品/SaaS | 商业许可（COMMERCIAL_LICENSE.md） | 付费（联系作者） |

> ⚠️ codelab 是商业闭源售卖软件：velxio 免费版 AGPLv3 不可用，商业许可需购买。**只能参考功能清单自研**，用户已确认此原则。

---

## 三、velxio 商业化模型（codelab 定价参考）

| 层级 | 价格 | 关键权益 |
|---|---|---|
| **Free** | $0 | 基础 AI 聊天 50 条/天；20 AI 积分/天；30+ 板卡（Arduino/ESP32/RP2040/RISC-V）；48+ 元件；浏览器真实 CPU 仿真；自定义芯片；库管理 100MB；公共项目无限；STM32/Pi/UNIHIKER 每族 3 次 15 分钟试用；ESP32 运行有时长上限 |
| **NO AI** | $3/月（年付 $36） | 完整工作台但**无任何 AI**（无聊天/无 Agent/无代码补全） |
| **Maker** | 未列（年付） | 解锁 STM32/Pi Linux/UNIHIKER、WiFi、离线桌面版；**Agent + Tutor 模式（AI 在画布上构建并教学）**；私有项目；优先编译队列 |
| **Pro** | 未列 | Maker 全部 + 桌面离线版等 |
| **Classroom** | $34/学生/年起 | 整班 Pro 账号、私有项目、BOM/原理图导出、GitHub 同步 |

**codelab 可借鉴的点**：
1. **AI 分层变现**：免费给基础聊天引流 → 付费解锁 Agent/Tutor（教学场景正是 codelab 定位）
2. **"NO AI"档**：面向不信任 AI 的用户，价格敏感型市场（教学机构采购常要求无 AI）
3. **板卡分层**：免费板卡（教学入门）+ 付费板卡（专业），与 codelab 的"简单软件内模拟、复杂真实接板"互补

---

## 四、GitHub 生态清单（已检索确认）

| 项目 | Stars | 语言/许可 | 价值点 | 可用性判断 |
|---|---|---|---|---|
| **velxio** (davidmonterocrespo24/velxio) | 2.9k | TypeScript / AGPLv3+商业 | 功能清单全对齐（WiFi 仿真/外设可视化/串口监视器/示波器/SPICE） | 🔴 AGPL 不可引入，**参考功能自研**（用户已确认） |
| **arduino/arduino-ide** | 3.3k | TypeScript / AGPL-3.0 | 官方 IDE 2.x：串口/烧录/库管理/boards 管理完整实现 | 🔴 AGPL 不可引入，可读源码学架构 |
| **arduino/Arduino** | 14.6k | Java / GPL-2.0 | IDE 1.x（过时，跳过） | — |
| **arduino/arduino-cli** | （本机已装） | Go / GPL-3.0 | 编译/烧录命令行核心 | ✅ 已在用（工具链合法） |
| **espressif/qemu** | — | GPL | ESP32 Xtensa/RISC-V QEMU fork | 🔴 GPL 不可打包进商业产品（此前已否决） |
| **wokwi/wokwi-elements** | — | Apache-2.0 | 元件 SVG/交互组件（velxio 的 third-party 引用） | 🟡 可评估单独元件（Apache 宽松） |

---

## 五、对 codelab VirtualRuntime 的落地建议（仅建议，待用户拍板）

1. **明确边界（用户已拍板）**：软件定位=真实烧录；简单功能软件内模拟、复杂功能真实接开发板；仿真辅助停靠右侧不遮挡。
2. **ESP32 指令级仿真的现实路径**：QEMU 系列（GPL）不可打包 → 两个选择：① 服务端 QEMU 方案（像 velxio 一样跑后端，但商业化需谨慎）；② codelab 自研保持"教学级外设模拟"（GPIO/串口/OLED/I2C/ADC 等外设级可视化），不追求指令级，与真实烧录互补。当前自研 VirtualRuntime 走的是 ②，合理。
3. **可学习的开源组件（宽松许可）**：wokwi-elements（Apache-2.0）的元件视觉；avr8js/rp2040js（MIT）的 GPIO/定时器模拟思路（若未来支持 AVR 板卡可评估）。
4. **功能路线参考 velxio 优先级**：串口监视器（✅ 已有）→ OLED/I2C 外设（✅ 已在做）→ ADC 滑块/DHT22/示波器（进行中）→ WiFi 可视化（远期）。
5. **AI 面板可抄布局**：右侧固定侧栏、免费消息额度、登录解锁——与 codelab 现有 AI 面板（本地大模型/自定义模型）可对齐。

---

## 附：本次操作与检索轨迹

- 实际操作：https://velxio.dev（浏览器自动化，选 ESP32 DevKit V1 → Run → 编译成功 → 串口 LED ON/OFF 实时输出）
- GitHub 仓库：https://github.com/davidmonterocrespo24/velxio
- 官方文档：https://docs.velxio.dev（docs/ 下含 ESP32_EMULATION.md、RISCV_EMULATION.md、RP2040_EMULATION.md）
- TrieCode 检索：无公开官网（trae.com.cn 为另一产品 Trae，非本机 TrieCode），本机 TrieCode 学习仍以解包源码为准

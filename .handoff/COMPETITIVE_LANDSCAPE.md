# 竞品 landscape — AI 辅助硬件开发桌面端（开源）

> 目的：梳理开源界与 **codelab-desktop / LabCode**（Electron + React + arduino-cli + 串口 + 自研 Agent 引擎 + 三通道 AI 网关）定位相近的项目，明确我们的差异化功能（已具备 + 待补强）。
> 检索时间：2026-10-05。结论：本赛道已有直接竞品，最像的是 **Exort**（同架构）与 **Embedist**（同愿景）。

---

## 一、一句话结论

- **直接竞品存在**：Exort（Electron + OpenCode + Arduino CLI + 串口 + Agent）几乎同架构；Embedist（Tauri + PlatformIO + board-aware + Agent 四模式）同产品愿景。
- **我们的硬差异**：① 三通道 AI 网关（内置免费 / BYOK / 本地 llama 离线）；② 自研 49 工具 Agent 引擎（状态机/预算护栏/工具失败恢复/验证闸门/上下文压缩/plan mode/wrap-up）；③ ESP32 写码→编译→烧录→串口硬链路做厚（serialport 真机兜底识别）。
- **待补强（借鉴竞品）**：board-aware 上下文注入、接线图自动生成、MCP 工具层、串口 Plotter、Debug 模式自动修编译错。

---

## 二、竞品对比矩阵

| 项目 | 形态 / 技术栈 | AI 集成 | 烧录 / 串口 | 硬件广度 | 协议 | 热度 |
|---|---|---|---|---|---|---|
| **Exort** (`Razz19/Exort`) | Electron + Svelte + Monaco + OpenCode | OpenCode agent（自带免费模型 + 自带/外部 provider） | **Arduino CLI 编译/烧录** + 串口监视/**绘图** | Arduino/ESP32/ESP8266/RP2040/STM32/Teensy | AGPL-3.0 | 新项目 |
| **Embedist** (`mandarwagh9/embedist`) | Tauri2 + Rust + React + Monaco | 多 provider（OpenAI/Anthropic/Gemini/DeepSeek/**Ollama**/NIM）；Chat/Plan/**Agent**/Debug 四模式 + **board-aware** | **PlatformIO** 编译/烧录 + Web Serial | ESP32 全系/Arduino/ESP8266 | 开源 | v0.37 |
| **aily-blockly** (`ailyProject/aily-blockly`) | Electron + Angular | AI 全流程：项目生成 / 代码 / **接线图** / 库转换 / 调试 | 多编译器 + probe-rs 调试 | 100+ 板（Arduino/MicroPython/ESP32/STM32/RP2040/Nrf5x） | GPL-3.0 | ~3.7k★ |
| **PlatformIO MCP** (`jl-codes/platformio-mcp`) | Node（MCP server） | 给 AI Agent 暴露 PlatformIO 工作流（board/build/flash/monitor） | PlatformIO | PlatformIO 全系 | MIT | — |
| **TuyaOpen** (tuya/TuyaOpen) | C/C++ SDK + VS Code/Cursor 扩展 | 多模型 + 云端多模态 | `tos.py build/flash` | Tuya T 系列/ESP32/Pi | Apache-2.0 | 8k+ 社区 |
| **Adsum-IoT-Coder** (`adsumnetworks/SoC-AI-Debugger`) | VS Code 扩展 | Agent 真机编译/烧录/调试（ESP-IDF + nRF） | 真机 RTT/UART/BLE | ESP32(ESP-IDF)/nRF52/53/54/91 | Apache-2.0 | — |
| **NeuralInverse** (`neuralinverse/neuralinverse`) | VS Code fork (TS) | 20+ provider，agentic Power Mode，357 MCU | 固件模块 | 357 MCU 变体 | Apache-2.0 | ~193★ |

> 排除：`ESP32-S3-AI-Assistant` 是**跑在芯片上**的固件（调用 Groq/Gemini API），不是开发工具，不算竞品。

---

## 三、直接竞品详解

### 3.1 Exort —— 架构最接近
- 几乎同架构：Electron 桌面 + Arduino CLI 编译/烧录 + 串口监视/绘图 + AI Agent 一条龙闭环。
- AI 用现成 **OpenCode** 运行时（自带免费模型 + 可接外部 provider），不是自研引擎。
- 短板（我们的机会）：无"本地 llama 离线通道"的明确产品化；Agent 工具集依赖 OpenCode，未做硬件专属的验证闸门/预算护栏。

### 3.2 Embedist —— 产品愿景最接近
- "AI-native 嵌入式 IDE"：board-aware 上下文（把板型/引脚注入 prompt 减少幻觉）、Chat/Plan/Agent/Debug 四模式、PlatformIO 集成、Web Serial。
- 用 **Tauri + Rust**（~5.7MB，轻量），非 Electron；用 **PlatformIO**，非 arduino-cli；本地模型只靠 Ollama。
- 短板（我们的机会）：无"内置免费模型 + 官方积分"通道；Agent 工具未针对 ESP32 硬链路做厚。

### 3.3 aily-blockly —— 通用度最高但路线不同
- 图形化 Blockly + AI：自然语言→项目架构/引脚接线图→代码；AI 还能把原生 Arduino 库转成 Blockly 积木（"无限扩库"）。
- 我们走**纯代码 + Agent** 路线，不碰 Blockly，但"接线图自动生成"这个点可直接借鉴。

---

## 四、我们的差异化功能

### 4.1 已具备（核心卖点）
1. **三通道 AI 网关**：内置免费大模型 + 用户自定义（BYOK）+ 本地 llama 离线，三者均支持 function calling。
   - 竞品短板：Exort/Embedist 主做 BYOK/云端，离线与"零成本开箱"弱；我们内置免费 + 本地 llama 是强差异。
2. **自研 49 工具 Agent 引擎**：状态机 + 预算护栏 + 工具失败恢复 + 验证闸门（compile/upload 为验证工具）+ 上下文压缩 + plan mode + wrap-up。
   - 竞品多接通用 agent 运行时（OpenCode/Cursor），无硬件专属验证闭环。
3. **ESP32 硬链路做厚**：写码→编译→烧录→串口一条龙；`serialport` 真机兜底识别（Windows 上 ESP32-S3 原生 USB 303A:1001 自动识别缺口已修）。
4. **界面三入口**（文件 / 设备 / AI）+ Monaco + xterm + node-pty 终端，工程化体验完整。

### 4.2 待补强（借鉴竞品，对应第四批规划）
| 差异化功能 | 借鉴自 | 价值 | 落入规划 |
|---|---|---|---|
| **board-aware 上下文注入**：把当前板型/FQBN/引脚注入 Agent prompt | Embedist | 大幅降低引脚/库幻觉 | 第四批 Agent 增强 |
| **接线图自动生成**：需求/代码 → 引脚接线图 | aily-blockly | 小白用户最刚需 | 第四批 EDA/可视化 |
| **MCP 工具层**：把 board/build/flash/monitor 标准化为 Agent 工具 | PlatformIO MCP | 你第四批 MCP 规划可直接复用其协议 | 第四批 MCP |
| **串口 Plotter**：数值波形可视化 | Exort / Embedist | 传感器/校准调试刚需 | 串口增强 |
| **Debug 模式**：自动读编译错误→定位→修复 | Embedist (Debug 模式) | 闭环调测体验 | 验证闸门已具备，补自动修复流 |
| **多 Agent 模式**：Chat / Plan / Agent / Debug 切换 | Embedist | 结构化工作流 | plan mode 已有，补 Chat/Debug |

---

## 五、行动建议
1. **守住主线**：ESP32 硬链路（编译/烧录/串口）继续做厚，这是与 Exort/Embedist 正面竞争的基本盘。
2. **放大三通道网关**：在 UI 与文档里把"内置免费 + 本地 llama 离线"作为第一卖点突出（竞品普遍弱）。
3. **第四批优先级**：MCP 工具层（复用 PlatformIO MCP 思路）→ board-aware 注入 → 串口 Plotter → 接线图 → Debug 自动修复。
4. **监测竞品**：Exort（同架构，需盯其 Agent 能力演进）、Embedist（同愿景，需盯其 board-aware 与本地模型进展）。

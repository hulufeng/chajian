# LabCode 项目文档

> 最后更新：2026-10-08
> 版本：1.1.3
> 技术栈：Electron 44 + React 19 + TypeScript 5.9 + electron-vite 5

---

## 1. 项目定位

面向 ESP32 开发的**商业化桌面 IDE**，核心卖点：
- 内置 AI 编程助手（本地小模型 + 云端大模型）
- 真实烧录（Arduino CLI 工具链）
- 板级仿真（不接板子也能跑）
- 课程体系（28+ 个 ESP32 教学示例）

**目标用户：** ESP32 初学者、单片机教学场景、低配电脑（4GB/8GB 内存可跑）。

---

## 2. 技术架构

```
src/
├── main/                  # 主进程（Node.js）
│   ├── engine/           # Agent 引擎核心（36 文件）
│   │   ├── agent-runner # 主循环：工具调用循环
│   │   ├── tools/       # 40+ 个工具定义
│   │   ├── prompts/     # 系统提示词
│   │   └── types.ts
│   ├── services/         # 各种服务（41 文件）
│   │   ├── aiGateway    # AI 网关（本地+云端）
│   │   ├── serialService # 串口
│   │   ├── toolchain    # Arduino CLI 编译
│   │   ├── platformio   # PlatformIO
│   │   ├── debugService  # SVD 调试
│   │   ├── lspService    # 代码智能提示
│   │   ├── gitService  # Git
│   │   ├── mcpManager  # MCP 外部协议
│   │   └── ...
│   ├── plugins/          # 插件系统（15 文件）
│   ├── mcp/             # MCP 协议（4 文件）
│   └── index.ts         # 入口
├── renderer/            # 渲染进程（React）
│   └── src/
│       └── components/   # 29 个 UI 组件
│           ├── EditorArea    # Monaco 编辑器
│           ├── AiPanel      # AI 面板
│           ├── SerialPlotter # 串口监视器
│           ├── DevicePanel    # 设备面板
│           ├── TerminalView  # 终端
│           └── ...
└── preload/             # 预加载脚本
```

---

## 3. 核心功能

### 3.1 AI 助手

**本地模型：**
- Qwen2.5 Coder 3B（gguf 格式，4GB 内存可跑）
- 内置知识库（40-60 条 ESP32 基础问答）
- 教学问答模式（精简提示词，禁工具）

**云端模型：**
- DeepSeek Flash（快速，1分/次）
- DeepSeek Coder（代码专用，2分/次）
- DeepSeek R1 推理（深度推理，4分/次）
- 通义千问 Coder（中文友好，2分/次）
- 通义千问 Max（通用强模型，3分/次）

**账号体系：**
- 邮箱验证码注册/登录（SMTP 发 6 位验证码，10 分钟有效）
- 新用户送 100 积分
- Guest 模式（匿名，50 次免费额度）

**Agent 能力：**
- 40+ 工具：文件读写/终端/Git/网页搜索/编译/烧录/SVD 调试
- Todo 工具（任务规划）
- ask_user（主动提问）
- 文件冲突检测（防 AI 覆盖用户改动）
- 反幻觉检测（声称 vs 工具证据）
- Diff 可视化（红绿行）

### 3.2 ESP32 开发

- **编译：** Arduino CLI / PlatformIO 双工具链
- **烧录：** esptool 一键烧录
- **串口监视器：** 实时日志 + 波形图
- **板级仿真：**
  - OLED 文本显示
  - ADC 滑块（模拟传感器）
  - DHT22 温湿度
  - 示波器（GPIO 波形）
- **演示固件：** ESP32-C3 / ESP32-S3 内置 bin

### 3.3 课程体系

28+ 个教学示例：
- 基础：LED、按键、PWM
- 通信：Wi-Fi、BLE、UART
- 传感器：DHT22、OLED、ADC
- 系统：FreeRTOS、任务调度
- 项目：智能家居、传感器节点

---

## 4. 已修复的 Bug

| 日期 | Bug | 修复 |
|---|---|---|
| 2026-10-08 | tool-observers.ts 给箭头函数设 .name 报错 | Object.defineProperty + try-catch |
| 2026-10-08 | 插件 UI XSS 风险 | 加 escapeHtml 转义 |
| 2026-10-07 | 串口监视器窗口遮挡 | 串口并入底部 Tab |
| 2026-10-06 | 文件冲突检测（防 AI 覆盖） | T8 冲突检测 |
| 2026-10-05 | 反幻觉检测（伪造工具响应） | T13 增强 |

---

## 5. 对标 TrieCode 的差距

**已对齐：**
- 工具集（40+ 个，基本持平）
- Diff 可视化
- 邮箱注册/登录
- 本地小模型（3B）

**仍有差距：**
- 模型绝对能力（TrieCode 用 Claude/GPT-4，我们用 DeepSeek/通义）
- 长上下文窗口
- 商业化成本（Claude API 太贵，不适合免费内置）

---

## 6. 云端后端

**技术栈：** 零依赖 Node.js ESM（cloud-server/server.mjs）

**API：**
- `POST /api/guest` — Guest 登录（设备指纹，50 次免费）
- `POST /api/auth/send-code` — 发邮箱验证码
- `POST /api/auth/verify-code` — 验证登录（新用户送 100 积分）
- `GET /api/models` — 模型列表（5 个）
- `POST /api/chat` — 聊天接口（转发到 DeepSeek/通义）

**部署：** https://bluebubai.work（生产）/ 127.0.0.1:8787（本地开发）

---

## 7. GitHub 仓库

- 地址：https://github.com/hulufeng/LabCode（私有）
- 问题：本地 git push 连不上 GitHub（国内网络），用 GitHub MCP API 推
- 解决：配 git 代理（Clash 7890 端口）或继续用 API

---

## 8. 待办

- [ ] 全量代码推到 GitHub（等网络通）
- [ ] SMTP 配置（生产环境需要用户提供 SMTP_HOST/PORT/USER/PASS）
- [ ] 线上 cloud-server 部署最新代码
- [ ] debug 相关文件合并成目录
- [ ] LSP 相关文件合并成目录

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

**云端模型（9 个，来自后端 `/api/models`，客户端不写死）：**
- DeepSeek Flash（快速，1分/次）、Coder（代码专用，2分/次）、R1 推理（深度推理，4分/次）
- 通义千问 Coder（中文友好，2分/次）、Max（通用强模型，3分/次）
- GPT-4o（6分/次）、GPT-4o mini（3分/次）— 需服务端配 `OPENAI_API_KEY`
- Gemini 1.5 Pro（5分/次）、Gemini 2.0 Flash（3分/次）— 需服务端配 `GEMINI_API_KEY`
- 未配对应 Key 的模型返回演示回复（仍真实扣积分，便于验证整链路）

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
- 模型绝对能力：已补 GPT-4o / Gemini，但需服务端配 Key 才真实生效（未配则演示回复）；Claude 仅 BYOK（用户自带 Key），不走官方积分通道
- 长上下文窗口（已给云端/BYOK 16000 字符读取预算，本地 4000）
- 商业化成本（Claude API 太贵，不适合免费内置）

---

## 6. 云端后端

**技术栈：** 零依赖 Node.js ESM（cloud-server/server.mjs）

**API：**
- `POST /api/auth/register` / `/api/auth/login` — 邮箱密码注册/登录
- `POST /api/auth/send-code` / `/api/auth/verify-code` — 邮箱验证码登录（新用户送 100 积分）
- `POST /api/guest` — Guest 匿名试用（设备指纹，50 次免费）
- `GET /api/me` — 查账户积分
- `GET /api/models` — 模型列表（9 个，见 3.1）
- `POST /api/chat` / `POST /api/chat/stream` — 非流式 / SSE 流式对话（含工具调用）

**按 provider 分派：** 每个模型自带 `provider + baseUrl + keyEnv`，后端按 provider 转发：
OpenAI 兼容档（openai / deepseek / qwen）直连 `/chat/completions`；**Gemini 由后端把 OpenAI 格式翻译成 Gemini 格式，并把响应归一化回 OpenAI 兼容 SSE**，因此客户端零改动。

**部署：** https://bluebubai.work（生产）/ 127.0.0.1:8787（本地开发）

---

## 7. GitHub 仓库

- 地址：https://github.com/hulufeng/chajian（public，默认分支 main）
- 状态：桌面端（codelab-desktop）**已推送成功**
- 注意：推送**必须走系统代理**（端口会变，用 `GIT_CURL_VERBOSE=1` 看实际端口）；清空代理环境变量会导致推送必败；代理偶发 502 需忽略重试
- 官网（codelab-site）是**独立 git 仓库**，不在此仓库内（见第 9 节）

---

## 8. 待办

- [x] 全量代码推到 GitHub（已完成 → hulufeng/chajian）
- [ ] SMTP 配置（生产环境需要用户提供 SMTP_HOST/PORT/USER/PASS）
- [ ] 线上 cloud-server 部署最新代码（含 GPT-4o / Gemini 模型）
- [ ] 服务端配 `OPENAI_API_KEY` / `GEMINI_API_KEY`（未配则对应模型走演示回复）
- [ ] debug 相关文件合并成目录
- [ ] LSP 相关文件合并成目录

---

## 9. 官网后台（codelab-site）

**技术栈：** 零依赖 Node.js ESM（`codelab-site/server/server.mjs`，端口 8788）

**职责：** 静态托管官网 + 管理后台 API —— 登录管理 / 插件上架 / 下载统计 / 内容管理 / 联系留言

**启动：** `cd codelab-site && node server/server.mjs` → 官网 `http://127.0.0.1:8788/`，后台 `/admin/`

**公开接口：**
- `GET /api/plugins` — 插件市场列表；`GET /api/plugins/:id` 详情
- `POST /api/plugins/:id/install` — 安装意向计数
- `GET /api/version` — 最新版本号（下载页徽标）
- `GET /api/content` — 内容列表（首页公告条消费）；`GET /api/content/:key` 单条
- `GET /api/downloads` — 下载统计（轻量）
- `POST /api/contact` — 提交联系留言
- `GET /d/:os`（windows/macos/linux）— 记录一次下载后 **302 跳转真实安装包**

**管理接口（Bearer token）：** `/api/admin/login` `/logout`；`plugins` / `content` CRUD；`contacts` 留言管理；`version` 版本设置；`downloads`、`overview` 统计

**配置：** `server/.env`（不入库，模板 `server/.env.example`）—— 管理员 `admin@labcode.dev` + 强密码；下载地址指向 `https://bluebubai.work/updates/LabCode-Setup-0.1.9.exe`（.dmg / .AppImage）。
⚠ 改管理员密码时：若 `server/data/db.json` 已存在，改 `.env` **不生效**，需删 `db.json` 重建账号。

**验证：** 从**工作区根**运行 `node codelab-site/server/check-site-server.mjs`（37 项断言，当前 37/0）。
⚠ 必须从工作区根运行 —— 脚本 spawn 的是相对根的路径；从 `codelab-site/` 或 `server/` 运行会 MODULE_NOT_FOUND。

**仓库：** `codelab-site` 已初始化为独立 git 仓库（首次提交 `94b997b`）；`.gitignore` 排除 `server/.env` 与 `server/data/`（含凭据与运行时数据）。

**前端对接点：** `index.html` 顶部公告条 + 联系表单 + `loadPlugins()`；`plugins.html` 动态拉插件；`download.html` 版本徽标 + `/d/windows` 下载按钮；各页导航含「管理后台」入口 `/admin/`。

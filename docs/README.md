# ⚡ BubaiCode

> 通用 AI 软件开发智能体 — 从想法到可运行的软件。

BubaiCode 内置真正动手的 AI 智能体：读写代码、执行命令、运行测试、联网检索。一个桌面应用，覆盖软件开发全流程。

**基于 TrieCode 仿写，品牌名 BubaiCode。**

---

## 📊 项目状态

| 项目 | 状态 |
|------|------|
| **当前版本** | v1.0.0 (MVP) |
| **完成度** | 52% (13/25 核心任务) |
| **当前迭代** | Sprint 1 - MVP 核心功能 ✅ |
| **下一迭代** | Sprint 2 - 真实 AI + 插件系统 |
| **目标发布** | 2026-11-01 (v1.0 正式版) |

---

## 📦 项目结构

```
BubaiCode/
├── desktop-app/                # 桌面客户端（核心）
│   ├── package.json            # 项目配置和依赖
│   ├── main/                   # Electron 主进程
│   │   ├── index.js            # 主进程入口（窗口管理/IPC/菜单）
│   │   ├── preload.js          # 预加载脚本（安全 IPC 接口）
│   │   └── terminal.js         # 终端服务（node-pty 集成）
│   └── renderer/               # 渲染进程
│       ├── index.html          # IDE 界面（含48个菜单项下拉菜单）
│       ├── css/
│       │   └── style.css       # IDE 样式（浅色主题，蓝色主色）
│       ├── js/
│       │   ├── app.js          # 智能体引擎（168KB，含AI思考/工具调用/计划进度/权限确认）
│       │   └── terminal.js     # 终端管理器（xterm.js 集成）
│       └── icons/
│           └── bubaicode-icons.svg # SVG 图标 sprite（50+图标，MIT许可）
│
├── website/                    # 官方网站
│   ├── index.html              # 主页面（Landing Page）
│   ├── css/style.css           # 网站样式
│   └── js/main.js              # 网站交互脚本
│
├── admin/                      # 管理后台
│   ├── index.html              # 管理后台主页面（7大模块）
│   ├── css/style.css           # 管理后台样式
│   └── js/app.js               # 管理后台逻辑
│
├── docs/                       # 文档
│   ├── README.md               # 本文档
│   ├── 开发文档.md              # 技术开发文档（API/实现说明）
│   ├── 团队协作指南.md          # 团队协作指南（分工/流程/规范）
│   ├── 项目任务看板.md          # 项目任务看板（进度/任务/Bug）
│   ├── HANDOFF.md              # 交接文档
│   ├── BubaiCode_vs_TrieCode_功能对比.md  # 与 TrieCode 功能对比
│   ├── TrieCode界面设计学习记录.md        # TrieCode 学习记录
│   └── screenshots/            # 截图归档
│
├── examples/                   # 示例代码
│   └── esp32_light_controller.ino  # ESP32 智能关灯控制器示例
│
└── README.md                   # 根目录说明
```

---

## ✨ 核心功能

### 🤖 AI 智能体引擎

- **统一 turn 循环** — 工具调用处理、残缺校验、并行/串行调度
- **三级权限策略** — Plan（只读）/ Default（确认）/ Auto（自动）
- **AI 思考过程展示** — 可折叠的思考区域，展示 AI 详细推理
- **工具调用记录** — 实时显示工具名/参数/结果，可展开详情
- **计划进度面板** — 多步骤任务管理，进度条+步骤列表
- **权限确认弹窗** — 4种选项（允许一次/本会话允许/按此修改/拒绝）
- **五类预算护栏** — 迭代数/token/成本/墙钟/无菌动作检测
- **验证硬闸门** — P0-4 验证级别、占位符检测、进展闸
- **计划系统** — submit_plan 触发计划批准、即兴清单
- **记忆系统** — remember/forget/list_memories 跨会话记忆
- **Skill 系统** — 基于 Omarchy Skill 标准结构，自动匹配开发场景
- **上下文压缩** — 四级压缩、主动水位、forceFold 兜底

### 💻 IDE 功能

- **现代编辑器** — Monaco 内核，多语言高亮，文件树 + 多标签
- **真实终端** — xterm.js + node-pty，支持 PowerShell/cmd/bash（含降级模式）
- **完整菜单栏** — 文件/编辑/视图/帮助，48个菜单项，快捷键支持
- **真实文件操作** — 打开项目/新建/保存/刷新，真实文件系统
- **测试运行器** — 自动识别 pytest/unittest/go test/cargo test
- **子智能体研究** — 只读研究子智能体，结论结构化返回
- **通用插件系统** — CLI/gRPC/HTTP/MCP/MQTT/stdio 七类通道
- **本地安全** — API Key 存本机，三种操作模式

### 🌐 官方网站 + 管理后台

- **官方网站** — 产品展示、功能介绍、下载页面
- **管理后台** — 7大模块（用户管理/API配置/插件管理/数据统计/系统设置/日志/权限）
- **可商用图标** — Tabler Icons（MIT 许可），50+ 内联 SVG sprite

### 🤖 支持的 AI 模型

- DeepSeek V4、通义千问 Qwen、MiniMax M3、智谱 GLM-5.2
- 另有 Kimi、Doubao、OpenAI、Claude、Ollama 本地模型
- 任意 OpenAI 兼容端点

> **注意：** 当前 AI 对话为模拟模式，需配置真实 API Key 后启用。

---

## 🎨 设计规范

### 品牌色

- **主色：** `#2563eb`（蓝色）
- **强调色：** `#06b6d4`（青色）
- **成功：** `#22c55e`（绿色）
- **警告：** `#f59e0b`（黄色）
- **错误：** `#ef4444`（红色）

### IDE 主题

- **浅色主题**（白色背景）
- **背景：** `#ffffff`
- **文字：** `#1f2937`
- **边框：** `#e5e7eb`
- **悬停：** `#f3f4f6`

---

## 🚀 快速开始

### 环境要求

- **操作系统：** Windows 10/11 x64（推荐）、macOS、Linux
- **Node.js：** v16.0.0+
- **npm：** v8.0.0+
- **内存：** 4GB+
- **磁盘：** 1.5GB+

### 桌面客户端开发

```bash
cd desktop-app

# 安装依赖
npm install

# 启动应用
npm start
# 或者
node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox

# 构建 Windows 安装包
npm run build:win

# 构建 macOS 安装包
npm run build:mac

# 构建 Linux 安装包
npm run build:linux
```

### 完整终端支持（可选）

要使用完整的 node-pty 终端（支持 vim/ssh 等），需要安装：

1. **Visual Studio 2022**（含 "Desktop development with C++" 工作负载）
2. **Python 3.10+**
3. 然后运行 `npm install node-pty@1.0.0 --save`

> 未安装时自动使用降级模式（child_process + 简单文本终端），基础命令可用。

### 网站开发

```bash
cd website
# 直接用浏览器打开 index.html
# 或使用本地服务器：
python3 -m http.server 8080
```

### 管理后台开发

```bash
cd admin
# 直接用浏览器打开 index.html
# 默认账号：admin / admin123
```

---

## 👥 团队协作

### 角色分工

| 角色 | 人数 | 负责模块 |
|------|------|----------|
| **项目负责人** | 1 | 项目规划、进度把控、决策 |
| **前端开发** | 2-3 | 界面、编辑器、UI/UX、网站、管理后台 |
| **后端开发** | 1-2 | 主进程、终端、文件系统、IPC、插件系统 |
| **AI 引擎开发** | 1-2 | 智能体引擎、工具调用、AI 集成 |
| **嵌入式开发** | 1 | Arduino/ESP-IDF/STM32 集成 |
| **测试/QA** | 1 | 功能测试、Bug 跟踪、文档 |
| **UI/UX 设计** | 1 | 界面设计、交互设计、图标 |

### 开发流程

```
需求分析 → 任务拆分 → 开发 → 代码审查 → 测试 → 发布
   ↑                                          ↓
   └──────────── 反馈迭代 ←──────────────────┘
```

### 沟通方式

- **每日站会：** 每天 09:00，15分钟
- **周例会：** 每周一 10:00，1小时
- **代码评审：** 每周三 15:00，1小时
- **沟通工具：** 飞书/钉钉 + GitHub + 腾讯会议

### 详细协作指南

详见 **[团队协作指南.md](团队协作指南.md)**，包含：
- 完整的角色定义和分工
- 敏捷开发流程
- 代码规范（JS/CSS/HTML/提交信息）
- Git 分支策略和工作流程
- 任务看板和进度跟踪
- 沟通协作方式
- 开发环境搭建
- 测试和发布流程
- 风险和应对措施

---

## 📋 任务进度

### 当前迭代（Sprint 1）✅ 已完成

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 桌面客户端框架 | P0 | ✅ |
| Monaco 编辑器集成 | P0 | ✅ |
| AI 智能体引擎 | P0 | ✅ |
| 真实终端集成 | P0 | ✅ |
| 文件树/项目管理 | P0 | ✅ |
| 菜单栏/工具栏（48项） | P1 | ✅ |
| AI 思考过程展示 | P1 | ✅ |
| 工具调用记录 | P1 | ✅ |
| 计划进度面板 | P2 | ✅ |
| 权限确认弹窗 | P1 | ✅ |
| 官方网站 | P2 | ✅ |
| 管理后台 | P2 | ✅ |
| 可商用图标替换 | P2 | ✅ |

### 下一迭代（Sprint 2）📋 待开始

| 任务 | 优先级 | 预计工时 |
|------|--------|----------|
| 真实 AI 对话集成（DeepSeek） | P0 | 24h |
| API Key 管理 | P0 | 8h |
| 模型选择器 | P1 | 8h |
| 插件系统框架 | P0 | 40h |
| Arduino CLI 插件 | P1 | 24h |
| 插件市场界面 | P1 | 16h |
| 串口监视器 | P1 | 16h |

### 详细任务看板

详见 **[项目任务看板.md](项目任务看板.md)**，包含：
- 完整的任务列表（40+ 任务）
- 进度概览和统计
- Bug 列表
- 里程碑计划
- 团队成员
- 会议记录

---

## 📚 文档清单

| 文档 | 说明 |
|------|------|
| **[README.md](README.md)** | 本文档，项目概览 |
| **[开发文档.md](开发文档.md)** | 技术开发文档，API 说明，实现原理 |
| **[团队协作指南.md](团队协作指南.md)** | 团队协作，分工，流程，规范 |
| **[项目任务看板.md](项目任务看板.md)** | 任务进度，Bug，里程碑 |
| **[HANDOFF.md](HANDOFF.md)** | 交接文档，项目历史 |
| **[BubaiCode_vs_TrieCode_功能对比.md](BubaiCode_vs_TrieCode_功能对比.md)** | 与 TrieCode 功能对比 |
| **[TrieCode界面设计学习记录.md](TrieCode界面设计学习记录.md)** | TrieCode 学习记录 |

---

## 🔧 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | v28.0.0 |
| 包管理 | npm | v8.0.0+ |
| 前端编辑器 | Monaco Editor | v0.45.0 |
| 终端界面 | xterm.js | v5.3.0 |
| 伪终端 | node-pty | v1.0.0（可选） |
| 构建工具 | electron-builder | v24.9.1 |
| 自动更新 | electron-updater | v6.1.7 |
| 图标 | Tabler Icons | MIT 许可 |
| 网站/后台 | 原生 HTML/CSS/JS | - |

---

## 📄 许可证

MIT License

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

贡献流程：
1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/awesome-feature`)
3. 提交更改 (`git commit -m 'feat: add awesome feature'`)
4. 推送到分支 (`git push origin feature/awesome-feature`)
5. 创建 Pull Request

---

**Built with ❤️ for developers.**

*项目基于 TrieCode 仿写，品牌名 BubaiCode。*

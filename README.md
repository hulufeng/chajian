# BubaiCode — 软硬件开发桌面 IDE

面向软硬件开发的一体化桌面 IDE：内置 AI 智能体、多 Agent 协作工作区、真实编译/烧录/串口工具链、板级仿真。

## 功能

### 多 Agent AI 工作区（对齐 Ekko Studio）
- **Agent 目录**：16 个内置 Agent（BubaiCode/Hermes/Claude/Codex/Grok/OpenCode/DeepSeek/Qwen/Kimi/CodeBuddy/Qoder/Copilot/Cursor/Antigravity/ZCode 等）+ 自定义 Agent 安装（OpenAI/Anthropic/Ollama/DeepSeek 模板）
- **CLI 工具**：真实 coding-agent CLI 安装/检测/更新/卸载（npm 全局安装，对齐 Ekko Agent Manager），已装 CLI 自动桥接为可执行 Agent，可进工作流与群聊
- **可视化工作流**：AI / 条件分支 / 终端命令 / 输出节点，连线编排、循环回边、审批门、导入导出、定时调度触发
- **群聊协作**：多 Agent 房间，@mention 定向，依次回应
- **定时任务**：支持 chat / workflow 两种模式深度执行

### 软硬件开发主线
- **ESP32 真实烧录**：Arduino CLI 工具链（自动下载引导），一键编译/烧录/串口监视
- **板级仿真**：OLED/ADC/DHT22/示波器等外设可视化，不接板子也能跑
- **开发流程流水线**：选板 → 编译 → 烧录 → 串口 一键贯通
- **课程体系**：28+ 个 ESP32 教学示例（LED/Wi-Fi/传感器/FreeRTOS/BLE）

### 基础能力
- 内置 AI 助手（本地模型 + 云端 DeepSeek/通义千问/自定义 API，40+ 工具）
- 双主题（深色/浅色）切换、用量统计、文件/Git/终端/MCP 插件面板

## 技术栈

Electron 28 + 原生 HTML/JS（Monaco 编辑器、node-pty 终端、xterm）

## 开发

```bash
npm install
npm run dev        # 开发模式启动
npm start          # 正常启动
```

## 打包发布

产物统一输出到 `desktop-app/dist/`。图标已内置（`resources/icon.ico` / `icon.png`）。

### Linux（AppImage + deb）

```bash
cd desktop-app
npx electron-builder --linux --publish never
# 产物：dist/BubaiCode-1.0.0.AppImage（免安装直接运行）
#       dist/BubaiCode_1.0.0_amd64.deb（sudo dpkg -i 安装）
```

### Windows（NSIS 安装包，在 Windows 本机执行）

```bash
cd desktop-app
scripts\build-win.bat        # 一键脚本（或 build-win.ps1）
# 产物：dist\BubaiCode Setup 1.0.0.exe
#       允许自选安装目录、自动创建桌面/开始菜单快捷方式
```

手动方式：

```bash
npx electron-builder --win --publish never
```

### macOS（dmg，需在 macOS 本机执行）

```bash
cd desktop-app
npx electron-builder --mac --publish never
# 产物：dist/BubaiCode-1.0.0.dmg
```

> 注：跨平台打包受限——Windows/macOS 安装包需在对应系统上构建（Linux 交叉编译 Windows 需 wine 且 Electron 二进制为对应平台版本）。

## 更新通道

应用内置 electron-updater，`build.publish` 指向自建更新服务 `https://bluebubai.work/updates`；发布新版本时生成 `latest*.yml` 与安装包即可实现增量更新。

# 代码实验室 CodeLab · 桌面客户端

通用软件开发智能体桌面客户端（Electron + React + TypeScript），界面**完全复刻 TrieCode** 桌面 IDE 布局，已按方案文档 10.6「桌面客户端技术栈落地清单」完成核心软件功能、Windows 打包分发、插件系统与自动更新。

## 当前状态（10.6 落地清单）

- [x] **D1 工程骨架**：Electron + React + TS，主 / 渲染进程 IPC 通信
- [x] **D2 四栏 IDE 布局**：顶部菜单栏 / 左侧插件市场 / 中间多标签 Monaco 编辑器 / 底部输出面板 / 右侧 AI 面板 / 状态栏
- [x] **D3 终端 + 串口**：输出面板「终端」tab（xterm.js + 主进程命令执行，可运行 PowerShell/命令）；「串口监视器」tab（serialport 枚举端口 / 打开 / 关闭 / 波特率切换 / 实时数据）
- [x] **D4 arduino-cli 集成**：启动时自动检测工具链（PATH + 常见安装路径），状态显示在工具栏 / 状态栏
- [x] **D5 编译 / 烧录**：工具栏「编译」「烧录」按钮，封装 arduino-cli compile/upload，流式输出到「输出」tab，错误行自动汇总到「问题 2」tab
- [x] **D6 项目树 + 文件读写**：打开项目文件夹 → 渲染文件树（自动跳过 node_modules/.git 等）→ 点击文件在 Monaco 打开，支持编辑 / 保存（脏标记 ●）
- [ ] **D7 AI 闭环**：AI 网关已占位（设置环境变量 `CODELAB_AI_BASE_URL` / `CODELAB_AI_API_KEY` / `CODELAB_AI_MODEL` 后接入 OpenAI 兼容接口；未配置时返回提示）。**当前按用户要求留空，暂不接入真实模型**
- [x] **D8 打包分发**：electron-builder 打 Windows 安装包（NSIS）+ 免安装便携版，应用图标使用品牌 Logo，关闭原生模块 rebuild（serialport 走 Node-API，跨 ABI 兼容，实测可用）
- [x] **D9 插件化**：自研插件运行时（对标 TrieCode 7 通道：internal / backend / cli / http / grpc / mcp / mqtt），**3 款官方插件已封装**——Arduino CLI / ESP-IDF / STM32Cube 工具链（manifest 声明式 + 命令注册），编译/烧录/串口全部经插件通道调用
- [x] **自动更新**：electron-updater 接入（generic provider），打包自动生成 latest.yml / app-update.yml，状态栏「⟳ 检查更新」按钮 + 下载进度 + 一键安装 + 更新源运行时配置（详见 UPDATE_DEPLOY.md）

## 技术栈

| 层次 | 选型 |
|---|---|
| 桌面壳 | Electron 44 |
| 构建 | electron-vite 5 + Vite 7 |
| UI | React 19 + TypeScript 5.9 |
| 编辑器 | Monaco Editor（@monaco-editor/react，本地 worker） |
| 终端 | @xterm/xterm + @xterm/addon-fit（主进程 child_process 执行） |
| 串口 | serialport（Node-API，跨 ABI 稳定） |
| 工具链 | arduino-cli（编译 / 烧录封装） |
| 打包 | electron-builder 26（NSIS）+ electron-updater 6 |
| 插件 | 自研插件运行时（7 通道 manifest） |
| IPC | contextBridge + ipcRenderer（上下文隔离开启） |

## 插件体系（D9）

对标 TrieCode 7 通道，自研插件运行时 `src/main/plugins/pluginManager.ts`：

| 通道 | 用途 | 现状 |
|---|---|---|
| internal | 插件内部命令（如 arduino.version） | ✅ 已实现 |
| backend | 主进程后端命令（IPC 可调用） | ✅ 已实现（toolchain.detect/compile/upload、serial.list/open） |
| cli | 命令行能力声明（arduino-cli compile/upload） | ✅ 已声明 |
| http / grpc / mcp / mqtt | 外部服务通道 | 预留（manifest 声明） |

**3 款官方工具链插件**（`src/main/plugins/`）：

| 插件 | 通道命令 | 依赖工具链 |
|---|---|---|
| `arduino-toolchain` | backend: toolchain.detect/compile/upload、serial.list/open；internal: arduino.version | arduino-cli |
| `esp-idf-toolchain` | backend: espidf.detect/build/flash/setTarget；internal: espidf.version | idf.py（ESP-IDF） |
| `stm32-cube-toolchain` | backend: stm32.detect/build/flash；internal: stm32.version | STM32CubeCLT / CubeProgrammer |

统一模板：`manifest.json`（声明式：名称/版本/入口/7 通道命令清单）+ `index.ts`（`load(ctx)` 内 `ctx.registerBackend / registerInternal` 注册命令，流式任务返回 `{ start(push, done) }` 由主进程驱动）。主进程启动时 `pluginManager.init()` 加载，日志确认各插件版本。第三方插件放入 plugins 目录即可被发现。

## 自动更新

- `src/main/updater.ts`：electron-updater 接入，`app.isPackaged` 时启用
- 事件：checking / available / not-available / progress / downloaded / error
- UI：状态栏「⟳ 检查更新」（悬浮提示当前更新源）→ 有更新可下载 → 下载进度 % → 「安装」一键重启安装
- 更新源优先级：环境变量 `CODELAB_UPDATE_URL` > `%APPDATA%\codelab-desktop\settings.json` 的 `updateUrl` > 打包内置 `build.publish.url`
- 一键设置更新源：`node scripts/set-update-url.js https://bluebubai.work/updates/`（无需重新打包）
- 发布产物：`latest.yml` + 安装包 + `.blockmap`，用 `scripts/sftp-upload.js` 上传到 ECS
- **✅ 更新服务器已上线（HTTPS）**：阿里云 ECS（青岛）+ 域名 `bluebubai.work`，更新源 `https://bluebubai.work/updates/`（Let's Encrypt 证书，HTTP/2），0.1.0 / 0.1.1 / 0.1.2 已发布，应用端到端验证通过（nginx 日志捕获 `GET /updates/latest.yml` HTTP/2 "electron-builder" 200）
- **完整上线流程见 [`UPDATE_DEPLOY.md`](UPDATE_DEPLOY.md)**

## 目录结构

```
codelab-desktop/
├─ package.json                 # 含 build（electron-builder）+ publish 配置
├─ electron.vite.config.ts
├─ build/icon.ico               # 品牌图标（Logo 转换）
├─ dist/                        # 打包产物（安装包 + 便携版 + latest.yml）
└─ src/
   ├─ main/
   │  ├─ index.ts               # 窗口 + 全部 IPC（项目/文件/插件/串口/命令/AI/流式推送）
   │  ├─ updater.ts             # electron-updater 自动更新
   │  ├─ services/
   │  │  ├─ fsService.ts        # 项目树 / 文件读写
   │  │  ├─ toolchain.ts        # arduino-cli 检测 / 编译 / 烧录
   │  │  ├─ espIdfService.ts    # ESP-IDF 检测 / 编译 / 烧录
   │  │  ├─ stm32Service.ts     # STM32 工具链检测 / 编译 / 烧录
   │  │  ├─ serialService.ts    # 串口枚举 / 打开 / 关闭
   │  │  ├─ commandService.ts   # 终端命令执行
   │  │  └─ aiGateway.ts        # AI 网关（OpenAI 兼容，占位）
   │  └─ plugins/
   │     ├─ pluginManager.ts            # 插件运行时（7 通道）
   │     ├─ arduino-toolchain/          # 官方插件 ①：Arduino CLI
   │     ├─ esp-idf-toolchain/          # 官方插件 ②：ESP-IDF
   │     └─ stm32-cube-toolchain/       # 官方插件 ③：STM32Cube
   ├─ preload/index.ts          # contextBridge 完整 API + 事件订阅
   └─ renderer/
      ├─ index.html
      └─ src/
         ├─ main.tsx / App.tsx  # 全局状态 + IDE 组装
         ├─ components/
         │  ├─ TitleBar.tsx / Toolbar.tsx（编译/烧录/板卡/端口）
         │  ├─ ProjectTree.tsx  # 项目树
         │  ├─ PluginSidebar.tsx  # 插件市场
         │  ├─ EditorArea.tsx   # 多标签 Monaco（脏标记/保存）
         │  ├─ OutputPanel.tsx  # 输出/问题/串口监视器/绘图仪/终端
         │  ├─ TerminalView.tsx # xterm 终端
         │  ├─ AiPanel.tsx / StatusBar.tsx（插件数 + 检查更新）
         └─ assets/main.css
```

## 运行命令

```bash
cd D:\工作\代码实验室\codelab-desktop
npm run dev       # 开发模式（自动打开窗口）
npm run build     # 构建产物到 out/
npm run start     # 预览构建产物
npm run typecheck # 类型检查（node + web）
npm run dist      # 打包 Windows 安装包（NSIS + 更新元数据）
```

## 打包产物（D8 完成）

产物位于 `dist/`：
- `CodeLab-Setup-0.1.2.exe`（~129 MB）— NSIS 安装包：可选安装目录、桌面/开始菜单快捷方式、品牌图标（最新版，0.1.0 / 0.1.1 为历史版）
- `win-unpacked/CodeLab.exe`（~234 MB）— 免安装便携版，直接双击运行
- `latest.yml` — 自动更新元数据（版本 / sha512 / 大小）

打包要点：
- 应用图标 = 品牌 Logo（`build/icon.ico`，由 logo_appicon.png 经 PNG→ICO 多尺寸转换）
- `npmRebuild: false`：本机无 VS 工具链时跳过原生模块重编译；serialport 走 Node-API（ABI 149 兼容，实测在 Electron 44 / Node 24 下加载成功并枚举到端口），串口功能完整保留
- 国内镜像：`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

## 使用说明

1. **打开项目**：左侧「📂 项目 → 打开项目」选择文件夹，文件树显示，点击 `.ino` / `.c` / `.cpp` 等文件在编辑器打开
2. **编译**：工具栏确认「板卡 FQBN」（默认 `esp32:esp32:esp32c3`）→ 点「▶ 编译」，输出实时显示在底部「输出」tab
3. **烧录**：串口选择端口（工具栏或串口面板）→ 点「烧录」
4. **串口监视**：底部「串口监视器」tab → 选端口 / 波特率 → 「● 打开」，设备数据实时显示
5. **终端**：底部「终端」tab → 输入命令回车，在项目目录执行（PowerShell）
6. **检查更新**：状态栏「⟳ 检查更新」，有新版可下载安装
7. **AI 助手**：右侧面板对话（D7 留空，配置 `CODELAB_AI_BASE_URL` / `CODELAB_AI_API_KEY` 环境变量后接入真实模型）

## 验证结果

- `npm run typecheck`：通过（node + web）
- `npm run build`：通过（main / preload / renderer 三部分）
- `npm run dev`：插件系统就绪（已加载 Arduino CLI v0.3.11 / ESP-IDF v0.1.11 / STM32Cube v0.1.2 共 3 款），窗口创建 + 渲染完成，无错误
- `dist/win-unpacked/CodeLab.exe`：启动验证通过（进程存活、无崩溃）
- 原生模块：serialport 在 Electron 44（Node 24，ABI 149）下加载成功，`SerialPort.list()` 实测枚举到端口
- 自动更新：`latest.yml`（sha512/大小）与 `app-update.yml` 随打包生成

## 品牌素材

- `D:\工作\代码实验室\codelab-doc\logo_appicon.png` — 主图标
- `D:\工作\代码实验室\codelab-doc\logo_horizontal.png` — 横版组合

## 下一步

1. **更新服务器已上线（完成）**：按 `UPDATE_DEPLOY.md` 把 latest.yml + 安装包传到 HTTPS 更新源 `https://bluebubai.work/updates/`，0.1.0 / 0.1.1 / 0.1.2 已发布并用 `node scripts/set-update-url.js <url>` 写入应用（详见 UPDATE_DEPLOY.md）
2. **D7 真实 AI**：用户确认后填写 API 配置，跑通「AI 生成 → 编译 → 烧录 → 串口回读」最短闭环
3. **更多插件**：Wokwi 模拟器 / browser-toolchain 等按统一模板封装

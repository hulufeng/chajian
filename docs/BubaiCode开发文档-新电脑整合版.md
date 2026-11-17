# BubaiCode 开发文档（新电脑接手整合版）

**版本：** v1.0.2 | **整理日期：** 2026-09-09
**项目定位：** 仿写 TrieCode（www.triecode.com，v1.2.9）的 AI 编程桌面开发工具
**GitHub 仓库：** https://github.com/hulufeng/BubaiCode（public，最新 commit：2d3654f）
**本地项目路径：** `D:\工作\BubaiCode\`

> 📌 **本文件是整合版**：合并了《开发文档-完整版》《BubaiCode项目整理与继续开发指南》《TrieCode实际操作记录》《BubaiCode_vs_TrieCode_功能对比》《HANDOFF》等文档的核心内容，**新电脑只需读这一份即可接手开发**。

---

## 一、项目是什么

BubaiCode 是一款集成 **Monaco 编辑器 + AI 智能体 + 内置终端 + 测试运行器** 的桌面开发工具，核心亮点是 AI 能真正动手读写代码、执行命令、运行测试，通过三种权限模式保障安全。

项目包含**三端**：

| 端 | 目录 | 技术栈 | 状态 |
|---|---|---|---|
| 官方网站 | `website/` | HTML + CSS + JS（纯静态） | ✅ 已完成 |
| 桌面客户端 | `desktop-app/` | Electron 28 + Monaco + 智能体引擎 | ✅ MVP 完成 |
| 管理后台 | `admin/` | HTML + CSS + JS（localStorage 持久化） | ✅ 已完成（7 大模块） |

**品牌硬约束（不可改）：**
- 品牌名：**BubaiCode**
- 主题：浅色白色主题，主色蓝色 `#2563eb`
- 图标：Tabler Icons 风格内联 SVG（MIT 许可，可商用）

---

## 二、环境要求（新电脑）

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 64位（推荐）、macOS、Linux |
| Node.js | v16.0.0 或更高（建议 v18+） |
| npm | v8.0.0 或更高 |
| 内存 | 4GB+ |
| 磁盘空间 | 1.5GB+ |
| 网络 | 需要联网（npm install / AI 调用） |

---

## 三、获取代码（二选一）

### 方式 A：从 GitHub 克隆（推荐）

```bash
git clone https://github.com/hulufeng/BubaiCode.git
cd BubaiCode
```

> ✅ **已确认**：GitHub 上文件齐全（含 app.js 168KB、package-lock.json 100KB），`npm install` 后可直接运行。2026-09-09 已实测 clone 验证。

### 方式 B：本 zip 解压

解压本包到任意位置（不含 node_modules 和 .git），进入 `desktop-app/` 执行 `npm install`。

---

## 四、项目结构

```
BubaiCode/
├── .gitignore                       # Git 忽略规则
├── README.md                        # 根目录项目说明
│
├── website/                         # ═══ 官方网站 ═══
│   ├── index.html                   # 网站首页（产品展示+下载入口）
│   ├── css/style.css
│   └── js/main.js
│
├── admin/                           # ═══ 管理后台 ═══
│   ├── index.html                   # 后台首页（7大模块导航）
│   ├── css/style.css
│   └── js/app.js                    # 后台逻辑（localStorage 存储）
│
├── desktop-app/                     # ═══ 桌面客户端（核心）═══
│   ├── package.json                 # 项目配置（依赖清单）
│   ├── package-lock.json            # 依赖锁文件
│   ├── main/                        # Electron 主进程
│   │   ├── index.js                 # 主进程入口（窗口/IPC/菜单/配置/会话/更新）
│   │   ├── preload.js               # 预加载脚本（暴露 window.BubaiCode API）
│   │   └── terminal.js              # 终端服务（node-pty + 降级模式）
│   └── renderer/                    # 渲染进程
│       ├── index.html               # 主界面（五区布局）
│       ├── css/style.css
│       ├── js/
│       │   ├── app.js               # 智能体引擎（168KB，核心逻辑）
│       │   └── terminal.js          # 终端管理器（xterm.js 集成）
│       └── icons/
│           └── bubaicode-icons.svg    # SVG 图标库（50+ 图标，MIT）
│
├── docs/                            # ═══ 文档 ═══
│   ├── 开发文档-完整版.md           # 详细开发文档
│   ├── TrieCode实际操作记录.md       # TrieCode 真实操作记录
│   ├── BubaiCode_vs_TrieCode_功能对比.md
│   ├── TrieCode界面设计学习记录.md
│   ├── HANDOFF.md                   # 交接文档
│   ├── 团队协作指南.md
│   ├── 项目任务看板.md
│   └── screenshots/                 # 测试截图（修复前后证据）
│
└── examples/
    └── esp32_light_controller.ino   # ESP32 智能关灯控制器示例
```

---

## 五、快速开始

### 5.1 安装依赖并启动桌面客户端

```bash
cd desktop-app
npm install          # 安装依赖（含 electron、xterm、iconv-lite 等）
npm start            # 启动
```

> ⚠️ **重要**：本机若白屏/崩溃，必须加参数启动：
> ```bash
> node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox
> ```

### 5.2 打开其他两端

| 内容 | 打开方式 |
|---|---|
| 管理后台 | 浏览器打开 `admin\index.html`（默认账号 **admin / admin123**） |
| 官方网站 | 浏览器打开 `website\index.html` |

### 5.3 依赖清单（package.json）

- **dependencies**：`@tabler/icons`、`@tabler/icons-webfont`、`electron-updater`、`iconv-lite@^0.6.3`（GBK 编码检测用，已加入依赖）、`xterm`、`xterm-addon-fit`、`xterm-addon-web-links`
- **devDependencies**：`electron@^28.0.0`、`electron-builder@^24.9.1`

> ⚠️ 注意：node-pty 未安装（编译需 VS C++ 工具链），终端自动走**降级模式**（child_process），不影响使用。

---

## 六、桌面客户端架构

### 6.1 进程架构

```
┌─────────────────────────────────────────────────┐
│                  Electron 主进程                 │
│              main/index.js（窗口/IPC/菜单）       │
│         main/terminal.js（终端服务）             │
├─────────────────────────────────────────────────┤
│              Preload 预加载脚本                  │
│           main/preload.js（contextBridge）       │
├─────────────────────────────────────────────────┤
│              渲染进程（renderer/）               │
│  index.html（界面） + app.js（智能体引擎）       │
│  terminal.js（xterm 终端） + style.css           │
└─────────────────────────────────────────────────┘
```

- **安全配置**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`
- 渲染进程通过 `window.BubaiCode.*` 调用主进程能力（IPC）
- **关键约束**：renderer 因 contextIsolation **没有 require()**，所有 Node 能力必须走 preload 暴露的 API

### 6.2 主进程（main/index.js）

1. **窗口管理** — 无边框窗口（frame: false），宽高记忆（config.json）
2. **菜单** — 原生菜单：文件/编辑/视图/帮助
3. **配置存储** — `%APPDATA%\BubaiCode\config.json`
4. **会话存储** — `%APPDATA%\BubaiCode\sessions\*.json`
5. **IPC 接口** — 窗口控制、配置、会话、对话框、文件读写、终端、外部链接、代理、自动更新
6. **文件读写（含编码自动检测）**：
   - 读文件：UTF-8 BOM → 严格 UTF-8 解码（fatal）→ GBK 回退（iconv-lite）
   - 写文件：`ensureDir` 自动创建父目录 + UTF-8 写入

### 6.3 预加载脚本（main/preload.js）

```javascript
window.BubaiCode = {
  window:   { minimize, maximize, close, isMaximized },
  config:   { get, set, save },
  sessions: { list, save, delete },
  dialog:   { openFile, openDirectory, saveFile },
  fs:       { readFile, writeFile, exists, listDir },
  shell:    { openExternal },
  app:      { getVersion, getPath, getPlatform },
  proxy:    { set },
  update:   { check, download, install },
  terminal: { create, write, resize, getBuffer, clearBuffer, kill, list, execute, onData, onExit },
  on:       (channel, callback)
}
```

### 6.4 智能体引擎（renderer/js/app.js）★ 核心文件

**168KB，约 4100 行**，主要模块：

| 模块 | 说明 |
|---|---|
| Electron 适配层 | isElectron 检测、FileSystem 封装 |
| 状态管理 | state 对象（files/tabs/memories） |
| 文件树 & 编辑器 | 文件树渲染、标签页、Monaco 编辑器 |
| 工具定义 TOOL_DEFS | **16 个 AI 工具** |
| 权限判定 | computeNeedsConfirm / isPlanGated |
| 7 层终端安全拦截 | 危险命令/敏感路径/链式命令检测 |
| Rule 权限引擎 | PermissionRule / PermissionRuleEngine |
| 文件回滚系统 | FileChangeTracker（Turn 级回滚） |
| 技能系统 | BUILTIN_SKILLS / SkillManager |
| Mock AI 客户端 | MockAIClient（模拟响应，待替换真实 API） |
| 工具瀑布 | ToolPipeline（四阶段） |
| 流式调度器 | StreamingScheduler |
| 子智能体 | SubAgent（只读调研） |
| AgentRunner | 智能体主循环（核心） |

### 6.5 AI 工具清单（16 个）

| 工具名 | 类别 | 说明 |
|---|---|---|
| `list_files` | query | 列出工作区文件 |
| `read_file` | query | 读取文件内容 |
| `write_file` | modify | 写入/创建文件 |
| `edit_file` | modify | 编辑文件（替换指定文本） |
| `delete_file` | modify | 删除文件 |
| `terminal` | execute | 执行终端命令 |
| `run_test` | execute | 运行项目测试 |
| `todo_write` | modify | 创建/更新任务清单 |
| `submit_plan` | modify | 提交计划供批准 |
| `remember` / `forget` / `list_memories` | modify/query | 长期记忆管理 |
| `web_search` / `web_fetch` | query | 联网检索（SSRF 防护+缓存） |
| `ask_user` | query | 向用户提问 |
| `run_subagent` | query | 派只读子智能体调研 |

### 6.6 三种权限模式

| 模式 | 行为 |
|---|---|
| ⚡ **auto** | AI 直接执行所有操作，无需确认 |
| 🛡 **default**（默认） | 查询自动执行；写入/删除/高风险命令弹窗确认 |
| 📋 **plan** | 只读探索，先输出实施计划，确认后执行 |

**安全机制：** 7 层终端拦截（受保护路径 `.git/`、`.env` 等）、高风险命令（`git push`、`rm -rf` 等）、Rule 权限引擎、审批审计（5000 条上限）。

### 6.7 界面布局（五区，对齐 TrieCode）

```
┌─────────────────────────────────────────────────────────┐
│ 标题栏：Logo + 菜单(文件/编辑/视图/帮助) + 窗口控制       │
├──────────┬──────────────────────────────┬───────────────┤
│ 活动栏    │  编辑器区域                    │  AI 对话面板   │
│ 侧边栏    │  标签页 + Monaco 编辑器       │  快捷指令按钮   │
│ (文件树)  │                              │  AI 输入框     │
├──────────┴──────────────────────────────┴───────────────┤
│ 底部面板：输出 / 问题 / 终端 / 调试控制台                  │
├─────────────────────────────────────────────────────────┤
│ 状态栏：CN 位置 UTF-8 用户ID                             │
└─────────────────────────────────────────────────────────┘
```

---

## 七、管理后台（admin/）

### 7.1 七大模块

仪表盘 / 用户管理 / API 配置 / 插件管理 / 会话管理 / 日志 / 设置

### 7.2 关键说明

- **localStorage 本地存储**（非后端），默认数据在 `admin/js/app.js` 的 `DEFAULT_*` 常量
- 默认账号：**admin / admin123**
- **API 配置**：`PROVIDER_ENDPOINTS` 定义了 DeepSeek/Qwen/MiniMax/智谱/Kimi/豆包/OpenAI/Claude/Ollama/自定义端点

---

## 八、最新修复记录（2026-09-09，已在 GitHub）

### 1. 新建项目功能修复（用户反馈"点不动"）
- **根因**：① renderer 因 contextIsolation 无 `require()`，createProject 抛错；② 欢迎页按钮绑定到不存在的 `new-project-btn`
- **修复**：实现 `new-project-modal` 弹窗（**6 类型卡片**：Arduino/Python/Node.js/ESP-IDF/C/C++/通用）+ `createProject` 磁盘创建（纯字符串路径拼接 + `FileSystem.writeFile`，主进程自动建目录）
- **验证**：创建 `ESP32C3_DesktopRobot` 项目成功，磁盘落盘 `.bubaicode.json` + `.ino` + `README.md`

### 2. GBK 编码乱码修复
- **根因**：GBK 编码的 .ino 文件（中文 Windows 常见）按 UTF-8 读取产生乱码
- **修复**：主进程 `fs:readFile` 自动检测（UTF-8 BOM → 严格 UTF-8 → GBK 回退 via iconv-lite）
- **验证**：GBK 中文文件在编辑器正确显示"ESP32 智能关灯控制器"等中文
- **依赖**：iconv-lite 已加入 `package.json` dependencies（**必须保留**，否则新电脑 GBK 修复失效）

---

## 九、当前状态：已完成 vs 待开发

### ✅ 已完成

1. TrieCode 界面完全对齐（五区布局、浅色主题、蓝色 #2563eb）
2. 菜单栏 文件/编辑/视图/帮助（含快捷键）
3. 33+ 按钮全部可点击
4. 真实文件操作（打开项目/新建/保存/刷新，Electron 环境写磁盘）
5. 新建项目弹窗（6 类型模板，2026-09-09 修复）
6. AI 智能体引擎（16 工具、三级权限、AgentRunner、思考过程展示、工具调用记录、权限确认弹窗）
7. 终端（xterm.js + 降级模式，PowerShell）
8. 7 层终端安全拦截 + Rule 权限引擎 + 审批审计
9. GBK 编码自动检测（2026-09-09 修复）
10. 50+ 可商用 SVG 图标（Tabler 风格，MIT）
11. 管理后台 7 大模块 + 官方网站
12. GitHub 仓库完整可 clone 运行

### 🔄 待开发 / 当前为模拟

| 功能 | 现状 | 完成所需 |
|---|---|---|
| AI 真实对话 | MockAIClient 模拟 | 用户提供 API Key，替换为真实 HTTP 调用（管理后台已可配置 provider） |
| 编译/烧录/验证 | 模拟输出 | 安装 Arduino CLI（约 60MB）+ serialport 串口库 |
| node-pty 真实终端 | 降级模式 | Windows 需 VS 2019+ C++ 构建工具重新编译 |
| 开发板选择 UI | 未实现 | 对齐 TrieCode 状态栏工具链菜单 |
| 插件系统/MCP | 未实现 | 需基础设施 |
| SQLite 会话持久化 | 内存存储 | 需 better-sqlite3 |
| 安装包 | 未打包 | 需 resources/ 图标 + electron-builder 构建 |
| 部署上线 | 未部署 | 官网可用 GitHub Pages 托管 |

---

## 十、TrieCode 真实操作记录（要点）

> 2026-09-09 在真实 Windows 桌面操作 TrieCode v1.2.9，完整过程见 `docs/TrieCode实际操作记录.md`。

### 操作流程（Arduino ESP32-C3 桌面机器人项目）

1. **启动**：cu.list_apps 找到 `TrieCode#...` → launch_app 启动，欢迎页文案"我们要一起做些什么？"
2. **新建项目**：弹窗列出 **9 种类型**（Arduino/插件/ESP-IDF/Node.js/Python/C/C++/Rust/通用）→ 选 Arduino → 输入 `DesktopRobot_ESP32C3`
3. **生成文件**：`.ino` 空模板 + `.triecode.json`：
   ```json
   { "version": 1, "projectType": "arduino", "toolchain": "arduino-cli-toolchain" }
   ```
4. **写代码**：ESP32-C3 机器人避障代码（双电机+LED+HC-SR04）
5. **开发板选择**：状态栏"工具链 Arduino CLI 工具链 未选择开发板"→ 工具链菜单有 Arduino CLI / ESP-IDF 两项
6. **AI 对话**：输入"帮我选择ESP32-C3开发板，然后编译这个项目" → **"积分不足，请前往官网充值或升级套餐"**（AI 需付费）
7. **终端**：`arduino-cli version` → **CommandNotFoundException**（本机未装 arduino-cli）
8. **编译**：未选板点 ✓编译 → 无反应

### 关键结论

- TrieCode 的 Arduino 工具链底层是 **arduino-cli**，未安装时无法编译/烧录（TrieCode 也不会替你装）
- **TrieCode AI 需积分付费**（免费版 200 积分/月）→ BubaiCode 的差异化机会：**管理后台配 API Key，用户自带 Key 即可用，不锁积分**
- TrieCode 也有部分按钮"点不动"（文件菜单无下拉）→ 此类桌面工具菜单不完整属常见问题

### TrieCode vs BubaiCode 操作对比

| 操作步骤 | TrieCode | BubaiCode | 结论 |
|---|---|---|---|
| 启动 | launch_app | electron.exe | ✅ 一致 |
| 新建项目 | 9 类型弹窗 | 6 类型弹窗（已修复） | ⚠️ 可补 插件/C/Rust |
| 项目元数据 | `.triecode.json` | `.bubaicode.json`（同结构） | ✅ 对齐 |
| 代码编辑 | Monaco | Monaco | ✅ 一致 |
| 终端 | PowerShell + node-pty | PowerShell（降级模式） | ⚠️ 需装 node-pty |
| AI 对话 | 需积分（付费墙） | MockAIClient | ✅ BubaiCode 差异化 |
| 开发板选择 | arduino-cli | 未实现 | ⚠️ 待补 |
| 编译 | 需 arduino-cli+选板 | 无编译按钮 | ⚠️ 待实现 |
| 编码处理 | 未知 | GBK 自动检测 | ✅ BubaiCode 更优 |

---

## 十一、打包发布

```bash
cd desktop-app
npm run build:win      # Windows NSIS 安装包
npm run build:mac      # macOS DMG
npm run build:linux    # Linux AppImage + deb
```

- appId：`com.BubaiCode.app`
- **注意**：`resources/` 目录目前可能不存在，打包前需添加图标文件（icon.ico/icns/png）

---

## 十二、代码规范

- ES6+ 语法、2 空格缩进、单引号字符串、中文注释
- 函数驼峰式、类帕斯卡式

### 新增 AI 工具步骤

在 `app.js` 的 `TOOL_DEFS` 数组添加 `{ name, category, description, parameters, execute }`。

### 新增 IPC 通道步骤

1. `main/index.js` 添加 `ipcMain.handle('my:channel', ...)`
2. `main/preload.js` 添加 `myModule: { myMethod: (arg) => ipcRenderer.invoke('my:channel', arg) }`

---

## 十三、常见问题排查

| 问题 | 解决方案 |
|---|---|
| Electron 白屏/崩溃 | 加参数启动：`--disable-gpu --no-sandbox` |
| 终端不显示 | 检查 node_modules 是否有 xterm；看控制台 CDN 加载 |
| 按钮点了没反应 | 检查 DevTools Console 报错；确认 HTML 元素 id 与 JS 选择器一致 |
| 新建项目失败 | 确认 renderer 代码**没有 require()**（contextIsolation 下不可用），用 `FileSystem.writeFile` |
| GBK 文件乱码 | 确认主进程 index.js 的编码检测逻辑存在 + iconv-lite 已安装 |
| node-pty 编译失败 | 不影响使用（自动降级），想用真实终端需装 VS Build Tools |
| GitHub push 失败 | 网络不稳时重试，或改用 MCP push_files |
| 重置应用数据 | 删除 `%APPDATA%\BubaiCode` 目录 |

---

## 十四、下一步建议（按优先级）

1. [x] **补推 app.js 与 package-lock.json 到 GitHub** ✅ 已完成（commit 9664d30）
2. [x] **新建项目功能修复** ✅ 已完成（commit 195924a）
3. [x] **GBK 编码检测 + iconv-lite 依赖** ✅ 已完成（commit 2d3654f）
4. [ ] **真实 AI 集成**：用户提供 API Key → 替换 MockAIClient → 对接管理后台配置的服务商
5. [ ] **安装 Arduino CLI**（约 60MB）→ 实现真实编译/烧录/验证 + 开发板选择 UI
6. [ ] **打包安装程序**：添加 resources/ 图标，electron-builder 构建
7. [ ] **部署上线**：官网 GitHub Pages，后台可本地部署
8. [ ] **插件系统**：参考 TrieCode 插件市场

---

## 十五、参考资料

- [TrieCode 官网](https://www.triecode.com)
- [Electron 文档](https://www.electronjs.org/docs)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [xterm.js](https://xtermjs.org/)
- [Tabler Icons](https://tabler-icons.io/)（MIT 可商用）

---

*本文档为整合版（2026-09-09），基于真实代码核实整理；GitHub 仓库：https://github.com/hulufeng/BubaiCode*

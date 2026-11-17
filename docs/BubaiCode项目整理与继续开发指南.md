# BubaiCode 项目整理与继续开发指南

**整理时间：** 2026-09-09
**项目全称：** BubaiCode（仿写 TrieCode 的 AI 编程 IDE）
**GitHub 仓库：** https://github.com/hulufeng/BubaiCode（public）
**本地项目路径：** `D:\工作\BubaiCode\`

---

## 一、项目是什么

BubaiCode 是一款对标 **TrieCode（www.triecode.com，v1.2.9）** 的 AI 编程桌面开发工具，包含三端：

| 端 | 目录 | 技术栈 | 状态 |
|---|---|---|---|
| 官方网站 | `website/` | HTML + CSS + JS | ✅ 已完成 |
| 桌面客户端 | `desktop-app/` | Electron 28 + Monaco 编辑器 + 智能体引擎 | ✅ MVP 完成 |
| 管理后台 | `admin/` | HTML + CSS + JS（localStorage 持久化） | ✅ 已完成（7 大模块） |

品牌硬约束：**品牌名 BubaiCode**、浅色白色主题、主色蓝色 `#2563eb`、图标使用 MIT 许可 Tabler 风格内联 SVG。

---

## 二、GitHub 仓库当前状态（2026-09-09 核实）

### 已推送（14 个 commit，28+ 文件）

```
BubaiCode/
├── .gitignore
├── README.md
├── admin/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── desktop-app/
│   ├── package.json
│   ├── main/            # index.js, preload.js, terminal.js
│   └── renderer/
│       ├── index.html
│       ├── css/style.css
│       ├── icons/bubaicode-icons.svg
│       └── js/terminal.js
├── docs/
│   ├── README.md
│   ├── HANDOFF.md
│   ├── 开发文档.md
│   ├── 团队协作指南.md
│   ├── 项目任务看板.md
│   ├── BubaiCode_vs_TrieCode_功能对比.md
│   └── TrieCode界面设计学习记录.md
├── examples/
│   └── esp32_light_controller.ino
└── website/
    ├── index.html
    ├── css/style.css
    └── js/main.js
```

最新 commit：`ddbb8fe`（docs: 添加TrieCode界面设计学习记录）

### 待推送（在本地 D 盘，未在 GitHub）

| 文件 | 大小 | 说明 |
|---|---|---|
| `desktop-app/renderer/js/app.js` | 172KB / 4136 行 | 智能体引擎核心（17 工具、三级权限、AgentRunner 主循环） |
| `desktop-app/package-lock.json` | 102KB | 依赖锁定文件（含 xterm 相关依赖） |
| `docs/screenshots/` | 7 张 PNG | 测试截图归档（二进制，可选推送） |

> **注意：** 以上文件需在**本地 Windows 电脑**（D 盘）上补推，或在本地执行 `git push` 完成。

---

## 三、已完成的功能

1. ✅ **TrieCode 下载安装与逐界面学习** — v1.2.9 安装于 `D:\360Downloads\TrieCode\`，用户账号 qwe123（邮箱 1205415012@qq.com）
2. ✅ **界面完全对齐 TrieCode** — 标题栏、活动栏、侧边栏、编辑器工具栏、AI 输入框、状态栏五区布局
3. ✅ **菜单栏** — 文件/编辑/视图/帮助 4 个下拉菜单共 48 项，含快捷键
4. ✅ **33+ 按钮全部可点击** — 修复缺失元素、选择器不匹配、事件绑定
5. ✅ **真实文件操作** — loadProjectFromDisk / readDirRecursive / 真实保存 / 新建 / 打开项目 / 刷新
6. ✅ **AI 智能体引擎** — 2600+ 行：17 个工具、三级权限模式（自动/默认/计划）、BudgetTracker、计划系统、MockAIClient、AgentRunner 主循环、思考过程展示、工具调用记录、计划进度面板、权限确认弹窗
7. ✅ **终端** — xterm.js + 降级模式（node-pty 编译失败后使用 child_process）
8. ✅ **可商用图标** — 50+ Tabler 风格内联 SVG sprite（MIT 许可）
9. ✅ **管理后台** — 7 大模块（用户管理、API 配置、插件管理等），默认账号 admin / admin123

---

## 四、当前仍为模拟/待完成的功能

| 功能 | 现状 | 需要的条件 |
|---|---|---|
| AI 真实对话 | MockAIClient 模拟 | 用户提供 API Key（DeepSeek/通义/MiniMax/智谱/Kimi/豆包/OpenAI/Claude/Ollama） |
| 编译/烧录/验证 | 模拟输出 | 安装 Arduino CLI + serialport 串口库 |
| 真实终端 node-pty | 降级模式 | Windows 需 VS 2019+ C++ 构建工具编译 |
| 插件系统 / MCP 集成 | 未实现 | 需基础设施 |
| SQLite 会话持久化 | 内存存储 | 需 better-sqlite3 |
| 安装包打包 | 未打包 | 需 electron-builder |

---

## 五、如何在其他电脑继续开发

### 方式 A：从 GitHub 克隆（推荐，仅缺 app.js 与 package-lock.json）

```bash
git clone https://github.com/hulufeng/BubaiCode.git
cd BubaiCode/desktop-app
npm install          # 重新生成 node_modules
npm start            # 或: node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox
```

缺的两个文件可从原电脑 `D:\工作\BubaiCode\` 复制，或本地补推：

```bash
cd D:\工作\BubaiCode
git add desktop-app/renderer/js/app.js desktop-app/package-lock.json
git commit -m "feat: 添加智能体引擎核心app.js与依赖锁文件"
git push origin main
```

### 方式 B：整包拷贝

直接复制 `D:\工作\BubaiCode\` 整个目录（含 node_modules 则免 npm install）。

### 本地快捷入口

| 内容 | 打开方式 |
|---|---|
| 桌面客户端 | `cd D:\工作\BubaiCode\desktop-app; node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox` |
| 管理后台 | 浏览器打开 `D:\工作\BubaiCode\admin\index.html`（admin/admin123） |
| 官方网站 | 浏览器打开 `D:\工作\BubaiCode\website\index.html` |
| 参考软件 TrieCode | `D:\360Downloads\TrieCode\TrieCode.exe` |
| TrieCode 操作记录 | `D:\工作\TrieCode操作记录\`（1345 张截图 + 操作记录文档） |

---

## 六、TrieCode 核心特性对照（已学习并参考）

- **五区布局**：顶部工具栏 / 左侧活动栏+侧边栏 / 中间 Monaco 编辑器 / 底部面板（输出、问题、终端、串口）/ 右侧 AI 对话
- **三种权限模式**：⚡自动（直接执行）/ 🛡默认（写入删除需确认）/ 📋计划（先出计划再执行）
- **30+ 工具调用**：文件操作、终端执行、测试运行、联网检索、子智能体、记忆、MCP、插件管理
- **多模型支持**：DeepSeek V4、通义千问、MiniMax M3、智谱 GLM-5.2、Kimi、Doubao、OpenAI、Claude、Ollama
- **嵌入式开发**：Arduino / ESP-IDF / STM32 / 51 单片机（插件）
- **安全机制**：硬闸门权限、反幻觉（基于真实项目结构）、文件回滚（Ctrl+Z）

---

## 七、技术要点备忘

- Electron 启动必须加 `--disable-gpu --no-sandbox`（本机验证）
- 大文件（>30KB）用 `Read` 会截断，需用 `Bash Get-Content -Raw` 或分块读取
- `cu.screenshot()` 无法捕获 Electron 窗口 → 用 .NET `CopyFromScreen`
- GitHub 直连 `git push` 不稳定（Connection reset）→ 用 MCP `push_files` / `create_or_update_file`
- GitHub MCP 服务偶发不可用 → 等 15 秒重试
- 临时文件（`admin_js_content.txt` 等 9 个 txt）推送完成后可删除

---

## 八、下一步建议（按优先级）

1. [ ] 在本地电脑补推 `app.js` 与 `package-lock.json` 到 GitHub
2. [ ] 提供 AI API Key，将 MockAIClient 换成真实模型调用（管理后台已预留配置位）
3. [ ] 安装 Arduino CLI，实现真实编译/烧录/验证
4. [ ] 打包安装程序（electron-builder）
5. [ ] 网站 + 管理后台部署上线（可先用 GitHub Pages 托管官网）

---

*本文档由整理 GitHub 仓库状态与既有交接文档生成，最新状态以 GitHub 仓库为准。*

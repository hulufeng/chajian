# ChipCode 产品结构与 UI 设计体系（对标实现蓝图）

> 依据：Craft Anything（Deep 模式）对 `C:\Program Files\TrieCode\ChipCode\ChipCode.exe` 的静态分析
> （PE→ `resources/app.asar` 1.3.2 → `js-app-map`：242 源文件 / 274 IPC / 900 端点 / 22 原生模块 / 2 暴露 API 命名空间）。
> 视觉令牌取自 TrieCode v1.3.x 设计语言（LabCode `theme.css` 备注「参照 TrieCode v1.3.1」并逐字拷贝其 Design Token），
> 并交叉核对 asar 内 `renderer/.../index-*.css` 实测字体栈、圆角与色值。
> 用途：供 LabCode / 同类「嵌入式+AI 编程 IDE」产品照此还原信息架构、功能板块与视觉规范。

---

## 0. 产品定位（一句话）

**面向嵌入式/物联网开发的 AI 原生桌面 IDE**：把「代码编辑 + 硬件工具链（编译/烧录/串口监视）+ AI 编程 Agent（规划/工具调用/记忆/会话/时间旅行）+ 插件/技能/MCP 扩展 + 多供应商 BYOK AI」整合在同一窗口内。
证据：暴露 API 含 `arduinoAPI`（board/compile/upload/monitor/library/core）+ `ai`/`mcp`/`skills`/`plugins`/`lsp`；原生模块含 `serialport`、`pty/conpty`、`skia`。

---

## 一、整体信息架构与导航布局

### 1.1 信息架构（IA）总览（自上而下三级）
```
应用外壳 Shell
├─ 标题栏 TitleBar            （窗口控制 + 全局搜索 + 账户/设置入口）
├─ 菜单栏 MenuBar            （文件/编辑/视图/运行/AI/插件/设置/帮助 —— menu:18 IPC）
├─ 活动栏 ActivityBar（左）  （图标导航：资源管理器 / 搜索 / 源码管理 / 调试/运行 / 扩展 / AI / 账户）
├─ 侧边栏 SideBar（左，可切换内容）   （文件树 / 搜索结果 / Git / 设备面板 / 插件市场 …）
├─ 主工作区 MainArea（中）   （编辑器组 + 预览/可视化 + 内嵌终端 Tab）
├─ 辅助面板 AuxPanel（右/下，可停靠） （AI 聊天 / 规划 / 终端 / 输出 / 问题 / 调试控制台）
└─ 状态栏 StatusBar（底）    （分支 / 端口 / 设备 / 语言 / 连接状态 / 自动保存）
```

### 1.2 导航布局原则（对照实现）
- **单主窗口、多面板可停靠**：分析确认仅 **1 个 BrowserWindow + 2 条路由**；所有功能通过面板/视图切换，而非多窗口。
- **活动栏为一级导航**：用图标切换「侧边栏内容」；同一图标可在侧栏/面板间联动。
- **命令面板中枢**：AI 命令（`ai:*`，占 IPC 最多 50 个）暗示存在命令面板（Ctrl/Cmd+Shift+P 风格）统辖所有动作。
- **上下文联动**：`ai:projectCreated` / `ai:boardChanged` / `ai:portChanged` 表明导航/设备/项目的状态变化会广播给 AI 与面板。

---

## 二、各功能模块：定位 / 职责 / 元素 / 交互 / 状态

> 标注的 IPC 前缀与 API 成员均来自实测，便于后续在 LabCode 中逐条对齐。

### 2.1 代码编辑 / 展示区（Editor）
- **定位**：核心工作区，承载源码、可视化（原理图/PCB 之类由渲染器承载）与差异对比。
- **元素**：多标签编辑器组、行号/缩略图、最小化地图(minimap)、悬浮提示、内联补全、状态条（语言/编码/换行）。
- **职责对接**：`lsp`（2）、`file`（2）—— 编辑器经由 LSP 提供语义；文件读写经 `file:*` IPC。
- **交互**：标签页拖拽分组、分屏、命令面板跳转符号(`ai:querySymbols`)、Ctrl/Cmd+P 快速打开。
- **状态**：脏标记(未保存)、只读、断点(debug)；`ai:fileChanged` 用于编辑后通知 AI 上下文。

### 2.2 AI 交互区（Chat / Agent）
- **定位**：右侧/底部停靠面板，承载与 AI 的对话、规划、工具执行可视化。
- **职责对接**：`ai:*` IPC（50 个）核心子集——
  - 会话：`loadSession/saveSession/searchSessions/reviseSession/deleteSession`
  - 流式：`onAgentStream`、`getCompletion`、`agentAccountStream`
  - 规划：`plan / planDecision / planUpdate`
  - 工具循环：`toolStep / toolProgress / toolDecision / toolDetail / toolPending`
  - 记忆：`extractMemory / listMemories / forgetMemory / openMemoryDir`
  - 时间旅行：`rewindCode / undoLastTurn / redoLastTurn / redoRewind / keepBatchesUpTo / truncateBatches / turnBatches`
  - 语音：`transcribe / cancelTranscribe`
  - 账户/供应商：`setProvider / setAgentMode / validateKey / getProviders / getBuiltinModels / contextUsage / estimateContext`
- **元素**：消息气泡、代码块（语法高亮+复制+应用）、工具步骤时间线、规划确认卡、上下文用量条、模型/思考档位选择器、记忆入口、会话历史列表。
- **交互**：输入框（Enter 发送/Shift+Enter 换行）、@提及文件、`rewind` 回退到任意编辑批次、对规划/工具请求人工确认(`planDecision/toolDecision`)。
- **状态**：streaming（打字机）、thinking、tool-running、awaiting-decision、error、compact-preview（压缩预览 `ai:compactPreview`）。

### 2.3 项目与文件管理（Explorer / Workspace）
- **定位**：左侧资源树 + 多根工作区，管理工程、文件、设备/平台配置。
- **职责对接**：`project`（21）、`workspace`（3）、`file`（2）、`git`（34）。
- **元素**：文件树（展开/折叠/新建/重命名/删除）、大纲视图、多根文件夹、`.code-workspace` 配置、`ai:projectCreated`。
- **交互**：双击打开、右键菜单、拖拽排序、与编辑器标签联动、保存即写盘（`windowControls` 控制自动保存指示）。
- **状态**：未保存(●)、冲突标记、与 Git 状态叠加（M/U/A/??）。

### 2.4 配置与设置（Settings）
- **定位**：用户偏好、AI 供应商密钥、工具链路径、外观、快捷键、代理。
- **职责对接**：`config`（5）、`proxy`（1）、`auth`（11）、`backend`（10）。
- **元素**：分类设置页（类似 VS Code 的设置 UI）、搜索框、表单控件、AI 供应商卡片（填 Key/Endpoint）、外观主题选择。
- **交互**：设置即时生效（部分需重载）；`setProvider`/密钥校验(`validateKey`)；`proxy` 配置网络出口。
- **状态**：默认值/已修改(●)、校验中/有效/无效、已保存/未保存。

### 2.5 终端（Terminal）
- **定位**：集成命令行（构建、git、包管理、工具链调用）。
- **职责对接**：`pty`（6）+ 原生 `pty.node`/`conpty.node`/`conpty_console_list.node`。
- **元素**：多标签终端、拆分、右键菜单、滚动缓冲、背景色/字体可配。
- **交互**：与编辑器/任务 (`compile`) 打通（编译错误可点击跳转到源码）；`ai:terminal?` 命令注入。
- **状态**：运行/退出码、焦点指示、拆分布局。

### 2.6 设备 / 串口 / 硬件面板（DevicePanel）
- **定位**：嵌入式专属——选板、选端口、烧录、串口监视。
- **职责对接**：`board`（6）、`monitor`（6）、`upload`（1）、`portChanged`、`devicePanel`（toolchainAPI 成员 + 3 IPC）、`serialport` 原生模块。
- **元素**：板卡下拉、端口下拉、波特率、连接按钮、监视器输出区（带时间戳）、烧录进度。
- **交互**：插拔自动刷新端口(`portChanged`)、一键编译上传、监视器发送指令。
- **状态**：未连接/已连接/烧录中/烧录成功/失败、端口占用、板型不匹配。

### 2.7 工具链 / 编译（Toolchain / Compile）
- **定位**：Arduino/ESP 等工具链的拉取、配置、编译、构建任务编排。
- **职责对接**：`compile`（6）、`core`（6）、`library`（6）、`toolchainAPI.*`（toolchain/capability/command/projectTypes/backend）、`backend`（10）。
- **元素**：任务面板、输出通道、进度、错误解析(跳源码)、工具链安装向导。
- **交互**：运行任务(▷)/停止、问题面板汇总、后台自动构建。
- **状态**：idle/queued/running/success/failed/cancelled。

### 2.8 版本控制 / Git（SCM）
- **定位**：源码管理，分支、提交、推送、冲突解决。
- **职责对接**：`git`（34，第二大 IPC 类）、`ai:fileChanged`。
- **元素**：变更列表、差异视图、分支切换、提交框、同步按钮、冲突编辑器。
- **交互**：暂存/取消暂存、提交、推送/拉取、`ai:` 可生成提交信息。
- **状态**：clean/dirty、ahead/behind、merge-conflict。

### 2.9 插件 / 扩展（Plugins / Extensions）
- **定位**：能力扩展市场与已装管理。
- **职责对接**：`plugins`（12，含 `plugins` 为 arduinoAPI 成员）、`payment`（1）。
- **元素**：市场列表、分类/搜索、详情页、已装列表、启用开关、更新提示、付费/订阅(`payment`)。
- **交互**：一键安装/卸载/禁用、重载窗口生效。
- **状态**：可安装/已装/需更新/已启用/已禁用/付费锁定。

### 2.10 会话与记忆（Sessions / Memory）—— AI 层
- **定位**：对话历史持久化 + 长期记忆库，支撑跨会话上下文。
- **职责对接**：`ai:loadSession/saveSession/reviseSession/searchSessions/listMemories/extractMemory/forgetMemory`。
- **元素**：历史会话侧栏、记忆条目、导入导出、目录打开(`openMemoryDir`)。
- **交互**：恢复会话、回顾/编辑记忆、删除。
- **状态**：进行中/已归档/压缩预览(`compactPreview`)。

### 2.11 计划 / 规划（Plan）
- **定位**：AI 执行前的方案生成与人工确认。
- **职责对接**：`ai:plan/planDecision/planUpdate`。
- **元素**：计划大纲卡、逐步展开、接受/拒绝按钮。
- **状态**：draft/proposed/approved/rejected/executing。

### 2.12 账户 / 支付 / 代理（Auth / Payment / Proxy）
- **定位**：登录态、订阅、网络出口。
- **职责对接**：`auth`（11）、`payment`（1）、`proxy`（1）、`backend`（10）。
- **元素**：登录卡、套餐/额度、密钥管理、代理设置。
- **状态**：未登录/已登录、免费/订阅、额度剩余。

### 2.13 调度 / 定时（Schedule）
- **定位**：定时/后台任务（如自动构建、定时同步、代理执行）。
- **职责对接**：`schedule`（17，第四大 IPC 类）+ `packages/engine/dist/schedule-store.js`。
- **元素**：任务列表、触发规则(Cron/间隔)、下次运行、启用开关。
- **状态**：启用/暂停/运行中/已完成/失败。

### 2.14 技能（Skills）
- **定位**：可复用的专家能力包（类 Cursor 规则/Agent 技能）。
- **职责对接**：`toolchainAPI.skills`（成员）。
- **元素**：技能列表、激活、参数化、运行。
- **状态**：可用/激活/运行中。

### 2.15 MCP 集成（Model Context Protocol）
- **定位**：把外部 MCP 服务接入 AI Agent，扩展工具集。
- **职责对接**：`arduinoAPI.mcp`（成员）+ `mcp`（5 IPC）。
- **元素**：MCP 服务器列表、连接状态、工具清单、启用开关。
- **状态**：connected/disconnected/error、工具可见/隐藏。

### 2.16 菜单系统（Menu）
- **定位**：传统菜单栏 + 右键上下文菜单。
- **职责对接**：`menu`（18 IPC，`onMenu` 桥）。
- **元素**：下拉菜单、快捷键提示、分割线、勾选项。
- **交互**：键盘导航、加速器、与命令面板同源。

---

## 三、视觉规范（Design Tokens）

> 来源：TrieCode v1.3.x 设计语言（LabCode `theme.css` 逐字拷贝）+ asar CSS 实测核对。

### 3.1 配色（Color）
| Token | 值 | 用途 |
|---|---|---|
| Primary / Accent | `#2563eb`（主）/ `#3b82f6`（hover/active） | 主操作、选中、链接、进度 |
| Surface-0 | 应用最底层背景（亮色≈`#ffffff`，暗色≈`#1e1e1e`） | 编辑器/主区背景 |
| Surface-1 | 侧栏/面板背景（比 -0 略深/浅一档） | 侧栏、状态栏 |
| Surface-2 | 卡片/输入背景 | 输入框、卡片、悬浮层 |
| Surface-3 | 悬浮/弹层/高亮背景 | Popover、菜单、选中行 |
| Text Primary | 主文字（亮≈`#1f1f1f` / 暗≈`#e6e6e6`） | 正文 |
| Text Secondary | 次级文字（≈`rgba(...,0.6)`） | 占位、说明 |
| Border | 分隔线/边框（≈`rgba(128,128,128,0.2)`） | 1px 分隔 |
| Semantic | success `#22c55e` / warn `#f59e0b` / error `#ef4444` / info `#3b82f6` | 状态色 |
| asar 实测蓝 | `#0066bf`（链接/强调变体） | 历史/锚点 |

- 支持 **亮/暗双主题**（Surface 体系即为此设计）；语义色用于编译成功/失败、端口状态、Git 变更。

### 3.2 排版（Typography）
- 字体栈（实测）：`-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', 'HelveticaNeue-Light', system-ui, Ubuntu, 'Droid Sans', sans-serif`。
- 代码字体：等宽（Monaco/Consolas/系统 mono，编辑器默认字号 13–14px，行高 1.5–1.6）。
- 字号阶梯（建议）：标题 18/16/14、正文 13、次要 12、小字 11；字重 400/500/600 三档。
- 中文混排：对齐中文标点为全角、避头尾——参照中文字体规范。

### 3.3 组件风格（Components）
- **按钮**：主按钮(实色 accent)/次按钮(描边)/幽灵按钮(纯文字)；圆角 3px（实测主 CSS `border-radius:3px`），高度 32px（control-height）。
- **输入**：surface-2 背景、1px border、focus 时 border→accent + 轻微阴影。
- **标签 Tab**：底部 2px 指示条随选中切换（与 LabCode 一致）；未保存用 ● 标记。
- **面板/卡片**：surface-1/2 背景、1px border、可停靠标题栏带拖拽热区。
- **列表/树**：行高 ~28–32px，hover→surface-3，选中→accent 10% 底色 + 左条。
- **徽标 Badge**：圆角药丸，语义色底+白字（端口占用、更新角标、MCP 工具数）。
- **模态/弹层**：居中或锚定，surface-3 + 阴影，半透明遮罩。
- **Toast/通知**：右下角栈，自动消失，错误态红边。

### 3.4 间距与圆角（Spacing & Radius）
- 间距标度（4 基准）：2/4/8/12/16/24/32 px（面板内边距 12–16，区块间距 16–24，控件间距 8）。
- 圆角：控件 3px、卡片 6–8px、模态 8–12px、头像/徽标 999px（圆形）。
- 栅格：面板宽度记忆、可拖拽分隔条（splitter）存偏好。

### 3.5 响应式与适配（Responsive / DPI）
- **桌面优先、单窗口**：仅 1 个窗口，无移动端；最小窗口约 960×600，面板在窄屏自动收起为图标活动栏。
- **DPI**：Electron + `skia` 渲染，支持 1x/1.25x/1.5x/2x 缩放；高分屏下字体/图标矢量清晰。
- **面板布局**：可停靠/隐藏，布局状态持久化；多屏时记住最后位置。
- **无障碍**：键盘可达（菜单/命令面板全覆盖）、焦点环、对比度达标。

---

## 四、模块间数据流与协作关系

### 4.1 进程模型（三层）
```
主进程 main (packages/main/dist/index.js)
   ├─ 暴露 IPC handlers（ipcMain.handle/on）  ← 274 通道，224 配对
   ├─ 文件/工具链/串口/终端/Git/插件/账户 的真实执行
   └─ 窗口管理（1 BrowserWindow）
preload (packages/preload/dist/index.js, sandbox:true)
   └─ contextBridge 暴露 arduinoAPI(27) + toolchainAPI(7) → 渲染层
渲染层 renderer (vite 打包, 242 源文件)
   ├─ UI 组件 + 状态 store（engine: session-store / schedule-store）
   └─ 经 contextBridge / ipcRenderer 调主进程；AI 经各 provider 端点
```
- 安全基线：**contextIsolation 开、nodeIntegration 关、sandbox 开**——渲染层不能直接触 Node，必须经桥/IPC。

### 4.2 IPC 通道分类与数据流
| 前缀 | 数 | 数据流向与职责 |
|---|---|---|
| `ai:*` | 50 | 渲染↔主进程↔AI：会话/流式/规划/工具/记忆/时间旅行；AI 结果回写编辑器 |
| `git:*` | 34 | 渲染请求 SCM 操作，主进程跑 git 返回状态/差异 |
| `project:*` | 21 | 工程增删切换，广播给设备/AI/编辑器 |
| `menu:*` | 18 | 菜单动作触发命令 |
| `schedule:*` | 17 | 定时任务 CRUD 与触发 |
| `plugins:*` | 12 | 插件安装/启用/市场 |
| `auth:*` | 11 | 登录态、额度、密钥校验 |
| `backend:*` | 10 | 后端/工具链后端选择 |
| `toolchain:*` | 8 | 工具链能力/命令/项目类型 |
| 其余 | — | board/monitor/upload/pty/lsp/skills/mcp/config/update/dialog/devicePanel/workspace/app/file/mqtt/payment/proxy/capability/projectTypes/image/command |

### 4.3 关键协作链路（典型数据流）
1. **AI 编程闭环**：编辑器改代码(`fileChanged`) → AI 面板(`onAgentStream`) → 规划(`plan`→`planDecision`) → 工具调用(`toolStep`/`toolProgress`) → 应用补丁 → `rewindCode` 可回退到任一编辑批次。
2. **编译烧录闭环**：工具链(`compile`) → 错误经 LSP/问题面板跳源码 → 选板/端口(`board/portChanged`) → `upload` 烧录 → 监视器(`monitor`)读串口回显。
3. **项目联动**：打开工程(`projectCreated`) → 侧栏文件树 + 设备面板就绪 + AI 上下文注入(`estimateContext`)。
4. **记忆/会话**：对话沉淀为 `extractMemory`，跨会话 `listMemories` 召回；`loadSession` 恢复完整上下文。
5. **扩展增强**：`plugins`/`skills`/`mcp` 在运行时向 AI 注册新工具，经 `mcp:*` 通道桥接外部服务。

### 4.4 状态管理
- `engine/session-store.js`：AI 会话/记忆持久化（匹配 `ai:*` 大量会话类 IPC）。
- `engine/schedule-store.js`：定时任务（`schedule:*` 17 个）。
- 其余（工程/Git/工具链/设备）状态主要在主进程维护，渲染层经 IPC 订阅更新。
- 视觉主题由主/渲染层注入（CSS 变量 + 运行时主题），暗/亮切换广播全局。

---

## 五、对照实现清单（LabCode 对齐要点）

- [ ] **外壳**：单主窗口 + 左活动栏图标导航 + 可停靠侧栏/面板 + 状态栏（LabCode 已有活动栏与面板体系，需补齐 devicePanel/调度/记忆入口）。
- [ ] **AI 面板**：会话/规划/工具步骤时间线/记忆/时间旅行(rewind) —— 按 `ai:*` 50 通道逐一对齐（LabCode 已有 agent 流式，缺 rewind 与 plan 确认卡）。
- [ ] **硬件面板**：板卡/端口/波特率/监视器（serialport），与 `board/monitor/upload/portChanged` 对齐（LabCode 已有 devicePanel 三标签）。
- [ ] **工具链**：编译/库/核心 + `toolchainAPI` 能力（LabCode 已有 arduino-cli/esp-idf 链路，需补 capability/command 注册）。
- [ ] **Git**：变更/差异/提交/同步（LabCode BATCH4 已补 git 面板）。
- [ ] **扩展体系**：plugins + skills + mcp（LabCode 已有 MCP 面板、插件依赖、skills 待补）。
- [ ] **账户/支付/代理/后端**：`auth/backend/payment/proxy`（LabCode 当前「登录门禁」需对齐多供应商 BYOK）。
- [ ] **调度**：`schedule:*` 17 通道（LabCode 待建）。
- [ ] **视觉令牌**：直接采用 TrieCode v1.3.x 令牌集（accent #2563eb/#3b82f6、surface-0..3、control-height 32、radius 3/6、字体栈如上），保证与 ChipCode 视觉一致。
- [ ] **安全基线**：contextIsolation/sandbox 维持；新能力一律走 contextBridge/IPC，不在渲染层直触 Node。

---

## 附：分析证据索引
- 目标：`C:\Program Files\TrieCode\ChipCode\ChipCode.exe`（225MB PE / Electron / `electron.exe.pdb`）
- asar：`resources/app.asar` 1.3.2（34.8MB）→ 解包 `D:\work\tmp\chipcode_asar`
- 主样式：`packages/renderer/dist/assets/index-BBLS699K.css`（198KB，主题经 JS 注入）
- 入口：main `packages/main/dist/index.js`；preload `packages/preload/dist/index.js`
- 暴露 API：`arduinoAPI`(27) + `toolchainAPI`(7)；IPC 274（224 配对）；端点 900（BYOK：deepseek/dashscope/minimax/moonshot/openai/anthropic/ollama:11434/智谱）；原生模块 serialport/pty/conpty/skia；store：`engine/session-store.js`、`engine/schedule-store.js`

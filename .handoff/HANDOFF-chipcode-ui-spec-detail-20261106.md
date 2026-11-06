# ChipCode UI 详细规格与交互状态机（像素级 · 逐功能）

> 配套文档：`HANDOFF-chipcode-product-structure-20261106.md`（产品蓝图）。
> 本文在其基础上，**每一功能逐条拆到像素级组件规格 + 交互状态机**，并把实测的 274 个 IPC 通道、34 个暴露 API 成员、900 个端点**全量映射到具体功能**。
> 像素基线：ChipCode 为 VS Code 类外壳，沿用同源度量（已实测确认：基准字号 13px、控件圆角 3px）；布局度量见 §0。

---

## 0. 全局度量基线（Design Metrics Baseline）

### 0.1 窗口外壳度量
| 区域 | 宽/高 | 说明 |
|---|---|---|
| 标题栏 TitleBar | 高 30px（Win）/ 36px（Mac 含红绿灯） | 双击标题区可最大化；右侧窗口控制 |
| 菜单栏 MenuBar | 高 30px（可隐藏，合并进标题栏） | 文件/编辑/视图/运行/AI/插件/设置/帮助 |
| 活动栏 ActivityBar | 宽 **48px**，图标 24px，间距 4px | 一级导航，图标垂直排列，选中左侧 2px 指示条 |
| 侧边栏 SideBar | 宽 **300px**（可拖拽 170–480） | 内容随活动栏切换 |
| 编辑器 Tab 行 | 高 **35px**，标签最小 100 / 最大 220px | 单标签高亮条 2px |
| 状态栏 StatusBar | 高 **22px** | 字号 12px，分段可点 |
| 面板 Panel（底/右） | 高 **240px**（底，拖拽 100–屏高 70%） | 右面板宽默认 360px |
| 主内容最小窗口 | 960×600 | 之下活动栏收为纯图标 |

### 0.2 间距 / 圆角 / 层级（4px 栅格）
```
间距:  s1=4  s2=8  s3=12  s4=16  s5=24  s6=32  px
圆角:  --r-ctrl=3  --r-card=6  --r-modal=8  --r-pill=999  px
层级:  base=0  panel=10  popover=100  modal=1000  toast/dnd=2000
```

### 0.3 组件通用尺寸
| 组件 | 规格 |
|---|---|
| 按钮 Button | 高 **32px**，padding 0/12，圆角 3，字号 13；主按钮实色 accent，次按钮描边(border 1px surface-border)，幽灵按钮纯文字 |
| 输入 Input | 高 32px，padding 0/8，border 1px，focus→border accent + 2px 阴影；placeholder 次级色 |
| 下拉 Select | 同输入高 32px，右侧 16px 箭头；展开项高 28px |
| 列表行 ListRow | 高 **28px**（树)**/32px**（面板列表），hover→surface-3，选中→accent/0.1 底 + 左 2px 条 |
| 标签 Tab | 高 35px，底部 2px 指示；未保存 ● |
| 徽标 Badge | 药丸高 16/18px，语义色底白字，圆角 999 |
| 图标 Icon | 16px（列表/状态栏）/ 24px（活动栏）/ 20px（工具栏） |
| 勾选/单选 | 16px 方/圆，accent 填充 |

### 0.4 色彩 / 字号（与蓝图 §3 一致）
- Accent `#2563eb`/`#3b82f6`；Surface-0…3；Text Primary/Secondary；Border；Semantic success `#22c55e`/warn `#f59e0b`/error `#ef4444`。
- 字号阶梯 18/16/14/13/12/11；字重 400/500/600；等宽代码 13–14px 行高 1.5–1.6。
- 字体栈：`-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif`。

---

## 1. 应用外壳与导航（Shell）

**功能清单（来自 `menu:18` / `app:3` / `window:6` / `windowControls` / `onMenu`）**
- 标题栏：窗口控制、全局搜索入口、账户/设置快捷、菜单合并开关
- 菜单栏：文件/编辑/视图/运行/AI/插件/设置/帮助（下拉 + 快捷键 + `onMenu` 桥接命令）
- 活动栏：资源管理器/搜索/源码管理/运行调试/扩展/AI/账户 图标切换
- 状态栏：分支·端口·设备·语言·编码·自动保存·连接状态 分段
- 命令面板：`Ctrl/Cmd+Shift+P` 统辖所有命令（`window:*` 含命令执行）
- 窗口控制：`windowControls` 暴露最小化/最大化/关闭、分屏、置顶

### 1.1 布局（顶→底）
```
┌────────────────────── 30px 标题栏（标题 │ 全局搜索⌕ │ 账户⚙）─────────────────────┐
├────────── 30px 菜单栏：文件 编辑 视图 运行 AI 插件 设置 帮助 ───────────────────┤
├ 48┬────────── 300px SideBar ──────────┬──────── 主工作区 ────────┬─ Panel 360 ─┤
│ AB│ 侧栏内容(文件树/搜索/Git/设备)     │ 编辑器组 + 终端 Tab        │ AI/规划/终端 │
├ 48┴──────────────────────────────────┴──────────────────────────┴─────────────┤
└──────────────────────────── 22px 状态栏： ⎇分支 │ 🔌端口 │ 📟设备 │ 语言 │ ⊙保存 ─┘
```

### 1.2 交互状态机
**活动栏图标**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| idle | hover | hover | bg surface-3 |
| hover | click | active | 左 2px accent 条；SideBar 切到对应内容 |
| active | click | idle/换项 | 内容切换；条移到新项 |

**状态栏分段**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 默认 | hover | hover | 反色高亮 |
| hover | click | 展开 | 弹出关联面板（如端口→设备面板，分支→Git） |

**全局搜索 / 命令面板**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| closed | Ctrl+Shift+P / Ctrl+P | open | 居中输入框，自动聚焦 |
| open | 输入 | filtering | 实时过滤命令/文件列表（虚拟滚动） |
| open | ↑↓+Enter | run | 执行选中命令，关闭面板 |
| open | Esc | closed | 关闭 |

---

## 2. 代码编辑器（Editor）

**功能清单（来自 `lsp:2` / `file:2` / `ai:querySymbols` / `ai:fileChanged` / 多标签）**
- 多标签多组编辑、分屏、小地图、行号/缩略图
- LSP 语义：补全、诊断、跳转定义、符号查询（`querySymbols`）
- 文件读写（`file:*`）、脏标记、只读、断点
- 编辑后广播 `fileChanged` 给 AI 上下文

### 2.1 组件规格
- 编辑器组容器：占据主区；每组顶 35px Tab 行，下为编辑画布。
- 行号区宽 ~58px，字号 13，行高 ~19px（字号13×1.46）。
- 小地图：右侧 90–120px（可关），透明度 0.25。
- 悬浮提示 Popover：max 480×320，圆角 6，延迟 300ms。
- 内联建议：accent 下划线虚线 + 右侧 ghost 按钮“快速修复”(Ctrl+.)。

### 2.2 状态机
**编辑器 Tab**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 打开 | 双击文件 | active | 标签高亮 + ●（未保存时） |
| active | 编辑 | dirty | 显示 ● |
| dirty | Ctrl+S | saved | ● 消失 |
| active | 关闭 | closed | 若 dirty 弹确认（`dialog:3`） |

**诊断/问题**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 无错 | LSP 返回诊断 | error/warn | 行内波浪线 + 问题面板计数徽标 |
| hover 波浪线 | hover | 显示 | 悬浮提示错误详情 |

---

## 3. AI 交互区（Chat / Agent）—— 核心差异化能力

**功能清单（来自 `ai:*` 50 通道 + `arduinoAPI.ai` + 900 端点 BYOK）**
- **会话**：`loadSession` `saveSession` `reviseSession` `deleteSession` `searchSessions` `redoLastTurn` `undoLastTurn` `redoRewind` `keepBatchesUpTo` `truncateBatches` `turnBatches`
- **流式**：`onAgentStream` `getCompletion` `getBuiltinModels` `getProviders` `setProvider` `setAgentMode` `setThinkingLevel` `validateKey` `contextUsage` `estimateContext`
- **规划**：`plan` `planDecision` `planUpdate` `compactPreview`
- **工具循环**：`toolStep` `toolProgress` `toolDecision` `toolDetail` `toolPending`
- **记忆**：`extractMemory` `listMemories` `forgetMemory` `openMemoryDir`
- **语音**：`transcribe` `cancelTranscribe`
- **协作桥**：`userQuestion` `userQuestionDecision` `agent` `agentAccountStream` `agentModeChanged` `cancelAgent`
- **上下文触发**：`fileChanged` `projectCreated` `querySymbols`
- **模型供应商（BYOK）**：deepseek / 通义 dashscope / minimax / moonshot / openai / anthropic / 本地 Ollama(:11434) / 智谱 bigmodel；base 由 `this.chatEndpoint` 运行时拼装

### 3.1 布局（右/底部板）
```
┌─ AI 面板标题：会话▾ │ 模型▾ │ 思考档位▾ │ 记忆⚙ ──────────────── 新建✎ ┐
├─ 消息流（可滚，虚拟列表，内联代码块可复制/应用）──────────────────┤
│  ● 用户气泡（右）            ● AI 气泡（左，支持流式打字机）         │
│  ├─ 规划卡（步骤列表 + ✓/✗ 确认）                                 │
│  ├─ 工具时间线（toolStep 进度环 + toolProgress 日志）              │
│  └─ 代码差异卡（应用/拒绝）                                       │
├─ 上下文用量条 contextUsage（剩余额度/上下文%）──────────────────────┤
└─ 输入区：textarea（Enter 发送 / Shift+Enter 换行） │ 发送➤ │ 🎤 ──┘
```

### 3.2 组件规格
- 面板宽 360px（右）/ 高 240px（底）；消息行圆角 8，AI 左对齐 max 520px，用户右对齐。
- 代码块：标题栏（语言 + 复制 + 应用到文件），正文等宽 13px，`应用` 按钮主色。
- 规划卡：每步 28px 行，左侧序号圆点，底部 “接受/拒绝” ghost 按钮。
- 工具时间线：左侧 spinner(16px)，右侧日志折叠；`toolDecision` 时变黄边框 + 确认按钮。
- 模型选择器：下拉 32px，分组（内置/自定义）；思考档位 3–4 档（关/低/中/高）。
- 上下文条：高 4px，accent 渐变，超 80% 转 warn 色。

### 3.3 交互状态机
**对话 / 流式**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| idle | 输入+发送 | streaming | 显示用户气泡；AI 区出现光标 |
| streaming | `onAgentStream` 分片 | streaming | 打字机增量；若触发工具→进 tool-running |
| streaming | 完成 | done | 渲染最终；滚动到底 |
| done | 编辑/继续 | idle | 追加轮次 |
| done | 出错 | error | 红色错误条 + 重试按钮 |

**规划确认**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| draft | `plan` 生成 | proposed | 规划卡展开 |
| proposed | `planDecision=accept` | executing | 锁卡，逐步执行 |
| proposed | `planDecision=reject` | cancelled | 灰化 |
| executing | 完成 | done | 标记完成 |

**工具调用**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| pending | `toolStep` 入队 | progress | 时间线加项 |
| progress | `toolProgress` | progress | 日志追加；spinner |
| progress | `toolDecision`（需确认） | await | 黄边 + 确认按钮（超时默认拒绝） |
| await | 确认/拒绝 | progress/cancel | 继续/中止 |
| progress | 完成 | done | 绿勾 |

**记忆**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 会话中 | `extractMemory` | 存 | 记忆库新增条目（侧栏可查 `listMemories`） |
| 查看 | `openMemoryDir` | 打开 | 文件系统打开记忆目录 |
| 清理 | `forgetMemory` | 删 | 条目移除 |

**时间旅行（rewind）**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 任意编辑批次 | `keepBatchesUpTo`/`truncateBatches` | 回退 | 源码恢复到该批次；`redoRewind` 可重做 |
| 多轮 | `undoLastTurn`/`redoLastTurn` | 回退/重做 | 会话与代码同步回退 |

**语音**
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| idle | 🎤 | recording | 录音中（红点脉冲） |
| recording | `transcribe` | transcribing | 转写中 |
| transcribing | 完成 | 填入输入框 | 文本进输入区 |
| recording | `cancelTranscribe` | idle | 丢弃 |

---

## 4. 文件与项目管理（Explorer / Workspace）

**功能清单（`project:21` / `workspace:3` / `file:2` / `arduinoAPI.project` / `arduinoAPI.file` / `toolchainAPI.projectTypes`）**
- 单/多根工作区、文件树、新建/重命名/删除/移动
- 大纲（符号树）、`.code-workspace` 配置、`projectTypes` 项目类型识别
- 与编辑器/Git 联动；`projectCreated` 广播

### 4.1 布局
- 文件树：行高 22px，缩进 12px/层；图标 16px；拖拽排序。
- 标题行：当前根名 + “…” 操作菜单（新建文件/文件夹/刷新）。

### 4.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 折叠 | 点击三角 | 展开 | 子树显隐（动画 120ms） |
| hover 行 | 右键 | context | 右键菜单 |
| 选中 | 双击 | 打开 | 编辑器新标签 |
| 拖拽 | drop | 移动 | `file:*` 重排；Git 标记移动 |

---

## 5. 设置（Settings）

**功能清单（`config:5` / `proxy:1` / `auth:11` / `backend:10` / `arduinoAPI.config`）**
- 分类设置：外观/编辑器/AI 供应商/工具链/键盘/代理/账户/隐私
- AI 供应商卡片：填 Key/Endpoint（`validateKey` 校验）、选模型（`setProvider`/`setThinkingLevel`）
- 外观主题（暗/亮）、字号、字体

### 5.1 布局
- 左：分类列表（行 28px）；右：表单卡片（surface-2 底，圆角 6，内 padding 16）。
- 顶部全局搜索框（过滤设置项）。

### 5.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 项默认 | 修改 | 已改(●) | 左侧导航该项 ●；可“重置” |
| Key 输入 | `validateKey` | 校验中→有效/无效 | spinner→绿勾/红叉 |
| 外观改 | 选主题 | 即时预览 | 全局令牌注入；部分需重载窗口 |

---

## 6. 终端（Terminal）

**功能清单（`pty:6` / `arduinoAPI.pty` / 原生 `pty.node`/`conpty.node`）**
- 多标签、拆分、滚动缓冲、背景/字体可配
- 与编译任务打通（错误点击跳源码）

### 6.1 组件规格
- 行高 ≈ 19px（字号13），等宽字体；标签高 35px；右键菜单（复制/粘贴/清空/拆分）。
- 未配对 PTY 用 conpty（Win）；缓冲区上限 ~10000 行。

### 6.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| idle | 运行命令 | running | 输出流；退出码显于标签 |
| running | 退出 | exited | 标签显示 code；可重开 |
| focus | 点击 | focus | 边框 accent；`pty` 通知主进程 |

---

## 7. 设备 / 串口面板（DevicePanel）

**功能清单（`board:6` / `monitor:6` / `upload:1` / `portChanged` / `boardChanged` / `boardOptionChanged` / `devicePanel:3` / `toolchainAPI.devicePanel` / 原生 `serialport`）**
- 板卡下拉、端口下拉（插拔自动刷新 `portChanged`）、波特率、连接
- 监视器（带时间戳输出、发送指令）、一键烧录 `upload`

### 7.1 布局
- 子标签：设备 / 配置 / 目标（`devicePanel` 三态，LabCode 已照此重构）。
- 设备页：板卡 Select(32px) + 端口 Select + 波特率 Select + 连接按钮(32px) + 监视器输出区（等宽，min 高 120）。

### 7.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 未连接 | 选板+选端口 | 就绪 | 连接/烧录按钮可用 |
| 就绪 | 点连接 | 已连接 | 监视器启用；状态栏端口亮 |
| 已连接 | 写指令+发送 | 回显 | 输出追加；`monitor` 读串口 |
| 就绪 | 点烧录 | 烧录中 | 进度条；`upload` 调工具链 |
| 烧录中 | 完成/失败 | 成功/失败 | 绿/红；失败显示错误 |
| 拔插 | `portChanged` | 列表更新 | 端口项增删，保留已选 |

---

## 8. 工具链 / 编译（Toolchain / Compile）

**功能清单（`compile:6` / `core:6` / `library:6` / `backend:10` / `toolchainAPI.{toolchain,capability,command,projectTypes,backend}` / `arduinoAPI.core/library/compile`）**
- Arduino/ESP 核心安装、库管理、编译、构建任务编排
- 工具链能力声明（`capability`）、自定义命令（`command`）、项目类型（`projectTypes`）

### 8.1 布局
- 任务面板（底）：任务列表 + 输出通道（等宽，分标签）。
- 库管理器：网格卡片（封面/名/版本/安装态）。

### 8.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| idle | ▷运行任务 | queued/running | 输出通道激活 |
| running | 错误 | failed | 问题面板汇总；点击跳源码(LSP) |
| running | 完成 | success | 绿勾；产物可用 |
| 库 | 安装 | 安装中→已装 | 进度；`library` 刷新 |

---

## 9. 版本控制 / Git（SCM）

**功能清单（`git:34` / `arduinoAPI.git` / `ai:fileChanged`）**
- 变更列表、差异视图、分支切换、提交、推送/拉取、冲突解决
- AI 生成提交信息（`ai` 联动）

### 9.1 布局
- 侧栏 SCM 视图：暂存/未暂存分组（行 22px，状态字母 M/U/A/?? 色标）。
- 差异编辑器：左原右改，行内/块内高亮；冲突三窗（base/ours/theirs）。

### 9.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| clean | 编辑 | dirty | 文件标 M；侧栏计数 + |
| dirty | 暂存 | staged | 移至暂存组；● 变 ●(绿) |
| staged | 提交 | committed | 计数归零；`git` 同步远程 |
| 拉取 | 冲突 | conflict | 冲突编辑器；`merge-conflict` 标记 |

---

## 10. 插件 / 扩展（Plugins / Extensions）

**功能清单（`plugins:12` / `arduinoAPI.plugins` / `payment:1` / `update:5`）**
- 市场列表、分类/搜索、详情、安装/卸载/启用/更新、付费订阅（`payment`）
- 自动更新（`update`）

### 10.1 布局
- 市场：左分类 + 右卡片网格；已装：列表（图标 32 + 名 + 版本 + 开关 + 更新角标）。
- 详情弹层：截图/描述/权限/安装按钮。

### 10.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 可装 | 安装 | 安装中→已装 | 进度；需重载窗口生效 |
| 已装 | 开关 | 启用/禁用 | 状态条；`plugins` 广播 |
| 已装 | 有更新 | 待更新 | 角标徽标 |
| 付费 | 订阅 | 解锁 | `payment` 校验额度 |

---

## 11. 会话与记忆（Sessions / Memory）

**功能清单（`loadSession` `saveSession` `reviseSession` `deleteSession` `searchSessions` `listMemories` `extractMemory` `forgetMemory` `openMemoryDir`）**
- 跨会话上下文持久化；长期记忆库（自动抽取 + 手动增删）
- 与 AI 面板（§3）共享状态

### 11.1 布局
- 历史会话：右面板可折叠列表（行 44px，标题+时间+模型）。
- 记忆：库视图（行 28px，内容预览 + 删除）。

### 11.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 活动会话 | 对话 | 持续 | 自动 `saveSession` 增量 |
| 列表 | `searchSessions` | 过滤 | 实时结果 |
| 记忆 | `extractMemory` | 新增 | 库追加 |
| 记忆 | `forgetMemory` | 移除 | 删除确认 |

---

## 12. 计划 / 规划（Plan）

**功能清单（`plan` `planDecision` `planUpdate` `compactPreview`）**
- AI 执行前方案生成；人工逐步确认；上下文压缩预览

### 12.1 状态机（同 §3.3 规划确认，独立视图）
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| draft | `plan` | proposed | 大纲卡 |
| proposed | `planDecision` | executing/cancelled | 执行/取消 |
| executing | `planUpdate` | 刷新 | 步骤进度 |

---

## 13. 账户 / 支付 / 代理 / 后端（Auth / Payment / Proxy / Backend）

**功能清单（`auth:11` / `payment:1` / `proxy:1` / `backend:10` / `arduinoAPI.auth/backend/proxy/payment` / `setProvider`/`validateKey`/`getProviders`/`getBuiltinModels`）**
- 登录态、订阅/额度、AI 供应商密钥与端点（`this.chatEndpoint` BYOK）
- 网络代理出口、后端选择

### 13.1 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 未登录 | 登录 | 已登录 | 账户态；`auth` 广播 |
| 登录 | 额度 | 显示 | 状态栏/设置显示剩余 |
| Key 填 | `validateKey` | 有效/无效 | 绿/红；`setProvider` 生效 |
| 代理 | 设 `proxy` | 生效 | 出站走代理 |

---

## 14. 调度 / 定时（Schedule）

**功能清单（`schedule:17` / `packages/engine/dist/schedule-store.js` / `arduinoAPI.schedule`）**
- 定时/后台任务（自动构建、同步、代理执行）；Cron/间隔；启用开关

### 14.1 布局
- 列表（行 32px）：名称 + 触发规则 + 下次运行 + 开关。
- 新建规则：Cron 输入框（32px）+ 校验。

### 14.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 启用 | 到点 | running | 执行；`schedule-store` 记录 |
| running | 完成 | 待下次 | 更新下次时间 |
| 启用 | 关闭 | 暂停 | 灰化 |

---

## 15. 技能（Skills）

**功能清单（`toolchainAPI.skills`）**
- 可复用专家能力包（类 Agent 技能）；激活/参数化/运行

### 15.1 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| 可用 | 激活 | 激活 | 注入 Agent 上下文 |
| 激活 | 运行 | running | 工具时间线显示 skill 步骤 |

---

## 16. MCP 集成（Model Context Protocol）

**功能清单（`mcp:5` / `arduinoAPI.mcp`）**
- 外部 MCP 服务接入 AI Agent；连接状态、工具清单、启用

### 16.1 布局
- MCP 面板：服务器列表（名 + 连接状态点 + 工具数徽标 + 开关）。
- 新增：命令/URL/环境变量表单。

### 16.2 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| disconnected | 启用 | connecting | 状态点转黄 |
| connecting | 握手 | connected | 绿点；工具注入 Agent |
| connected | 出错 | error | 红点；`mcp` 报错 |

---

## 17. 菜单系统（Menu）

**功能清单（`menu:18` / `onMenu` / `arduinoAPI.onMenu`）**
- 传统菜单栏 + 右键上下文菜单；快捷键；与命令面板同源

### 17.1 状态机
| 状态 | 触发 | 目标 | UI |
|---|---|---|---|
| closed | Alt/点击 / 右键 | open | 下拉/上下文菜单 |
| open | hover 项 | 展开子菜单 | 子菜单右开 |
| open | 点击命中 | 执行 | 经 `onMenu`→命令；关闭 |
| open | Esc/失焦 | closed | 关闭 |

---

## 18. 其它（跨模块零散功能）

| 功能 | 来源 | 定位 |
|---|---|---|
| MQTT 通信 | `mqtt:2` | IoT 设备消息（发布/订阅），与设备面板联动 |
| 图像处理 | `image:1` | 截图/图像插入/预览（如原理图导出、AI 多模态输入） |
| 原生对话框 | `dialog:3` | 文件选择/确认/错误（保存前确认、扩展安装） |
| 自动更新 | `update:5` | 客户端自更新（含插件更新） |
| 窗口控制 | `window:6` / `windowControls` | 最小化/最大化/分屏/置顶 |
| 解释器 | `interpreters:6` | Python/Node 等多语言运行环境管理 |
| 库 | `lib:6` | 包/库管理（与 §8 工具链库共享） |
| 应用级 | `app:3` | 应用信息/重启/关于 |
| LSP | `lsp:2` | 语言服务（补全/诊断/跳转，供 §2 编辑器） |

---

## 附：功能→IPC/API 全量映射索引
- **暴露 API**：`arduinoAPI`(27)=board/compile/upload/monitor/pty/library/core/backend/proxy/project/ai/auth/payment/config/mcp/interpreters/schedule/workspace/git/file/image/lsp/plugins/app/update/windowControls/onMenu；`toolchainAPI`(7)=toolchain/capability/command/projectTypes/skills/devicePanel/backend。
- **IPC 274 通道（按前缀）**：ai50/git34/project21/menu18/schedule17/plugins12/auth11/backend10/toolchain8/lib6/pty6/interpreters6/compile6/window6/board6/monitor6/core6/skills5/mcp5/config5/update5/dialog3/devicePanel3/workspace3/app3/file2/lsp2/mqtt2/upload1/payment1/proxy1/capability1/projectTypes1/image1/command1。
- **端点 900**：AI BYOK（deepseek/dashscope/minimax/moonshot/openai/anthropic/ollama:11434/智谱）+ 运行时 `{this.chatEndpoint}`。
- **原生模块 22**：serialport（多架构）、pty/conpty/conpty_console_list、skia.win32-x64-msvc。

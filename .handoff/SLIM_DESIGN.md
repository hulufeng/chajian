# LabCode 精简设计方案 v2（聚焦 ESP32 辅助开发 · 保留内置自主 Agent）

> 文档状态：设计方案（待用户批准后再落地代码）
> 依据：当前 `src/main/index.ts`、`App.tsx`、`ActivityBar.tsx`、`package.json` 真实代码梳理
> 作者纪律：设计先行（五种思维角色骨架）、文档与代码冲突以代码为准、不臆造业务
> v2 修订：用户决策「内置 AI Agent 不要删减，只能增加优化」——Agent 引擎 + 全部工具 + 其依赖服务**完整保留**，删除范围收紧为「其他硬件 + 插件市场 + 模拟器 + 课程 + 自动更新 + AI 登录积分」。

---

## 0. 设计前置 · 五种思维角色骨架

### 0.1 第一性原理（为什么这样收）
- 产品主线：**硬件编程 + 烧录，ESP32 优先**。ESP-IDF / STM32 是"其他硬件"，不属于 ESP32 辅助开发主线。
- 产品亮点 = **内置自主 Agent（AI 网关 function calling + 工具集）**：能对话、解释/生成 ESP32 代码，还能自主规划帮你写码→编译→烧录→看串口。用户明确：Agent **不删减、只优化**。
- 要删的是"干扰项"：其他硬件工具链、第三方插件市场、软件内模拟器/Wokwi、课程面板、自动更新、AI 登录积分体系。这些既非 ESP32 硬链路、也非 Agent 核心。

### 0.2 逆向思维（如果不收会怎样）
- 四栏 IDE + 8+ 入口（文件/源码管理/设备/插件/课程/模拟器/设置/Git），新手找不到"编译/烧录"在哪，也分不清哪些跟 ESP32 有关。
- 模拟烧录/Wokwi、课程、插件市场占用真机实测与回归精力，挤占 ESP32 硬链路与 Agent 优化。

### 0.3 发散思维（保留 Agent 后还能加什么小而美）
- Agent 一键「自动编译+烧录当前工程」按钮（UI 触发 `agent:start`）。
- 板卡一键自动识别（检测到 ESP32 自动选 FQBN + 端口）。
- 示例工程侧边栏（Blink / WiFi / WebServer）一键打开即编译。
- 串口监视器「发送指令 + 时间戳」三件套。

### 0.4 效果评估
| 维度 | 现状 | 精简后 |
|---|---|---|
| 左侧导航入口 | 文件/源码管理/设备/插件（+隐藏课程） | 文件/设备/AI 辅助（3 个） |
| 顶部工具栏 | 通用 IDE 风 | 突出板卡/端口/编译/烧录/串口/AI |
| 后端删减 | — | 删 ~6 类非主线模块；Agent 引擎 + 全部工具**零删减** |
| 打包体积 | 148MB | 预计降（去掉知识库/本地模型?见 §2 备注/模拟器资源） |

### 0.5 可行性论证
- **能做**：要删的 6 类都是相对独立的 service/plugin/component，删除不影响 `arduino-cli` 工具链核心与 Agent 引擎。
- **风险点**：`pluginManager` 被 `capability:run` 路由依赖（编译/烧录走 `capability` + `grpc` 两条路径），不能删空，仅去掉"市场/磁盘第三方发现"。
- **验证门槛**：删完后 `tsc --noEmit` 双过 + 真机 ESP32-S3 烧录 + 串口回显 + Agent 一键编译烧录 + AI 双通道实测。

---

## 1. 产品定位重述（一句话）

**LabCode = ESP32 辅助开发专用桌面工具 + 内置自主 Agent。**

核心闭环：**写码（Monaco）→ 编译（arduino-cli）→ 烧录（upload）→ 串口监视（serialport）→ AI 辅助（内置免费 + BYOK + 本地 llama 三通道，含自主 Agent）**。

> 范围边界：**Agent 引擎完整保留**（49 工具 + 状态机/预算护栏/计划模式/调度器/LSP/记忆/skill/知识库/搜索/浏览器/Git/MCP 等工具及其依赖服务一律不动）。只优化，不删减。

---

## 2. 功能裁剪矩阵（最终版）

| 模块 | 当前位置 | 动作 | 理由 |
|---|---|---|---|
| Arduino CLI 工具链（编译/烧录/板卡/平台/库） | `plugins/arduino-toolchain` + `toolchain.ts` + `grpc-client.ts` | **保留** | ESP32 硬链路核心 |
| 串口监视 | `serialService.ts` + `OutputPanel` | **保留** | 调试必需 |
| **内置自主 Agent（完整）** | `engine/*` + 全部工具 + git/mcp/browser/scheduler/skill/memory/knowledge/search/lsp/modelRuntime 等依赖服务 | **保留·只优化** | 用户决策：不删减 |
| AI 网关（内置免费 + BYOK + 本地 llama） | `aiGateway.ts` + `modelRuntime.ts` + `AiPanel` | **保留**（去掉登录/积分 UI） | 产品亮点 |
| LSP 实时补全 | `lsp-client.ts` | **保留** | 写码体验 |
| Monaco 编辑器 / 文件树 | `EditorArea` + `ProjectTree` + `fsService` | **保留** | 写码 + 浏览 |
| 示例工程 | `examples/` + `app:getExamplesDir` | **保留** | 快速上手 |
| 真终端（node-pty） | `pty:*` + `TerminalView` | **保留** | 命令调试/工具调用 |
| ESP-IDF 工具链 | `plugins/esp-idf-toolchain` + `espIdfService` | **删除** | 其他硬件，非 ESP32 主线 |
| STM32 工具链 | `plugins/stm32-cube-toolchain` + `stm32Service` | **删除** | 其他硬件 |
| 第三方插件市场 | `pluginMarket.ts` + `PluginSidebar` + `plugin:market/install/uninstall` | **删除** | 其余全部不要（Agent 内部工具不动） |
| 模拟烧录 / Wokwi | `simBurnService` + `fakeBoardService` + `SimulatorPanel` + `simBurn:*` | **删除** | 软件内虚拟板，非主线 |
| 课程 / 教学面板 | `CurriculumPanel` + `LessonDetail` | **删除** | 已隐藏但代码在 |
| 自动更新 | `updater.ts` + `UpdateBanner` + `electron-updater` + `publish` | **删除** | 非主线 |
| AI 登录/积分体系 | `ai:register/login/logout` + credits UI | **删除** | 收敛为内置免费+BYOK+本地 llama，去掉账号/积分 |
| 命令面板 Ctrl+Shift+P | `CommandPalette` | **保留** | 轻量快捷操作 |

> 备注：Agent 内部依赖的 `gitService / mcp-client / browser-automation / scheduler / skillService / memoryService / knowledgeUpdater / search` 等**服务文件全部保留**（它们是 Agent 工具的后端），只是它们对应的"独立 UI 面板"（GitSidebar / PluginSidebar 等）随界面简化移除；对应的渲染层 IPC（如 `git:*` 给 Git UI 用的）一并删除，Agent 走 `tool-registry` 直接调服务，不经过这些 IPC。

---

## 3. 后端裁剪映射（`src/main/index.ts` + 服务/插件/引擎）

### 3.1 删除的 IPC（仅限"被移除 UI 面板使用"的渲染层桥）
- **插件市场**：`plugin:market` / `plugin:installed` / `plugin:install` / `plugin:uninstall`
- **Git 面板（10 个）**：`git:status` `git:diff` `git:stage` `git:stageAll` `git:unstage` `git:commit` `git:init` `git:log` `git:pull` `git:push` `git:applyPatch`（Agent 的 git 工具直接调 `gitService`，不受影响）
- **模拟烧录**：`simBurn:list` `simBurn:start` `simBurn:demos` `simBurn:collectBuild`
- **自动更新**：`initUpdater` 调用 + `window.api.updater`（preload 桥） + `updater.getUrl/check/install`
- **AI 账号**：`ai:register` `ai:login` `ai:logout`（保留 `ai:chat` `ai:models` `ai:state` `ai:setModel` `ai:setByok` `ai:byok*`）
- **MCP 配置 UI 专用**：`mcp:list` `mcp:add` `mcp:remove` `mcp:test` —— 若保留 Agent 的 mcp 工具，可改为 Agent 内部直接读 `settings.mcpServers`，UI 不暴露；IPC 删除。
- **搜索/知识库 UI 专用**：`search:getConfig` `search:setConfig` `kb:status` `kb:check` `kb:update` `kb:reset` `model:*`(本地模型管理 UI) —— 服务保留给 Agent，UI 桥删除。
- **硬件检测**：`hardware:info`（仅本地模型推荐用，可删；Agent 本地 llama 走 `modelRuntime` 自带检测）

### 3.2 删除的文件 / 目录
- `src/main/services/`：`espIdfService.ts` `stm32Service.ts` `simBurnService.ts` `fakeBoardService.ts` `updater.ts`
- `src/main/plugins/`：`esp-idf-toolchain/` `stm32-cube-toolchain/` `pluginMarket.ts`
- `src/main/system/hardwareInfo.ts`（若确认 Agent 不再需要其 UI 入口）

### 3.3 保留且只优化的（不动）
- `src/main/engine/`（**整个目录，零删减**）：`agent-runner.ts` `permission-policy.ts` `tool-registry.ts` `types.ts` `tools/`（全部 49 工具）
- `src/main/services/`：`aiGateway.ts` `toolchain.ts` `serialService.ts` `commandService.ts` `backgroundTask.ts` `fsService.ts` `grpc-client.ts` `lsp-client.ts` `gitService.ts` `mcp-client.ts` `browser-automation.ts` `memoryService.ts` `scheduler.ts` `skillService.ts` `knowledgeUpdater.ts` `search.ts` `modelRuntime.ts`（均作为 Agent 工具后端）
- `src/main/plugins/arduino-toolchain/` + `pluginManager.ts`（仅去市场/第三方发现）
- `src/main/ai/`：`modelRuntime.ts` `knowledgeUpdater.ts`（AI 网关 + Agent 知识库，保留）

### 3.4 `initPlugins()` 改为
```ts
pluginManager.registerBuiltin(arduinoManifest, loadArduinoPlugin)
// 去掉 espIdf / stm32 / loadUserPlugins / 磁盘第三方插件发现（插件市场已删）
const loaded = pluginManager.init()
```

### 3.5 `app.whenReady()` 不变
- 保留 `initPlugins()` + `createWindow()`；`schedulerService` 保留（Agent 调度工具依赖）。
- 不引入新逻辑。

---

## 4. 前端界面优化方案（同 v1，AI 面板改为 Agent 载体）

### 4.1 ActivityBar 精简（三入口）
`ActivityBar.tsx` 的 `ITEMS` 改为：
```ts
const ITEMS = [
  { id: 'files', icon: FolderIcon, label: '文件' },
  { id: 'device', icon: ChipIcon, label: '设备' },
  { id: 'ai', icon: SparkIcon, label: 'AI 辅助' },
]
```
删除 `GitIcon` / `PuzzleIcon` / `BookIcon` 及对应入口，删去悬浮「设置」项（并入工具栏）。

### 4.2 App.tsx 渲染分支裁剪
- 删除 `activeSidebar === 'git'` → `GitSidebar`
- 删除 `activeSidebar === 'plugins'` → `PluginSidebar`
- 删除 `activeSidebar === 'curriculum'` 分支（已注释，删干净）
- 删除 `<SimulatorPanel>` 及其状态
- 删除 `UpdateBanner`
- **AiPanel 强化为 Agent 载体**：增加「自动编译烧录当前工程」按钮（调 `agent:start`，传入当前工程路径 + "编译并烧录"意图）

### 4.3 TitleBar 工具栏强化
突出：**新建/打开/保存 · 板卡下拉 · 端口下拉 · 波特率 · 编译 · 烧录 · 串口 · AI · 主题**；编译/烧录做主按钮。

### 4.4 WelcomeView 重写为「ESP32 快速开始」
三卡片：① 打开示例工程 ② 新建 ESP32 工程 ③ 连接开发板（自动识别）；副文案五步闭环。

### 4.5 StatusBar 简化
只显示：工具链状态 · 板卡 · 端口 · 波特率 · AI 模型/通道。去掉 `pluginCount` / 更新信息。

### 4.6 删除的前端组件文件
`GitSidebar.tsx` `PluginSidebar.tsx` `CurriculumPanel.tsx` `LessonDetail.tsx` `SimulatorPanel.tsx` `SerialMonitorWindow.tsx`（串口已并入 OutputPanel）`UpdateBanner.tsx`

---

## 5. 依赖与打包清理

### 5.1 删除 dependencies
- `electron-updater`（自动更新）

### 5.2 保留 dependencies
- `@grpc/grpc-js` + `@grpc/proto-loader`（arduino-cli daemon）
- `@monaco-editor/react` + `monaco-editor`
- `@xterm/*` + `node-pty`
- `serialport`
- `react` / `react-dom`

### 5.3 `build.extraResources`
- 删 `resources/knowledge`（如知识库改由 Agent 内置、不随包分发，可删；否则保留）
- `resources/llama`（本地模型）视是否保留本地 llama 通道决定：若保留本地 llama 通道则保留此资源
- 保留 `proto` + `examples`

### 5.4 `build.publish` 删除（不再自动更新发布）

---

## 6. 落地步骤（批准后执行顺序）

1. **Phase 1 · 后端裁剪**：按 §3 删除 IPC（仅 UI 桥）与 §3.2 文件；改 `initPlugins()`；`tsc` 通过。Agent 引擎零改动。
2. **Phase 2 · 前端裁剪 + 界面优化**：按 §4 改 ActivityBar / App / TitleBar / WelcomeView / StatusBar / AiPanel（加一键编译烧录）；删组件文件；`tsc` 通过。
3. **Phase 3 · 依赖/打包清理**：改 `package.json`；`electron-vite build` + `electron-builder`（全新输出目录 `pkgout` 规避 SAFE_DELETE 护栏）。
4. **Phase 4 · 真机实测验证**：
   - 工具链检测 + 一键安装 arduino-cli；
   - 打开 Blink 示例 → 编译 → 烧录到 ESP32-S3（COM27）；
   - 串口监视回显；
   - AI 双通道（内置免费 + BYOK + 本地 llama）对话；
   - **Agent 一键「自动编译烧录当前工程」** 端到端跑通；
   - 体积/启动确认下降。

---

## 7. 风险与验证清单

- ⚠️ `pluginManager` 不能删空：`capability:run` 仍路由编译/烧录。
- ⚠️ `grpc-client` 依赖 `@grpc/*`，保留；`proto` 资源保留。
- ⚠️ 删 `preload` 中 `window.api.updater` / `window.api.plugin.market` / `window.api.git.*` 等已删 IPC 的桥接，否则渲染层报错。
- ⚠️ **Agent 引擎零删减**：切勿在 `engine/tools/` 删除任何工具文件，否则 `tool-registry` 注册会缺引用导致 tsc/运行错误。
- ✅ 每步 `tsc --noEmit -p tsconfig.node.json` 与 `tsconfig.web.json` 双过。
- ✅ 最终真机 ESP32-S3 烧录 + 串口回显 + AI 三通道 + Agent 一键编译烧录实测。

---

## 8. 决策锁定 ✅

1. **AI 登录/积分体系** → ✅ 完全删除（只留内置免费 + BYOK + 本地 llama 三通道）。
2. **LSP 代码补全** → ✅ 保留。
3. **命令面板** → ✅ 保留。
4. **内置 AI Agent** → ✅ **完整保留，不删减、只优化**（用户最新决策：v1 中"裁剪 Agent 工具集"条款作废，引擎 + 49 工具 + 全部依赖服务零删减）。
5. **删除范围** → 仅：ESP-IDF / STM32 / 第三方插件市场 / 模拟烧录-Wokwi / 课程 / 自动更新 / AI 登录积分 + UI 面板简化。

> 决策全部锁定。可按 Phase 1→4 落地。执行前需用户最终批准「开始实现」。

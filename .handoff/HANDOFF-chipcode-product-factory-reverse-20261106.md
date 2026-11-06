# ChipCode「产品工厂」反编译报告 + LabCode 改造方案（待用户决策）

- 日期：2026-11-06
- 工具：**Craft Anything v0.4.0**（用户安装的技能，Deep 模式）+ 3 个 `code-explorer` 子代理并行勘察
- 目标：`C:\Program Files\TrieCode\ChipCode\resources\app.asar`（34.8MB，`sha256=4cb71b199c9ebac633630ec04c87df126353540144bd186be9bda131a8cdc0a5`），解包到 `D:\work\tmp\chipcode_asar`
- 输入：用户提供的产品工厂空态截图
- **本轮不改任何 LabCode 代码**，只交付证据与方案，由用户决定怎么改

---

## 0. 技能执行说明（诚实标注限制）

按 `craft-anything` 技能流程执行：`core-investigation-show` → `core-brief-write` → `core-plan-update` → `core-target-open` → `js-app-map` → `core-evidence-export`。

**限制（observed）**：本机 CLI 是**无常驻 server** 模式，每次调用都是独立进程，`core-session-show` 恒为 `open:false`、`project-list count=0`、`core-investigation-show` 恒为 `revision:0`。因此：
- brief/plan 写入后无法跨调用保持；
- `core-evidence-export` 导出成功但 `records:0`；
- `core-finding-record` 无法挂 `ev_…` id（ledger 为空）。

**替代做法**：把「证据」以 **文件路径 + 行号 + 代码片段** 形式固化在本文档与项目交接书（这才是持久 handoff）。证据包空壳留在 `.handoff/chipcode-product-factory-evidence.json`（99B）。
若需要真正的 evidence ledger，需启动 `craft-anything-cli mcp` 常驻服务并让本 IDE 重连（会重启会话，本轮未做，避免打断工作）。

---

## 1. 调查结论（证据分级）

### 1.1 Observed（直接从字节/源码读到）

| # | 结论 | 证据 |
|---|---|---|
| O1 | 截图的空态文案、五阶段导航、头部与新建对话框，全部集中在 `packages/renderer/dist/assets/index-BPkqxohS.js:52` | `当前不是产品项目` / `先新建或打开一个产品项目，才会出现五阶段导航。` / `新建产品项目` / `打开已有项目` |
| O2 | **五阶段固定为 `idea → shape → hardware → software → integration`（创意→造型→硬件→软件→联调）**，不是需求/设计/开发/测试/发布 | `packages/core/dist/product-state.js:8` `STAGE_IDS`；`:9` 注释「五个阶段就是一条龙」；`renderer:52` `COe={idea:"创意",...}` |
| O3 | 四状态 `done / in_progress / blocked / not_started`，中文 `完成/进行中/阻塞/未开始` | `renderer:52` `xOe`；`main:1348` 重复定义 |
| O4 | 「是不是产品项目」的 **UI 判别条件只有** `project?.projectType === "product"` | `renderer:52` `ut(h=>h.project?.projectType==="product")` |
| O5 | 产品项目由 `.triecode.json` 的 `{version:1, projectType:"product", toolchain:"none"}` 定义 | `main:1186` `I2()`；`main:1161` `qXe()` 读取 |
| O6 | 新建项目对话框是**通用** `arduino:newProject`/`project:new`，产品只是 `projectTypes:list` 里的一个类型 | `renderer:52` `MOe()`；`main:1930` 类型定义 `id:"product", title:"产品项目", icon:"product", scaffoldPreview:[spec.md, design/shape.json, bom.json, constraints.json, evidence.jsonl, firmware/, hardware-package/]` |
| O7 | 打开已有项目只是选目录，**不筛选产品项目**，随后由 projectType 决定是否显示导航 | `renderer:45` `xwe()`；`main:1929` `project:open` |
| O8 | 阶段状态由**磁盘文件计算**，非内存态；`pipelineProgress()` = done 阶段数/5 | `product-state.js:300-386,405-408` |
| O9 | 无独立 `product:*` IPC 命名空间，复用 `project:*` / `workspace:*` / `dialog:*` / `projectTypes:list` / `ai:*` | CLI `js-app-map` 实测 274 通道中 product 相关 36 个，全部为 project/workspace/menu 前缀 |
| O10 | `productStage` 是 `ai:agent`/`ai:agentAccountStream` 的末位参数；非法/缺失时 main 从磁盘选第一个非 done 阶段，兜底 `integration` | `preload:1` 第 10 位参数 `v`；`main:1344` `aIe()`；`main:1562` 动态 `productState` system block |
| O11 | 五个产品 AI 工具：`propose_criteria` / `propose_shape` / `propose_bom` / `record_evidence` / `build_package` | `core/dist/i18n/ai.js:78-83,312-317`；`main:1344` 系统提示「五步固定流程」 |
| O12 | 侧栏是**纵向阶段按钮列表**（`pf-nav__stages`）+ 顶部证据覆盖进度条（`pf-nav__meter`），不是横向 stepper | `renderer:52` JSX |
| O13 | 空态与截图像素级对应：Package 图标 + 标题 + hint + primary「新建产品项目」+ outline「打开已有项目」 | `renderer:52` `pf-nav__empty` JSX |
| O14 | 文件变化监听：300ms 防抖，只关心 spec/bom/constraints/evidence/shape 与 firmware/design/hardware-package | `renderer:45` `Nte()` 正则 |

### 1.2 Derived（由观察计算）

- **D1 各阶段完成条件**（`product-state.js:300-386`）：

| # | 阶段 | 主要文件 | done 条件 | AI 工具 |
|---|---|---|---|---|
| 01 | idea 创意 | `spec.md`, `spec.json` | `criteria.length>0` 且 `confirmed===true` | `propose_criteria` |
| 02 | shape 造型 | `design/shape.json`, `design/views/` | 结构文件存在 + 有 `mesh` + 至少一张 2D 视图 + `confirmed` | `propose_shape` |
| 03 | hardware 硬件 | `bom.json`, `constraints.json` | BOM 非空、每项有 `source.url`、全部 `confirmed` | `propose_bom` |
| 04 | software 软件 | `firmware/` | 有固件且存在 `stage:"software", result:"pass"` 的有效证据 | 编译/上传 + `record_evidence` |
| 05 | integration 联调 | `evidence.jsonl` | 无有效 `fail`，`pass` 证据覆盖全部 `spec.json` 条件 | `record_evidence` + `build_package` |

- **D2 状态优先级**：无 `source.url` 的器件 → `blocked` 优先于 `done`（`:260-263`）；只有 `result==="pass"` 能覆盖验收条件（`:240-258`）。
- **D3 产品包不是第六阶段**，是整条线的导出产物（`product-state.js:9`）；导出 `requirements.md` / `bom.csv` / `evidence.md` / `README.md` / `.manifest.json` + `firmware/**` / `design/**` 副本（`main:1362-1368`），用 FNV-1a `inputsFingerprint()` 判过期（`:287-295`）。
- **D4 产品项目脚手架**（`main:1185-1186`）：
```
<project>/
├─ .triecode.json   {version:1, projectType:"product", toolchain:"none"}
├─ spec.md / spec.json          {confirmed, criteria:[{id,text,verify}]}
├─ design/shape.json            {unit,dims,model,mesh,views[],confirmed}
├─ design/views/
├─ bom.json                     {items:[{role,part,status,source:{type,url},qty}]}
├─ constraints.json             {power,pins[],buses[]}
├─ evidence.jsonl               每行 {id,at,stage,claim,result,covers,invalidates,by}
├─ firmware/
└─ hardware-package/.manifest.json
```
- **D5 联动链**：点击阶段 → `setStage()` + `openBoard()`（恢复编辑器宽度）→ AI 请求带 `productStage` → main 渲染 `PRODUCT STATE` 动态 system prompt → 产品工具写固定文件 → `ai:fileChanged` / `project:fsChanged` 广播 → 看板/文件树刷新。

### 1.3 Inferred（判断，未直接证实）

- **I1** 阶段详情板大致包含：需求原文/验收条件/确认、3D 网格预览、BOM/约束表、固件列表、证据与「未证明」项、产品包过期提示。依据：`renderer:5081` 命中「需求原文」「未证明」「产品包已过期」「3D 预览」及 Three.js/WebXR 代码，但该行 152KB 无法完整直读。
- **I2** `bo.activeStage` 大概率被逐字作为末位实参传给 `ai:agentAccountStream`；`renderer:857` 约 194KB，未能逐字确认。
- **I3** 阶段语义图标 `Lightbulb/Ruler/Cpu/Code/Workflow` 与五阶段一一对应——未找到可靠映射。
- **I4** 英文模式下五个阶段名仍显示中文（阶段名硬编码，i18n 只有工具名）。

### 1.4 Unknowns（技能要求明确列出）

- U1：CSS `pf-nav__*` 的具体声明（唯一 CSS 194KB 单行，无法局部截取）——**影响像素级还原**。
- U2：五个产品工具执行器的完整参数 schema 与失败处理。
- U3：3D 预览的网格格式支持范围（STL/OBJ/3MF）与 Y/Z 轴转换细节。
- U4：截图左侧 3 个活动栏图标的精确 tab 对应关系。

---

## 2. LabCode 现状（关键，决定方案起点）

**LabCode 并非从零**：已存在「产品工厂」的壳，但语义完全不同。

| 项 | 证据 | 状态 |
|---|---|---|
| `#product-factory-view` | `renderer/index.html:451-465` | ✅ 存在，但内容是**「AI 硬件拆解工坊」**：一个 `产品构想` textarea + `让 AI 生成方案` 按钮 + `pf-output` |
| 欢迎页「做产品」pill | `index.html:1047` → `app.js:13089-13091` | ✅ 点击打开上述视图 |
| 活动栏 product-factory tab | `app.js:10338-10341, 10814, 12322` | ✅ 存在，但 `app.js:12321` 注明「由 ai-hardware-lab 真插件提供入口与能力」 |
| 项目类型判别 | 全仓搜 `projectType.*product` | ❌ 无 `projectType:"product"` 概念 |
| 五阶段 / `computeStages` / `spec.json` / `bom.json` / `evidence.jsonl` | 全仓搜 | ❌ **0 命中** |
| `productStage` / 五个产品 AI 工具 | 全仓搜 | ❌ 0 命中 |
| 已有的项目/文件 IPC | `project:*` 族（Phase A 调研） | ✅ 有可复用基础 |

**结论**：LabCode 的「产品工厂」是**一次性 AI 生成方案**的轻量工具，ChipCode 的是**以磁盘文件为真相、五阶段状态机驱动、AI 工具逐步推进**的完整产品生命周期系统。两者同名但不同物。

---

## 3. 改造方案（请用户选择）

> 所有方案都**不动**现有「AI 硬件拆解工坊」的功能，除非选择方案 D。

### 方案 A：最小可视化对齐（推荐先做，1-2 天）
**做什么**：只复刻截图的**侧栏空态 + 五阶段导航 UI**，状态用本地 JSON 模拟（不接磁盘文件、不接 AI）。
- 新增左活动栏 `product` tab + 侧栏面板（空态与截图 1:1）
- 项目类型判别改为读取项目根 `.labcode.json` 的 `projectType`（先做简化版）
- 五阶段纵向导航 + 状态圆点 + 证据进度条（`pf-nav__*` 风格）
- 阶段详情板只读展示，数据来自一个 `product-state.json`

**收益**：视觉/交互 1:1 对齐截图，用户能立刻看到差异。**成本**：纯前端 + 1 个 IPC，零风险。
**不做**：脚手架、状态机、AI 工具联动、产品包导出。

### 方案 B：数据闭环（3-5 天）
**做什么**：A + ChipCode 的**磁盘真相模型**。
- `product` 项目类型注册 + 完整脚手架（`.triecode.json` 兼容、spec/shape/bom/constraints/evidence/firmware/hardware-package）
- 移植 `computeStages()` 纯函数（五阶段完成条件、blocked 优先、证据覆盖、FNV 指纹）
- 新建/打开产品项目走通用项目对话框
- 文件监听 300ms 防抖刷新看板
- 容错解析：坏 JSON 退化为「未开始」不白屏

**收益**：状态可持久化、可跨重启、可验证，是后续 AI 联动的地基。**成本**：主进程文件服务 + 状态机单测。
**风险**：中。需保证路径安全（禁止绝对路径/`..`）。

### 方案 C：AI 联动（7-10 天）
**做什么**：B + 五个产品 AI 工具 + `PRODUCT STATE` 动态 system prompt + `productStage` 焦点机制。
- 在现有 `AgentRunner` 工具集里加 5 个工具（复用 Phase A 已确认的 `toolStep`/`showPermissionModal` 确认链路）
- AI 请求带 `productStage`，非法时按磁盘选第一个非 done 阶段
- 工具写盘后广播 `fileChanged` 让看板刷新
- 防止「对话里说完成」被误判为阶段完成（只认磁盘证据）

**收益**：真正 1:1 对齐 ChipCode 的产品形态。**成本**：要动 AgentRunner / 系统提示 / 工具审批，回归面大。
**风险**：高。建议 B 稳定后再启动。

### 方案 D：完整复刻 + 替换现有工坊（2-3 周）
**做什么**：C + 3D 网格预览（STL/OBJ/3MF）、2D 视图、产品包导出（`build_package`）、过期提示，并**用新面板替换**「AI 硬件拆解工坊」。

**收益**：完全对齐。**成本/风险**：最高，且会删除现有用户可见功能，需产品决策。

### 方案 E：不改造，只做文档
把本报告作为设计基线归档，LabCode 保持现状。

---

## 4. 我的建议

**选 A**（先可视化对齐），理由：
1. 用户提供的证据是**截图**（空态 UI），A 直接消除最直观的差异；
2. LabCode 已有同名视图但语义不同，A 不改它、零冲突；
3. B/C 的地基（项目 IPC、AgentRunner、Phase A 的工具确认链路）都已具备，A 完成后可平滑升级；
4. 与 Phase A/B/C 的节奏一致（每阶段可验证、可回滚）。

若你更看重「产品形态一致」而非「视觉一致」，则**先 B**。

---

## 4.5 用户决策：全做（A→B→C→D 完整落地）

用户选择「全做」，即一次性交付方案 D 的完整形态（含替换现有工坊），并记录如下实施结果。

### 分层落地
| 层 | 文件 | 内容 |
|---|---|---|
| L1 主进程 | **新增** `main/product-factory.js` | 脚手架（`.triecode.json` + spec/shape/bom/constraints/evidence/firmware/design/views/hardware-package）、`computeStages()` 五阶段状态机（done/in_progress/blocked/not_started、blocked 优先、证据作废链、pass 覆盖、未证明项）、FNV-1a 输入指纹、`build_package()` 导出 5 文件、路径白名单防穿越、`fs.watch` 300ms 防抖推送、坏 JSON/JSONL 容错 |
| L1 | `main/index.js` / `main/preload.js` | 7 个 `product:*` handler + `product:files-changed` 推送；preload `product` 命名空间（state/create/package/readFile/writeFile/watch/unwatch/onFilesChanged） |
| L2 渲染 | **新增** `renderer/js/product-factory.js` | 五阶段纵向导航 + 证据进度条 + 空态（截图 1:1）+ 阶段详情板（需求/BOM/固件/证据/2D 预览）+ 新建/打开项目 + 产品包导出 + 文件监听刷新；`window.ProductFactory` 暴露 activeStage/snapshot/refresh/writeFile |
| L3 AI | **新增** `renderer/js/product-ai-tools.js` | 5 个工具 `propose_criteria` / `propose_shape` / `propose_bom` / `record_evidence` / `build_package`（写盘为真相，禁止对话声称完成；covers 校验 criterion id；BOM 缺 url 警告） |
| L3 | `renderer/js/app.js` | `TOOL_DEFS` 追加 5 工具（分派/schema/权限/toolStep UI 自动生效）；`_buildSystemPrompt` 注入 `PRODUCT STATE` 动态块与 `- 产品阶段`；`product-factory` 分支委派新模块；解耦 3 处 `ai-hardware-lab` 插件门槛（保留 hwlab service/manifest/命令面板入口） |
| L4 外壳 | `renderer/index.html` | 静态活动栏「产品工厂」按钮（app.js 初始化前必须存在）、替换 `#product-factory-view` 内容、脚本按依赖顺序挂载（`product-ai-tools.js` 在 app.js 前）、`pf-nav__*` 样式 |

### 验证
- **`D:\work\tmp\verify_phased.js` → 68/68**：D1 脚手架/项目类型、D2 五阶段固定顺序与初始全未开始、D3-D6 逐阶段 done 条件、D7 证据作废与 fail 优先、D8 坏文件容错、D9 指纹/产品包/过期、D10 路径穿越防护、D11 文件监听、D12 五个 AI 工具、D13 面板渲染与阶段切换/空态。
- 全量回归 **28 + 46 + 40 + 68 = 182/182**（Phase A/B/C/D 无互相回归）；9 个 JS 文件 `node --check` 全过；IPC 契约无缺失通道、无重复 handler。
- **运行时 asar 热修 + GUI 实测**：新增活动栏第 5 个芯片图标渲染；点击后产品工厂空态与用户截图 1:1（Package 图标、标题、hint、蓝色「+ 新建产品项目」、描边「打开已有项目」）。另用真实磁盘项目跑出 `创意/造型/硬件/软件/联调` 全 `done`、`meter 1/1`、进度 `5/5`。
- 诚实标注：**带五阶段导航的产品项目视图未做 GUI 逐点实测**（原生目录对话框送达问题），该分支由 D13 DOM 级回归覆盖。

### 实现中修正的真实缺陷
- `isProductProject()` 用 `||` 短路会返回 `null` 而非 `false` → 改 `!!(...)`。
- 脚手架预置 `firmware/README.md` 与模板 `spec.md`/空 `shape.json` 被误判为 `in_progress` → 去掉 README、模板不计进度、说明文件不计入固件/视图产物（对齐 ChipCode 新建项目五阶段全未开始）。

---

## 5. Handoff（给下一次会话）

- **现状**：Phase A/B 已提交 `f094f68`；Phase C（MQTT 长连接 + 订阅套餐）已实施、回归 40/40、未提交；本轮产品工厂只出方案、**未改代码**。
- **下一步**：等用户在 A/B/C/D/E 中选择；选定后再动代码。
- **陷阱**：
  1. Craft Anything CLI 无常驻 server，evidence ledger 为空 → 别依赖 `ev_` id，用路径+行号引用；要真 ledger 需 `mcp` 常驻 + IDE 重连。
  2. 渲染包 `index-BPkqxohS.js` 的 `:857`/`:5081` 是 150-194KB 超长行，局部 JSX 读不全 → 阶段详情板布局属推断。
  3. CSS 194KB 单行 → 像素级 `pf-nav__*` 还原需另想办法（运行时截图或 CSS 解析）。
  4. LabCode 的 `#product-factory-view` 已被「AI 硬件拆解工坊」占用，别直接覆盖，除非选 D。
  5. `.handoff` 在根仓库被 `.gitignore` 忽略，交接文档须放 `codelab-desktop/.handoff/` 才入库。

# 交接书：工作流可视化编排 —— 完善执行能力

日期：2026-10-17
分支：main（本地提交 `849c17e`；工作流改动经 GitHub REST API 推到 `hulufeng/LabCode@main` 为 `18a21b5`，因安全原因本交接文档未随推，故本地 `849c17e` 与远程 `18a21b5` 仅在本文档上分叉，后续 `git pull` 可干净合并）
关联：前序 `HANDOFF-20261015-autoUpdate.md`（自动更新修复，已完成）

## 背景
工作流 MVP（`8fa0b81` / `2999f65`）已具备画布、节点增删/拖拽/连线/属性编辑、保存加载、拓扑排序运行。
但 MVP 的**工具(终端)节点为桩**（`[终端] …（MVP 未接真实终端）`），**条件分支无真实判定**，缺少导入/导出与运行态可视化。
本次按用户"完善工作流执行"指令补齐。

## 改动文件
- `desktop-app/renderer/js/app.js`
  - `wfRun()` 重写：
    - 工具(终端)节点：调用 `window.LabCode.terminal.execute(cmd, cwd, 60000)`（cwd = `state.projectPath`），解析 `{success,stdout,stderr,exitCode,blocked}` 写入节点结果；命中 `blocked==='deny'` 安全护栏时标记 error。
    - 条件分支节点：用 `new Function('ctx','prev', 'return (' + expr + ')')` 评估，表达式可用 `prev`（上游节点输出文本，换行连接）或 `ctx['节点ID']`；**真分支取第 1 条出边、假分支取第 2 条出边**，其余出边删除（prune）。
    - 执行模型改为**拓扑序 + 可达性传播**：从入度为 0 的根出发，仅沿 active 出边把下游加入 `reachable`；被 prune 的边下游整体跳过（state=`skipped`）。这修复了"删除唯一入边会让下游误判为根而执行"的问题，同时菱形汇聚（true/false 重新汇合）仍正确执行。
    - 环检测保留（完整图 Kahn，若不包含所有节点即报错）。
    - 运行后 toast 汇总：执行数 + 跳过数（分支未命中）。
  - `wfRenderNodes()`：节点 class 增加 `wf-<state>`（running/done/error/skipped），头部增加状态徽标（⏳运行中 / ✅ / ⚠️ / ⏭️跳过）。
  - `wfRenderProps()`：条件节点标签改为"条件表达式（JS）"并加占位与说明（prev / ctx 用法、真/假分支取边规则）。
  - 新增 `wfExport()` / `wfImport()`：经 `LabCode.dialog.saveFile`+`fs.writeFile` 导出/导入 JSON（导出剥离 `_state` 瞬态）；非 Electron 环境导出走 Blob 下载。
- `desktop-app/renderer/index.html`
  - 工作流侧栏动作区新增「导入」「导出」按钮（`#wf-import` / `#wf-export`）。
  - 工作流 `<style>` 增加 `.wf-running/.wf-done/.wf-error/.wf-skipped`、`.wf-state*`、`.wf-cond-hint` 样式。
- `desktop-app/scripts/wf_logic_test.js`（新增，开发期回归测试，未提交）
  - 独立复刻 wfRun 核心算法，验证 4 类图：线性+false 分支跳过、菱形汇聚、环检测、普通线性全执行 —— 10/10 通过。

## 验证状态
- `node --check renderer/js/app.js` 通过。
- `node scripts/wf_logic_test.js` 10/10 通过（纯算法层：线性+false 跳过 / 菱形汇聚 / 环检测 / 普通线性）。
- `node scripts/wf_integration_test.js` **16/16 通过**：在 jsdom 真实 DOM + mock LabCode 下抽离并运行真实工作流模块，覆盖 AI 节点真实 `ai.chat`、工具节点真实 `terminal.execute`、条件分支真/假裁剪与下游跳过、导出/导入往返（剥离并恢复 `_state`）、空画布不崩溃。
  - ⚠️ **2026-11-14 状态更新**：以上为 10-17 当时的旧引擎验收。此后 `app.js` 工作流模块重构为「多 Agent 引擎」（`data.status` 状态机 / `route=success|loop` / 审批门 / 环检测 / 按钮内联导入导出），本测试因硬编码行号 `slice(8424,8603)` 失效，已**重写为 11 个用例**（按源码标记动态抽取），纳入 `npm test` 默认套件（现 12 脚本 / 99 断言全绿）。详见 `.handoff/BubaiCode_实机验收_20261108.md` §27.4。
- 依赖已重装：`npm install` 经 npmmirror（此前 `node_modules` 在清理时被移至 `D:/_nm_quarantine/`，现已恢复；重装前需先结束残留 `electron.exe` 进程以释放 `electron/dist` 文件锁，否则 EBUSY）。
- **仍待用户机器真机验证**：GUI 渲染、AI 节点真实 API Key 调用、终端节点真实命令执行需在带显示环境 + 配置可用 API Key 下确认。

## 使用说明（给用户）
1. 工具节点：属性填"终端命令"，运行时在 `state.projectPath`（当前项目根）下执行，结果显示退出码与输出。
2. 条件分支：属性填 JS 表达式（如 `prev.includes('error')` 或 `ctx['n上一步ID'].includes('失败')`）；从节点拉出的第 1 条连线=真分支、第 2 条=假分支。
3. 导入/导出：把整张工作流存为 `labcode-workflow.json` 或读取恢复。
4. 运行后节点边框/徽标实时反映 running/done/error/skipped。

## 待办 / 遗留
- [x] 重装依赖 + 算法/集成验证（10/10 + 16/16）已完成；本地提交 `849c17e`。
- [x] 推 GitHub：经 REST API 推 `hulufeng/LabCode@main` = `18a21b5`（2 源码 + 2 测试；`.handoff` 因含阿里云 AK 完整值当时未随推，安全考虑）。
- [x] 补推：`.handoff` 已脱敏（AK `LTAI5t***********`、PAT `ghp_****`、生产密码 `zpp****` 全部打码）并经 REST API 追加推到 `main` = `395985b`；同批纳入 `desktop-app/package-lock.json`。本地提交 `dda5306`。
- [ ] 用户机器真机验证（GUI / AI 真实 API Key / 终端真实命令）。
- [ ] 后续可增强：并行节点执行、循环节点、节点级超时/重试、运行日志时间线。
- [ ] 安全：对话中暴露的 PAT `ghp_****`、阿里云 AK `LTAI5t***********`、生产密码 `zpp****` 均须吊销/轮换（本文件中的敏感值已打码）；**AK 仍残留在本地旧提交（849c17e / de34b6c）中，必须轮换方能彻底消除风险**。

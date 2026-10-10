# Agent 引擎对齐 TrieCode · 差距补齐任务规划

> 日期：2026-10-09
> 依据：`codelab-doc/TrieCode源码架构与逻辑深度分析.md`（TrieCode v1.2.9 app.asar 逐行精读）
> 对象：`src/main/engine/`（LabCode v1.1.3）
> 判断口径：**以当前代码为准**。2026-09 那份对比文档列的差距多数已补齐（决策台账、验证闸门、计划模式、并发调度、wrap-up 均已在位），本规划只列**仍真实存在**的缺口。

---

## 一、总览

| ID | 优先级 | 任务 | 改动文件 | 状态 |
|---|---|---|---|---|
| T1 | P1 | 外部进程 hooks（PreToolUse 可拒绝/改参 + PostToolUse 观测） | 新增 `engine/hooks.ts`、`scripts/check-agent-hooks.mjs`；改 `tool-registry.ts`、`agent-runner.ts` | ✅ 已完成（自检 16/0） |
| T2 | P1 | 自动记忆提取（run 结束自动提炼长期记忆） | 新增 `engine/auto-memory.ts`；改 `agent-runner.ts` 收口 | ✅ 已完成（待真机实测） |
| T3 | P2 | token 水位压缩（65% 水位主动剪裁旧工具输出） | 改 `agent-runner.ts` `compressContext` 触发条件 | ✅ 已完成（待真机实测） |
| T4 | P2 | 并发上限（并行批限流） | 改 `agent-runner.ts` `groupToolCallsForConcurrency` | ✅ 已完成 |
| T5 | P3 | 多模态（vision）/ PDF 读取工具 | 新增 `engine/tools/vision-tools.ts` 等 | 未启动（依赖云端模型能力） |
| T6 | P3 | 代码 FTS 全文索引 worker | 新增 `services/codeIndexer.ts` | 未启动（LSP + search_content 已可覆盖） |

**不在本规划内**（已持平，无需动）：迭代上限 20 / 墙钟 120min / 75% 收尾提醒 / 连续失败 3 次熔断 / 决策台账 / 失败分类与退避 / 验证证据闸门 / 反幻觉纠正 / 计划模式 / 并发调度 / wrap-up 空工具集强总结 / 上下文压缩 + 最近读文件重注入。

**已领先 TrieCode，保持不动**：多智能体编排器（角色 + writeScope 冲突检测 + 分层并行）、checkpoint 快照/回退/fork、`.labignore` 写保护、`closed_loop` 硬件闭环、`verify`/`research` 子智能体、本地小模型通道、工具耗时观测中间件。

---

## 二、T1 · 外部进程 hooks（P1）

### 现状（为什么算缺口）
`tool-registry.ts` 已实现 pre/around/post 三层管道，但只挂了两类中间件：
- `tool-observers.ts` 的 `timing-audit`（post，观测）与 `slow-tool`（around，仅提示）
- 均**不能拒绝工具调用、不能改参数**

TrieCode 的 `hooks.js` 允许外部脚本在 `PreToolUse` 阶段**拒绝执行或修改参数**（如禁止写 `platformio.ini`、给 `terminal` 加 `--dry-run`），这是把「团队规范/项目红线」外置成脚本的能力，AI 无法绕过。

### 目标
1. 支持 `PreToolUse`（可 reject / 可改参）与 `PostToolUse`（纯观测）两类事件。
2. 配置来源：全局 `%APPDATA%/CodeLab/hooks.json` + 项目 `<root>/.labcode/hooks.json`（项目覆盖全局）。
3. 钩子失败一律放行（超时 5s、spawn 失败、输出不可解析 → `allow` 并 `console.warn`），**钩子不得把 Agent 卡死**。

### 配置格式
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "write_file,edit_file", "command": "node .labcode/guard.js", "timeoutMs": 5000 }
    ],
    "PostToolUse": [
      { "matcher": "*", "command": "node .labcode/audit.js" }
    ]
  }
}
```
`matcher`：`*` 全部；逗号分隔多个工具名；支持尾缀通配 `compile*`。

### 钩子协议
- 输入：stdin 传 JSON `{ event, tool, args, cwd, projectRoot, ts }`（PostToolUse 额外带 `result`，content 截断 2000 字符）
- 输出（stdout，JSON）：`{ "decision": "reject", "reason": "..." }` 或 `{ "decision": "allow", "args": {...} }`（改参）
- 退出码：`0` 正常（`decision` 取自 stdout JSON）；`2` 拒绝（stderr 作为 reason）；其它视为放行

### 验收
- [ ] 配一条 `PreToolUse` matcher=`write_file`、命令 `exit 2` 的钩子 → 该工具被拒绝，Agent 收到 `rejectReason` 不崩溃
- [ ] 钩子超时（命令 `sleep 20`）→ 5s 后放行，不卡主循环
- [ ] 钩子输出 `{"decision":"allow","args":{"path":"x"}}` → 工具实际收到改后的参数
- [ ] 未配置 hooks.json → 零开销、零日志噪音
- [ ] `scripts/scan-*.mjs` 全部 0 命中；`tsc --noEmit` 双配置通过

---

## 三、T2 · 自动记忆提取（P1）

### 现状
`memoryService.ts` 提供 `saveMemory / recall_memory / searchMemory`，但**只有模型主动调用 `save_memory` 才会写入**——模型不调就等于没有。
TrieCode 有 `auto-memory.js`：会话结束自动从对话提炼长期记忆，下次 run 启动时由 `listMemory` 注入。

### 目标
run 正常结束时，异步（不阻塞 `done` 事件）用一次轻量 LLM 调用从本次会话提炼 **0~3 条**值得长期记住的事实，写入 `memoryService`。

### 触发条件（全部满足才跑）
- 主 Agent 循环结束（非 `teaching` / `modify` / `chat` 纯对话模式）
- `stats.toolCalls > 0`（真的干了活）
- 非 `stopped`（用户主动中止）

### 提炼什么（写进 prompt）
项目约定 / 硬件配置（板卡、端口、FQBN）/ 用户偏好 / 踩过的坑及解法 / 已完成的关键决策。
**不提炼**：一次性文件内容、临时报错、重复信息。

### 防护
- 单次最多 3 条，每条 ≤ 300 字符
- 整个流程包 try-catch，失败仅 `console.warn`，不得影响 `done` 事件
- 去重：与最近 20 条记忆做关键词重合度判断，高度相似不重复写

### 验收
- [ ] 跑一次带工具调用的 run → `userData/memory/projects/*.json` 新增条目
- [ ] 连续两次相同任务 → 不产生重复记忆
- [ ] 模型调用失败 / 返回非法 JSON → 静默跳过，界面无感
- [ ] `done` 事件不被延迟（提炼在后台进行）

---

## 四、T3 · token 水位压缩（P2）

### 现状
`agent-runner.ts:359` 仅按**消息条数 > 40** 触发压缩，且 `compressed` 一次性开关，之后不再压缩。
TrieCode：`>128k` 上下文在 **65% 水位**时主动无损剪裁旧工具输出，条数不是唯一判据。

### 目标
1. 增加 token 估算（字符数 / 3 粗估，中英混排够用），预算常量 `CONTEXT_TOKEN_BUDGET`；达到 **65%** 触发。
2. 触发条件改为「条数 > 40 **或** token 超 65%」。
3. 超水位时先做**无损剪裁**：把较早的 `role: 'tool'` 消息 content 截断到 `MAX_TOOL_RESULT_CHARS`，可重复执行（不受 `compressed` 一次性开关限制）。

### 验收
- [ ] 构造长工具输出会话 → 未到 40 条也会触发剪裁
- [ ] 剪裁后最近 N 条消息内容完整（不误伤当前轮）
- [ ] 剪裁可重复触发，不会因 `compressed=true` 失效

---

## 五、T4 · 并发上限（P2）

### 现状
`groupToolCallsForConcurrency`（`agent-runner.ts:1441`）把连续的可并发工具合并成一批后 `Promise.all`，**批长度无上限**。
TrieCode 有 `PARALLEL_LIMIT = 5`。

### 目标
批长度达到 `PARALLEL_LIMIT = 5` 时先 flush，再开新批。批间仍严格串行。

### 验收
- [ ] 一次返回 12 个只读工具调用 → 分成 ≤ 5 的批执行
- [ ] 批内并行、批间串行语义不变

---

## 六、T5 / T6（P3，暂不启动）

- **T5 多模态 / PDF**：TrieCode 有 `vision.js`(5KB)、`pdf.js`(10.5KB)。LabCode 本地小模型无多模态能力，只能对云端通道开放，收益/成本比低，等云端通道稳定后再做。
- **T6 代码 FTS 索引**：TrieCode 有 263KB `indexer-worker`。LabCode 现有 5 个 LSP 工具 + `search_content` + `code_symbols` 已覆盖主要检索场景；真到大型仓库再补。

---

## 七、开发记录（2026-10-09）

### 已完成
- T1：新增 `src/main/engine/hooks.ts`（`loadHooks` / `matchTool` / 两个中间件），`tool-registry.ts` 补 `hasPreMiddleware`，`agent-runner.ts` 构造函数幂等注册。自检 `scripts/check-agent-hooks.mjs` **16/0**。
- T2：新增 `src/main/engine/auto-memory.ts`；`agent-runner.ts` 新增 `finishRun(reason?)` 统一收口，主循环 4 个 done 出口全部改为走它（此前漏一个出口就会让收尾动作失效）。
- T3：`agent-runner.ts` 新增 `estimateContextTokens` / `isOverContextWatermark` / `trimOldToolOutputs`；压缩触发条件改为「条数 > 40 **或** token ≥ 128000×0.65」；已折叠过一次后改走可重复的无损剪裁。
- T4：`PARALLEL_LIMIT = 5`，并发批封顶后先 flush 再开新批。

### 本次踩到的坑（补进 `docs/PROJECT.md` §12 候选）
**箭头函数的 `.name` 是只读属性，不能直接赋值。** `makePreToolUseHookMiddleware` 里写 `mw.name = 'hooks-pre'` 直接抛
`TypeError: Cannot assign to read only property 'name'`——而且是在**注册中间件时**抛，会让整个 Agent 构造失败。
`tool-observers.ts` 2026-10-08 已踩过同一个坑，修法是 `Object.defineProperty + try-catch`，本次照抄。
**规则：给函数挂幂等名一律用 `Object.defineProperty(..., { value, configurable: true })`。**
这个 bug 是新写的自检脚本第一次运行就抓到的——再次印证「新增断言先自证不误报」的价值。

### 验证结果
| 检查项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` | 通过（0 错误） |
| `scripts/check-agent-hooks.mjs` | 16 / 0 |
| `scripts/check-agent-tools.mjs` | 18 / 0 |
| `scripts/scan-ipc-handlers.mjs` | 0 命中 |
| `tsc --noEmit -p tsconfig.web.json` | ❌ `TitleBar.tsx:332` JSX 未闭合 —— **改动前就存在**（`TitleBar.tsx` 在我介入前已是 modified 状态），非本次引入 |

### 待真机实测（本地无板/无模型，跑不了）
- T2：跑一次带工具调用的 run，确认 `%APPDATA%/codelab-desktop/memory/projects/*.json` 新增条目；再跑一次相同任务确认不重复写。
- T3：构造长编译日志会话，确认未到 40 条也会触发剪裁。

---

## 八、开发红线（照抄 `docs/PROJECT.md` §12）

1. 不谎称"新增"：动手前先 grep 是否已存在。
2. 误报比漏报更烦人：新增断言先自证不误报。
3. 主进程代码会被 rollup 拆进 `out/main/chunks/`，复核必须 `grep -r`。
4. 改完必跑：`tsc --noEmit`（双配置）+ `scripts/scan-ipc-handlers.mjs` 等扫描四件套。

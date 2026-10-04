# Cline SDK 源码级对标报告（Apache-2.0，可合法落地）

> 日期：2026-10-01 ｜ 性质：源码精读（sdk/ 目录核心引擎），对照 TrieCode 全链路深度报告（20 章）
> 源码获取方式：git 直连/镜像全部不可达（网络限制），改经 doubao 浏览器访问 github.com + 页面内 fetch api.github.com 逐文件精读；**已验证通道**：`github.com` blob 页 + `api.github.com` raw（页面内 fetch，CORS 放行）
> 许可结论：**Apache-2.0**，商业闭源产品可自由使用/修改（保留版权声明），这是与 TrieCode（闭源仅学习）、velxio（AGPL 不可用）本质不同的可落地项目
> 仓库：https://github.com/cline/cline（69.6k★，main 分支，sdk/ 为独立 monorepo）

---

## 〇、一句话结论

**Cline SDK = TrieCode Agent 的开源精简版**：同样的"循环+恢复+审批"三件套，但分层更干净（shared/llms/agents/core）、错误恢复更聚焦（重试/截断/溢出三恢复）、工具治理更插件化（toolPolicies+approval 回调），且多出 TrieCode 没有的 **loop-detection 防死循环、subprocess 沙箱、hub 多客户端、cron 定时**。codelab 的 AI 面板落地可直接照其架构自研嵌入式专属 Agent 层。

---

## 一、架构分层（ARCHITECTURE.md 权威源）

```
@cline/shared  低层契约：类型/schema、路径解析、hook 契约、扩展注册、prompt 解析、存储路径
@cline/llms    模型/provider 运行时：provider 配置、模型目录、网关契约、AI SDK 执行、语音转写
@cline/agents  无状态运行时循环：迭代循环、工具编排、运行时事件、hook/扩展执行、turn 准备
@cline/core    有状态编排：会话生命周期、存储持久化、配置 watcher、默认主机工具组装、
               插件发现/加载、上下文压缩策略、telemetry、hub server、cron、cloud
```

**设计规则**（codelab 架构可抄）：
1. shared 不得依赖上层运行时包
2. provider 专属行为隔离在 llms，不散落到 core/apps
3. agents 不持有持久存储或 host 生命周期（**无状态循环 vs 有状态编排分离**）
4. core 是 app-facing 编排层；`ClineCore.start()` 是门面，归一化宽泛配置后委托 `RuntimeHost`

**三条设计接缝（Design Seams）**：
| 接缝 | 实现 | codelab 借鉴 |
|---|---|---|
| Config Watchers | rules/workflows/skills/agents/hooks/plugins **全部走文件发现+watcher**，不另建内存路径 | AI 面板的规则/技能统一落盘 + watcher |
| Runtime Builder | DefaultRuntimeBuilder 从 tools/hooks/extensions/指令 watcher/telemetry 组合运行时 | 编译/烧录/串口工具通过 builder 注入 |
| Runtime Host Boundary | LocalRuntimeHost / HubRuntimeHost / RemoteRuntimeHost 三种，core 统一委托不分支 | 单机/远程烧录主机抽象 |

---

## 二、Agent 主循环（agent-runtime.ts，2863 行）——对照 TrieCode §5/§11/§17

### 2.1 execute() 循环骨架（L782）
```
execute()
 ├─ ensureInitialized()（工具+插件 setup 注册）
 ├─ run-started 事件
 ├─ 输入消息入列（message-added 事件）
 ├─ 完成工具提醒注入（completionPolicy.requireCompletionTool）
 └─ while (iteration < maxIterations)
     ├─ turn-started 事件
     ├─ resetLastError()          ← 每轮错误清零，防跨轮污染
     ├─ generateAssistantMessageWithProviderRetry()
     ├─ finishReason 分流：
     │   ├─ aborted → throw
     │   ├─ error+空内容 → throw（内容过滤/空响应各有专属文案）
     │   ├─ max-tokens+无工具 → recoverFromIncompleteMaxTokensTurn() 或 throw
     │   └─ 有工具调用 → 重置截断计数器
     ├─ 无工具调用 → finishRun("completed") / 完成提醒继续
     ├─ executeToolCalls(toolCalls) → 工具结果入列
     └─ findCompletingToolMessage → 终止工具成功即完成
 └─ 超 maxIterations → throw
```

### 2.2 三类恢复机制（对照 TrieCode：TrieCode 靠五类预算+三级压缩+失败恢复三级）

| 机制 | Cline 实现 | TrieCode 对应 | codelab 建议 |
|---|---|---|---|
| **max-tokens 截断恢复** | `MAX_TOKENS_RECOVERY_LIMIT=3`，注入 nudge 提示（"精简输出，小步走"），有工具调用即清零计数（只惩罚连续截断） | §17 预算循环 | ✅ 直接抄 |
| **provider 瞬时错误重试** | `PROVIDER_ERROR_MAX_RETRIES=3`，指数退避 1s/2s/4s（上限 15s），`abortableDelay` 等待期间可取消；`isRetryableProviderErrorTurn` 判定：无任何内容 + 无 provider 工具副作用 + 非 auth + 非 context_window_exceeded | §19 backoff + error-classification(transient) | ✅ 直接抄 |
| **上下文溢出恢复** | 压缩后重试一次；三类终端文案：无可压缩（系统提示+工具就超窗）/ 压缩后仍超 / 无压缩管线 | §17 context-manager 三级压缩 | ✅ 文案可直接参考 |

### 2.3 完成锚点（对照 TrieCode 验证硬闸门）
- `completionPolicy.requireCompletionTool` + 工具 `lifecycle.completesRun`（内置 `submit_and_exit`）
- 每轮开头注入提醒："本 run 未完成直到调用终止工具之一"
- `findCompletingToolMessage`：终止工具返回非 error → 立即 finishRun("completed") 并带工具输出文本
- **task.completed telemetry 锚定在 submit_and_exit 显式声明**，teardown 兜底（emitTaskCompletedOnTeardown）覆盖"正常结束但无显式完成工具"的会话

### 2.4 状态与取消
- `abort(reason)` → AbortController + AgentRuntimeAbortError；`notifyPendingUserMessage()` 只中断当前模型请求、放行正在运行的工具有序结束
- `restore(messages)` 会话重置：保留模型/工具/hooks/订阅者，丢弃 run/usage 状态（外部持久化者可重播种）

---

## 三、工具系统（对照 TrieCode §2 工具面 + §12 权限）

### 3.1 执行编排 executeToolCalls（L2284）
```
prepareToolExecution 逐个（可并行）
 ├─ metadata.inputParseError → skip
 ├─ provider-executed tool（toolSource.executionMode==="provider"）→ skip（防重放副作用）
 ├─ normalizeJsonLikeStringsForSchema（宽松字符串→schema 规范化）
 ├─ beforeTool hooks 链：可改 input / 叠加 policy / appendContext（注入下一轮请求）/ skip
 ├─ toolPolicies 解析 + hook 覆盖：
 │   ├─ enabled===false → skip
 │   └─ autoApprove===false → requestToolApproval 回调（无回调则拒绝+TOOL_REJECTION_SUFFIX）
执行：sequential 与 parallel 分组——相邻 parallel 调用并行（Promise.all），
      sequential 工具必须等前组、阻塞后组（防止并行破坏顺序依赖）
```

### 3.2 内置工具清单（runtime-builder.ts 实测）
| 工具 | 说明 | codelab 对应 |
|---|---|---|
| `editor` | 文件编辑工具集（read/write/edit） | ✅ AI 文件工具（落地第一批） |
| `run_commands` | 命令执行（subprocess-sandbox 包裹） | ✅ compile/upload 工具化 |
| `search_codebase` | 代码搜索（file-indexer 索引） | ✅ |
| `read_files` | 读文件 | ✅ |
| `skills` | 技能系统 | ✅ 教学技能 |
| `web_search` | 网络搜索 | 可选 |
| `image_generation` | 图像生成 | 可选 |
| `submit_and_exit` | 完成工具（completesRun） | ✅ |
| MCP 工具 | createMcpTools 加载 | ✅ 插件化 |
| `spawn` | 子代理工具（team） | ✅ 多 Agent 形态 |
| mode | **yolo / plan / act** 三模式 | ✅ 对应 Plan/Act 交互 |

### 3.3 审批（tool-approval.ts）
- 与 TrieCode deny>ask>allow 等效，但更简洁：`ToolPolicy{enabled, autoApprove}` + host 注入 `requestToolApproval` 回调
- 拒绝理由拼接 `TOOL_REJECTION_SUFFIX` 返回给模型（模型知道被拒可调整）

---

## 四、安全护栏（对照 TrieCode §12）

| 机制 | Cline 实现 | TrieCode 对应 | 评价 |
|---|---|---|---|
| **loop-detection**（防死循环） | 工具调用签名 `toolCallSignature`（**sortKeys 规范化 JSON**，参数顺序无关）；连续相同（工具+签名）计数，`softThreshold` 软警告 / `hardThreshold` 硬升级；SessionRuntime 装为 beforeTool hook | §2 checkHallucination | Cline 更直接（行为级），codelab 两个都做 |
| **subprocess-sandbox** | 子进程沙箱执行命令（生命周期管理+隔离） | §11 terminal（黑名单/白名单） | Cline 更彻底 |
| **mistake-tracker** | 错误追踪（连续失败归因） | §13 tool-failure 分类器 | 同思路 |
| **rules** | 安全规则加载（.clinerules） | §10 projectInstructions | 同思路 |

---

## 五、会话 / 记忆 / 多 Agent（对照 TrieCode §17/§18）

| 能力 | Cline 实现 | codelab 借鉴 |
|---|---|---|
| 会话存储 | session/stores + checkpoint-diff/restore（**文件级回滚**，桌面版 checkpoint 门控） | ✅ 文件回滚 |
| 用量统计 | services/usage：**root 与 aggregate（含子代理）双桶**，telemetry 只记主代理 | ✅ |
| 多 Agent 团队 | team 服务 + `spawn` 工具 + coordinator/teammate 事件（teammate_spawned/shutdown）+ **团队状态跨会话持久** | 完整形态 |
| 工作区 | file-indexer（文件索引）+ mention-enricher（@提及增强）+ workspace-manager | ✅ @文件提及 |
| 记忆 | （Cline 依赖外部 skills/规则，无 TrieCode 式 MEMORY.md） | 保留 TrieCode 记忆方案 |

---

## 六、Hub 架构（codelab 独有价值）

- **detached hub daemon**：core 可 spawn 独立守护进程（15s 发现窗口，冷启动超时上报 telemetry），多客户端 attach/detach 共享会话
- 事件跨 hub 转发保持流式边界：text/reasoning 增量、tool start/update/finish、agent done
- 客户端适配器：NodeHubClient / HubSessionClient / HubUIClient / connectToHub
- 会话记录含 root + aggregate 双桶用量，客户端可自主选择渲染口径
- **codelab 场景**：未来多窗口/局域网共享烧录会话、教师端查看学员会话可参考

---

## 七、Provider 层（llms 包）与杂项

- **llms**：catalog（模型目录/清单）+ providers（网关式 provider 注册）+ transcription（语音转写，TrieCode 也有 speech STT）+ `classifyProviderError`/`isRetryableProviderError`
- **cron**：定时 Agent（`cline schedule`）——codelab 可做"每日编译检查/自动烧录"
- **cloud/remote**：云端会话（远期）
- **extensions/config**：rules/workflows/skills/agents/hooks/plugins 全部文件发现 + watcher + slash 命令投影
- **插件系统**：`plugin.setup({agentId, role, systemPrompt})` → 注入 tools + hooks；marketplace 安装管理

---

## 八、对 codelab 的落地映射（修订深度报告 §8 三批路线）

### 第一批（1-2 周）——直接抄 Cline 的：
1. **Agent 循环骨架**：execute 的 maxIterations + turn 事件流 + resetLastError + finishReason 分流（代码级参考）
2. **三类恢复**：max-tokens nudge（文案可参考）/ provider 重试指数退避（abortableDelay 模式）/ 上下文溢出终端文案
3. **工具治理**：ToolPolicy{enabled, autoApprove} + requestToolApproval 回调 + TOOL_REJECTION_SUFFIX
4. **完成锚点**：submit_and_exit 模式（compile/upload 成功即"完成"）
5. **loop-detection**：toolCallSignature（sortKeys）+ 连续计数双阈值，装为 beforeTool hook

### 第二批（2-4 周）：
- Plan/Act/yolo 三模式切换（Cline mode 概念）
- subprocess-sandbox 包装 arduino-cli 编译/烧录
- checkpoint 文件回滚（TrieCode §13 + Cline checkpoint-diff 对照）
- file-indexer + @提及（编辑器联动）

### 完整形态（第三批）：
- spawn 子代理（Cline team + TrieCode subagent 对照）
- usage 双桶统计
- skills 教学技能（融合 Hermes 学习循环：自动沉淀"教过学员的问题"为可复用技能）
- 本地大模型 Provider（llms 包 catalog + Ollama）

---

## 附：精读轨迹与源码位置（可复查）

| 目标 | 位置 | 已提取要点 |
|---|---|---|
| 架构权威文档 | sdk/ARCHITECTURE.md | 四层职责、设计规则、六条设计接缝、Local/Hub/Remote 流程 |
| Agent 主循环 | sdk/packages/agents/src/agent-runtime.ts（2863 行） | execute 骨架、三类恢复、完成锚点、工具编排、hooks |
| 工具装配 | sdk/packages/core/src/runtime/orchestration/runtime-builder.ts | 内置工具清单、policy 过滤、MCP 加载、spawn |
| 安全护栏 | sdk/packages/core/src/runtime/safety/loop-detection.ts | 签名规范化+双阈值 |
| 会话/团队 | sdk/packages/core/src/session/{stores,team,checkpoint-*} | 存储/回滚/团队事件 |
| 用量 | sdk/packages/core/src/services/usage.ts | root/aggregate 双桶 |
| Provider | sdk/packages/llms/src/{catalog,providers,transcription} | 目录/网关/转写 |
| 获取通道 | doubao 浏览器 + api.github.com（页面内 fetch raw） | git 直连/镜像/raw 域名均不可达（网络限制） |

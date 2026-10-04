# TrieCode Agent 架构学习报告

> 学习对象：TrieCode v1.3.1（Arduino IDE with AI coding agent，Electron 应用，`C:\Program Files\TrieCode`）
> 学习方式：窗口界面走查 + 解包 `resources/app.asar` 源码研读（解包目录：`D:\工作\代码实验室\_triecode_learn\app`）
> 日期：2026-09-30
> 用途：为 codelab-desktop 的 AI 面板升级为完整 Agent 提供参考。仅供学习借鉴，不复制其版权代码。

---

## 一、产品定位与整体架构

**定位**：Arduino 专用 AI 编程 IDE —— "打开或创建一个项目，AI智能体将在这里**读写代码、执行命令、运行测试**"。

**技术栈**（package.json + 目录结构）：
- Electron + pnpm monorepo，`packages/` 分六个子包：`ai` / `core` / `engine` / `gRPC` / `main` / `preload` / `renderer`
- 关键依赖：`@modelcontextprotocol/sdk`（MCP 协议）、`serialport`（串口烧录）、`node-pty`（伪终端）、`@grpc/grpc-js`（gRPC，AI 服务通信）、`clangd.exe`（C/C++ LSP 语言服务器，50MB，内置）、`pdfjs-dist`、`turndown`
- **架构亮点**：`engine` 包是"唯一大脑"，纯 Node、零 Electron 依赖；桌面主进程和 CLI 消费同一套引擎（headless 化）

---

## 二、AI 包（packages/ai）—— 模型层

### 1. 四个核心 Prompt 模板（prompt-templates.js）

| 模板 | 用途 | 关键规则 |
|---|---|---|
| `codeCompletion` | 内联代码补全（幽灵文本） | 只输出补全文本，无解释无代码块；补 1-3 行；匹配现有风格；用 Arduino API（digitalWrite/analogRead/Serial…） |
| `codeGeneration` | 自然语言 → Arduino 代码 | 必须带 #include、必须有 setup()/loop()；指定开发板（如 ESP32）用对应 API；附"Required Libraries"清单 |
| `errorDiagnosis` | 编译错误诊断 | 用**简体中文**解释；指出要改的精确行；给出修正代码；提示缺失库 |
| `libraryRecommendation` | 库推荐 | 只推荐 Library Manager 真实库；说明为什么需要；已 include 的不重复；聚焦 1-3 个 |

### 2. 多模型提供商（provider-registry.js）

9 家：DeepSeek、通义千问、MiniMax、Kimi、OpenAI、Claude、**Ollama（本地）**、智谱 GLM、豆包。每个 provider 有 `defaultModel`、`baseURL`、`models[]`、`iconName`。

**思考模式分级**（modelConfig.thinkingLevels + thinkingParams，可服务端配置、无需改代码）：
- 例：deepseek-v4-pro → `fast`（thinking 关闭）/ `light`（enabled + effort low）/ `standard`（effort high）/ `deep`（effort max）
- 不同模型给不同档位（MiniMax-M3 只有 fast/standard，因为官方只有 adaptive/disabled 两态）

### 3. Provider 抽象层（ai-provider.js）工程细节

- **流式 usage 归一化**：兼容 OpenAI（total_tokens / prompt_tokens_details.cached_tokens）与 Anthropic（input_tokens / cache_read_input_tokens）两种字段口径；缓存 token 单独统计
- **流式读取超时宽限**：OpenAI 把 usage 放在 finish_reason 之后的独立 chunk，拿到 finish_reason 后再等一小段收 usage，超时放弃该次读（防挂起）
- **max_tokens 按模型解析**：用户显式配置 → 官方规格表 → 保守默认 32768（gpt-4o 官方上限 16384，写死 32768 会被上游 400）
- **工具调用参数完整性校验**：JSON.parse 失败 → incomplete；required 参数缺失 → incomplete（防空参执行写空文件）
- **流式空闲超时 5 分钟看门狗**：长时间无数据才 abort（深度思考可停顿数分钟，60s 硬超时会误杀）
- **错误分类**：transient/deterministic，附加 HTTP status + Retry-After，支持退避重试

### 4. 模型规格表（core/model-specs.js）

单一来源保存每个模型的 contextWindow / maxInput / maxOutput。**数据纪律**：每个数字必须有厂商官方一手来源（注释里逐条列了官方文档链接）；查不到宁可不写（不写只回落保守兜底并打一次告警）。

---

## 三、Engine 包（packages/engine）—— Agent 大脑

### 1. Agent 主循环（agent-runner.js，108KB）

统一 turn 循环，通过依赖注入收敛两套历史实现：

```
callModel（调模型）→ 解析 toolCalls → executeTool（执行工具）→ 收集结果 → 循环
awaitDecision（工具需确认时等用户 approve/reject/feedback）
isCancelled（取消传播）
```

**关键护栏机制**：
- **验证命令判定**（isVerificationCommand）：链式命令按 `&&`/`||`/`;` 拆分，任一段命中 test/build/compile/run/lint 等关键词才算真验证；`cd x && ls` 不算。排除 ls/cat/grep/sed 等纯列举命令，防模型用无关命令冒充验证
- **中性工具 vs 状态变更工具**：read/search/lsp/git 只读类算中性（成功不算进展信号），防 read 反复清零卡死计数
- **进度判定**：terminal 里跑只读命令（ls/cat/git log）不算实质进展；npm install / git commit / 构建才算
- **验证硬闸门**：收尾时"改了没验证"会被连续追问，上限 2 次后放行（防死循环）
- **todo 提醒**：距上次提醒 ≥10 轮才再提醒；单轮划掉 ≥3 项未验证 → 提醒验证
- **轮次上限自我延长**：剩 5 轮时评估，往前 10 轮内有实质进展 → 延长 20 轮
- **上下文超限重试**：识别 context_length 类错误 → 压缩后重试，而非直接抛
- **子代理报告渲染**：结构化卡片（只截断展示，模型看到的 text 仍是全文）

### 2. 只读子 Agent（subagent.js）—— 最有借鉴价值

**安全设计（三层防线）**：
1. **工具白名单**：显式 `READ_ONLY_TOOLS` Set —— 只给读文件/搜索/LSP 符号/git 只读/web 只读/本地知识类
2. **运行时只读硬门**：模型若幻觉输出白名单外工具调用，执行器直接拒绝返回错误（不依赖模型自觉）
3. **行为约束**：system prompt 声明"只读、不编辑、不跑终端"，请求写操作就明确拒绝；无证据就写「无」，不编造文件路径

**为什么显式列工具名而不是按 category 过滤**：MCP 工具的 per-tool allow 规则可能让任意工具变成 query 类，且 autoApprove 下有名字正则启发式（`get_*` 的写工具可能被判只读）——按名字硬白名单防边界击穿。

**结构化报告格式**（父级 agent 依赖此结构行动）：
```
## 结论摘要（2-4 句话）
## 发现（编号：结论 — 相对路径:行号 — 证据）
## 涉及文件（去重路径列表）
## 未决问题（写「无」）
## 置信度（高/中/低 + 理由）
```
- 报告控制 600-800 字；返回父级截断 4000 字符
- maxTurns 收紧到 6；onStream 静默（不污染渲染层）；取消共享父级 cancelRef
- system prompt 按 (workspace, model) 缓存 → 命中 provider 缓存

**有意排除清单**（看着只读但不能给，注释里解释了原因）：
- `open_project`（改共享状态+发事件）、`ask_user`（不打断用户）、`task`（嵌套放大）、`todo_write`/`submit_plan`（状态副作用）
- `analyze_image`/`read_pdf`（**产生真实积分消耗**，后台委派不该静默花钱）
- `plugin_market_search`/`search_sessions`（跨会话发现类，不属代码库调查）

### 3. 循环预算（loop-engine.js）—— BudgetTracker 五类预算

- 迭代次数 / token 用量 / 成本(USD) / 墙钟时长 / **无菌动作**（同一 tool+参数重复，阈值默认 4）
- **actionKey**：tool + JSON 参数（字符串 trim + 超长 200 字符后 hash 化）——防"加换行再试"绕过无菌检测；write_file 大 content 不污染 Map
- 停止判定固定优先级：iterations → tokens → cost → wallTime → sterile（确定性升级原因）

### 4. 模型族分档引导（prompt-core.js）

按模型族（claude/gemini/deepseek/qwen/gpt/default）注入**只补该族易错点**的引导块，不重复整套系统提示：
- Claude 系强模型已内化行为 → 空（不浪费 token）
- DeepSeek（推理模型）→ "长思考后必须运行验证并引用真实输出；工具调用间文本 ≤25 词"
- Qwen/GLM/Kimi 等 agentic 训练较新 → 显式负面护栏 + 反幻觉 + 让计划可见
- GPT → 禁止破坏性 git 命令、不要覆盖用户未提交改动
- **强模型判定**：正则词边界 + 小参数变体排除（`gpt-4.1-mini`/`claude-haiku` 不算强档，它们最需要完整护栏）

### 5. 上下文管理（context-manager.js）—— 三级降载

0. **snip 层**：零成本删除"空结果工具回合"（纯噪音，call+result 成对删）
1. **Prune 旧工具结果**：只压缩保护边界（最近 N 个用户轮次）之前的超长 tool 输出，按工具价值分级 + 最旧半区时间衰减（无损、零 LLM 调用）
2. **折叠最旧轮次为摘要**（默认启发式，可注入 LLM summarize）

- 上下文预算默认 30k（留输出空间）；模型规格表驱动，未收录模型保守兜底 + 一次性告警
- token 估算：CJK≈1字/token，拉丁≈4字符/token，符号≈2字符/token

### 6. 其他引擎模块

| 模块 | 功能 |
|---|---|
| `verification-agent.js` | 独立验证代理（复用 isVerificationCommand 判定） |
| `permission-policy.js` / `permission-rules.js` | 工具权限策略与规则 |
| `terminal-exec.js`（20KB） | 终端执行（node-pty），只读命令分类器 |
| `plan-store.js`（13KB） | 计划存储（PLAN 门控：先计划再执行） |
| `memory.js` / `auto-memory.js` | 记忆系统（20KB+10KB） |
| `file-change-tracker.js`（34KB） | 文件变更追踪 |
| `session-store.js`（13KB） | 会话存储 |
| `web-tools.js`（43KB） | Web 搜索/抓取工具（net-guard 防内网/私网地址） |
| `cron.js` / `schedule-store.js`（50KB） | 定时任务调度 |
| `ask-user.js` | 用户询问交互 |
| `speech.js` / `vision.js` / `pdf.js` | 多模态（语音/识图/PDF） |

---

## 四、UI 与交互设计（窗口走查）

### 欢迎页（右侧 Agent 能力面板）

- 定位文案："打开或创建一个项目，AI智能体将在这里读写代码、执行命令、运行测试"
- 三个入口：新建项目 / 打开项目 / 克隆项目；下方"最近打开"列表

### 主 Agent 报告结构（用户可见）

```
发现：找到的关键信息
涉及文件：具体的文件:行号证据
未决问题：无法确定的地方
置信度：对结论的确信程度
```

### 子 Agent（task）场景引导

**代码维护类**：
- 批量重构：所有调用旧 API 的地方改成新 API，列出需要改的文件和行号
- 安全审计：检查所有 SQL 拼接、eval 调用、未授权的 system() 调用
- 死代码检测：找出所有定义了但从未被调用的函数
- 接口追踪：追踪 user_id 参数在哪些文件间传递，最终被用在哪里

**代码理解类**：
- 新项目上手：快速了解项目技术栈、目录结构、主要模块作用
- Bug 溯源：用户反映支付失败，分析 payment/ 目录找出可能的失败点
- 依赖分析：列出所有外部依赖和使用频率
- 协议解析：分析自定义协议的帧格式和状态机

### 消耗可视化

- 每轮显示：`输入 24.1k · 输出 601 · 思考 98 · 消耗 0.88 积分`
- 状态显示：`已工作 16s 思考`

### 真实案例教学（欢迎页内置）

> 假设项目报错 `TypeError: Cannot read property 'map' of undefined`，你不知道哪里的问题：
> 让子 Agent 检查所有使用 `.map()` 的地方，列出可疑位置（文件:行号）；主 Agent 再针对性地加 `?.map()` 或 `if (arr) map(...)` 修复。

展示了"**子 Agent 定位 + 主 Agent 修复**"的分工模型。

---

## 五、对 codelab-desktop 的落地建议

### 短期（低成本，直接可用）
1. **Agent 报告结构化**：AI 面板输出改为 结论摘要/发现（带文件:行号）/未决问题/置信度 四段式，提升可信度
2. **场景快捷指令**：内置 6-8 个一键 prompt（分析当前代码/解释这个错误/推荐库/生成 README/检查死代码/批量重构），带示例
3. **消耗展示**：显示本次对话的输入/输出 token 数和耗时（我们已有内置 llama.cpp + 自定义模型，成本可视化很有价值）
4. **编译错误中文诊断**：已有 arduino-cli 编译流程，把 stderr 交给模型做错误诊断（错误信息+源码上下文 → 中文解释+修复代码+精确行号）

### 中期（借鉴子 Agent 模式）
5. **只读分析子任务**：把"分析项目/解释代码/找 bug 位置"类请求隔离成只读子任务（工具白名单：读文件+搜索），返回结构化报告后再由主对话展示——安全且省 token
6. **验证闭环**：模型改完代码后，提示"运行验证"（我们对应：编译/烧录）；未验证不宣称成功
7. **上下文预算**：长对话按 token 估算自动折叠旧轮次（CJK 估算公式可直接用）

### 长期（架构级）
8. **Engine 与 UI 分离**：把 Agent 循环（无 Electron 依赖）独立成纯 Node 模块，桌面版与将来的 CLI/Tauri 版共用
9. **权限策略**：写文件/执行命令前按权限规则确认（我们已偏向真实烧录，权限确认是安全底线）
10. **计划门控**：复杂任务先产出计划、用户确认后再执行

---

## 六、关键文件索引（解包源码，仅学习参考）

```
D:\工作\代码实验室\_triecode_learn\app\
├── packages\
│   ├── ai\dist\
│   │   ├── prompt-templates.js        # 4 个核心 Prompt
│   │   ├── provider-registry.js       # 9 家模型提供商
│   │   ├── ai-provider.js             # Provider 抽象层（29KB）
│   │   └── error-classification.js    # 错误分类
│   ├── engine\dist\
│   │   ├── agent-runner.js            # Agent 主循环（108KB）
│   │   ├── subagent.js                # 只读子 Agent（核心借鉴）
│   │   ├── loop-engine.js             # 预算追踪（无菌检测）
│   │   ├── context-manager.js         # 上下文压缩
│   │   ├── prompt-core.js             # 模型族分档
│   │   ├── verification-agent.js      # 验证代理
│   │   ├── plan-store.js              # 计划存储
│   │   ├── permission-policy.js       # 权限策略
│   │   └── ...                        # 完整引擎模块清单见上文
│   └── core\dist\
│       ├── model-specs.js             # 模型规格表
│       └── ...
```

> 注：`_triecode_learn` 为本地解包学习目录，仅作技术参考；TrieCode 为商业闭源软件，产品代码与文案不得直接复制进交付物。

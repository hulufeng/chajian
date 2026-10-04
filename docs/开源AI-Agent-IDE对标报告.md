# 开源 AI Agent IDE 对标报告（Cline / OpenHands / OpenCode / cc-switch）

> 日期：2026-10-01 ｜ 性质：GitHub 生态检索，对标 TrieCode / TraeCode 的开源 AI Agent IDE
> 用途：为 codelab-desktop AI 面板落地提供**可合法参考/引入**的开源实现（TrieCode 闭源只能解包学习，以下项目多数为宽松许可）
> 关键结论先行：**cline/cline 是 TrieCode Agent 的开源镜像（Apache-2.0，商业可用）**，其 SDK/Plan-Act/权限审批/多 Agent/本地模型支持，与 codelab AI 面板需求高度重合

---

## 一、四个核心对标项目总览

| 项目 | Stars | 许可 | 形态 | 与 TrieCode 的相似度 |
|---|---|---|---|---|
| **cline/cline** | 69.6k | **Apache-2.0** ✅ | IDE 扩展（VS Code/JetBrains）+ CLI + 桌面 App + **SDK** | ★★★★★ 最像：自主 Agent + 审批 + Plan/Act + 子代理 |
| **OpenHands/OpenHands** | 89.6k | MIT ✅ | AI 驱动开发平台（Web/CLI/SDK） | ★★★★ 全自动 Agent 引擎 + 事件流架构 |
| **anomalyco/opencode** | 211k | MIT（待确认）✅ | 终端编码 Agent（TUI/headless） | ★★★ Agent 循环 + 会话管理 |
| **farion1231/cc-switch** | 139k | Apache-2.0 ✅ | 桌面 All-in-One AI 助手聚合器（Rust+Tauri） | ★★ 多 Agent 客户端聚合 + **Provider 管理**（对"集成所有内置 token"直接参考） |
| **NousResearch/hermes-agent** | ~250k | MIT ✅ | 服务器常驻自学习 Agent（CLI/Dashboard/云） | ★★★★ 学习循环（自生成 skill 复用）+ 跨会话记忆 |

> 备注：TrieCode 本体为商业闭源（Arduino IDE + AI coding agent），已在 `docs/triecode-agent-全链路深度报告.md` 完成源码级学习；本报告聚焦**可合法落地的开源对标**。

---

## 二、Cline 深挖（与 TrieCode 对照）

### 2.1 产品形态（四种形态共享同一 Agent 引擎）

| 形态 | 技术栈 | 说明 |
|---|---|---|
| SDK | Node.js | `@cline/sdk` 程序化 Agent API，插件/工具/多 Agent 注册 |
| CLI | Node | TUI + headless（CI/CD JSON 输出）+ shell 命令 |
| VS Code 扩展 | TypeScript | 市场扩展 + extension host 集成（**人审审批循环**） |
| 桌面 App | **Tauri shell + Bun sidecar + Next.js UI** | macOS/Windows 原生应用（与 codelab Electron 类似但更轻） |

### 2.2 核心机制与 TrieCode 对照

| 能力 | Cline 实现 | TrieCode 对应（深度报告章节） | codelab 落地建议 |
|---|---|---|---|
| **Plan / Act 双模式** | Plan 探索代码库+提问+出策略；Act 执行，**每个文件编辑/命令需审批**；可 auto-approve 全自动 | §15 renderer 审批四态 / §5 权限 pipeline | ✅ 直接抄这个交互模型 |
| **权限审批** | human-in-the-loop approval（允许一次/会话/自动） | §12 permission-rules deny>ask>allow | ✅ 落地第一批 |
| **跨文件编辑** | 读项目结构→协调改动→**diff 可审查/修改/回滚**+checkpoints | §13 file-change-tracker Turn 级回滚 | ✅ |
| **命令执行** | 终端实时输出、后台进程（dev server 持续监听编译错误/测试失败/崩溃） | §11 terminal 后台进程 / §18 SerialLogService | ✅ 编译/烧录用这个模式 |
| **规则与技能** | `.clinerules` 项目规则自动加载；skills 按需加载模型规则 | §10 SYSTEM_CONTEXT_SOURCES projectInstructions/skills | ✅ |
| **多模型 Provider** | Anthropic/OpenAI/Gemini/OpenRouter/Bedrock/Azure/Groq/**Ollama/LM Studio 本地**/OpenAI 兼容 | §19 provider-registry 9 家 | ✅ **本地大模型路线对齐** |
| **插件系统** | SDK 注册工具+生命周期钩子（日志/审计/策略/领域能力） | §2.7 Arduino 插件 manifest 20 工具 | ✅ 烧录工具做成插件 |
| **MCP** | `cline mcp` 管理服务器、自定义工具 | §19 插件引用、gRPC daemon | ✅ |
| **多 Agent 团队** | coordinator 分解→专家 agent 各自工具+上下文，状态跨会话持久 | §5 subagent 只读白名单 / verification-agent | ⏳ 完整形态 |
| **定时 Agent** | `cline schedule create --cron` 周期自动化 | （TrieCode 无） | 可做"每日编译检查" |
| **消息平台** | Telegram/Slack/Discord 对话映射 agent 会话 | （无） | 远期 |

### 2.3 许可证结论（重要）

- **Apache-2.0**：商业闭源产品可自由使用/修改/再分发，仅需保留版权声明 + 修改说明。**codelab 可以合法引入其代码/借鉴架构**（与 TrieCode 解包只读、velxio AGPL 不可用形成对比）。
- 落地方式建议：不整体引入（Cline 是通用代码 Agent，codelab 是嵌入式教学 IDE），而是**选择性参考其 SDK 架构 + Plan/Act 交互 + 权限审批实现**，自研嵌入式专属 Agent 层。

---

## 三、OpenHands 概览

- **形态**：AI 驱动开发平台，Web UI + CLI + SDK（Python `software-agent-sdk`）
- **核心**：Agent 事件流架构（observation/action 事件总线），技能系统，云 IDE 沙箱（Docker）
- **对 codelab 价值**：其 **Agent 事件流模型**（所有动作/观察事件化、可回放、可审计）与 TrieCode 的 workLog 步骤卡片（§15）是同一思路，可参考其事件数据结构
- 许可：MIT ✅

---

## 四、OpenCode 概览

- **形态**：终端原生编码 Agent（TUI），headless 模式输出 JSON 事件流
- **对 codelab 价值**：轻量 Agent 循环 + 会话存储 + 工具注册，可作为"codelab 终端模式"参考（教学场景让学员在终端里用 Agent 学 Arduino）
- 许可：MIT（按 README 标注，待最终确认 LICENSE 文件）

---

## 五、cc-switch 深挖（针对"集成所有内置 token"）

- **形态**：Rust + Tauri 桌面应用，跨平台 All-in-One 管理 Claude Code / Codex / OpenCode / OpenClaw / Grok Build / Hermes Agent
- **能力**：Provider 管理（模型切换/API key 配置）、Skills 管理、MCP 配置、多 Agent 客户端聚合、WSL 支持
- **对 codelab 价值（直接命中用户此前问题"能不能集成所有内置 token"）**：
  - 桌面软件内统一管理多家模型 Provider 的 API key / base URL / 模型列表——codelab AI 面板（本地大模型 + 自定义模型 + 云端模型）的 Provider 管理 UI 可参考其交互
  - Tauri 技术栈与 codelab Tauri 轻量版一致
- 许可：Apache-2.0 ✅

---

## 五之二、Hermes Agent 深挖（NousResearch/hermes-agent，用户点名补充）

### 基本信息
- 官方仓库：`NousResearch/hermes-agent`（hermes-agent.ai / docs.hermes-agent.nousresearch.com）
- 许可：**MIT** ✅（商业可用）
- 出品：Nous Research（Hermes/Nomos 模型家族实验室，模型训练方做 Agent）
- Stars：约 25 万（2026-09-27 第三方统计，为增长最快的开源 Agent 之一）
- 形态：**服务器常驻型 Agent**（不是 IDE 扩展）——CLI / Dashboard / 云三种界面，Linux/macOS/WSL2，一条 curl 命令自动装依赖（Python/Git），24/7 常驻

### 核心差异化：学习循环（Learning Loop）
| 机制 | 说明 | 与 TrieCode 对照（深度报告） |
|---|---|---|
| **自生成 Skill** | 完成复杂任务后把流程写成 skill 存盘，下次遇到相似任务自动复用 | TrieCode auto-memory（§17，Jaccard 0.7 去重）是记忆层；Hermes 是**技能层自进化**，更进一步 |
| **跨会话记忆** | 记住持久事实（用户画像/项目偏好）并在后续会话注入 | TrieCode memory 库（MEMORY.md+slug 文件，§17）同思路 |
| **自提示持久化** | 主动"提醒自己"保存知识，构建跨会话的用户模型 | TrieCode 无此显式机制 |
| **渠道接入** | Telegram/Discord/邮件等消息平台对话映射 agent 会话 | TrieCode 无；Cline 有 connect 命令 |
| **定时任务** | scheduled jobs（每日总结/监控） | TrieCode 无；Cline 有 `cline schedule` |

### 对 codelab 的价值评估
1. **教学场景契合度高**：codelab 是"教用户学 ESP32 开发"，如果 AI 助手能把"排查某类编译错误/接线问题"的流程自动沉淀成可复用 skill，学员学过的内容可跨会话复用——这是**教学级 Agent 的杀手锏功能**，可作为 codelab AI 面板完整形态（第三批）的核心差异化
2. **Provider 灵活**：Nous Portal / OpenRouter / OpenAI / 任意端点——与 codelab"本地大模型+自定义模型"路线一致
3. **MIT 可引入**：学习循环（skill 生成+复用）的具体实现可直接读源码参考
4. **注意**：Hermes 是通用服务器 Agent，非嵌入式/教学 IDE 形态；codelab 应取其**学习循环机制**，而非整体架构

---

## 六、落地建议（延续深度报告 §8 三批路线）

1. **第一批（1-2 周）直接参考 Cline 实现**：权限审批交互（允许一次/会话/自动）+ Plan/Act 切换 + 编译命令工具化（Cline 命令执行模式）+ 串口日志（后台进程监听模式）
2. **第二批**：Agent 事件流（OpenHands 数据结构参考）+ 上下文压缩（TrieCode §17 + Cline 对照）+ 失败恢复 + 反幻觉
3. **Provider 管理**：参考 cc-switch 做 codelab 的"模型 Provider 中心"（本地 Ollama/自定义 API/内置 token 统一管理）
4. **完整形态**：多 Agent 团队（Cline SDK + TrieCode subagent 对照）+ 计划模式 + 验证代理

---

## 附：检索轨迹与链接

- cline/cline：https://github.com/cline/cline （Apache-2.0，SDK/CLI/Desktop/VS Code/JetBrains 四形态）
- OpenHands/OpenHands：https://github.com/OpenHands/OpenHands （MIT）
- anomalyco/opencode：https://github.com/anomalyco/opencode （211k★）
- farion1231/cc-switch：https://github.com/farion1231/cc-switch （Apache-2.0，Rust/Tauri）
- NousResearch/hermes-agent：https://github.com/NousResearch/hermes-agent （MIT，自学习循环；Stars 数据为第三方统计 hermesatlas.com 2026-09-27，官方仓库待 API 复核）
- 检索方式：GitHub MCP search_repositories（本轮因语义搜索噪音，改用精确项目名检索命中）
- 对照基准：docs/triecode-agent-全链路深度报告.md（20 章，TrieCode 闭源解包学习）

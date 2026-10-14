// Agent 主循环：状态机 + 工具调度 + SSE 流式解析
// 对齐 TrieCode agent-runner.js 核心机制：预算护栏 / 工具失败恢复 / 验证证据闸门
import { toolRegistry } from './tool-registry'
import { coreTools } from './tools'
import { PermissionPolicy } from './permission-policy'
import { aiChatStream, getAiState, setLocalModel, resolveLocalModelForRun } from '../services/aiGateway'
import { searchKnowledge, knowledgeCount } from '../ai/knowledgeBase'
import { detectFirmwareProject, loadProjectConfigBlock, FIRMWARE_RULES_BLOCK, type FirmwareDetection } from './project-config'
import { buildProjectContext } from './project-context'
import { findToolchain, listConnectedBoardsWithSerial } from '../services/toolchain'
import { listMemory } from '../services/memoryService'
import { buildTodosSection as buildTodosSectionFor, loadTodos as loadTodosFor } from './tools/todo-tools'
import { listSkills } from '../services/skillService'
import { newToolTiming, makeTimingAuditMiddleware, makeSlowToolMiddleware, type ToolTiming } from './tool-observers'
import { makePreToolUseHookMiddleware, makePostToolUseHookMiddleware } from './hooks'
import { autoSaveMemory } from './auto-memory'
import { actionKey, SterileGuard } from './loop-guard'
import type {
  AgentRunOptions, AgentStatus, AgentStats, ToolCall, ConfirmRequest, ToolContext, ToolResult, ToolDefinition
} from './types'

// 注册核心工具
toolRegistry.registerAll(coreTools)

// ── 预算护栏 ──────────────────────────────────────────────
const MAX_WALL_TIME_MS = 120 * 60 * 1000 // 120 分钟墙钟上限
const BUDGET_WARN_RATIO = 0.75 // 75% 时提前提醒收尾
const PARALLEL_LIMIT = 5 // 单个并发批的最大工具数（对齐 TrieCode PARALLEL_LIMIT，防一次性打满 IO/进程）

// ── 工具失败恢复 ──────────────────────────────────────────
const TRANSIENT_PATTERN = /timeout|超时|timed ?out|econnreset|etimedout|econnrefused|fetch failed|network|网络|rate ?limit|429|temporar|暂时|服务器繁忙|overload|过载|502|503/i
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_BACKOFF_MS = 1200

// ── 验证证据闸门 ──────────────────────────────────────────
// verify（Verifier 子智能体）与 closed_loop（编译→烧录→观察→修复闭环）内部都真跑了编译/测试/烧录，
// 因此同样算"验证动作"——否则主 agent 用 verify 验证后仍会被闸门反复催促。
const VERIFICATION_TOOLS = new Set(['run_command', 'execute_command', 'terminal', 'run_tests', 'compile', 'upload', 'build', 'test', 'verify', 'closed_loop'])
const VERIFICATION_COMMANDS = /\b(test|build|compile|run|npm\s+(test|run|build)|pytest|go\s+test|cargo\s+test|python\s+-m\s+pytest|arduino-cli\s+(compile|upload))\b/i

// ── 进展闸（对齐 TrieCode isActionProgress / lastProgressTurn / noProgressRounds）──
// 为什么需要：纯读取/搜索类工具的成功**不算实质进展**。若不区分，模型卡在"反复 read/search 探索"或
// "变参失败循环"里时，每轮都有"成功的工具调用"→ 进展计数永不触发 → 一路跑到 maxTurns 才停。
// 只有真有副作用/状态变更的动作（写文件/编译/烧录/装库/提交…）或 terminal 里非只读命令才算进展。
const PROGRESS_NEUTRAL_TOOL_RE = /^(read_file|list_files|list_dir|search_content|search_files|find_files|code_symbols|lsp_|read_diagnostics|git_status|git_diff|git_log|git_show|web_search|web_fetch|analyze_image|read_pdf|list_memories|recall_memory|skill_list|read_skill|list_skills|list_plugins|plugin_market_search|mcp_tools|mcp_list_servers|search_sessions|schedule_list|todo_list|board_list|board_detect|platform_list|project_overview|ask_user|set_agent_mode|list_background_tasks|get_task_status|arxiv_search)/i
const READONLY_CMD_RE = /^(ls|dir|cd|pwd|echo|cls|clear|git\s+(status|log|diff|branch|show)|tasklist|netstat|where|type|more|cat|tree|help|ver|grep|find|findstr|rg|sed|awk|head|tail|wc|sort|uniq|cut|tr|diff|strings|which|whoami|date|set|export|mkdir|md)\b/i
/** 这次工具调用是否**真的推进了任务**（比"成功"严一档：terminal 还要看命令是否只读） */
function isActionProgress(name: string, args: Record<string, unknown>): boolean {
  if (PROGRESS_NEUTRAL_TOOL_RE.test(String(name || ''))) return false
  if (name === 'terminal' || name === 'execute_command' || name === 'run_command') {
    const cmd = String(args?.command || args?.cmd || args?.script || '').trim()
    if (!cmd) return true // 无命令参数的工具类 terminal 视为有动作
    // 链式命令按分隔符拆段，任一段非只读即算进展（`cd x && ls` 仍不算）
    const segs = cmd.split(/&&|\|\||[;|&]/).map((s) => s.trim()).filter(Boolean)
    return segs.some((seg) => !READONLY_CMD_RE.test(seg))
  }
  return true
}
const NO_PROGRESS_LIMIT = 3   // 连续多少轮无实质进展 → 注入"换策略/问用户"
const EXTEND_LOOKAHEAD = 5    // 距 maxTurns 还剩几轮时评估自延长
const EXTEND_BY = 20          // 每次延长轮数
const PROGRESS_WINDOW = 10    // 往前看多少轮内有过实质进展才算"还在干活"
const MAX_TURN_EXTENSIONS = 3 // 自延长次数上限（防失控）

// ── 工具并发调度（对齐 TrieCode）：
// - SERIAL_EXCLUDES：出现在该名单中的工具，不管是否声明 concurrencySafe，都必须严格串行、一个个来，不能并发
// - concurrencySafe=true 且不在 SERIAL_EXCLUDES 且 category=read/query 的同类型工具，可以合并一批并发执行
const SERIAL_EXCLUDES = new Set([
  'read_file', 'write_file', 'edit_file', 'create_file', 'create_project',
  'terminal', 'execute_command',
  'ask_user',
  'compile', 'build', 'upload', 'closed_loop', 'run_tests', 'test', 'verify',
  'submit_plan',
  'board_detect',
  'todo_write', 'todo_update', 'save_memory', 'create_skill', 'save_skill',
  'git_commit', 'git_checkout', 'git_merge', 'git_reset', 'git_stash',
  'browser_navigate', 'browser_click', 'browser_type',
  'burn_firmware',
  'set_target',
  'set_schedule', 'update_schedule',
  'run_closed_loop',
  'install_arduino_library', 'uninstall_arduino_library',
  'create_background_task', 'stop_background_task',
  'dispatch_task', 'cancel_task',
  'install_plugin', 'uninstall_plugin',
  'web_fetch',
  'create_project_wizard'
])

/**
 * 某个工具能否进并发批（对齐 TrieCode，但默认值按 category 推）。
 *
 * 为什么不全靠 `concurrencySafe` 显式声明：实测下来全仓没有工具声明过这个字段，
 * 结果 canParallel 恒 false、PARALLEL_LIMIT 形同虚设。改成
 * 「未显式声明时，read/query 类默认可并发；写类/交互类一律串行」，
 * 既让限流真正生效，又保留 `concurrencySafe: false` 的显式否决权，
 * 并且 SERIAL_EXCLUDES 仍然是不管怎么声明都必须串行的硬名单。
 */
export function isConcurrencySafe(name: string): boolean {
  if (SERIAL_EXCLUDES.has(name)) return false
  const def = toolRegistry.get(name)
  if (!def) return false // 未知工具保守串行
  if (def.concurrencySafe !== undefined) return def.concurrencySafe === true
  return def.category === 'read' || def.category === 'query'
}

// ── 教学问答模式（知识库命中 + 纯疑问句）───────────────────
// 与 detectRequiredTools 的疑问句豁免同口径：疑问句特征词，且无"帮我/请/现在"等祈使操作词
const TEACHING_QUESTION_RE = /(是什么|为什么|怎么办|怎么读|怎么做|怎么用|如何|区别|介绍|讲讲|说明|吗$|呢$|？$|\?$)/
const TEACHING_IMPERATIVE_RE = /(帮我|请|立刻|马上|现在|麻烦|快点|打开|读取|写入|修改|运行|执行|创建|发送|输入|调用|查一下|看看)/
function isTeachingQuestion(text: string): boolean {
  return TEACHING_QUESTION_RE.test(text) && !TEACHING_IMPERATIVE_RE.test(text)
}

// ── 修改类对话模式（无工具单轮，输出修改后完整代码块）───────────────────
// 本地 3B 模型工具决策弱 + 安全确认链路体验差（对照豆包实测 T3 123s 无产出），
// 修改类请求走"空工具集对话"，模型直接输出修改后完整代码，用户点"应用到文件"写入。
// 判定：祈使修改动词命中，且不是纯疑问句（怎么/如何/为什么）。
const MODIFY_VERB_RE = /(修改|改成|换成|改一下|改一改|优化一下|改改|加个|加上|添加|重写|重构|把[^，。？?\n]*?(?:改成|改为|变成|调成|加上|去掉|删除|换成))/
const MODIFY_QUESTION_RE = /(怎么|如何|为什么|是什么|哪些|注意什么|区别|原理|技巧|方法)/
function isModifyRequest(text: string): boolean {
  return MODIFY_VERB_RE.test(text) && !MODIFY_QUESTION_RE.test(text)
}
const FILE_MODIFY_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'fs:writeFile', 'write'])
const MAX_VERIFY_PROMPTS = 2 // 验证追问上限（防死循环）

// ── 确认超时 ──────────────────────────────────────────────
const CONFIRM_TIMEOUT_MS = 120 * 1000 // 用户确认弹窗最长等待 120 秒，超时自动拒绝并提示

// ── 上下文压缩 ────────────────────────────────────────────
const MAX_MESSAGES_BEFORE_COMPRESS = 40 // 消息数超过此值触发压缩
const COMPRESS_KEEP_RECENT = 15 // 保留最近 N 条消息
const MAX_TOOL_RESULT_CHARS = 2000 // 单条工具结果截断长度
// B3 最近读文件重注入（对齐 TrieCode：压缩后把模型读过/写过的关键文件摘要补回来，防止失忆重读）
const MAX_RECENT_FILES = 8 // LRU 容量：最多记住最近 N 个文件
const RECENT_FILE_MAX_BYTES = 8192 // 单文件最多记住前 8KB 完整内容（压缩时只展示前 1200 字符，其余留作潜在复用）
const RECENT_FILE_REINJECT_CHARS = 1200 // 压缩回填时单文件展示前 N 字符
// 主动水位（对齐 TrieCode：大窗口在 65% 时提前无损剪裁旧工具输出）
// 只按消息条数判断不够——一条编译日志就能顶 20 条短消息，条数没到但上下文已经爆了。
const CONTEXT_TOKEN_BUDGET = 128000 // 上下文预算（token）
const CONTEXT_WATERMARK = 0.65 // 达到预算的 65% 即触发剪裁/压缩
const CHARS_PER_TOKEN = 3 // 字符→token 粗估系数（中英混排取保守值）

// 失败分类
function classifyFailure(text: string): 'transient' | 'deterministic' | 'unknown' {
  if (TRANSIENT_PATTERN.test(text)) return 'transient'
  if (/error|failed|失败|exception|拒绝|denied|not found|不存在|permission/i.test(text)) return 'deterministic'
  return 'unknown'
}

function failureHint(kind: string): string {
  switch (kind) {
    case 'transient': return '网络/超时/服务不可用类错误，可稍后重试'
    case 'deterministic': return '参数/路径/权限/编译类错误，需诊断根因后换方式'
    default: return '未知错误，请检查完整错误信息'
  }
}

function isToolFailure(text: string): boolean {
  return /^Error:|^错误:|失败|failed/i.test(text)
}

function summarizeFailure(text: string): string {
  const firstLine = text.split('\n')[0] || text
  return firstLine.slice(0, 120)
}

export class AgentRunner {
  private status: AgentStatus = 'idle'
  private messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = []
  private stats: AgentStats = { turns: 0, toolCalls: 0, startTime: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 }
  /** 工具耗时累计（由 tool-registry 的中间件写入，getStats 时并入 stats） */
  private toolTiming: ToolTiming = newToolTiming()
  private maxTurns = 20
  private projectRoot: string | null = null
  private firmware: FirmwareDetection | null = null
  /** 项目上下文（启动时确定性扫描一次，注入系统提示，减少探索性工具调用） */
  private projectContext = ''
  private thinkingLevel: 'light' | 'standard' | 'deep' = 'standard'
  private debugMode = false
  private pendingConfirm: ConfirmRequest | null = null
  private confirmResolve: ((action: string) => void) | null = null
  private stopped = false
  private onEvent: (event: { type: string; data?: unknown }) => void
  // 每个 Agent 会话持有独立的安全策略实例，避免调度任务/交互会话互相污染全局单例
  private policy = new PermissionPolicy()
  private confirmTimer: NodeJS.Timeout | null = null

  // ── 预算护栏状态 ──
  private sterileGuard = new SterileGuard() // 无菌动作检测（键含参数归一化，见 loop-guard.ts）
  private budgetHinted = false
  private wallStart = 0

  // ── 工具失败恢复状态 ──
  private failedTools = new Map<string, number>() // 工具名 → 连续失败次数
  private failureLedger = new Map<string, string>() // 工具名|参数键 → 首次失败原因
  private denialHits = new Map<string, number>() // 工具名 → 用户拒绝次数

  // ── 验证证据闸门状态 ──
  private lastFileModTurn = -1
  private lastVerifyTurn = -1
  // 强验证轮次（对齐 TrieCode：只有真的跑了 compile/upload/run_tests 命令才算，ls/pwd/echo/纯占位不能冒充）
  private lastStrongVerifyTurn = -1
  private verifyPromptCount = 0
  /** wrap-up 收尾总结是否已尝试（对齐 TrieCode：模型空收尾时追加"请总结"并空工具集重调一次） */
  private wrapupTried = false
  /** 工具强制重试计数（任务明确要求工具、模型却纯文本回复时的强制引导次数，上限 2，真实调用后清零） */
  private forcedToolRetries = 0

  // ── 进展闸状态（对齐 TrieCode）──
  private lastProgressTurn = -1      // 最近一次「实质进展」的轮次（纯读取不算）
  private noProgressRounds = 0       // 连续无实质进展的轮数
  private turnProgress = false       // 本轮是否有实质进展（每轮开头重置）
  private turnsExtended = 0          // 轮次天花板自延长次数（设上限防失控）

  // ── 上下文压缩状态 ──
  private compressed = false
  private recentReadFiles = new Map<string, string>() // path → 截断内容（最近读文件重注入）

  // ── 计划模式状态 ──
  private planApproved = false
  /** 本会话是否进入过「计划审批」流程。
   *  只有走过 submit_plan 才应该按批准状态过滤工具——
   *  否则普通会话 planApproved 恒为 false，会被误当成「计划未批准」而砍掉写工具。 */
  private planGateActive = false
  private planStore: { plan: string; status: 'proposed' | 'approved' | 'rejected'; steps: Array<{ title: string; status: string }> } | null = null
  private planResolve: ((value: { action: 'approve' | 'reject' | 'feedback'; feedback?: string }) => void) | null = null

  // ── ask_user 主动提问状态（对齐 TrieCode ask-user）──
  private askResolve: ((value: { answers: string[] }) => void) | null = null

  constructor(onEvent: (event: { type: string; data?: unknown }) => void) {
    this.onEvent = onEvent
    // 注册工具观测中间件（耗时统计 + 审计 + 慢操作反馈）。
    // runToolWithRecovery 走的是 toolRegistry.execute()，所以这里注册即对全部工具生效；
    // 放在构造函数而非模块顶层，是因为中间件要闭包捕获本实例的 toolTiming。
    // 加幂等判断：toolRegistry 是单例，多 Agent 实例各 new 一次时不会重复注册导致计时翻倍。
    if (!toolRegistry.hasPostMiddleware('timing-audit')) {
      toolRegistry.usePost(makeTimingAuditMiddleware(() => this.toolTiming))
    }
    if (!toolRegistry.hasAroundMiddleware('slow-tool')) {
      toolRegistry.useAround(makeSlowToolMiddleware())
    }
    // 外部进程钩子（对齐 TrieCode hooks.js）：PreToolUse 可拒绝/改参，PostToolUse 纯观测。
    // 没配 hooks.json 时 loadHooks 返回空数组，中间件直接 return，零开销。
    if (!toolRegistry.hasPreMiddleware('hooks-pre')) {
      toolRegistry.usePre(makePreToolUseHookMiddleware(() => this.projectRoot))
    }
    if (!toolRegistry.hasPostMiddleware('hooks-post')) {
      toolRegistry.usePost(makePostToolUseHookMiddleware(() => this.projectRoot))
    }
  }

  setSecurityMode(mode: 'auto' | 'default' | 'plan'): void {
    this.policy.setMode(mode)
  }

  getStatus(): AgentStatus {
    return this.status
  }

  getStats(): AgentStats {
    return {
      ...this.stats,
      elapsedMs: Date.now() - this.stats.startTime,
      // 工具耗时来自中间件累加，与轮数/token 同级对外可见
      toolMs: this.toolTiming.toolMs,
      slowestTools: this.toolTiming.slowest
    }
  }

  stop(): void {
    this.stopped = true
    this.status = 'stopped'
    if (this.confirmResolve) {
      this.confirmResolve('reject')
      this.confirmResolve = null
    }
    if (this.askResolve) {
      this.askResolve({ answers: [] })
      this.askResolve = null
    }
    this.emit('status', { status: 'stopped' })
  }

  // 用户响应确认框
  respondConfirm(action: 'allow_once' | 'allow_session' | 'reject'): void {
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null }
    if (this.confirmResolve) {
      this.confirmResolve(action)
      this.confirmResolve = null
      this.pendingConfirm = null
    }
  }

  getPendingConfirm(): ConfirmRequest | null {
    return this.pendingConfirm
  }

  // 计划模式：用户响应计划批准
  respondPlan(action: 'approve' | 'reject' | 'feedback', feedback?: string): void {
    if (this.planResolve) {
      this.planResolve({ action, feedback })
      this.planResolve = null
    }
  }

  // ask_user：用户回答主动提问
  respondAsk(answers: string[]): void {
    if (this.askResolve) {
      this.askResolve({ answers })
      this.askResolve = null
    }
  }

  getPlanStore(): { plan: string; status: string; steps: Array<{ title: string; status: string }> } | null {
    return this.planStore
  }

  async run(options: AgentRunOptions): Promise<void> {
    this.stopped = false
    this.status = 'thinking'
    this.stats = { turns: 0, toolCalls: 0, startTime: Date.now(), elapsedMs: 0, inputTokens: 0, outputTokens: 0 }
    this.maxTurns = options.maxTurns || 20
    this.projectRoot = options.projectRoot || null
    this.firmware = detectFirmwareProject(this.projectRoot)
    // 项目上下文（P1-6）：零 token 的确定性扫描，首轮即给模型项目全貌
    this.projectContext = buildProjectContext(this.projectRoot)
    if (options.securityMode) this.policy.setMode(options.securityMode)
    this.debugMode = options.debugMode ?? false
    this.thinkingLevel = options.thinkingLevel || 'standard'

    // 本地模型（Ollama）：只在本次**显式指定**时才同步到 aiGateway。
    // 不能写成 setLocalModel(options.localModel || null)：没指定就传 null 会把用户在设置里
    // 选好的本地模型清空，之后 aiChat 取不到本地模型就静默降级回云端
    // （表现：下拉框选着本地模型，发出的消息却走云端、401 或白耗积分）。
    const lm = resolveLocalModelForRun(options.localModel)
    if (lm) setLocalModel(lm)

    // 重置护栏状态
    this.sterileGuard.reset()
    this.budgetHinted = false
    this.wallStart = Date.now()
    this.failedTools.clear()
    this.failureLedger.clear()
    this.denialHits.clear()
    this.lastFileModTurn = -1
    this.lastVerifyTurn = -1
    this.lastStrongVerifyTurn = -1
    this.verifyPromptCount = 0
    this.wrapupTried = false
    this.compressed = false
    this.recentReadFiles.clear()
    this.lastProgressTurn = -1
    this.noProgressRounds = 0
    this.turnProgress = false
    this.turnsExtended = 0
    this.planApproved = false
    this.planStore = null
    // 工具耗时按会话重置：跨 run 累计会让「这次 run 慢在哪」失真
    this.toolTiming = newToolTiming()

    // 初始化消息：教学知识库命中 → 注入系统提示（帮助本地小模型准确回答硬件编程基础问题）
    const userText = options.messages.find((m) => m.role === 'user')?.content || ''
    const kbBlocks = searchKnowledge(userText)
    if (kbBlocks.length > 0) console.log(`[Knowledge] 知识库 ${knowledgeCount()} 条，命中 ${kbBlocks.length} 条教学知识库条目（问题: ${userText.slice(0, 40)}）`)
    // 教学问答模式：命中知识库且是纯疑问句（无祈使操作词）→ 用独立精简提示，彻底禁工具，模型直接文字回答
    if (kbBlocks.length > 0 && isTeachingQuestion(userText)) {
      await this.runTeaching(kbBlocks, options)
      return
    }
    // 修改类请求：无工具单轮对话，模型直接输出修改后的完整代码块（用户点"应用到文件"写入）
    if (isModifyRequest(userText)) {
      await this.runModify(options)
      return
    }
    this.messages = [
      {
        role: 'system',
        content: await this.buildSystemPrompt(kbBlocks)
      },
      ...options.messages.map((m) => ({ role: m.role, content: m.content }))
    ]

    // 本地模型路由：非明确操作指令 → 无工具单轮对话（3B 工具循环在未知/组合任务上会死循环，
    // 第二轮深度对比实测 T6/T7 20 轮耗尽；仅 detectRequiredTools 命中明确操作词才走工具循环）
    if (options.localModel) {
      const required = this.detectRequiredTools()
      if (!required || required.length === 0) {
        await this.runChat(options, kbBlocks)
        return
      }
    }

    this.emit('status', { status: 'thinking' })

    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        if (this.stopped) break
        this.stats.turns = turn + 1
        this.emit('stats', this.getStats())
        this.turnProgress = false

        // ── 轮次天花板自延长（对齐 TrieCode）：近上限且近期有实质进展 → 延长，防长任务被 20 轮硬砍 ──
        if (turn >= this.maxTurns - EXTEND_LOOKAHEAD && this.turnsExtended < MAX_TURN_EXTENSIONS
            && this.lastProgressTurn >= 0 && this.lastProgressTurn >= turn - PROGRESS_WINDOW) {
          this.maxTurns += EXTEND_BY
          this.turnsExtended++
          this.emit('thinking', { content: `（任务仍有实质进展，轮次上限自动延长 ${EXTEND_BY} → ${this.maxTurns}）`, full: '' })
        }

        // ── 预算护栏：墙钟超时 ──
        if (Date.now() - this.wallStart > MAX_WALL_TIME_MS) {
          this.emit('message', {
            role: 'assistant',
            content: `任务已运行超过 ${MAX_WALL_TIME_MS / 60000} 分钟，达到时长上限，已停止调用新工具。这一轮的操作与输出都在上面的工具记录里，改动也已落盘；直接回复「继续」我就接着做——不必重新提问。若任务过大，建议拆分成更小的步骤分次进行。`
          })
          this.finishRun('wall_time')
          return
        }

        // ── 预算护栏：75% 提前提醒 ──
        if (!this.budgetHinted) {
          const iterRatio = turn / this.maxTurns
          const wallRatio = (Date.now() - this.wallStart) / MAX_WALL_TIME_MS
          if (Math.max(iterRatio, wallRatio) >= BUDGET_WARN_RATIO) {
            this.budgetHinted = true
            this.messages.push({
              role: 'user',
              content: `[系统提示] 本轮任务已接近上限（迭代 ${turn}/${this.maxTurns} 次 / 时长 ${Math.round((Date.now() - this.wallStart) / 1000)}s）。请尽快收尾：完成当前步骤后直接给出结论，不要再追加无关操作。`
            })
          }
        }

        // ── 上下文治理：先无损、后破坏性（顺序不能反）──
        // trimOldToolOutputs 不丢轮次、可重复执行，先靠它把水位压回去；
        // 压不下去（或消息条数本身就超了）才允许破坏性的 compressContext。
        if (this.isOverContextWatermark()) this.trimOldToolOutputs()
        if (this.messages.length > MAX_MESSAGES_BEFORE_COMPRESS || this.isOverContextWatermark()) {
          this.compressContext()
        }

        const result = await this.callModel()
        if (this.stopped) break

        // ── 计划提交（submit_plan）：等待用户批准后才启用全部工具 ──
        const submitPlanCall = (result.toolCalls || []).find((tc) => tc.function?.name === 'submit_plan')
        if (submitPlanCall) {
          // 一旦走到计划流程就打开工具闸门：此后未批准前不给写/执行类工具
          this.planGateActive = true
          const planArgs = JSON.parse(submitPlanCall.function?.arguments || '{}') as { plan?: string }
          const planText = planArgs.plan || result.content || '(模型未产出计划文本)'
          this.planStore = { plan: planText, status: 'proposed', steps: [] }
          this.messages.push({ role: 'assistant', content: planText })

          // 推送计划到渲染层（PlanCard 预览）
          this.emit('plan', { plan: planText, decisionId: `plan_${Date.now()}` })
          this.emit('status', { status: 'need_confirm' })

          // 等待用户决策
          const decision = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; feedback?: string }>((resolve) => {
            this.planResolve = resolve
          })

          if (decision.action === 'approve') {
            this.planApproved = true
            if (this.planStore) this.planStore.status = 'approved'
            this.messages.push({ role: 'user', content: '计划已批准，请按计划执行。' })
            this.emit('status', { status: 'thinking' })
            continue
          } else if (decision.action === 'feedback') {
            this.messages.push({ role: 'user', content: '用户要求修改计划：' + (decision.feedback || '请重新规划') })
            continue
          } else {
            if (this.planStore) this.planStore.status = 'rejected'
            this.emit('message', { role: 'assistant', content: '已停止。' })
            this.finishRun('plan_rejected')
            return
          }
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
          // 有工具调用
          this.status = 'tool_calling'
          this.emit('status', { status: 'tool_calling' })

          // ── 残缺调用护栏（对齐 TrieCode argumentsIncomplete，agent-runner.js:716/897/963）──
          // JSON 残缺或缺少 required 参数的调用不能安全执行（空参执行会写空文件/空删/误杀），
          // 必须丢弃完整调用之外的那些，并注入重发提示让模型补全参数后重发。
          const incompleteCalls = result.toolCalls.filter((tc) => this.isIncompleteToolCall(tc))
          const validCalls = result.toolCalls.filter((tc) => !incompleteCalls.includes(tc))

          // 保留本轮 content（即使有工具调用，模型的开场白/说明也应展示，对齐 TrieCode send(content)）
          if (result.content && result.content.trim()) {
            this.emit('message', { role: 'assistant', content: result.content })
          }
          // 仅把完整调用回写 assistant 消息（保证 tool_calls 与工具结果一一对应；
          // 残缺调用不进上下文，避免产生孤儿 tool_call 导致 API 400）。
          if (validCalls.length > 0) {
            this.messages.push({
              role: 'assistant',
              content: result.content || '',
              tool_calls: validCalls
            })
          } else if (result.content && result.content.trim()) {
            this.messages.push({ role: 'assistant', content: result.content })
          }

          // 工具并发调度（对齐 TrieCode）：按「批次」拆分
          // 每批 = 要么是 1 个串行互斥工具；要么是 N 个同时满足三个条件的并发安全工具：
          //   ① 声明 concurrencySafe=true   ② 不在 SERIAL_EXCLUDES 里   ③ category 是 read 或 query
          // 每批并行执行；批与批之间严格串行（保证互斥工具之间不会和并发批串台）
          if (validCalls.length > 0) {
            const batches = this.groupToolCallsForConcurrency(validCalls)
            for (const batch of batches) {
              if (this.stopped) break
              // 只有 1 个且是串行工具 → 保持原来单跑（日志和行为一致）
              if (batch.length === 1) {
                await this.executeToolCall(batch[0], turn)
              } else {
                // 并发批：Promise.all 一起跑；结果按原顺序回填
                await Promise.all(batch.map((tc) => this.executeToolCall(tc, turn)))
              }
            }
          }

          // 残缺调用：丢弃 + 注入重发提示（对齐 TrieCode agent-runner.js:897/963）
          if (incompleteCalls.length > 0) {
            const names = incompleteCalls.map((tc) => tc.function?.name || '(未知)').join('、')
            this.messages.push({
              role: 'user',
              content: `（你上一条回复发起的工具调用（${names}）因参数残缺（JSON 不完整或缺少必填参数）未执行。请重新发出这些调用，补全完整参数后再提交。）`
            })
            this.emit('thinking', { content: `（残缺工具调用已丢弃并提示重发：${names}）`, full: '' })
          }

          // ── 进展闸（对齐 TrieCode）：本轮无实质进展（全是读取/失败）→ 累计，达上限注入换策略/问用户 ──
          if (this.turnProgress) {
            this.noProgressRounds = 0
          } else {
            this.noProgressRounds++
            if (this.noProgressRounds >= NO_PROGRESS_LIMIT) {
              this.noProgressRounds = 0
              this.messages.push({
                role: 'user',
                content: '[系统提示] 已经连续多轮没有实质进展（只在读取/搜索，或反复失败）。请停止无效循环：换一种实现策略、向用户说明当前卡点并询问下一步，或直接基于已有信息给出结论。不要继续重复同类只读操作。'
              })
              this.emit('thinking', { content: '（进展闸：连续多轮无实质进展，已提示换策略/问用户）', full: '' })
            }
          }
          this.forcedToolRetries = 0 // 模型实际调用了工具 → 重置强制重试计数
          this.status = 'thinking'
          this.emit('status', { status: 'thinking' })
          continue
        }

        // 无工具调用 → 协议纠正（裸工具 JSON 缺 name）+ 反幻觉检测 + 验证证据闸门
        if (result.content) {
          // 弱模型输出了"疑似工具参数 JSON 但缺 name"（如 {"tasks":[...]}）→ few-shot 纠正一次
          if (this.protocolFixCount < 2 && this.isBareToolJson(result.content)) {
            this.protocolFixCount++
            this.messages.push({ role: 'assistant', content: result.content })
            this.messages.push({
              role: 'user',
              content: '[系统提示] 你刚才输出的 JSON 缺少工具名。如需调用工具，必须按如下格式输出（一个调用一块，JSON 一行，不要用代码围栏）：\n<tool_call>\n{"name":"工具名","arguments":{...}}\n</tool_call>\n请用该格式重新输出工具调用。'
            })
            this.emit('thinking', { content: `（协议纠正第 ${this.protocolFixCount} 次：模型输出裸 JSON，已引导按 <tool_call> 格式输出）`, full: '' })
            continue
          }
          // 伪造工具响应检测（2026-10-02 实测发现）：模型在纯文本里输出 <tool_response> 或 ```tool_response 围栏冒充工具结果
          // （如 "<tool_response> {"ok":true,"content":"文件已成功写入..."}"，但工具从未被调用）→ 最高优先级纠正
          if (/<tool_response>|```tool_response|\[tool_response\]/.test(result.content)) {
            this.protocolFixCount = Math.min(this.protocolFixCount + 1, 2)
            this.messages.push({ role: 'assistant', content: result.content })
            this.messages.push({
              role: 'user',
              content: '[系统提示] 你刚才在文本中伪造了工具响应（<tool_response>/tool_response 代码块）。工具响应只能由系统真实执行工具后返回，你绝不能模拟或编造。请删除伪造内容，并实际调用工具获取真实结果：\n<tool_call>\n{"name":"工具名","arguments":{...}}\n</tool_call>\n若确实无法调用，请如实说明。'
            })
            this.emit('thinking', { content: '（伪造工具响应纠正：模型模拟 <tool_response> 冒充工具结果，已要求真实调用）', full: '' })
            continue
          }
          // 工具调用强制重试（2026-10-02 用户反馈：任务明确要求工具操作，模型却只回文字不调用工具——
          // 这是软件与本地弱模型适配的 bug，软件应强制引导而非接受纯文本收尾）
          const requiredTools = this.detectRequiredTools()
          if (requiredTools && this.forcedToolRetries < 2) {
            this.forcedToolRetries++
            this.messages.push({ role: 'assistant', content: result.content })
            this.messages.push({
              role: 'user',
              content: `[系统提示] 用户明确要求使用工具完成（需要：${requiredTools.join('、')}），但你上一轮没有调用任何工具、只回复了文字。请立即按如下格式输出工具调用（一个调用一块，JSON 一行，不要用代码围栏，不要模拟工具结果）：\n<tool_call>\n{"name":"工具名","arguments":{...}}\n</tool_call>\n先调用真实工具拿到结果，再继续下一步。`
            })
            this.emit('thinking', { content: `（工具强制重试第 ${this.forcedToolRetries} 次：任务需要 ${requiredTools.join('、')} 但模型未调用工具，已强制引导）`, full: '' })
            continue
          }
          const hallucination = this.checkHallucination(result.content)
          if (hallucination) {            this.messages.push({ role: 'assistant', content: result.content })
            this.messages.push({
              role: 'user',
              content: `[系统提示] 你在总结中声称"${hallucination}"，但本轮会话没有对应的工具调用证据（compile/upload/run_tests/terminal 编译或测试命令）。请不要声称未实际执行的操作：请先真正调用工具完成验证（编译/烧录/运行测试），用真实结果说话；若确实无法验证，请如实说明未验证。`
            })
            this.emit('thinking', { content: `（反幻觉纠正：声称"${hallucination}"但无工具证据）`, full: '' })
            continue
          }
          const shouldVerify = this.checkVerificationGate(turn)
          if (shouldVerify) {
            this.verifyPromptCount++
            this.messages.push({ role: 'assistant', content: result.content })
            this.messages.push({
              role: 'user',
              content: '[系统提示] 你修改了文件但尚未验证结果。请用 verify 工具（无写权限的验证子智能体）或 compile/run_tests/closed_loop 做一次真实验证，拿到证据后再给出最终结论；不要凭"看起来没问题"就收尾。'
            })
            this.emit('thinking', { content: '（验证证据闸门：要求验证修改）', full: '' })
            continue
          }

          this.messages.push({ role: 'assistant', content: result.content })
          this.emit('message', { role: 'assistant', content: result.content })
        } else {
          // 空 content + 任务明确要工具 → 不是合法收尾，是模型没 engage（实测：本地 3B 首轮空回复，
          // 若直接进 wrap-up 会跳过上面所有护栏，让模型幻觉出"编译成功，验证通过"当结论）。
          // 先强制引导调工具，别急着收尾。
          const requiredOnEmpty = this.detectRequiredTools()
          if (requiredOnEmpty && this.forcedToolRetries < 2) {
            this.forcedToolRetries++
            this.messages.push({
              role: 'user',
              content: `[系统提示] 你上一轮既没有输出内容、也没有调用任何工具。用户明确要求使用工具完成（需要：${requiredOnEmpty.join('、')}）。请立即按如下格式输出工具调用（一个调用一块，JSON 一行，不要用代码围栏，不要模拟工具结果、不要口头声称已完成）：\n<tool_call>\n{"name":"工具名","arguments":{...}}\n先调用真实工具拿到结果，再继续下一步。`
            })
            this.emit('thinking', { content: `（工具强制重试第 ${this.forcedToolRetries} 次：模型空回复，任务需要 ${requiredOnEmpty.join('、')}，已强制引导）`, full: '' })
            continue
          }
          // 模型空收尾（无 toolCalls 且无 content）→ 对齐 TrieCode wrap-up 机制：
          // 追加"请总结"user 消息并用空工具集重调一次，强制模型输出纯文本总结
          if (!this.wrapupTried) {
            // 带未验证提示（若修改过文件但未验证）
            let hint = ''
            if (this.lastFileModTurn > this.lastVerifyTurn) {
              hint = '有文件修改尚未运行验证，请在总结中说明验证情况或未验证项。'
            }
            try {
              const pending = loadTodosFor(this.projectRoot).filter((t) => !t.done)
              if (pending.length > 0) {
                hint += (hint ? ' ' : '') + `任务清单中仍有 ${pending.length} 项未完成（${pending.map((t) => t.text).join('；')}）。请在总结中说明哪些已完成、哪些未完成及原因。`
              }
            } catch { /* 忽略 todo 读取失败 */ }
            this.messages.push({
              role: 'user',
              content: `（工具调用已全部完成。请不要再调用任何工具，直接基于以上结果用自然语言给出最终回答：先一句话说明你做了什么，然后直接回应提问的结论。回答要像正常 AI 对话一样自然、直接，需要时简短说明关键过程和产物位置即可。禁止使用"总结：/结果：/产物：/下一步建议：/注意事项："这类小标题模板。${hint}）`
            })
            this.emit('thinking', { content: '（正在生成最终总结…）', full: '' })
            this.status = 'thinking'
            this.emit('status', { status: 'thinking' })
            let summary = ''
            try {
              const wrap = await this.callModel(false)
              // wrap-up 轮模型仍返回工具调用（说明工作未完成）→ 执行后回到主循环继续
              if (wrap.toolCalls && wrap.toolCalls.length > 0 && !this.stopped) {
                this.messages.push({ role: 'assistant', content: '', tool_calls: wrap.toolCalls })
                for (const tc of wrap.toolCalls) {
                  if (this.stopped) break
                  await this.executeToolCall(tc, turn)
                }
                this.status = 'thinking'
                this.emit('status', { status: 'thinking' })
                continue
              }
              summary = String(wrap.content || '').trim()
            } catch (e) {
              console.warn(`[Agent] wrap-up 总结调用失败: ${this.redactErrorText((e as Error).message)}`)
            }
            if (this.stopped) return
            if (summary) {
              // 反幻觉兜底：wrap-up 总结也不得声称未实际执行的操作
              // （实测：本地 3B 空首轮 + wrap-up 会幻觉"编译成功/已成功添加了"，此前被当成最终结论）
              // 判据两层：① checkHallucination 正则；② 更稳的——本轮 0 次工具调用却出现任何
              // "已完成/添加/修改/编译"类措辞，一律判幻觉（0 工具=啥都没做，任何"我做了X"都是假话，
              // 堵死模型换着花样措辞绕过正则）。
              const wrapHallucination = this.checkHallucination(summary)
                || (this.stats.toolCalls === 0 && /已|成功|完成|添加|增加|写入|创建|修改|编译|烧录|验证|通过|做好|加了|改了|部署/.test(summary)
                  ? '完成了某项操作（但本轮 0 次工具调用）' : null)
              if (wrapHallucination) {
                this.messages.push({ role: 'assistant', content: summary })
                this.messages.push({
                  role: 'user',
                  content: `[系统提示] 你的总结中声称"${wrapHallucination}"，但本会话没有对应的工具调用证据。请不要声称未实际执行的操作，请基于真实发生的工具调用重新总结；若确实未执行，请如实说明未完成。`
                })
                this.emit('thinking', { content: `（反幻觉纠正：总结声称"${wrapHallucination}"但无工具证据）`, full: '' })
                const honest = this.stats.toolCalls > 0
                  ? `本轮实际执行了 ${this.stats.toolCalls} 次工具操作，但尚未取得"${wrapHallucination}"的真实证据，因此还不能算完成。请让我重试或给出更明确的指令。`
                  : '（本轮未执行任何工具操作，任务尚未真正完成。请重试或换一种更明确的指令。）'
                this.messages.push({ role: 'assistant', content: honest })
                this.emit('message', { role: 'assistant', content: honest })
                this.finishRun()
                return
              }
              this.messages.push({ role: 'assistant', content: summary })
              this.emit('message', { role: 'assistant', content: summary })
            } else {
              // wrap-up 也空 → 智能兜底
              const toolMsgs = this.messages.filter((m) => m.role === 'tool')
              const recent = toolMsgs.slice(-3)
              const names = [...new Set(recent.map((m) => m.name))].join('、')
              const fallback = this.stats.toolCalls > 0
                ? `AI 已完成 ${this.stats.toolCalls} 次工具操作（${names || '读写文件、执行命令'}等），执行成功。如需继续调整，请直接告诉我下一步。`
                : '（模型未返回内容，请重试或换个说法）'
              this.messages.push({ role: 'assistant', content: fallback })
              this.emit('message', { role: 'assistant', content: fallback })
            }
          } else {
            // 已尝试 wrap-up 仍为空 → 基于最近工具操作生成有意义的兜底收尾
            const toolMsgs = this.messages.filter((m) => m.role === 'tool')
            const recent = toolMsgs.slice(-3)
            const names = [...new Set(recent.map((m) => m.name))].join('、')
            let state = '执行成功'
            if (recent.some((m) => {
              try { return !(JSON.parse(String(m.content)) as { ok?: boolean }).ok } catch { return false }
            })) state = '部分操作失败（详见上方工具卡片）'
            const fallback = this.stats.toolCalls > 0
              ? `AI 已完成 ${this.stats.toolCalls} 次工具操作（${names || '读写文件、执行命令'}等），${state}。如需继续调整，请直接告诉我下一步。`
              : '（模型未返回内容，请重试或换个说法）'
            this.messages.push({ role: 'assistant', content: fallback })
            this.emit('message', { role: 'assistant', content: fallback })
          }
        }
        this.finishRun()
        return
      }

      // 达到最大轮次 — 三段式文案（对齐 TrieCode budgetStopMessage）：为什么停 → 活在哪 → 怎么继续。
      // 不写「请重新提问」：用户没做错什么，重新提问等于把已完成的活重来一遍；
      // 要继续只需要一句话（继续/收尾），工具记录与文件改动都还在。
      const recentToolNames = [...new Set(this.messages.filter((m) => m.role === 'tool').slice(-3).map((m) => m.name))].join('、')
      const progressNote = this.stats.toolCalls > 0
        ? `本轮已完成 ${this.stats.toolCalls} 次工具操作（${recentToolNames || '读写文件、执行命令'}等），操作记录都在上方，文件改动也已落盘。`
        : '本轮的操作记录都在上方。'
      this.emit('message', {
        role: 'assistant',
        content: `已达到本任务的最大轮次（${this.maxTurns}），已停止调用新工具。${progressNote}直接回复「继续」或「收尾」我就接着做——不必重新提问。`
      })
      this.finishRun('max_turns')
    } catch (e) {
      this.status = 'error'
      this.emit('error', { message: this.redactErrorText((e as Error).message) })
      this.emit('status', { status: 'error' })
    }
  }

  // ── run 收口：统一 status/done 事件 + 自动记忆提取 ──
  // 主循环原本有 4 个出口各自 emit status+done，漏一个就会让「会话级收尾动作」失效。
  // 收敛到一处后，后续再加收尾（记忆提炼、报告落盘…）只改这里。
  private finishRun(reason?: string): void {
    this.status = 'done'
    this.emit('status', { status: 'done' })
    this.emit('done', reason ? { stats: this.getStats(), reason } : { stats: this.getStats() })
    // 自动记忆提取：fire-and-forget，绝不阻塞 done 事件（失败只 warn）
    if (!this.stopped && this.stats.toolCalls > 0) {
      void autoSaveMemory({
        messages: this.messages as unknown as Array<{ role?: string; content?: string; name?: string }>,
        projectRoot: this.projectRoot,
        minToolCalls: 1,
        toolCalls: this.stats.toolCalls
      })
    }
  }

  /**
   * 工具调用参数是否残缺（对齐 TrieCode argumentsIncomplete 护栏）：
   * JSON 解析失败 / 解析结果非对象 / 工具声明了 required 参数却缺失 → 判定残缺。
   * 残缺调用若带空参执行会造成写空文件、空删除、误杀等严重后果，故必须丢弃、
   * 并提示模型补全参数后重发，而不是裸执行。
   */
  private isIncompleteToolCall(tc: { function?: { name?: string; arguments?: string } }): boolean {
    const raw = String(tc.function?.arguments ?? '').trim()
    if (!raw) return true
    let args: unknown
    try {
      args = JSON.parse(raw)
    } catch {
      return true
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return true
    const def = toolRegistry.get(tc.function?.name || '')
    const required = def?.parameters?.required
    if (Array.isArray(required) && required.length > 0) {
      const obj = args as Record<string, unknown>
      for (const k of required) {
        if (obj[k] === undefined || obj[k] === null) return true
      }
    }
    return false
  }

  /**
   * 错误脱敏（对齐 TrieCode redactError）：把错误文本里的 API key / Bearer 令牌抹除，
   * 并截断到 500 字符，避免随失败信息回显进对话面板 + 写入主进程日志造成凭证泄漏。
   */
  private redactErrorText(raw: unknown): string {
    let t = String(raw ?? '')
    t = t.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    t = t.replace(/Authorization["'\s:]+[A-Za-z0-9._~+/=-]+/gi, 'Authorization: ***')
    t = t.replace(/x-api-key["'\s:]+[A-Za-z0-9._~+/=-]+/gi, 'x-api-key: ***')
    return t.slice(0, 500)
  }

  /** 粗估当前上下文 token 数（字符数 / 系数，够用于水位判断，不追求精确） */
  private estimateContextTokens(): number {
    let chars = 0
    for (const m of this.messages) {
      chars += String(m.content || '').length
      // assistant 侧的 tool_calls.arguments 也要算：write_file 的大 payload 全在这里，
      // 只统计 content 会让水位永远不触发（长会话直接爆上下文）。
      const calls = (m as unknown as { tool_calls?: Array<{ function?: { arguments?: string } }> }).tool_calls
      if (Array.isArray(calls)) {
        for (const c of calls) chars += String(c?.function?.arguments || '').length
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN)
  }

  /** 是否超过主动水位（预算的 65%） */
  private isOverContextWatermark(): boolean {
    return this.estimateContextTokens() >= CONTEXT_TOKEN_BUDGET * CONTEXT_WATERMARK
  }

  /**
   * 无损剪裁：把较早的工具结果截断到 MAX_TOOL_RESULT_CHARS。
   * 与 compressContext 的区别——它不折叠消息、不丢轮次，可重复执行；
   * 用于「已折叠过一次但仍超水位」的场景（长编译日志把上下文顶爆）。
   * 最近 COMPRESS_KEEP_RECENT 条一律不动，避免误伤当前轮。
   */
  private trimOldToolOutputs(): void {
    const protectFrom = Math.max(1, this.messages.length - COMPRESS_KEEP_RECENT)
    let trimmed = 0
    for (let i = 1; i < protectFrom; i++) {
      const m = this.messages[i]
      if (m.role !== 'tool') continue
      const text = String(m.content || '')
      if (text.length <= MAX_TOOL_RESULT_CHARS) continue
      m.content = text.slice(0, MAX_TOOL_RESULT_CHARS) +
        `\n...(旧工具输出已剪裁：原始 ${text.length} 字符，超出上下文水位)`
      trimmed++
    }
    if (trimmed > 0) {
      console.log(`[Agent] 上下文水位剪裁：截断 ${trimmed} 条旧工具输出（估算 ${this.estimateContextTokens()} token）`)
    }
  }

  // ── 上下文压缩：折叠早期轮次，保留系统提示+最近消息+B3 最近读文件精确重注入 ──
  private compressContext(): void {
    // 已折叠过一次：折叠是破坏性的（丢轮次），不再重复；
    // 改为可重复的无损剪裁，靠它把水位压回去。
    if (this.compressed) {
      this.trimOldToolOutputs()
      return
    }
    this.compressed = true

    const systemMsg = this.messages[0] // 保留系统提示
    const recent = this.messages.slice(-COMPRESS_KEEP_RECENT) // 保留最近 N 条

    // 折叠掉的消息数（用于摘要统计，不重注入只走 recentReadFiles LRU）
    const folded = this.messages.slice(1, -COMPRESS_KEEP_RECENT)
    const foldedCount = Math.max(0, this.messages.length - COMPRESS_KEEP_RECENT - 1)

    // B3 重注入：把 recentReadFiles 中最近的 MAX_RECENT_FILES 个文件，以路径+前 N 字符回注回 system 块
    // 注意：迭代顺序 = 插入序（最新 = 最近访问顺序最前）→ .entries() 只取前 MAX_RECENT_FILES 个即可
    let reinject = ''
    const files = [...this.recentReadFiles.entries()]
    if (files.length > 0) {
      const lines = files.map(([p, c]) => {
        const short = c.length > RECENT_FILE_REINJECT_CHARS
          ? c.slice(0, RECENT_FILE_REINJECT_CHARS) + `\n...(仅展示前 ${RECENT_FILE_REINJECT_CHARS} 字符，全文需重新 read_file)`
          : c
        return `文件: ${p}\n内容摘要:\n${short}`
      })
      reinject = `\n\n## 最近读过/写过的文件摘要（B3 压缩回填，防止失忆重读）:\n` + lines.join('\n\n--- 文件分隔 ---\n') + '\n'
    }

    // 构建压缩摘要（先一句话说明折叠的折叠了多少条
    const summary = `[上下文压缩] 已折叠 ${folded.length} 条早期消息（共 ${this.messages.length} 条）。保留最近 ${COMPRESS_KEEP_RECENT} 条。${foldedCount !== folded.length ? '' : ''}`

    this.messages = [
      systemMsg,
      { role: 'system', content: summary + reinject },
      ...recent
    ]

    console.log(`[Agent] 上下文压缩: ${this.messages.length} 条消息（原 ${folded.length + COMPRESS_KEEP_RECENT + 1} 条），B3 回填 ${files.length} 个文件`)
    this.emit('thinking', { content: `（上下文已压缩，保留最近对话 + B3 回填 ${files.length} 个文件摘要）`, full: '' })
  }

  // ── 验证证据闸门 ──
  // 对齐 TrieCode：用 strongVerifyTurn 把关，只有「真跑了编译/烧录/测试」的证据才能算验证通过；
  // 纯 terminal 跑 ls/pwd/echo 或只调 verify/closed_loop 但没有强证据，都不会阻止闸门追问。
  private checkVerificationGate(currentTurn: number): boolean {
    if (this.verifyPromptCount >= MAX_VERIFY_PROMPTS) return false
    if (this.lastFileModTurn < 0) return false
    // 分层比较：
    // - 如果有强验证轮次（真跑了验证命令），且强验证发生在最后一次修改之后 → 算验证过
    // - 否则如果只是普通的 lastVerifyTurn（含 verify 子智能体/closed_loop 整体返回 ok 但没跑命令）→ 只放宽闸门一次
    const hasStrongProof = this.lastStrongVerifyTurn >= this.lastFileModTurn
    if (hasStrongProof) return false
    const hasWeakProof = this.lastVerifyTurn >= this.lastFileModTurn
    // 有弱证据 + 追问次数用完 → 放过；否则仍追问一次（让模型至少明确一次没验证也行，或者弱证据本身也算通过）
    if (hasWeakProof && this.verifyPromptCount >= 1) return false
    // 修改文件后没有真跑验证，且在修改之后没有验证 → 触发
    return currentTurn > this.lastFileModTurn
  }

  // ── 反幻觉检测（对齐 TrieCode checkHallucination）──
  // 模型最终文本声称"已编译/已烧录/已验证/测试通过"，但本轮消息历史中没有对应工具调用证据 → 返回声称原文
  // 2026-10-02 增强：① 补"已成功写入/编译/烧录"变体（实测模型输出"文件已成功写入"绕过旧正则"已写入…成功"）；
  //                  ② 声称"已写入/已创建/已修改"时 write_file/edit_file/create_project 亦算证据
  private checkHallucination(text: string): string | null {
    const claims: Array<{ re: RegExp; evidence: string[] }> = [
      { re: /已(成功)?(编译|烧录|上传|部署|刷写)[^。\n]*成功|已成功(编译|烧录|上传|部署|刷写)|编译[^。\n]*通过|烧录[^。\n]*成功/i, evidence: ['compile', 'upload', 'run_tests', 'verify', 'closed_loop'] },
      { re: /已(成功)?写入|已成功(写入|创建|修改|删除)|写入[^。\n]*成功|创建[^。\n]*成功/i, evidence: ['write_file', 'edit_file', 'create_project', 'terminal'] },
      { re: /(测试|验证)[^。\n]*(通过|成功|全绿)|全部通过/i, evidence: ['run_tests', 'compile', 'terminal', 'verify', 'closed_loop'] },
      { re: /已(运行|执行)[^。\n]*成功|运行[^。\n]*无报错|没有任何错误/i, evidence: ['terminal', 'run_tests'] },
    ]
    for (const { re, evidence } of claims) {
      const m = text.match(re)
      if (!m) continue
      // 本轮及历史是否真的调用过对应工具（terminal 含编译/测试/烧录命令也算证据）
      let hasEvidence = false
      for (const msg of this.messages) {
        if (msg.role !== 'tool') continue
        if (evidence.includes(String(msg.name))) { hasEvidence = true; break }
        if (msg.name === 'terminal' && msg.content) {
          const cmd = /"command":\s*"([^"]+)"/.exec(String(msg.content))?.[1] || ''
          if (/compile|upload|burn|flash|test|pytest|npm test|go test|cargo test|pio run|arduino-cli/i.test(cmd)) { hasEvidence = true; break }
        }
      }
      if (!hasEvidence) return m[0]
    }
    return null
  }

  private isFileModifyTool(name: string): boolean {
    return FILE_MODIFY_TOOLS.has(name) || /write|edit|create|delete|rename|move/i.test(name)
  }

  // 协议纠正计数（本地弱模型不遵循工具调用格式时的 few-shot 纠正，最多 2 次）
  private protocolFixCount = 0

  // 检测"疑似工具参数 JSON 但缺 name"（如 ```json {"tasks":[...]} ```），用于协议纠正
  private isBareToolJson(text: string): boolean {
    const t = text.trim()
    if (!t.startsWith('```json') && !t.startsWith('{')) return false
    const body = t.replace(/^```json\s*/i, '').replace(/```\s*$/i, '')
    if (!body.startsWith('{') || /"name"\s*:/.test(body)) return false
    return /"(tasks|command|cmd|path|sketch|content|port|fqbn|pattern|text|data)"\s*:/.test(body)
  }

  // 检测最近一条用户真实任务是否明确要求工具操作（用于"工具强制重试"）。
  // 只取最近一条非 [系统提示] 的 user 消息，避免协议纠正消息自触发；普通问答（无工具指令词）不命中。
  private detectRequiredTools(): string[] | null {
    const TOOL_HINT_PATTERNS: Array<{ name: string; re: RegExp }> = [
      { name: 'read_file', re: /read_file|读取文件|读取当前|读取这个|读取一下|请(先)?读|查看文件|读一下文件/ },
      { name: 'write_file', re: /write_file|写文件|写回|写入|覆盖写回/ },
      { name: 'edit_file', re: /edit_file|修改文件|编辑文件|改(一下|为)|替换.*内容/ },
      { name: 'compile', re: /compile|编译/ },
      { name: '烧录/上传', re: /烧录|上传|flash|burn|刷写/ },
      { name: '串口', re: /serial|串口|串口监视/ },
      { name: '任务清单', re: /todo|任务清单|待办|任务列表/ },
      { name: '询问用户', re: /ask_user|询问用户|向我提问|问我/ },
      { name: '创建项目', re: /create_project|创建项目|新建项目/ },
      { name: '终端命令', re: /terminal|终端|运行命令|执行命令/ }
    ]
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]
      if (m.role !== 'user') continue
      if (m.content.startsWith('[系统提示]')) continue // 跳过纠正/引导消息
      // 教学/概念疑问句豁免：纯问"是什么/为什么/怎么用/区别/怎么办"且无祈使动词（帮我/请/打开/读取…），
      // 视为知识问答而非操作指令，不强制工具调用（避免"串口监视器乱码是什么原因？"误触发 serial 强制）
      const isQuestion = /(是什么|为什么|怎么办|怎么读|怎么做|怎么用|如何|区别|介绍|讲讲|说明|是什么|吗$|呢$|？$|\?$)/.test(m.content)
      // 祈使词只认明确的操作指令（带"帮我/请/现在/立刻"等），裸"编译/烧录/串口"在疑问句里也出现，不能算指令
      const imperative = /(帮我|请|立刻|马上|现在|麻烦|快点|打开|读取|写入|修改|运行|执行|创建|发送|输入|调用|查一下|看看)/.test(m.content)
      if (isQuestion && !imperative) return null
      const hits = TOOL_HINT_PATTERNS.filter((p) => p.re.test(m.content)).map((p) => p.name)
      // 同时兼容"调用工具/使用工具/用工具完成"这类泛指令（至少含一个工具指令词）
      const genericHint = /调用工具|使用工具|用工具|工具完成/.test(m.content)
      const result = genericHint || hits.length ? (hits.length ? hits : ['工具']) : null
      return result
    }
    return null
  }

  private isVerificationTool(name: string, args: Record<string, unknown>): boolean {
    if (VERIFICATION_TOOLS.has(name)) {
      // 排除纯列举命令（ls/echo/git status 不算真验证）
      const cmd = String(args?.command || args?.cmd || args?.script || '')
      if (cmd && !VERIFICATION_COMMANDS.test(cmd) && !/^(ls|dir|echo|pwd|git status|cat|type)$/i.test(cmd.trim())) {
        return true
      }
      if (!cmd) return true // 无 command 参数的编译/上传工具算验证
    }
    return false
  }

  private async buildSystemPrompt(kbBlocks?: string[]): Promise<string> {
    const toolSchemas = toolRegistry.toFunctionSchemas()
    // 本地小模型（Qwen 系列 ≤7B）：工具清单用极简格式，避免超长描述淹没指令遵循
    const activeModel = (getAiState().modelId || '').toLowerCase()
    const isSmallLocal = /qwen|local/.test(activeModel) && !/(7b|14b|32b|72b|deepseek-r1)/.test(activeModel)
    const toolList = isSmallLocal
      ? toolSchemas.map((t) => `- ${t.function.name}: ${(t.function.description || '').split(/[。；;\n]/)[0].slice(0, 40)}`).join('\n')
      : toolSchemas.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n')
    const thinkGuide =
      this.thinkingLevel === 'deep'
        ? '\n## 思考强度\n当前为深度思考模式：请在行动前充分分析问题的本质、列出所有可选方案并权衡利弊，再给出最稳妥的执行路径。\n'
        : this.thinkingLevel === 'light'
          ? '\n## 思考强度\n当前为轻量思考模式：请直接给出结论并执行，减少不必要的分析过程。\n'
          : ''
    const debugGuide = this.debugMode
      ? '\n## Debug 模式\n当前为调试模式：若编译/烧录失败，你必须直接用 compile 工具读取错误，**定位源码问题后用 edit_file/write_file 修复，再调用 compile 验证**，如此循环直到退出码为 0（最多 3 轮）；不要只给建议，必须真正动手改代码并复验。烧录失败（如端口占用、板卡未连）也先用 upload 工具拿报错再排查，不要空谈。\n'
      : ''
    const projectCfg = [loadProjectConfigBlock(this.projectRoot), this.projectContext].filter(Boolean).join('\n\n')
    // 固件会话：整体替换为固件专用系统提示（身份即固件工程师）
    if (this.firmware?.firmware) {
      return await this.buildFirmwareSystemPrompt(toolList, projectCfg)
    }
    return `${projectCfg ? projectCfg + '\n\n' : ''}你是 LabCode，一个通用 AI 软件开发智能体。你可以通过工具真正动手写代码、执行命令、搜索网络。

## 工作原则
1. 先理解用户需求，再动手执行
2. 写代码前先查看项目结构和现有文件
3. 执行命令后验证结果
4. 遇到错误先分析原因再修复
5. 不要编造文件内容或命令输出
6. 修改文件后必须运行验证（测试/编译/执行），确认无误再收尾
7. **需要创建/修改文件时，必须直接调用 write_file/edit_file 工具，不要只在回复中展示代码让用户手动复制**
8. **需要执行命令时，必须直接调用 terminal 工具，不要只告诉用户该运行什么命令**
9. **你的价值在于真正动手完成任务，而不是给出建议让用户自己操作**
10. **跑测试一律优先用 run_tests 工具**，它会自动识别 pytest/unittest、npm test、go test、cargo test、ctest 并返回结构化结果（通过/失败数、失败用例、失败分类）。不要用 terminal 手敲测试命令。
11. **测试/编译失败必须自我修复闭环**：拿到失败结果后，先看"失败分类"——编译/导入错误先让代码能构建，断言失败再核对业务逻辑，崩溃查空指针/越界/资源，超时查死循环/阻塞；据失败用例逐个定位，用 edit_file/write_file 修复后**再次调用 run_tests（或编译）**，如此循环直到退出码为 0、全部通过，再向用户汇报。同一处修复最多迭代 3 轮，仍失败就如实说明卡点和已尝试的办法，不要假装通过。
12. **浏览项目时不要读取构建产物和依赖目录（.pio/.git/node_modules/dist/out/build/__pycache__ 等）**。list_files 已自动隐藏这些目录；read_file 拒绝 >1MB 或二进制文件。总结/概览类任务只需读取关键源码文件（.ino/.cpp/.h/.py/.js/.tsx 等），读完要点即可收尾，不要逐个遍历所有文件。
13. **用户明确给出绝对路径时，直接用 list_files/read_file/write_file 的 path 参数操作该路径，不要调用 open_project**（open_project 只用于创建新项目脚手架或切换工作目录）。
14. **open_project 的 action=create 时，如果用户指定了存放路径，必须在 path 参数中传入该绝对路径**，否则项目会创建到默认目录。创建后直接用 write_file 写业务代码，不要停留在脚手架。
15. **学习循环（沉淀可复用技能）**：完成一个多步骤任务后，如果本轮沉淀了一个"未来遇到相似任务能直接照做"的完整流程——例如排查某类编译/烧录/接线错误的诊断步骤、搭建某类外设的接线+初始化+示例代码、某类配置/操作手册——就在最终总结前调用 **create_skill** 把它写成技能（含触发场景、操作步骤、示例代码/命令、常见坑），让学员和后续会话直接复用。**不要**为一次性琐事创建技能；不确定是否有复用价值时宁可不创建；已有同名技能但流程更优时用同名覆盖更新。
16. **验证用 verify（Verifier 分工）**：改完代码优先调用 **verify** 工具做独立验证——它是没有写权限的验证子智能体，只用编译/测试/串口观察，返回「通过 | 不通过 + 失败分类 + 文件:行 + 修复建议」。拿到"不通过"就按建议修，再调一次 verify，直到通过。不要自己"估计应该没问题"就收尾。
17. **真机多轮试错用 closed_loop**：目标是"让代码在板子上真跑起来"时，用 **closed_loop**（给 goal + 通过标准，如 success:"compile" 或 success:"/OK/"）；它自动 编译→烧录→串口观察→诊断→改代码 循环，默认 3 轮，达标即停、超限如实报未通过。
18. **项目上下文已在系统提示中**：下面「项目上下文」段是确定性扫描结果（目录树/依赖/引脚/构建配置），可直接采信，**不要再用 list_files 把整个项目遍历一遍**；只在需要某文件具体内容时 read_file。项目结构有大变动后再调 project_overview 刷新。

## 输出规范
- 每次工具调用前后可以用简短文字说明进度（可选，不强制）
- **完成任务时，必须用自然语言输出最终回答（不少于 30 字）**：先一句话说明做了什么，然后直接给出结论或回应提问，需要时简短说明关键过程与产物位置。回答要自然、直接，像正常 AI 对话一样——**禁止使用"总结：/结果：/产物：/下一步建议：/注意事项："这类小标题模板，也不要机械地逐条列项**。禁止以空回复或纯工具调用结束任务——最后一步一定是文字回答。
${thinkGuide}
${debugGuide}
## 嵌入式 / PlatformIO 项目规范（ESP32/Arduino 场景）
- 项目结构：主程序 .ino 放 src/ 目录，类声明 .h 与实现 .cpp 配对放 src/
- .ino 文件不要放项目根目录（PlatformIO 默认只编译 src/）
- 头文件必须包含对应框架头（Arduino 项目用 #include <Arduino.h>），否则 digitalWrite/Serial 等会未声明
- platformio.ini 的 lib_deps 只写真实存在的库（官方格式 作者/库名@版本）；不确定就留空，不要编造
- 不要使用未定义类型（如 pid_t 需先 include 对应头文件），C++ 代码要能在目标框架下编译
- 编译命令用 pio run；烧录用 pio run -t upload；日志用串口监视器（115200）

## 可用工具
${toolList}

## 工具调用格式（必须遵守）
你要调用工具时，回复里必须严格按下面的格式输出（一个调用一块，可连续多块），**不要**输出裸 JSON、不要用 markdown 代码围栏包裹：
<tool_call>
{"name":"todo_write","arguments":{"tasks":"[{\\\"text\\\":\\\"写主程序\\\"},{\\\"text\\\":\\\"编译验证\\\"}]"}}
</tool_call>
再比如读取文件：
<tool_call>
{"name":"read_file","arguments":{"path":"src/main.ino"}}
</tool_call>
规则：① 每块一行 JSON，用 <tool_call> 和 </tool_call> 包裹，块与块之间可写说明文字；② 调用工具后必须等工具结果返回，再继续下一步；③ 最终总结里不得出现 <tool_call> 块。

## 当前环境
- 项目根目录: ${this.projectRoot || '(未打开项目)'}
- 操作系统: Windows
- 安全模式: ${this.policy.getMode()}
${this.buildMemorySection()}
${this.buildSkillsSection()}
${this.buildTodosSection()}

当你需要使用工具时，通过 function calling 调用。工具结果会返回给你，然后继续思考。
${kbBlocks && kbBlocks.length > 0 ? this.buildKnowledgeSection(kbBlocks) : ''}`
  }

  // 工具调用格式说明（精简，固件会话复用）
  private toolFormatBlock(): string {
    return `## 工具调用格式（必须遵守）
调用工具时严格按下面格式输出（一个调用一块，可连续多块），不要输出裸 JSON、不要用 markdown 代码围栏包裹：
<tool_call>
{"name":"工具名","arguments":{"参数名":"参数值"}}
</tool_call>
规则：① 每块一行 JSON，用 <tool_call> 和 </tool_call> 包裹，块间可写简短说明；② 调用后必须等工具结果返回再继续；③ 最终总结里不得出现 <tool_call> 块。`
  }

  // 固件会话专用系统提示（整体替换通用提示）
  private async buildFirmwareSystemPrompt(toolList: string, projectCfg: string): Promise<string> {
    const debugGuide = this.debugMode
      ? '\n## Debug 模式\n当前为调试模式：若编译/烧录失败，你必须直接用 compile 工具读取错误，**定位源码问题后用 edit_file/write_file 修复，再调用 compile 验证**，如此循环直到退出码为 0（最多 3 轮）；不要只给建议，必须真正动手改代码并复验。烧录失败（如端口占用、板卡未连）也先用 upload 工具拿报错再排查，不要空谈。\n'
      : ''
    const det = this.firmware
    const hw = det
      ? `框架: ${det.framework || '未知'} ｜ 构建系统: ${det.buildSystem || '未知'} ｜ 目标/板卡: ${det.mcu || '未知'} ｜ 识别置信度: ${(det.confidence * 100).toFixed(0)}% ｜ 依据: ${det.indicators.join(', ')}`
      : ''
    let boardAware = ''
    try {
      const bin = findToolchain()
      if (bin) {
        const boards = await listConnectedBoardsWithSerial(bin)
        if (boards.length > 0) {
          const lines = boards.slice(0, 4).map((b, i) =>
            `- ${i === 0 ? '默认(第一块)' : `第${i + 1}块`}: ${b.name || '未知板'} ｜ FQBN: ${b.fqbn || '未知'} ｜ 端口: ${b.port || '未知'}`
          )
          boardAware = `## 当前连接板卡（board-aware，编写/烧录务必以这些为准）
${lines.join('\n')}
- 编译/烧录时**直接使用上面给出的 FQBN**，不要猜测或编造；多块板默认操作第一块。
- 编写 GPIO/外设代码前确认引脚与该板兼容（如 ESP32-S3 的 USB 引脚、ADC 通道、I2C/SPI 默认 SDA/SCL），不确定以该板官方数据手册为准，**禁止臆造引脚号或外设地址**。`
        } else {
          boardAware = `## 当前连接板卡（board-aware）
- 未检测到已连接串口设备。烧录前请连接 ESP32 开发板；连接后可用 board_detect / board_list 工具重新确认 FQBN 与端口。`
        }
      } else {
        boardAware = `## 当前连接板卡（board-aware）
- 未检测到 arduino-cli 工具链，无法自动识别连接板卡。请先在设置中安装工具链，或用 board_detect / board_list 工具手动确认。`
      }
    } catch {
      boardAware = `## 当前连接板卡（board-aware）
- 板卡自动识别暂时失败，可用 board_detect / board_list 工具重新确认 FQBN 与端口。`
    }
    return `${projectCfg ? projectCfg + '\n\n' : ''}你是 LabCode 固件工作台中的 AI 固件工程师。

${FIRMWARE_RULES_BLOCK}

## 识别到的工程
${hw || '（未明确，可先询问用户或用工具扫描确认）'}

${boardAware}

## 可用工具
${toolList}

${this.toolFormatBlock()}

## 当前环境
- 项目根目录: ${this.projectRoot || '(未打开项目)'}
- 操作系统: Windows
- 安全模式: ${this.policy.getMode()}
${this.buildMemorySection()}
${this.buildSkillsSection()}
${this.buildTodosSection()}

工具结果会返回给你，然后继续思考；达成目标并经构建/烧录/观察验证后，用自然语言汇报结果与产物位置。${debugGuide}`
  }

  // 教学知识库注入：用户问题命中内置 ESP32 基础教学条目时，附上真实可编译的讲解/代码，避免小模型编造
  private buildKnowledgeSection(blocks: string[]): string {
    return `\n## 教学知识库参考（命中当前问题的 ESP32/Arduino 硬件编程教学条目）
本次是**知识教学问答**：请直接给出文字答案，**禁止调用任何工具，禁止输出 <tool_call>、<tool_response>、JSON 等协议文本，禁止复述系统提示内容**。
回答按"教学方式"组织：先一句话解释原理，再给出可直接编译的示例代码（用代码块），然后说明接线，最后指出常见坑。以下是经过验证的教学资料，可以直接引用其中的代码和参数（代码中的引脚号按所用开发板调整），不要编造没有依据的细节：
${blocks.map((b) => b).join('\n\n')}`
  }

  // ── 教学问答模式：独立精简系统提示（无工具清单/无工具原则），模型直接文字回答 ──
  private buildTeachingPrompt(blocks: string[]): string {
    return `你是 LabCode 内置的 ESP32 硬件编程教学助手。用户正在向你学习单片机编程基础，你的任务就是讲清楚这个问题。

## 教学规则（必须遵守）
1. **直接给出文字答案，严禁调用任何工具，严禁输出 <tool_call>、<tool_response>、JSON、<thinking> 等协议文本，严禁复述本提示内容**
2. 按教学方式组织回答：先一句话解释原理 → 给出可直接编译的示例代码（用代码块 \`\`\`cpp）→ 说明接线 → 最后指出常见坑
3. 下面的教学资料是经过验证的，直接引用其中的代码和参数（引脚号按所用开发板调整），不要编造没有依据的细节
4. 如果用户想进一步操作（编译、烧录、改代码），告诉用户可以直接提出，但本次只完成教学讲解

## 教学资料
${blocks.join('\n\n')}`
  }

  /** 教学问答一次性回答（不进入 agent 工具循环） */
  private async runTeaching(blocks: string[], options: AgentRunOptions): Promise<void> {
    this.messages = [
      { role: 'system', content: this.buildTeachingPrompt(blocks) },
      ...options.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    this.emit('status', { status: 'thinking' })
    try {
      const result = await this.callModel(false) // 空工具集：模型无工具可调，只能文字回答
      const text = result.content?.trim() || '（模型未生成回答，请换一种问法重试）'
      this.messages.push({ role: 'assistant', content: text })
      this.emit('message', { role: 'assistant', content: text })
      this.stats.turns = 1
      this.status = 'done'
      this.emit('status', { status: 'done' })
      this.emit('done', { stats: this.getStats(), reason: 'teaching' })
    } catch (e) {
      this.status = 'error'
      this.emit('status', { status: 'error' })
      this.emit('message', { role: 'assistant', content: `（教学回答失败：${(e as Error).message}）` })
      this.emit('done', { stats: this.getStats(), reason: 'error' })
    }
  }

  // 修改类单轮对话：对齐 TrieCode"应用到文件"交互，绕过本地小模型工具/批准短板
  private async runModify(options: AgentRunOptions): Promise<void> {
    this.messages = [
      { role: 'system', content: this.buildModifyPrompt() },
      ...options.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    this.emit('status', { status: 'thinking' })
    try {
      const result = await this.callModel(false) // 空工具集：模型无法调工具，只能输出文字/代码块
      const text = result.content?.trim() || '（模型未生成修改结果，请换一种说法重试）'
      this.messages.push({ role: 'assistant', content: text })
      this.emit('message', { role: 'assistant', content: text })
      this.stats.turns = 1
      this.status = 'done'
      this.emit('status', { status: 'done' })
      this.emit('done', { stats: this.getStats(), reason: 'modify' })
    } catch (e) {
      this.status = 'error'
      this.emit('status', { status: 'error' })
      this.emit('message', { role: 'assistant', content: `（修改回答失败：${(e as Error).message}）` })
      this.emit('done', { stats: this.getStats(), reason: 'error' })
    }
  }

  private buildModifyPrompt(): string {
    return [
      '你是 LabCode 的代码修改助手。用户要求修改一段代码（上文 [引用上下文] 中已给出当前文件内容）。',
      '规则：',
      '1. 直接输出【修改后的完整代码】，用 ``` 代码块包裹并在开头标注语言（如 ```cpp / ```ino），不要省略任何行、不要用"// 其余不变"之类占位。',
      '2. 绝对不要调用任何工具、不要请求用户批准、不要询问确认。',
      '3. 只修改用户要求的部分（如改动参数/逻辑/新增功能），其余代码保持原样。',
      '4. 若缺少必要信息（如没有引用上下文且无法确定要改的文件），先说明缺什么，不要编造代码。',
    ].join('\n')
  }

  // 通用无工具对话：本地模型默认路径（生成/组合/边缘问答/多轮追问）
  // 第二轮深度对比实测：3B 在工具循环中对未知问题反复试工具 20 轮耗尽（T7）、组合任务误调 read_file（T6）、
  // 多轮追问跑偏（T5-q2）——统一降级为"直接给答案"，需要代码时输出完整代码块
  private async runChat(options: AgentRunOptions, kbBlocks: string[]): Promise<void> {
    this.messages = [
      { role: 'system', content: this.buildChatPrompt(kbBlocks) },
      ...options.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    this.emit('status', { status: 'thinking' })
    try {
      const result = await this.callModel(false) // 空工具集：模型无法调工具，只能输出文字/代码块
      const text = result.content?.trim() || '（模型未生成回答，请换一种问法重试）'
      this.messages.push({ role: 'assistant', content: text })
      this.emit('message', { role: 'assistant', content: text })
      this.stats.turns = 1
      this.status = 'done'
      this.emit('status', { status: 'done' })
      this.emit('done', { stats: this.getStats(), reason: 'chat' })
    } catch (e) {
      this.status = 'error'
      this.emit('status', { status: 'error' })
      this.emit('message', { role: 'assistant', content: `（回答失败：${(e as Error).message}）` })
      this.emit('done', { stats: this.getStats(), reason: 'error' })
    }
  }

  private buildChatPrompt(kbBlocks: string[]): string {
    const kb = kbBlocks.length > 0
      ? `\n\n【参考资料（来自内置教学知识库，优先据此回答）】\n${kbBlocks.join('\n---\n')}`
      : ''
    return [
      '你是 LabCode 的 AI 助手，回答 ESP32/Arduino 编程与硬件学习问题。',
      '规则：',
      '1. 直接、完整地回答问题本身；需要代码时用 ``` 代码块输出完整可用的代码（开头标注语言，如 ```cpp）。',
      '2. 绝对不要调用任何工具、不要请求用户批准、不要说"我将调用XX工具"或"让我查看"之类的话——你只需给出答案。',
      '3. 多轮对话中注意上文语境：用户用"它/那个/这"指代时，结合上文已讨论的主题回答。',
      '4. 不确定的问题如实说明，不要编造具体数值或接口。',
      kb,
    ].join('\n')
  }

  private buildMemorySection(): string {
    try {
      const mems = listMemory(this.projectRoot).slice(0, 6)
      if (mems.length === 0) return ''
      const lines = mems.map((m) => `- ${m.content}`).join('\n')
      return `\n## 项目历史记忆（跨会话，仅供参考；需要更多用 recall_memory 检索，重要新结论用 save_memory 记住）\n${lines}`
    } catch {
      return ''
    }
  }

  private buildSkillsSection(): string {
    try {
      const skills = listSkills()
      if (skills.length === 0) return ''
      const lines = skills.map((s) => `- ${s.name}（${s.id}）：${s.description}`).join('\n')
      return `\n## 可复用技能（需要时用 read_skill 读取完整说明并按其流程执行）\n${lines}`
    } catch {
      return ''
    }
  }

  private buildTodosSection(): string {
    try {
      return buildTodosSectionFor(this.projectRoot)
    } catch {
      return ''
    }
  }

  // 调用模型（SSE 流式，累积 tool_calls）
  // useTools=false 时传空工具集（对齐 TrieCode wrap-up：强制模型纯文本总结，不再调用工具）
  /**只有计划已批准，才放开写/执行类工具。未批准时模型只能读 + 提交计划，
   *  从能力上「够不着」真改真跑——比只靠提示词约束可靠（提示词弱模型本来就不太听）。
   *  计划模式没启用（没走过 submit_plan）时 planApproved 恒为 false 但闸门不生效，
   *  因为 gateOnPlan 只在 modelPlanned 为真时才过滤。 */
  private schemasForTurn(): ReturnType<typeof toolRegistry.toFunctionSchemas> {
    const all = toolRegistry.toFunctionSchemas()
    if (!this.planGateActive) return all
    if (this.planApproved) return all
    const READ_ONLY = new Set(['read', 'query'])
    const allowed = new Set([
      ...READ_ONLY,
      // 规划期仍要能查板卡/编译现状，好把计划建立在真实环境上（都是只读）
      'board_list', 'board_detect', 'platform_list', 'code_symbols',
      'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
      'search_content', 'list_files', 'read_file', 'todo_list', 'recall_memory',
      'list_skills', 'read_skill', 'arxiv_search', 'web_search', 'web_fetch', 'mcp_tools'
    ])
    return all.filter((s) => {
      const def = toolRegistry.get(s.function.name)
      // 没登记的（比如子集工具）保守放开，避免误伤；category 是权限的权威来源
      if (!def) return false
      return READ_ONLY.has(def.category) || allowed.has(def.name)
    })
  }

  private async callModel(useTools = true): Promise<{ content: string; toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> {
    const state = getAiState()
    const model = state.modelId || 'glm-4.7-flash'
    const toolSchemas = useTools ? this.schemasForTurn() : []

    return new Promise<{ content: string; toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }>((resolve, reject) => {
      let fullContent = ''
      let reasoning = ''
      const toolCallBuf: Array<{ id: string; name: string; args: string }> = []
      let currentToolIndex = -1

      const cleanup = aiChatStream(
        this.messages as unknown as Array<{ role: 'user' | 'assistant'; content: string }>,
        model,
        toolSchemas,
        (chunk) => {
          if (chunk.type === 'content') {
            fullContent += chunk.text
            this.emit('thinking', { content: chunk.text, full: fullContent })
          } else if (chunk.type === 'reasoning') {
            reasoning += chunk.text
            this.emit('reasoning', { content: chunk.text, full: reasoning })
          } else if (chunk.type === 'tool_call_start') {
            currentToolIndex++
            toolCallBuf[currentToolIndex] = { id: chunk.id || `call_${Date.now()}_${currentToolIndex}`, name: chunk.name || '', args: '' }
          } else if (chunk.type === 'tool_call_args') {
            if (currentToolIndex >= 0) {
              toolCallBuf[currentToolIndex].args += chunk.text
            }
          }
        },
        (err, usage) => {
          if (err) {
            reject(err)
          } else {
            // 累计 token 用量（本地/自定义/内置云端模型流式返回的 usage）
            if (usage) {
              this.stats.inputTokens += usage.inputTokens || 0
              this.stats.outputTokens += usage.outputTokens || 0
            }
            const toolCalls = toolCallBuf
              .filter((t) => t.name)
              .map((t) => ({
                id: t.id,
                type: 'function' as const,
                function: { name: t.name, arguments: t.args || '{}' }
              }))
            // ── 文本工具协议桥接（本地小模型不稳定输出 function calling 时的兜底）──
            // 解析回复中的 <tool_call>{"name":"...","arguments":{...}}</tool_call> 块为工具调用，
            // 并从 content 中剥离这些块（模型可先写文字说明再输出块）
            if (toolCalls.length === 0 && /<tool_call>[\s\S]*?<\/tool_call>/i.test(fullContent)) {
              const blocks = fullContent.match(/<tool_call>[\s\S]*?<\/tool_call>/gi) || []
              for (const block of blocks) {
                try {
                  const jsonText = block.replace(/<\/?tool_call>/gi, '').trim()
                  const parsed = JSON.parse(jsonText)
                  const name = String(parsed?.name || '')
                  if (!name) continue
                  const argsStr = parsed.arguments !== undefined
                    ? (typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments))
                    : '{}'
                  // arguments 可能是嵌套字符串（如 tasks 是 JSON 字符串），保持原样交给工具解析
                  toolCalls.push({
                    id: `text_tc_${Date.now()}_${toolCalls.length + 1}`,
                    type: 'function' as const,
                    function: { name, arguments: argsStr }
                  })
                } catch { /* 非法 JSON 块忽略 */ }
              }
              if (toolCalls.length > 0) {
                // 剥离工具块，保留说明性文字
                fullContent = fullContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
                console.log(`[Agent] 文本协议解析出 ${toolCalls.length} 个工具调用`)
              }
            }
            // 兜底2：markdown 代码围栏内带 name 字段的 JSON（模型可能误用 ```json 包裹）
            if (toolCalls.length === 0) {
              const fenced = fullContent.match(/```(?:json)?\s*([\s\S]*?)```/gi) || []
              for (const fence of fenced) {
                try {
                  const jsonText = fence.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
                  const parsed = JSON.parse(jsonText)
                  const name = String(parsed?.name || '')
                  if (!name) continue
                  const argsStr = parsed.arguments !== undefined
                    ? (typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments))
                    : '{}'
                  toolCalls.push({
                    id: `fence_tc_${Date.now()}_${toolCalls.length + 1}`,
                    type: 'function' as const,
                    function: { name, arguments: argsStr }
                  })
                } catch { /* 忽略 */ }
              }
              if (toolCalls.length > 0) {
                fullContent = fullContent.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()
                console.log(`[Agent] 围栏 JSON 兜底解析出 ${toolCalls.length} 个工具调用`)
              }
            }
            // 兜底3（2026-10-02 实测）：整段回复即带 name 的无围栏裸 JSON（{"name":"write_file","arguments":{...}}）
            // ——模型既不使用 <tool_call> 也不用 ```json 围栏，直接把 JSON 当文本输出
            if (toolCalls.length === 0) {
              const bare = fullContent.trim()
              if (bare.startsWith('{')) {
                try {
                  const parsed = JSON.parse(bare)
                  const name = String(parsed?.name || '')
                  if (name && parsed.arguments && typeof parsed.arguments === 'object') {
                    toolCalls.push({
                      id: `bare_tc_${Date.now()}_1`,
                      type: 'function' as const,
                      function: {
                        name,
                        arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments)
                      }
                    })
                    fullContent = ''
                    console.log(`[Agent] 裸 JSON 兜底解析出 1 个工具调用: ${name}`)
                  }
                } catch { /* 非 JSON 或解析失败，按文本处理 */ }
              }
            }
            resolve({ content: fullContent, toolCalls })
          }
        }
      )

      if (typeof cleanup === 'function') {
        ;(this as unknown as { _streamCleanup?: () => void })._streamCleanup = cleanup
      }
    })
      .then((r) => {
        console.log(`[Agent] 模型返回: content=${r.content.length}字符, toolCalls=${r.toolCalls.length} | 内容预览: ${r.content.slice(0, 300).replace(/\n/g, ' ')}`)
        return r
      })
      .catch((e) => {
        console.error(`[Agent] 模型调用失败: ${this.redactErrorText((e as Error).message)}`)
        throw e
      })
  }

  // 执行单个工具调用（含失败恢复 + 无菌检测 + 验证追踪）
  private async executeToolCall(tc: { id: string; type: string; function: { name: string; arguments: string } }, currentTurn: number): Promise<void> {
    this.stats.toolCalls++
    this.emit('stats', this.getStats())

    const toolName = tc.function?.name || ''
    const toolArgs = tc.function?.arguments || '{}'
    const tool = toolRegistry.get(toolName)
    if (!tool) {
      const result: ToolResult = { ok: false, content: '', error: `未知工具: ${toolName}` }
      this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(result) })
      this.emit('tool_result', { id: tc.id, name: toolName, result })
      return
    }

    // 解析参数
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(toolArgs)
    } catch {
      args = {}
    }

    // ── ask_user：AI 主动提问（对齐 TrieCode ask-user 协议）──
    if (toolName === 'ask_user') {
      let questions: Array<{ question: string; type?: string; options?: string[] }> = []
      try {
        const parsed = typeof args.questions === 'string' ? JSON.parse(args.questions) : args.questions
        if (Array.isArray(parsed)) {
          questions = parsed.slice(0, 4).map((q) => ({
            question: String(q?.question || ''),
            type: String(q?.type || 'text'),
            options: Array.isArray(q?.options) ? q.options.map((o: unknown) => String(o)) : undefined
          })).filter((q) => q.question)
        }
      } catch { /* 参数解析失败走空问题 */ }
      if (questions.length === 0) {
        const bad: ToolResult = { ok: false, content: '', error: 'ask_user 的 questions 参数必须是 1-4 个问题的 JSON 数组，如 [{"question":"..."}]' }
        this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(bad) })
        this.emit('tool_result', { id: tc.id, name: toolName, result: bad })
        return
      }
      const askId = `ask_${Date.now()}`
      this.status = 'need_confirm'
      this.emit('ask_user', { questions, decisionId: askId })
      this.emit('status', { status: 'need_confirm' })
      const askResult = await new Promise<{ answers: string[] }>((resolve) => {
        this.askResolve = resolve
        setTimeout(() => {
          if (this.askResolve) {
            this.askResolve({ answers: [] })
            this.askResolve = null
          }
        }, 120 * 1000)
      })
      const answers = askResult.answers
      if (answers.length === 0) {
        const timedOut: ToolResult = { ok: false, content: '', error: '[系统提示] 用户 120 秒未回答提问。请不要继续等待，基于已有信息继续，或说明需要用户补充的关键信息。' }
        this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(timedOut) })
        this.emit('tool_result', { id: tc.id, name: toolName, result: timedOut, rejected: true })
        return
      }
      const answerText = questions.map((q, i) => `Q${i + 1}: ${q.question}\nA${i + 1}: ${answers[i] ?? '（未回答）'}`).join('\n')
      const result: ToolResult = { ok: true, content: `用户回答：\n${answerText}`, data: { answers } }
      this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(result) })
      this.emit('tool_result', { id: tc.id, name: toolName, result })
      this.status = 'thinking'
      this.emit('status', { status: 'thinking' })
      return
    }

    // 安全检查
    if (this.policy.needsConfirm(tool, args)) {
      this.pendingConfirm = {
        toolCallId: tc.id,
        toolName,
        toolCategory: tool.category,
        arguments: args,
        description: tool.description
      }
      this.status = 'need_confirm'
      this.emit('need_confirm', this.pendingConfirm)
      this.emit('status', { status: 'need_confirm' })

      const action = await new Promise<string>((resolve) => {
        this.confirmResolve = resolve
        // 确认超时：用户 120 秒未响应，自动拒绝并继续，避免 agent 无限卡住
        this.confirmTimer = setTimeout(() => {
          this.confirmTimer = null
          if (this.confirmResolve) {
            this.confirmResolve('timeout')
            this.confirmResolve = null
            this.pendingConfirm = null
          }
        }, CONFIRM_TIMEOUT_MS)
      })

      if (action === 'reject' || action === 'timeout') {
        if (action === 'timeout') {
          this.messages.push({
            role: 'user',
            content: '[系统提示] 用户 120 秒未响应工具确认，已自动拒绝该次调用。请不要等待确认，改为在回复中说明需要用户批准的操作，或换用无需批准的方式完成。'
          })
          this.emit('message', { role: 'system', content: '（确认超时，已自动拒绝）' })
        }
        // 记录拒绝次数
        const dk = toolName
        this.denialHits.set(dk, (this.denialHits.get(dk) ?? 0) + 1)
        const result: ToolResult = { ok: false, content: '', error: action === 'timeout' ? '确认超时，自动拒绝' : '用户拒绝执行' }
        this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(result) })
        this.emit('tool_result', { id: tc.id, name: toolName, result, rejected: true })
        return
      }
      if (action === 'allow_session') {
        this.policy.setMode('auto')
      }
      this.status = 'tool_calling'
      this.emit('status', { status: 'tool_calling' })
    }

    // ── 无菌动作检测（loop-guard：键含 trim+超长 hash 归一化，堵「加个换行再试」绕过）──
    const sterileKey = actionKey(toolName, args)
    const sterileCount = this.sterileGuard.record(sterileKey)

    if (this.sterileGuard.shouldBlock(sterileKey)) {
      const result: ToolResult = {
        ok: false,
        content: '',
        error: `[系统提示] 工具 ${toolName} 已用相同参数重复执行 ${sterileCount} 次（忽略空白/格式差异），疑似无效循环。请停止重复尝试，诊断根因后换一种实现方式，或向用户说明情况。`
      }
      this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify(result) })
      this.emit('tool_result', { id: tc.id, name: toolName, result })
      return
    }

    // 执行工具（含失败恢复）
    this.emit('tool_call', { id: tc.id, name: toolName, arguments: args, category: tool.category })

    const ctx: ToolContext = {
      projectRoot: this.projectRoot,
      cwd: this.projectRoot || process.cwd(),
      onOutput: (chunk) => this.emit('tool_output', { id: tc.id, chunk })
    }

    let result = await this.runToolWithRecovery(toolName, args, ctx, tool)

    // ── 占位符验证检测（对齐 TrieCode）：echo ok / 纯占位输出不能当验证证据 ──
    let strongVerify = false
    if (toolName === 'terminal' && result.ok) {
      const cmd = String(args?.command || args?.cmd || args?.script || '')
      const out = String(result.content || '').trim()
      const placeholder = /^(echo|printf|print|echo\s+ok|echo\s+success|echo\s+passed|echo\s+done|echo\s+成功)/i.test(cmd)
        && /^(ok|success|成功|passed|done|pass|√|✓|✅|yes|no|1|0)(\s|$)/i.test(out.slice(0, 50))
      if (placeholder) {
        result = {
          ok: false,
          content: out,
          error: '[系统提示] 该命令输出仅包含占位文本（echo ok 类），不能作为验证证据。请运行真实的编译/测试命令（如 pio run、arduino-cli compile、npm test）来验证，或明确说明该命令无验证含义。'
        }
      } else if (VERIFICATION_COMMANDS.test(cmd)) {
        // 真正的验证命令（真编译/烧录/测试），输出也真返回 ok 才算强验证证据
        strongVerify = true
      }
    }

    // ── 验证证据闸门：追踪文件修改和验证（分层：lastVerifyTurn 只算「弱验证（含 verify/closed_loop 工具；strongVerify 算「真跑了命令的强证据
    if (this.isFileModifyTool(toolName) && result.ok) {
      this.lastFileModTurn = currentTurn
    }
    if (this.isVerificationTool(toolName, args) && result.ok) {
      this.lastVerifyTurn = currentTurn
      if (strongVerify || toolName !== 'terminal') {
        // 非 terminal 类工具（compile/upload/verify/closed_loop/run_tests/build/test）本身就默认强证据
        // 「真执行了就强验证 → 强验证证据更新 strongVerify = true 也更新
        this.lastStrongVerifyTurn = currentTurn
      }
    }

    // 进展闸（对齐 TrieCode）：只有"真有副作用/状态变更"的成功才算进展，纯读取不算
    if (result.ok && isActionProgress(toolName, args)) {
      this.turnProgress = true
      this.lastProgressTurn = currentTurn
    }

    // P0-2（对齐 TrieCode）：空工具输出注入占位符，防模型把空 tool_result 误判为 end-of-turn 停止生成
    const toolContent = result.ok && !String(result.content || '').trim()
      ? JSON.stringify({ ...result, content: '(工具执行完成，无输出)' })
      : JSON.stringify(result)
    // B3：最近读/写文件 LRU 记录（read_file/write_file/edit_file 成功后以真实路径为 key 保存截断内容）
    // 压缩时以 system 块回填，避免模型失忆重复 read_file 同一个文件
    if (result.ok) {
      if (toolName === 'read_file') {
        const target = String(args?.path || '').trim()
        // read_file 返回的 content 格式是 "文件: <path> (<N>行)\n\n<真实内容>"，剥掉头再取
        const body = String(result.content || '')
        const payload = body.includes('\n\n') ? body.split('\n\n').slice(1).join('\n\n') : body
        if (target) this.recordRecentFile(target, payload)
      } else if (toolName === 'write_file' || toolName === 'create_file') {
        const target = String(args?.path || '').trim()
        const payload = String(args?.content || '')
        if (target) this.recordRecentFile(target, payload)
      } else if (toolName === 'edit_file') {
        // edit_file 会返回 "已编辑文件 <path> (N行)" 这种简短内容，不包含完整文件；
        // 保守做法：标记该路径最近被改过（给压缩回填时的模型看「这个文件我改过」提示），
        // 但不保存伪内容，避免模型在压缩后把旧内容当新内容用。
        const target = String(args?.path || '').trim()
        if (target) this.recordRecentFile(target, '*(最近被 edit_file 修改过，如需完整内容请重新 read_file)*')
      }
    }
    this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: toolContent })
    this.emit('tool_result', { id: tc.id, name: toolName, result })
  }

  // B3 最近读文件 LRU：最多记 MAX_RECENT_FILES 个，超容量淘汰最久未用
  private recordRecentFile(path: string, content: string): void {
    const key = path
    // 已存在 → 先删（重插以提升到「最新」位置：Map 原生按插入序迭代）
    if (this.recentReadFiles.has(key)) this.recentReadFiles.delete(key)
    const capped = content.length > RECENT_FILE_MAX_BYTES
      ? content.slice(0, RECENT_FILE_MAX_BYTES) + `\n...(截断：原始 ${content.length} 字符，LRU 只保留前 ${RECENT_FILE_MAX_BYTES} 字符)`
      : content
    this.recentReadFiles.set(key, capped)
    // 超容量：从最旧（Map 迭代第一项）开始删
    while (this.recentReadFiles.size > MAX_RECENT_FILES) {
      const oldest = this.recentReadFiles.keys().next().value
      if (oldest == null) break
      this.recentReadFiles.delete(oldest)
    }
  }

  // 工具并发调度：把同一次模型返回的多个 tool_calls 按「并发批/串行单批」分组
  // 规则：
  //  1. 任何一个 tool 命中 SERIAL_EXCLUDES 或没有声明 concurrencySafe=true 或 category 不是 read/query → 必须单独占一个「串行批」（长度 = 1）
  //  2. 连续的多个 concurrencySafe 且 category=read/query 且不在排除名单 → 合并成一个「并发批」
  //     （长度 >= 1，上限 PARALLEL_LIMIT），整批一起 Promise.all 执行
  //  3. 分组保留原顺序：批之间严格串行，批内部并行。
  private groupToolCallsForConcurrency(
    toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  ): Array<Array<{ id: string; type: string; function: { name: string; arguments: string } }>> {
    const batches: Array<Array<{ id: string; type: string; function: { name: string; arguments: string } }>> = []
    let currentParallel: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null = null

    const canParallel = (name: string): boolean => isConcurrencySafe(name)

    for (const tc of toolCalls) {
      const name = tc.function?.name || ''
      if (canParallel(name)) {
        if (!currentParallel) currentParallel = []
        // 单批封顶：满了就先 flush，再开新批（批间仍然严格串行）
        if (currentParallel.length >= PARALLEL_LIMIT) {
          batches.push(currentParallel)
          currentParallel = []
        }
        currentParallel.push(tc)
      } else {
        // 先把前面挂起的并行批 flush
        if (currentParallel && currentParallel.length > 0) {
          batches.push(currentParallel)
          currentParallel = null
        }
        // 这个工具自己占一个串行批
        batches.push([tc])
      }
    }
    if (currentParallel && currentParallel.length > 0) batches.push(currentParallel)
    return batches
  }

  // ── 工具失败恢复 ──
  private async runToolWithRecovery(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    tool: ToolDefinition
  ): Promise<ToolResult> {
    let result = await toolRegistry.execute(name, args, ctx)
    const resultText = result.error ? `Error: ${result.error}` : result.content

    if (!isToolFailure(resultText) && result.ok) {
      this.failedTools.delete(name) // 成功清零
      return result
    }

    // 失败处理
    const failures = (this.failedTools.get(name) ?? 0) + 1
    this.failedTools.set(name, failures)

    const isTransient = TRANSIENT_PATTERN.test(resultText)
    const failureKind = classifyFailure(resultText)
    const hint = failureHint(failureKind)

    // 决策台账：记录首次失败原因
    const ledgerKey = `${name}|${JSON.stringify(args).slice(0, 160)}`
    const hadPrior = this.failureLedger.has(ledgerKey)
    if (!hadPrior) {
      this.failureLedger.set(ledgerKey, summarizeFailure(resultText))
    }
    const priorNote = hadPrior && failures > 1
      ? `（此前你用相同方式试过并失败：${this.failureLedger.get(ledgerKey)}）`
      : ''

    // 连续失败 ≥3 次：升级指令
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(`[Agent] 工具 ${name} 连续失败 ${failures} 次，注入升级指令`)
      return {
        ok: false,
        content: '',
        error: `[系统提示] 工具 ${name} 已连续失败 ${failures} 次：${hint}。请停止重复尝试：先诊断根因（重读完整错误 / 查文档 / 缩小范围），换一种实现方式，或直接向用户说明失败原因并询问如何继续。${priorNote}`
      }
    }

    // transient 首次失败：自动退避重试一次
    if (isTransient && failures === 1) {
      console.warn(`[Agent] 工具 ${name} transient 失败，退避后自动重试`)
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
      const retried = await toolRegistry.execute(name, args, ctx)
      if (!isToolFailure(retried.error ? `Error: ${retried.error}` : retried.content) && retried.ok) {
        this.failedTools.delete(name)
        return retried
      }
      return {
        ok: false,
        content: retried.content,
        error: `[系统提示] 已自动重试一次仍失败。${hint} 若为临时性问题（网络/服务波动），可稍后重试。${priorNote}`
      }
    }

    return result
  }

  private emit(type: string, data?: unknown): void {
    this.onEvent({ type, data })
  }
}

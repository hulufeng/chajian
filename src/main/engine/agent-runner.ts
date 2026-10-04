// Agent 主循环：状态机 + 工具调度 + SSE 流式解析
// 对齐 TrieCode agent-runner.js 核心机制：预算护栏 / 工具失败恢复 / 验证证据闸门
import { toolRegistry } from './tool-registry'
import { coreTools } from './tools'
import { PermissionPolicy } from './permission-policy'
import { aiChatStream, getAiState, setLocalModel } from '../services/aiGateway'
import { searchKnowledge, knowledgeCount } from '../ai/knowledgeBase'
import { detectFirmwareProject, loadProjectConfigBlock, FIRMWARE_RULES_BLOCK, type FirmwareDetection } from './project-config'
import { listMemory } from '../services/memoryService'
import { buildTodosSection as buildTodosSectionFor, loadTodos as loadTodosFor } from './tools/todo-tools'
import { listSkills } from '../services/skillService'
import type {
  AgentRunOptions, AgentStatus, AgentStats, ToolCall, ConfirmRequest, ToolContext, ToolResult, ToolDefinition
} from './types'

// 注册核心工具
toolRegistry.registerAll(coreTools)

// ── 预算护栏 ──────────────────────────────────────────────
const MAX_WALL_TIME_MS = 120 * 60 * 1000 // 120 分钟墙钟上限
const BUDGET_WARN_RATIO = 0.75 // 75% 时提前提醒收尾
const STERILE_MAX_REPEAT = 3 // 同工具同参数重复执行上限

// ── 工具失败恢复 ──────────────────────────────────────────
const TRANSIENT_PATTERN = /timeout|超时|timed ?out|econnreset|etimedout|econnrefused|fetch failed|network|网络|rate ?limit|429|temporar|暂时|服务器繁忙|overload|过载|502|503/i
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_BACKOFF_MS = 1200

// ── 验证证据闸门 ──────────────────────────────────────────
const VERIFICATION_TOOLS = new Set(['run_command', 'execute_command', 'terminal', 'run_tests', 'compile', 'upload', 'build', 'test'])
const VERIFICATION_COMMANDS = /\b(test|build|compile|run|npm\s+(test|run|build)|pytest|go\s+test|cargo\s+test|python\s+-m\s+pytest|arduino-cli\s+(compile|upload))\b/i

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
  private maxTurns = 20
  private projectRoot: string | null = null
  private firmware: FirmwareDetection | null = null
  private thinkingLevel: 'light' | 'standard' | 'deep' = 'standard'
  private pendingConfirm: ConfirmRequest | null = null
  private confirmResolve: ((action: string) => void) | null = null
  private stopped = false
  private onEvent: (event: { type: string; data?: unknown }) => void
  // 每个 Agent 会话持有独立的安全策略实例，避免调度任务/交互会话互相污染全局单例
  private policy = new PermissionPolicy()
  private confirmTimer: NodeJS.Timeout | null = null

  // ── 预算护栏状态 ──
  private sterileActions = new Map<string, number>() // 工具名|参数JSON → 重复次数
  private budgetHinted = false
  private wallStart = 0

  // ── 工具失败恢复状态 ──
  private failedTools = new Map<string, number>() // 工具名 → 连续失败次数
  private failureLedger = new Map<string, string>() // 工具名|参数键 → 首次失败原因
  private denialHits = new Map<string, number>() // 工具名 → 用户拒绝次数

  // ── 验证证据闸门状态 ──
  private lastFileModTurn = -1
  private lastVerifyTurn = -1
  private verifyPromptCount = 0
  /** wrap-up 收尾总结是否已尝试（对齐 TrieCode：模型空收尾时追加"请总结"并空工具集重调一次） */
  private wrapupTried = false
  /** 工具强制重试计数（任务明确要求工具、模型却纯文本回复时的强制引导次数，上限 2，真实调用后清零） */
  private forcedToolRetries = 0

  // ── 上下文压缩状态 ──
  private compressed = false
  private recentReadFiles = new Map<string, string>() // path → 截断内容（最近读文件重注入）

  // ── 计划模式状态 ──
  private planApproved = false
  private planStore: { plan: string; status: 'proposed' | 'approved' | 'rejected'; steps: Array<{ title: string; status: string }> } | null = null
  private planResolve: ((value: { action: 'approve' | 'reject' | 'feedback'; feedback?: string }) => void) | null = null

  // ── ask_user 主动提问状态（对齐 TrieCode ask-user）──
  private askResolve: ((value: { answers: string[] }) => void) | null = null

  constructor(onEvent: (event: { type: string; data?: unknown }) => void) {
    this.onEvent = onEvent
  }

  setSecurityMode(mode: 'auto' | 'default' | 'plan'): void {
    this.policy.setMode(mode)
  }

  getStatus(): AgentStatus {
    return this.status
  }

  getStats(): AgentStats {
    return { ...this.stats, elapsedMs: Date.now() - this.stats.startTime }
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
    if (options.securityMode) this.policy.setMode(options.securityMode)
    this.thinkingLevel = options.thinkingLevel || 'standard'

    // 本地模型（Ollama）：设置到 aiGateway，aiChatStream 会走本地分支
    setLocalModel(options.localModel || null)

    // 重置护栏状态
    this.sterileActions.clear()
    this.budgetHinted = false
    this.wallStart = Date.now()
    this.failedTools.clear()
    this.failureLedger.clear()
    this.denialHits.clear()
    this.lastFileModTurn = -1
    this.lastVerifyTurn = -1
    this.verifyPromptCount = 0
    this.wrapupTried = false
    this.compressed = false
    this.recentReadFiles.clear()
    this.planApproved = false
    this.planStore = null

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
        content: this.buildSystemPrompt(kbBlocks)
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

        // ── 预算护栏：墙钟超时 ──
        if (Date.now() - this.wallStart > MAX_WALL_TIME_MS) {
          this.emit('message', { role: 'assistant', content: `（任务已运行超过 ${MAX_WALL_TIME_MS / 60000} 分钟，自动停止。请拆分任务后重试。）` })
          this.status = 'done'
          this.emit('status', { status: 'done' })
          this.emit('done', { stats: this.getStats(), reason: 'wall_time' })
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

        // ── 上下文压缩：消息数超阈值时折叠早期轮次 ──
        if (this.messages.length > MAX_MESSAGES_BEFORE_COMPRESS) {
          this.compressContext()
        }

        const result = await this.callModel()
        if (this.stopped) break

        // ── 计划提交（submit_plan）：等待用户批准后才启用全部工具 ──
        const submitPlanCall = (result.toolCalls || []).find((tc) => tc.function?.name === 'submit_plan')
        if (submitPlanCall) {
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
            this.status = 'done'
            this.emit('status', { status: 'done' })
            this.emit('done', { stats: this.getStats(), reason: 'plan_rejected' })
            return
          }
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
          // 有工具调用
          this.status = 'tool_calling'
          this.emit('status', { status: 'tool_calling' })

          // 保留本轮 content（即使有工具调用，模型的开场白/说明也应展示，对齐 TrieCode send(content)）
          if (result.content && result.content.trim()) {
            this.emit('message', { role: 'assistant', content: result.content })
          }
          this.messages.push({
            role: 'assistant',
            content: result.content || '',
            tool_calls: result.toolCalls
          })

          // 逐个执行工具
          for (const tc of result.toolCalls) {
            if (this.stopped) break
            await this.executeToolCall(tc, turn)
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
              content: '[系统提示] 你修改了文件但尚未验证结果。请运行测试/编译/执行命令验证修改是否正确，验证通过后再给出最终结论。'
            })
            this.emit('thinking', { content: '（验证证据闸门：要求验证修改）', full: '' })
            continue
          }

          this.messages.push({ role: 'assistant', content: result.content })
          this.emit('message', { role: 'assistant', content: result.content })
        } else {
          // 模型空收尾（无 toolCalls 且无 content）→ 对齐 TrieCode wrap-up 机制：
          // 追加"请总结"user 消息并用空工具集重调一次，强制模型输出纯文本总结
          if (!this.wrapupTried) {
            this.wrapupTried = true
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
              console.warn(`[Agent] wrap-up 总结调用失败: ${(e as Error).message}`)
            }
            if (this.stopped) return
            if (summary) {
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
        this.status = 'done'
        this.emit('status', { status: 'done' })
        this.emit('done', { stats: this.getStats() })
        return
      }

      // 达到最大轮次
      this.status = 'done'
      this.emit('message', { role: 'assistant', content: `（已达到最大轮次 ${this.maxTurns}，停止执行）` })
      this.emit('done', { stats: this.getStats(), reason: 'max_turns' })
    } catch (e) {
      this.status = 'error'
      this.emit('error', { message: (e as Error).message })
      this.emit('status', { status: 'error' })
    }
  }

  // ── 上下文压缩：折叠早期轮次，保留系统提示+最近消息+最近读文件摘要 ──
  private compressContext(): void {
    if (this.compressed) return
    this.compressed = true

    const systemMsg = this.messages[0] // 保留系统提示
    const recent = this.messages.slice(-COMPRESS_KEEP_RECENT) // 保留最近 N 条

    // 收集被折叠的工具结果中的文件读取内容（用于重注入）
    const folded = this.messages.slice(1, -COMPRESS_KEEP_RECENT)
    for (const msg of folded) {
      if (msg.role === 'tool' && msg.content) {
        try {
          const parsed = JSON.parse(msg.content) as { content?: string; ok?: boolean }
          if (parsed.ok && parsed.content && parsed.content.length < 5000) {
            // 简单追踪：工具结果中可能包含文件内容
            const key = `tool_${msg.name || 'unknown'}`
            this.recentReadFiles.set(key, parsed.content.slice(0, 500))
          }
        } catch {
          // 非 JSON 工具结果，跳过
        }
      }
    }

    // 构建压缩摘要
    const summary = `[上下文压缩] 已折叠 ${folded.length} 条早期消息（共 ${this.messages.length} 条）。保留最近 ${COMPRESS_KEEP_RECENT} 条。`

    // 重注入最近读文件摘要
    let reinject = ''
    if (this.recentReadFiles.size > 0) {
      const files = [...this.recentReadFiles.entries()].slice(0, 5)
      reinject = '\n\n最近操作摘要：\n' + files.map(([k, v]) => `- ${k}: ${v.slice(0, 200)}`).join('\n')
    }

    this.messages = [
      systemMsg,
      { role: 'system', content: summary + reinject },
      ...recent
    ]

    console.log(`[Agent] 上下文压缩: ${this.messages.length} 条消息（原 ${folded.length + COMPRESS_KEEP_RECENT + 1} 条）`)
    this.emit('thinking', { content: '（上下文已压缩，保留最近对话）', full: '' })
  }

  // ── 验证证据闸门 ──
  private checkVerificationGate(currentTurn: number): boolean {
    if (this.verifyPromptCount >= MAX_VERIFY_PROMPTS) return false
    if (this.lastFileModTurn < 0) return false
    // 修改文件后没有验证过，且修改发生在最近
    if (this.lastVerifyTurn < this.lastFileModTurn && currentTurn > this.lastFileModTurn) {
      return true
    }
    return false
  }

  // ── 反幻觉检测（对齐 TrieCode checkHallucination）──
  // 模型最终文本声称"已编译/已烧录/已验证/测试通过"，但本轮消息历史中没有对应工具调用证据 → 返回声称原文
  // 2026-10-02 增强：① 补"已成功写入/编译/烧录"变体（实测模型输出"文件已成功写入"绕过旧正则"已写入…成功"）；
  //                  ② 声称"已写入/已创建/已修改"时 write_file/edit_file/create_project 亦算证据
  private checkHallucination(text: string): string | null {
    const claims: Array<{ re: RegExp; evidence: string[] }> = [
      { re: /已(成功)?(编译|烧录|上传|部署|刷写)[^。\n]*成功|已成功(编译|烧录|上传|部署|刷写)|编译[^。\n]*通过|烧录[^。\n]*成功/i, evidence: ['compile', 'upload', 'run_tests'] },
      { re: /已(成功)?写入|已成功(写入|创建|修改|删除)|写入[^。\n]*成功|创建[^。\n]*成功/i, evidence: ['write_file', 'edit_file', 'create_project', 'terminal'] },
      { re: /(测试|验证)[^。\n]*(通过|成功|全绿)|全部通过/i, evidence: ['run_tests', 'compile', 'terminal'] },
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

  private buildSystemPrompt(kbBlocks?: string[]): string {
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
    const projectCfg = loadProjectConfigBlock(this.projectRoot)
    // 固件会话：整体替换为固件专用系统提示（身份即固件工程师）
    if (this.firmware?.firmware) {
      return this.buildFirmwareSystemPrompt(toolList, projectCfg)
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

## 输出规范
- 每次工具调用前后可以用简短文字说明进度（可选，不强制）
- **完成任务时，必须用自然语言输出最终回答（不少于 30 字）**：先一句话说明做了什么，然后直接给出结论或回应提问，需要时简短说明关键过程与产物位置。回答要自然、直接，像正常 AI 对话一样——**禁止使用"总结：/结果：/产物：/下一步建议：/注意事项："这类小标题模板，也不要机械地逐条列项**。禁止以空回复或纯工具调用结束任务——最后一步一定是文字回答。
${thinkGuide}
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
  private buildFirmwareSystemPrompt(toolList: string, projectCfg: string): string {
    const det = this.firmware
    const hw = det
      ? `框架: ${det.framework || '未知'} ｜ 构建系统: ${det.buildSystem || '未知'} ｜ 目标/板卡: ${det.mcu || '未知'} ｜ 识别置信度: ${(det.confidence * 100).toFixed(0)}% ｜ 依据: ${det.indicators.join(', ')}`
      : ''
    return `${projectCfg ? projectCfg + '\n\n' : ''}你是 LabCode 固件工作台中的 AI 固件工程师。

${FIRMWARE_RULES_BLOCK}

## 识别到的工程
${hw || '（未明确，可先询问用户或用工具扫描确认）'}

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

工具结果会返回给你，然后继续思考；达成目标并经构建/烧录/观察验证后，用自然语言汇报结果与产物位置。`
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
  private async callModel(useTools = true): Promise<{ content: string; toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> {
    const state = getAiState()
    const model = state.modelId || 'glm-4.7-flash'
    const toolSchemas = useTools ? toolRegistry.toFunctionSchemas() : []

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
        console.error(`[Agent] 模型调用失败: ${(e as Error).message}`)
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
    if (this.policy.needsConfirm(tool)) {
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

    // ── 无菌动作检测 ──
    const sterileKey = `${toolName}|${JSON.stringify(args).slice(0, 160)}`
    const sterileCount = (this.sterileActions.get(sterileKey) ?? 0) + 1
    this.sterileActions.set(sterileKey, sterileCount)

    if (sterileCount >= STERILE_MAX_REPEAT) {
      const result: ToolResult = {
        ok: false,
        content: '',
        error: `[系统提示] 工具 ${toolName} 已用相同参数重复执行 ${sterileCount} 次，疑似无效循环。请停止重复尝试，诊断根因后换一种实现方式，或向用户说明情况。`
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
      }
    }

    // ── 验证证据闸门：追踪文件修改和验证 ──
    if (this.isFileModifyTool(toolName) && result.ok) {
      this.lastFileModTurn = currentTurn
    }
    if (this.isVerificationTool(toolName, args) && result.ok) {
      this.lastVerifyTurn = currentTurn
    }

    // P0-2（对齐 TrieCode）：空工具输出注入占位符，防模型把空 tool_result 误判为 end-of-turn 停止生成
    const toolContent = result.ok && !String(result.content || '').trim()
      ? JSON.stringify({ ...result, content: '(工具执行完成，无输出)' })
      : JSON.stringify(result)
    this.messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: toolContent })
    this.emit('tool_result', { id: tc.id, name: toolName, result })
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

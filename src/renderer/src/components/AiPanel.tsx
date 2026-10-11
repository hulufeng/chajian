import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorTab } from './EditorArea'
import type { ChannelHealth } from '../../../preload'
import { hint } from '../featureHints'
import { isChimeEnabled, playChime } from '../lib/sound'
import DiffView from './DiffView'

// ---------- 类型 ----------
interface AiModel {
  id: string
  name: string
  costPerCall: number
  desc: string
  available: boolean
  multiplier?: number // 积分系数，如 2 表示 ×2
}

interface AiState {
  token: string | null
  email: string | null
  totalCredits: number | null
  modelId: string
  byok: { baseUrl: string; apiKey: string; model: string } | null
  byokProfiles?: { id: string; name: string; baseUrl: string; apiKey: string; model: string }[]
}

interface ContextItem {
  id: string
  name: string
  content: string
  kind: 'file' | 'attachment'
}

type Block = { type: 'text' | 'code'; lang?: string; content: string }

// Agent 消息类型（扩展）
type AgentMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown>; category: string }
  | { kind: 'tool_result'; id: string; name: string; result: { ok: boolean; content: string; error?: string }; rejected?: boolean }
  | { kind: 'system'; text: string }

interface ConfirmRequest {
  toolCallId: string
  toolName: string
  toolCategory: string
  arguments: Record<string, unknown>
  description: string
}

interface AgentStats {
  turns: number
  toolCalls: number
  elapsedMs: number
  inputTokens?: number
  outputTokens?: number
}

const INITIAL: AgentMessage[] = [
  { kind: 'assistant', text: '我是 LabCode AI 智能体。可以帮你写代码、执行命令、搜索网络、管理项目。\n\n我能真正动手：创建项目→写文件→运行→验证结果。\n\n提示：输入 `/` 查看命令，输入 `@` 引用当前打开的文件。' },
]

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前对话' },
  { cmd: '/new', desc: '新建对话' },
  { cmd: '/model', desc: '切换模型' },
  { cmd: '/context', desc: '管理引用上下文' },
  { cmd: '/help', desc: '显示帮助' },
]

const SECURITY_MODES = [
  { value: 'auto', label: '自动（直接执行）' },
  { value: 'default', label: '默认（增删改需确认）' },
  { value: 'plan', label: '计划（先计划后执行）' },
]

/** 多模式：对话 / 计划 / 自动 / 调试，分别映射到 Agent 安全策略与 debug 标志 */
type AgentMode = 'chat' | 'plan' | 'agent' | 'debug'
const AGENT_MODES: Array<{ value: AgentMode; label: string; hint: string }> = [
  { value: 'chat', label: '对话', hint: '只问答、不自动改文件；涉及操作先说明步骤' },
  { value: 'plan', label: '计划', hint: '先给出执行方案，你批准后再动手' },
  { value: 'agent', label: '自动', hint: '自主多步调用工具完成任务' },
  { value: 'debug', label: '调试', hint: '自动定位并修复编译/烧录错误（Debug 模式）' }
]

const THINKING_LEVELS = [
  { value: 'light', label: '轻量思考' },
  { value: 'standard', label: '标准思考' },
  { value: 'deep', label: '深度思考' },
]

// ---------- 工具函数 ----------
// 轻量 markdown 渲染（对齐 TrieCode/Cline 回答风格）：支持 **粗体**、`行内代码`、- 列表、1. 列表、# 标题。
// 纯 React 元素渲染，不注入 HTML，无 XSS 风险。
function LightMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let listBuf: { ordered: boolean; items: string[] } | null = null
  const flushList = (keyBase: string) => {
    if (listBuf) {
      const items = listBuf.items.map((it, i) => <li key={`${keyBase}-li-${i}`}>{inlineMd(it)}</li>)
      out.push(listBuf.ordered
        ? <ol key={`${keyBase}-ol`}>{items}</ol>
        : <ul key={`${keyBase}-ul`}>{items}</ul>)
      listBuf = null
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flushList(`h-${i}`)
      const lv = h[1].length
      out.push(lv === 1
        ? <h4 key={`h-${i}`}>{inlineMd(h[2])}</h4>
        : lv === 2
          ? <h5 key={`h-${i}`}>{inlineMd(h[2])}</h5>
          : <h6 key={`h-${i}`}>{inlineMd(h[2])}</h6>)
      continue
    }
    const ul = /^[-*]\s+(.*)$/.exec(line)
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const content = (ul || ol)![1]
      if (!listBuf || listBuf.ordered !== !!ol) {
        flushList(`b-${i}`)
        listBuf = { ordered: !!ol, items: [] }
      }
      listBuf.items.push(content)
      continue
    }
    flushList(`t-${i}`)
    if (!line.trim()) { out.push(<div key={`b-${i}`} className="ai-md-blank" />); continue }
    out.push(<div key={`t-${i}`}>{inlineMd(line)}</div>)
  }
  flushList('end')
  return <>{out}</>
}

function inlineMd(line: string): React.ReactNode[] {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>
    return p
  })
}

// token 用量格式化（对齐 TrieCode 计量条："输入 23.6k · 输出 58"）
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const regex = /```(\w+)?\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) blocks.push({ type: 'text', content: text.slice(last, m.index) })
    blocks.push({ type: 'code', lang: m[1] || '', content: m[2] })
    last = regex.lastIndex
  }
  if (last < text.length) blocks.push({ type: 'text', content: text.slice(last) })
  return blocks
}

function categoryColor(cat: string): string {
  switch (cat) {
    case 'read': return 'var(--success)'
    case 'write': return 'var(--warning)'
    case 'execute': return 'var(--accent)'
    case 'query': return 'var(--violet)'
    default: return 'var(--text-3)'
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'read': return '读取'
    case 'write': return '写入'
    case 'execute': return '执行'
    case 'query': return '查询'
    default: return cat
  }
}

// ---------- 组件 ----------
function CodeBlock({ lang, content, onApply, onRunTerminal }: { lang: string; content: string; onApply?: (lang: string, content: string) => void; onRunTerminal?: (cmd: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const isShell = ['bash', 'shell', 'sh', 'powershell', 'ps1', 'cmd'].includes(lang.toLowerCase())
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div className="ai-codeblock">
      <div className="ai-codeblock-head">
        <span className="ai-codeblock-lang">{lang || 'code'}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {onApply && <button className="ai-codeblock-copy" onClick={() => onApply(lang, content)}>应用到文件</button>}
          {isShell && onRunTerminal && <button className="ai-codeblock-copy" onClick={() => onRunTerminal(content.trim())}>▶ 在终端运行</button>}
          <button className="ai-codeblock-copy" onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
        </div>
      </div>
      <pre className="ai-codeblock-pre"><code>{content}</code></pre>
    </div>
  )
}

// ── 工具中文名映射（对齐 TrieCode：AI 面板工具卡片显示中文名）──
const TOOL_CN_NAMES: Record<string, string> = {
  // 文件
  list_files: '列出文件', read_file: '读取文件', write_file: '写文件', edit_file: '编辑文件',
  open_project: '打开项目', create_project: '创建项目', delete_file: '删除文件',
  // 执行与测试
  terminal: '终端命令', run_tests: '运行测试', background_task: '后台任务', run_command: '运行命令',
  // 嵌入式
  compile: '编译', upload: '烧录', serial_monitor: '串口监视', serial_send: '串口发送', serial_read: '串口读取',
  serial_stop: '关闭串口', serial_log_tail: '串口日志', serial_log_grep: '串口检索', analyze_crash: '崩溃分析',
  // 任务与协作
  todo_write: '任务清单', todo_list: '查看清单', todo_done: '完成任务', ask_user: '询问用户',
  // 记忆/技能/搜索
  save_memory: '保存记忆', recall_memory: '检索记忆', read_skill: '读取技能', list_skills: '技能列表', create_skill: '创建技能',
  web_search: '搜索网络', web_fetch: '抓取网页', search_files: '搜索文件', grep: '全文检索',
  // 板卡/库/计划
  select_board: '选择板卡', list_boards: '板卡列表', arduino_lib: '库管理', submit_plan: '提交计划',
}
function toolCnName(name: string): string {
  return TOOL_CN_NAMES[name] || name
}

function ToolCallCard({ msg }: { msg: Extract<AgentMessage, { kind: 'tool_call' }> }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="agent-tool-call" style={{ borderLeft: `3px solid ${categoryColor(msg.category)}` }}>
      <div className="agent-tool-head" onClick={() => setExpanded((v) => !v)}>
        <span className="agent-tool-icon" style={{ color: categoryColor(msg.category) }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z"/></svg>
        </span>
        <span className="agent-tool-name">{toolCnName(msg.name)}<span className="agent-tool-en">({msg.name})</span></span>
        <span className="agent-tool-cat" style={{ background: categoryColor(msg.category) }}>{categoryLabel(msg.category)}</span>
        <span className="agent-tool-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="agent-tool-args">
          <pre>{JSON.stringify(msg.args, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

function ToolResultCard({ msg }: { msg: Extract<AgentMessage, { kind: 'tool_result' }> }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const ok = msg.result.ok && !msg.rejected
  // 识别 diff 块：```diff ... ```
  const content = msg.result.content || ''
  const diffMatch = content.match(/```diff\n([\s\S]*?)```/)
  const beforeDiff = diffMatch ? content.slice(0, diffMatch.index).trim() : ''
  const afterDiff = diffMatch ? content.slice((diffMatch.index || 0) + diffMatch[0].length).trim() : ''
  return (
    <div className="agent-tool-result" style={{ borderLeft: `3px solid ${ok ? 'var(--success)' : 'var(--error)'}` }}>
      <div className="agent-tool-head" onClick={() => setExpanded((v) => !v)}>
        <span className="agent-tool-icon" style={{ color: ok ? 'var(--success)' : 'var(--error)' }}>
          {ok ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4.5 12.75 6 6 9-13.5"/></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18 18 6M6 6l12 12"/></svg>
          )}
        </span>
        <span className="agent-tool-name">{toolCnName(msg.name)}<span className="agent-tool-en">({msg.name})</span></span>
        <span className="agent-tool-status" style={{ color: ok ? 'var(--success)' : 'var(--error)' }}>
          {msg.rejected ? '已拒绝' : ok ? '成功' : '失败'}
        </span>
        <span className="agent-tool-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {!expanded && diffMatch && (
        <div style={{ padding: '4px 12px', fontSize: 11 }}>
          <DiffView text={diffMatch[1]} />
        </div>
      )}
      {expanded && (
        <div className="agent-tool-output">
          {msg.result.error && <div className="agent-tool-error">{msg.result.error}</div>}
          {beforeDiff && <pre>{beforeDiff}</pre>}
          {diffMatch && <DiffView text={diffMatch[1]} />}
          {afterDiff && <pre>{afterDiff}</pre>}
          {!diffMatch && <pre>{content}</pre>}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="agent-thinking">
      <div className="agent-thinking-head" onClick={() => setExpanded((v) => !v)}>
        <span className="agent-thinking-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>
        </span>
        <span>思考过程</span>
        <span className="agent-tool-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && <div className="agent-thinking-content">{text}</div>}
    </div>
  )
}

function MessageBubble({ msg, onApply, onRunTerminal, onRegenerate, onEdit, onRewind }: {
  msg: AgentMessage
  onApply?: (lang: string, content: string) => void
  onRunTerminal?: (cmd: string) => void
  onRegenerate?: () => void
  onEdit?: () => void
  onRewind?: () => void
}): React.JSX.Element | null {
  if (msg.kind === 'tool_call') return <ToolCallCard msg={msg} />
  if (msg.kind === 'tool_result') return <ToolResultCard msg={msg} />
  if (msg.kind === 'thinking') return <ThinkingBlock text={msg.text} />
  if (msg.kind === 'system') return <div className="agent-system-msg">{msg.text}</div>

  const text = msg.text
  const blocks = useMemo(() => parseBlocks(text), [text])
  const hasOps = (msg.kind === 'user' || msg.kind === 'assistant') && (onRegenerate || onEdit || onRewind)
  return (
    <div className={`msg ${msg.kind}`}>
      {blocks.map((b, i) =>
        b.type === 'code' ? (
          <CodeBlock key={i} lang={b.lang ?? ''} content={b.content} onApply={onApply} onRunTerminal={onRunTerminal} />
        ) : (
          <div key={i} className="ai-text">
            <LightMarkdown text={b.content} />
          </div>
        )
      )}
      {hasOps && (
        <div className="ai-msg-ops">
          {msg.kind === 'user' && onRegenerate && (
            <button title="重新生成（重发这条提问）" onClick={onRegenerate}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 12a7.5 7.5 0 0 1 13.2-5.2L21 9m0-5v5h-5M19.5 12a7.5 7.5 0 0 1-13.2 5.2L3 15m0 5v-5h5"/></svg>
            </button>
          )}
          {msg.kind === 'user' && onEdit && (
            <button title="编辑并重发" onClick={onEdit}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>
            </button>
          )}
          {onRewind && (
            <button title="回退到这里（移除之后的消息）" onClick={onRewind}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- 主组件 ----------
interface AiPanelProps {
  tabs: EditorTab[]
  activePath: string
  projectRoot: string | null
  onApplyCode?: (lang: string, content: string) => void
  onRunTerminal?: (cmd: string) => void
  onOpenSettings?: () => void
  prefill?: { text: string; nonce: number; autoSend?: boolean } | null
}

function AiPanel({ tabs, activePath, projectRoot, onApplyCode, onRunTerminal, onOpenSettings, prefill }: AiPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>(INITIAL)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [agentStatus, setAgentStatus] = useState<string>('idle')
  const [stats, setStats] = useState<AgentStats>({ turns: 0, toolCalls: 0, elapsedMs: 0 })
  const [mode, setMode] = useState<AgentMode>('agent')
  // 由模式派生：chat/debug → default（需确认/受控），plan → plan，agent → auto
  const securityMode: 'auto' | 'default' | 'plan' =
    mode === 'plan' ? 'plan' : mode === 'agent' ? 'auto' : 'default'
  const debugMode = mode === 'debug'
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [askReq, setAskReq] = useState<{ questions: Array<{ question: string; type?: string; options?: string[] }>; decisionId: string } | null>(null)
  const [askAnswers, setAskAnswers] = useState<string[]>([])
  const [streamingText, setStreamingText] = useState('')
  // 模型思考过程（reasoning 增量）与正文（content 增量）是两个独立的流，必须分开存。
  // 早前两者都写 streamingThinking，导致推理内容把正在输出的正文覆盖掉。
  const [streamingThinking, setStreamingThinking] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  // 计划审批（submit_plan）：主进程等用户决策才继续，UI 要给出批准/驳回/要求修改三个出口
  const [planReq, setPlanReq] = useState<{ plan: string; decisionId: string } | null>(null)
  const [planFeedback, setPlanFeedback] = useState('')
  // 实时工作计时（对齐 TrieCode"已工作 16s"跳动样式；busy 时每秒递增）
  const [elapsedTick, setElapsedTick] = useState(0)

  const [models, setModels] = useState<AiModel[]>([])
  // 通道健康 / 云端错误：让「能不能用」在界面上直接可见
  const [health, setHealth] = useState<ChannelHealth | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  // 本地引擎一键启动：ok=null 表示进行中（界面显示「启动中…」）
  const [engineStarting, setEngineStarting] = useState(false)
  // 后台自动接上上次用的本地模型（不等用户点按钮）
  const [engineAuto, setEngineAuto] = useState(false)
  const [engineMsg, setEngineMsg] = useState<{ text: string; ok: boolean | null } | null>(null)
  const [state, setState] = useState<AiState | null>(null)
  const [showByok, setShowByok] = useState(false)
  const [byokForm, setByokForm] = useState({ baseUrl: '', apiKey: '', model: '' })
  const [byokSaved, setByokSaved] = useState(false)

  const [contextItems, setContextItems] = useState<ContextItem[]>([])
  // 对话 token 估算：中文约 1.5 字符/token（近似，仅 UI 展示）
  const dialogTokens = useMemo(() => {
    let chars = 0
    for (const m of messages) if ('text' in m) chars += m.text.length
    for (const c of contextItems) chars += c.content.length
    return Math.round(chars / 1.5)
  }, [messages, contextItems])
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [showTokenPanel, setShowTokenPanel] = useState(false)
  // 精简模式（对齐 TrieCode：默认只保留对话+输入框，高级项折叠，localStorage 记忆）
  const [showAdvanced, setShowAdvanced] = useState(() => localStorage.getItem('codelab-ai-advanced') === '1')
  const [localModels, setLocalModels] = useState<Array<{ id: string; name: string; sizeGB: number }>>([])
  const [useLocalModel, setUseLocalModel] = useState(false)
  const [selectedLocalModel, setSelectedLocalModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<'light' | 'standard' | 'deep'>(
    () => (localStorage.getItem('codelab-thinking') as 'light' | 'standard' | 'deep') || 'standard'
  )
  // 本地小模型工具能力提示条（可关闭，localStorage 持久化）
  const [smallModelTipDismissed, setSmallModelTipDismissed] = useState(
    () => localStorage.getItem('codelab-small-model-tip') === '1'
  )
  const showSmallModelTip = !smallModelTipDismissed && useLocalModel && /qwen2\.5(?:-coder)?-1\.5b/i.test(selectedLocalModel || '')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sendRef = useRef<() => Promise<void>>(() => Promise.resolve())
  // 语音输入（Web Speech 识别：桌面 Chromium 引擎为在线服务，network 错误即服务不可达）
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const voiceErrRef = useRef<{ type: string; t: number } | null>(null)

  // AI 面板宽度（可拖拽 220-420px，TrieCode 对齐；上限收窄避免挤压编辑器）
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('codelab-ai-width'))
    return saved >= 220 && saved <= 420 ? saved : 300
  })
  const widthRef = useRef(panelWidth)
  useEffect(() => { widthRef.current = panelWidth }, [panelWidth])
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: widthRef.current }
    document.body.classList.add('ai-resizing')
    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return
      const w = Math.min(420, Math.max(220, dragRef.current.startW - (ev.clientX - dragRef.current.startX)))
      setPanelWidth(w)
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.classList.remove('ai-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('codelab-ai-width', String(widthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const toggleVoice = (): void => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    type SRType = new () => {
      lang: string
      interimResults: boolean
      maxAlternatives: number
      continuous: boolean
      start: () => void
      stop: () => void
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
      onerror: ((e: { error: string }) => void) | null
      onend: (() => void) | null
    }
    const SR = (window as unknown as { SpeechRecognition?: SRType; webkitSpeechRecognition?: SRType }).SpeechRecognition
      ?? (window as unknown as { SpeechRecognition?: SRType; webkitSpeechRecognition?: SRType }).webkitSpeechRecognition
    if (!SR) {
      setMessages((p) => [...p, { kind: 'assistant', text: '当前环境不支持语音识别（需要 Chromium 内核，请更新 LabCode）' }])
      return
    }
    const rec = new SR()
    recognitionRef.current = rec
    rec.lang = 'zh-CN'
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.continuous = false
    rec.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      const t = text.trim()
      if (t) setInput((v) => (v.trim() ? v.trimEnd() + ' ' + t : t))
    }
    rec.onerror = (e) => {
      setListening(false)
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setMessages((p) => [...p, { kind: 'assistant', text: '未获得麦克风权限：请在系统设置中允许 LabCode 使用麦克风后重试。' }])
      } else if (e.error === 'no-speech') {
        // 静音超时：只复位按钮，不打扰用户
      } else if (e.error === 'aborted') {
        // 用户主动停止，不提示
      } else {
        // 去重限流：同类型错误 30s 内只提示一次，避免刷屏
        const now = Date.now()
        const prev = voiceErrRef.current
        if (prev && prev.type === e.error && now - prev.t < 30000) return
        voiceErrRef.current = { type: e.error, t: now }
        const msg = e.error === 'network'
          ? '语音识别服务不可用：当前桌面识别引擎需要联网（在线引擎），请稍后重试或用键盘输入。'
          : `语音识别失败：${e.error}`
        setMessages((p) => [...p, { kind: 'assistant', text: msg }])
      }
    }
    rec.onend = () => setListening(false)
    rec.start()
    setListening(true)
  }

  // 预填引导语（来自欢迎页「辅助编程 / 解决问题」或「一键 AI 诊断」入口）
  useEffect(() => {
    if (!prefill) return
    if (prefill.text) setInput(prefill.text)
    inputRef.current?.focus()
    if (prefill.autoSend && prefill.text) {
      const t = setTimeout(() => { void sendRef.current() }, 80)
      return () => clearTimeout(t)
    }
  }, [prefill])

  // 加载模型和状态
  useEffect(() => {
    void load()
  }, [])

  // 订阅 Agent 事件
  useEffect(() => {
    const cleanup = window.api.agent.onEvent((event) => {
      switch (event.type) {
        case 'thinking': {
          const d = event.data as { content?: string; full?: string }
          if (d?.full !== undefined) setStreamingThinking(d.full)
          break
        }
        case 'reasoning': {
          const d = event.data as { content?: string; full?: string }
          if (d?.full !== undefined) setStreamingReasoning(d.full)
          break
        }
        case 'tool_call': {
          const d = event.data as { id: string; name: string; arguments: Record<string, unknown>; category: string }
          setMessages((prev) => [...prev, { kind: 'tool_call', id: d.id, name: d.name, args: d.arguments, category: d.category }])
          break
        }
        case 'tool_result': {
          const d = event.data as { id: string; name: string; result: { ok: boolean; content: string; error?: string }; rejected?: boolean }
          setMessages((prev) => [...prev, { kind: 'tool_result', id: d.id, name: d.name, result: d.result, rejected: d.rejected }])
          break
        }
        case 'message': {
          const d = event.data as { role: string; content: string }
          if (d?.content) {
            setMessages((prev) => [...prev, { kind: d.role as 'user' | 'assistant', text: d.content }])
          }
          setStreamingText('')
          setStreamingThinking('')
          setStreamingReasoning('')
          break
        }
        case 'plan': {
          const d = event.data as { plan?: string; decisionId?: string }
          setPlanReq({ plan: d?.plan || '', decisionId: d?.decisionId || '' })
          setPlanFeedback('')
          break
        }
        case 'need_confirm': {
          const d = event.data as ConfirmRequest
          setConfirmReq(d)
          break
        }
        case 'ask_user': {
          const d = event.data as { questions: Array<{ question: string; type?: string; options?: string[] }>; decisionId: string }
          setAskReq(d)
          setAskAnswers(new Array(d.questions?.length || 0).fill(''))
          break
        }
        case 'status': {
          const d = event.data as { status: string }
          setAgentStatus(d.status)
          if (d.status === 'done' || d.status === 'error' || d.status === 'stopped') {
            setBusy(false)
            setConfirmReq(null)
            setAskReq(null)
          }
          break
        }
        case 'stats': {
          const d = event.data as AgentStats
          setStats(d)
          break
        }
        case 'done': {
          const d = event.data as { stats?: AgentStats }
          if (d?.stats) setStats(d.stats) // 收尾 stats（含累计 token 用量）
          setBusy(false)
          setStreamingText('')
          setStreamingThinking('')
          setStreamingReasoning('')
          // 完成提示音：长任务跑几分钟时用户会切走干别的，靠这一声把他叫回来。
          // 失败不响 —— 错误有自己的红色消息条，再响一声反而像成功。
          if (isChimeEnabled()) playChime()
          break
        }
        case 'error': {
          const d = event.data as { message: string }
          setMessages((prev) => [...prev, { kind: 'assistant', text: `错误：${d?.message || '未知错误'}` }])
          setBusy(false)
          break
        }
      }
    })
    return cleanup
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, streamingThinking, streamingReasoning])

  // 通道健康度低频刷新。
  // 之前只在面板打开时拉一次：主进程在后台自动接上本地引擎（十几秒）之后，
  // 界面还停在「本地引擎未启动」，用户会以为没接上、又点一次「一键启动」。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (engineStarting || engineAuto) return // 启动过程中不打扰，交给那边的轮询
      window.api.aiHealth
        .get()
        .then(setHealth)
        .catch(() => undefined)
    }, 8000)
    return () => window.clearInterval(t)
  }, [engineStarting, engineAuto])

  // 实时工作计时器：busy 时每秒 tick，驱动"已工作 Ns"实时跳动（对齐 TrieCode）
  useEffect(() => {
    if (!busy) return
    setElapsedTick(0)
    const t = setInterval(() => setElapsedTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  const load = async (): Promise<void> => {
    // 三路分别容错：云端未登录/过期时，本地模型与 BYOK 仍然可用，
    // 不能因为一个 Promise reject 就把整个面板状态清空（那正是「看着有模型却发不出消息」的成因）。
    const [mRes, sRes, localRes] = await Promise.allSettled([
      window.api.ai.models(),
      window.api.ai.state(),
      window.api.model.local().catch(() => [])
    ])

    const m = mRes.status === 'fulfilled' ? mRes.value : []
    if (mRes.status === 'fulfilled') {
      setModels(m)
      setCloudError(null)
    } else {
      setModels([])
      setCloudError((mRes.reason as Error)?.message || '内置模型服务不可用')
    }

    const s = sRes.status === 'fulfilled' ? sRes.value : null
    if (s) {
      setState(s)
      setByokForm(s.byok ?? { baseUrl: '', apiKey: '', model: '' })
      if (s.modelId === 'byok' || s.modelId.startsWith('byok:')) setShowByok(true)
      if (s.modelId.startsWith('local:')) {
        setUseLocalModel(true)
        setSelectedLocalModel(s.modelId.replace('local:', ''))
        // 上次就在用本地模型 → 确保引擎真在跑。
        // 只看界面显示是不够的：主进程的本地通道没同步的话，发消息会静默降级回云端。
        const file = s.modelId.replace('local:', '')
        setEngineAuto(true)
        window.api.engine
          .ensure({ model: file })
          .then((r) => {
            if (!r.ready) setEngineMsg({ text: `本地引擎没能接上：${r.error || r.reason || '未启动'}；发消息前可以先点「一键启动」`, ok: false })
          })
          .catch(() => undefined)
          .finally(() => setEngineAuto(false))
      }
    }

    const local = localRes.status === 'fulfilled' ? localRes.value : []
    setLocalModels(local)
    if (local.length > 0) {
      // 有本地模型时优先用本地（云端不可用也能干活）
      const id = local.find((x) => x.id.toLowerCase().includes('coder-3b'))?.id || local[0].id
      if (!s?.modelId?.startsWith('local:')) {
        setUseLocalModel(true)
        setSelectedLocalModel(id)
        window.api.ai.setModel(`local:${id}`).catch(() => undefined)
      }
    }

    window.api.aiHealth
      .get()
      .then(setHealth)
      .catch(() => undefined)
  }

  /** 一键启动本地引擎：挑最优模型 → 后台拉起 → 边等边轮询状态灯 → 就绪后按需切到本地通道 */
  const startLocalEngine = async (): Promise<void> => {
    if (engineStarting) return
    // 优先代码模型：3B > 1.5B > 列表第一个
    const best =
      localModels.find((m) => /coder-3b/i.test(m.id)) ||
      localModels.find((m) => /coder/i.test(m.id)) ||
      localModels[0]
    if (!best) {
      setEngineMsg({ text: '没有可启动的本地模型，请先到「设置 → 本地引擎 / 模型」下载', ok: false })
      return
    }
    setEngineStarting(true)
    setEngineMsg({ text: `正在启动本地引擎（${best.name}）…`, ok: null })
    // 关键：不等 IPC 返回才刷状态。引擎加载模型要 10~30s，
    // 期间轮询引擎状态，一旦 ready 就立刻把状态灯变绿，用户不会以为卡死。
    const poll = window.setInterval(() => {
      window.api.engine
        .status()
        .then((s) => {
          if (s.running) setHealth((h) => (h ? { ...h, localReady: true, engineRunning: true, engineHint: 'running' } : h))
        })
        .catch(() => undefined)
    }, 1500)
    try {
      const r = await window.api.engine.start({ model: best.id })
      if (r.ok) {
        const modelId = r.model || best.id
        // 只在「当前没有可用的非本地通道」时才自动切到本地 ——
        // 用户既然点了启动，意图就是离线跑；但若他明确在用 BYOK，不抢他的选择。
        const fallback = !health?.localReady && !health?.byokActive
        if (fallback) {
          setUseLocalModel(true)
          setSelectedLocalModel(modelId)
          void window.api.ai.setModel(`local:${modelId}`)
        }
        setEngineMsg({ text: `本地引擎已就绪（${best.name}）${fallback ? '，已切换到本地通道（离线、不耗积分）' : '，可在模型下拉里选本地模型'}`, ok: true })
      } else {
        setEngineMsg({
          text: `启动失败：${r.error || '未知错误'}${/超时|内存/.test(r.error || '') ? ' —— 可改选更小的 1.5B 模型，或关闭其他占内存的程序后重试' : ''}`,
          ok: false
        })
      }
    } catch (e) {
      setEngineMsg({ text: `启动失败：${(e as Error).message}`, ok: false })
    } finally {
      window.clearInterval(poll)
      setEngineStarting(false)
      window.api.aiHealth.get().then(setHealth).catch(() => undefined)
    }
  }

  // 通道健康条：把「现在能不能用」和「下一步该干什么」分开讲。
  // 之前只有红/绿两态，本地引擎没启动时也显示成绿色「已登录」，用户以为能用。
  const localIdle = health?.engineHint === 'idle'
  const healthTone: string = engineStarting
    ? 'busy'
    : health?.localReady
      ? 'ok'
      : localIdle || health?.engineHint === 'not-installed' || health?.engineHint === 'no-models'
        ? 'warn'
        : cloudError
          ? 'bad'
          : 'ok'
  // 主行只讲「当前用的是哪条通道」；引擎启动进度归到下面那一行，避免两行说同一件事
  const healthText: string = health?.localReady
    ? `本地引擎就绪（${health.localModel || '离线模型'}）· 不耗积分、代码不出本机`
      // 引擎「已装+有模型但没启动」不占主行 —— 那部分归下面那行带按钮的，两行说一件事就啰嗦了
      : health?.engineHint === 'not-installed'
          ? '本地引擎未安装（llama.cpp 引擎缺失）'
          : health?.engineHint === 'no-models'
            ? '本地引擎已安装，但还没有模型文件'
            : cloudError
              ? `内置模型服务不可用（${cloudError}）`
              : health?.byokActive
                ? `自定义模型通道：${health.byokActive}`
                : health?.loggedIn
                  ? '已登录，使用内置模型'
                  : '未登录：内置模型不可用，可在设置里登录或改用本地/自定义模型'
  const healthAction: { label: string; text: string; onClick: () => void; disabled?: boolean; title?: string } | null =
    engineStarting || engineAuto
        ? {
            label: '启动中…',
            text: engineMsg?.ok === null ? engineMsg.text : '正在后台接上本地引擎…（就绪时状态灯自动变绿）',
            onClick: startLocalEngine,
            disabled: true,
            title: '正在拉起 llama 引擎并加载 gguf 模型，就绪瞬间状态灯会变绿'
          }
      : localIdle
        ? {
            label: '一键启动',
            text: `本地引擎未启动（已下载 ${health?.localModelCount ?? 0} 个模型）· 离线可用，不耗积分、代码不出本机`,
            onClick: startLocalEngine,
            disabled: false,
            title: '一键拉起 llama 引擎并加载本地模型（默认选 qwen2.5-coder-3b）'
          }
        : null

  const buildUserText = (text: string, inject?: { name: string; content: string }): string => {
    const items = inject ? [inject, ...contextItems] : contextItems
    if (items.length === 0) return text
    const ctx = items.map((c) => `--- ${c.name} ---\n${c.content}`).join('\n\n')
    return `[引用上下文]\n${ctx}\n\n[用户问题]\n${text}`
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    if (text.startsWith('/')) {
      handleSlash(text)
      setInput('')
      return
    }
    // P0 确定性上下文注入（对齐 TrieCode 读文件链路）：检测"读取/查看/分析当前文件"意图时，
    // 自动把当前打开文件内容注入上下文——本地小模型工具决策能力弱，替它做决策，无需 read_file 也能答对
    const fileIntent = /(读取|看看|读一下|读一读|打开|查看|内容|实现什么|干什么的|分析|解释|讲一下).*(文件|代码|这个|当前)|(文件|代码|这个).*(是什么|实现|干嘛|功能|内容|写了|分析|解释|讲)/.test(text)
    // 修改类意图（对齐 TrieCode"应用到文件"交互）：检测"修改/改成/优化"请求 → 注入文件内容 + 附加输出指令
    const modifyIntent = /(修改|改成|换成|改一下|改一改|优化|升级|加个|加上|添加|调整|把.*(改成|改为|变成|调成|加上|去掉|删除)|重写|重构)/.test(text)
    let autoInjected: { name: string; content: string } | undefined
    let modifyHint = ''
    if ((fileIntent || modifyIntent) && activeTab && !contextItems.some((c) => c.id === `file-${activeTab.id}`)) {
      // 优先从主进程实时读文件（tabs.content 异步填充可能滞后）；失败回退 tab.content
      let content = activeTab.content || ''
      try {
        const r = await window.api.fs.read(activePath)
        if (typeof r === 'string' && r) content = r
      } catch { /* fallback */ }
      autoInjected = { name: activeTab.name, content: content || '(空文件)' }
      if (modifyIntent) {
        modifyHint = '【要求】用户要修改上面的代码。请直接输出修改后的完整代码，用 ``` 代码块包裹（不要省略、不要用注释占位），不要调用工具，不要请求批准。用户会点击代码块上的「应用到文件」按钮写入。'
        setMessages((prev) => [...prev, { kind: 'system', text: `已自动引用当前打开的文件：${activeTab.name}（检测到修改请求，请直接给出修改后的完整代码）` }])
      } else {
        setMessages((prev) => [...prev, { kind: 'system', text: `已自动引用当前打开的文件：${activeTab.name}` }])
      }
    }
    setMessages((prev) => [...prev, { kind: 'user', text }])
    setInput('')
    // 修改类请求：在用户文本后附加输出指令（引导模型输出完整代码块，绕过工具/批准链路）
    await doSend(modifyHint ? `${text}\n\n${modifyHint}` : text, undefined, autoInjected)
  }
  sendRef.current = send

  // 统一发送入口（消息操作/正常发送共用）
  const doSend = async (text: string, historyOverride?: { role: 'user' | 'assistant'; content: string }[], injectFile?: { name: string; content: string }): Promise<void> => {
    if (!text || busy) return
    setBusy(true)
    setStreamingText('')
    setStreamingThinking('')
    setStreamingReasoning('')
    setAgentStatus('thinking')

    // 使用 Agent 模式
    const history = historyOverride ?? messages
      .filter((m) => m.kind === 'user' || m.kind === 'assistant')
      .map((m) => ({ role: m.kind, content: m.text }))
    history.push({ role: 'user', content: buildUserText(text, injectFile) })

    try {
      // 统一走 Agent 模式：云端模型和本地 Ollama 模型都支持工具调用
      await window.api.agent.start({
        messages: history,
        localModel: useLocalModel && selectedLocalModel ? selectedLocalModel : undefined,
        securityMode,
        thinkingLevel,
        projectRoot,
        maxTurns: 20,
        debugMode,
      })
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'assistant', text: `启动失败：${(e as Error).message}` }])
      setBusy(false)
    }
  }

  // 重新生成：截断到该条提问之后，重发该条
  const regenerate = (idx: number): void => {
    const m = messages[idx]
    if (!m || m.kind !== 'user' || busy) return
    const text = m.text
    const before = messages.slice(0, idx)
    const hist = before
      .filter((x) => x.kind === 'user' || x.kind === 'assistant')
      .map((x) => ({ role: x.kind as 'user' | 'assistant', content: x.text }))
    setMessages([...before, { kind: 'user', text }])
    void doSend(text, hist)
  }

  // 编辑重发：截断该条并把它文本放回输入框
  const editResend = (idx: number): void => {
    const m = messages[idx]
    if (!m || m.kind !== 'user' || busy) return
    setMessages((prev) => prev.slice(0, idx))
    setInput(m.text)
    inputRef.current?.focus()
  }

  // 回退到这里：移除该条之后的所有消息
  const rewindTo = (idx: number): void => {
    if (busy) return
    setMessages((prev) => prev.slice(0, idx + 1))
  }

  const newChat = (): void => {
    setMessages(INITIAL)
    setContextItems([])
    setStreamingText('')
    setStreamingThinking('')
    setStreamingReasoning('')
    // busy/agentStatus 必须一起复位：agent 正在跑时点「新建对话」，
    // 旧会话的流式回调还会往新会话里灌字，发送按钮会永久 disabled（面板假死）。
    setBusy(false)
    setAgentStatus('idle')
    setShowTokenPanel(false)
  }

  /**
   * 所有「点了就要把 UI 复位」的异步操作都必须带兜底。
   * 踩过的坑：stopAgent 里 `await agent.stop()` 没有 catch，
   * 一旦主进程那边没在运行中共（reject），后面的 setBusy(false) 根本不执行 ——
   * 发送按钮永久 disabled，整个面板假死，用户只能杀进程。
   * 凡是「发消息给主进程」的动作，统一这条形状：先复位 UI，再谈结果。
   */
  const stopAgent = async (): Promise<void> => {
    setBusy(false)
    setConfirmReq(null)
    setAskReq(null)
    setAgentStatus('stopped')
    try {
      await window.api.agent.stop()
      setMessages((prev) => [...prev, { kind: 'system', text: '（用户已停止）' }])
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'system', text: `（停止未生效：${(e as Error).message}）` }])
    }
  }

  const respondConfirm = async (action: 'allow_once' | 'allow_session' | 'reject'): Promise<void> => {
    setConfirmReq(null)
    try {
      await window.api.agent.respond(action)
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'assistant', text: `确认没能送达 Agent：${(e as Error).message}` }])
    }
  }

  const submitPlan = async (action: 'approve' | 'reject' | 'feedback'): Promise<void> => {
    setPlanReq(null)
    try {
      await window.api.agent.planRespond({ action, feedback: planFeedback.trim() || undefined })
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'assistant', text: `计划审批没能送达 Agent：${(e as Error).message}` }])
    }
  }

  const submitAsk = async (): Promise<void> => {
    if (!askReq) return
    const answers = askAnswers.map((a, i) => {
      const q = askReq.questions[i]
      if (q?.type === 'yesno') return (a === 'true' || a === '1' || a === '是') ? '是' : '否'
      return (a || '').trim() || '（未回答）'
    })
    setAskReq(null)
    try {
      await window.api.agent.askRespond({ answers })
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'assistant', text: `回答没能送达 Agent：${(e as Error).message}` }])
    }
  }

  const skipAsk = async (): Promise<void> => {
    if (!askReq) return
    setAskReq(null)
    try {
      await window.api.agent.askRespond({ answers: [] })
    } catch (e) {
      setMessages((prev) => [...prev, { kind: 'assistant', text: `跳过没能送达 Agent：${(e as Error).message}` }])
    }
  }

  const handleSlash = (cmd: string): void => {
    const c = cmd.split(' ')[0].toLowerCase()
    switch (c) {
      case '/clear':
      case '/new':
        setMessages(INITIAL)
        setContextItems([])
        break
      case '/model':
        setShowByok(true)
        break
      case '/context':
        setShowContext((v) => !v)
        break
      case '/help':
        setMessages((prev) => [...prev, {
          kind: 'assistant',
          text: '可用命令：\n/clear 清空对话\n/new 新建对话\n/model 切换/管理模型\n/context 管理引用上下文\n/help 显示帮助\n\n我可以真正动手：创建项目、写文件、执行命令、搜索网络。试试说"创建一个Python项目写Hello World并运行"。',
        }])
        break
      default:
        setMessages((prev) => [...prev, { kind: 'assistant', text: `未知命令：${cmd}，输入 /help 查看可用命令。` }])
    }
    setShowSlash(false)
  }

  const addFileContext = (tab: EditorTab): void => {
    const id = `file-${tab.id}`
    setContextItems((prev) => (prev.some((c) => c.id === id) ? prev : [...prev, { id, name: tab.name, content: tab.content || '(空文件)', kind: 'file' }]))
    setShowMention(false)
  }

  const onPickAttachment = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result ?? '')
      setContextItems((prev) => [...prev, { id: `att-${Date.now()}`, name: file.name, content, kind: 'attachment' }])
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const removeContext = (id: string): void => setContextItems((prev) => prev.filter((c) => c.id !== id))

  const changeModel = async (id: string): Promise<void> => {
    setShowByok(id === 'byok')
    await window.api.ai.setModel(id)
    void load()
  }

  const saveByok = async (): Promise<void> => {
    if (!byokForm.baseUrl || !byokForm.apiKey || !byokForm.model) { setByokSaved(true); return }
    await window.api.ai.setByok(byokForm)
    await window.api.ai.setModel('byok')
    setByokSaved(true)
    void load()
  }

  const onInputChange = (v: string): void => {
    setInput(v)
    setShowSlash(v.startsWith('/'))
    setShowMention(v.endsWith('@') || /@[^\s]*$/.test(v))
  }

  const curModel = models.find((m) => m.id === state?.modelId)
  const activeTab = tabs.find((t) => t.id === activePath)
  const elapsedSec = Math.floor(stats.elapsedMs / 1000)

  return (
    <aside className="ai-panel" style={{ width: panelWidth }}>
      {/* 拖拽手柄：面板左缘 */}
      <div className="ai-panel-resizer" onMouseDown={onResizeStart} title="拖拽调整面板宽度" />
      {/* 顶部：标题 + 模型选择 + 新建对话 */}
      <div className="ai-head">
        <span {...hint('aiPanel')}>🤖 AI 智能体</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {(() => {
            const hasBuiltin = models.filter((m) => m.available).length > 0
            const hasLocal = localModels.length > 0
            const hasByok = (state?.byokProfiles ?? []).length > 0
            // 通道健康：云端不可用（未登录/过期）但本地或 BYOK 可用时，要说清楚「现在用的是哪个」，
            // 否则用户看到模型名就以为云端能用，发消息才吃 401
            const cloudDown = cloudError !== null
            if (!hasBuiltin && !hasLocal && !hasByok) {
              return (
                <button
                  onClick={() => onOpenSettings?.()}
                  style={{
                    fontSize: 11, padding: '4px 12px', borderRadius: 6,
                    border: 'none', background: 'var(--accent)',
                    color: 'var(--on-dark)', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 500
                  }}
                >＋ 添加 API Key</button>
              )
            }
            return (
              <>
          <select
            className="model-select"
            value={useLocalModel ? `local:${selectedLocalModel}` : (state?.modelId ?? '')}
            onChange={(e) => {
              const val = e.target.value
              if (val.startsWith('local:')) {
                setUseLocalModel(true)
                setSelectedLocalModel(val.replace('local:', ''))
                void window.api.ai.setModel(val)
              } else {
                setUseLocalModel(false)
                setSelectedLocalModel('')
                void changeModel(val)
              }
            }}
            title="选择模型"
            style={{ fontSize: 11 }}
          >
            <optgroup label="内置模型">
              {models.filter((m) => m.available).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.multiplier && m.multiplier > 1 ? `（×${m.multiplier} 积分）` : ''}
                </option>
              ))}
            </optgroup>
            {localModels.length > 0 && (
              <optgroup label="本地模型（离线）">
                {localModels.map((m) => (
                  <option key={m.id} value={`local:${m.id}`}>
                    {m.name}（{m.sizeGB}GB）
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="自定义（自带 Key）">
              {(state?.byokProfiles ?? []).map((p) => (
                <option key={p.id} value={`byok:${p.id}`}>{p.name}</option>
              ))}
            </optgroup>
          </select>
          <button
            title="模型设置"
            onClick={() => onOpenSettings?.()}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--surface-2)',
              color: 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap'
            }}
          >⚙</button>
              </>
            )
          })()}
          <button
            className="ai-head-icon"
            title={busy ? '新建对话（会中断当前回复）' : '新建对话'}
            onClick={newChat}
            disabled={busy}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 3, display: 'flex' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4.5v15m7.5-7.5h-15"/></svg>
          </button>
          <button
            className="ai-head-icon"
            title={showAdvanced ? '收起高级选项（精简模式）' : '展开高级选项'}
            onClick={() => {
              setShowAdvanced((v) => {
                const nv = !v
                localStorage.setItem('codelab-ai-advanced', nv ? '1' : '0')
                return nv
              })
            }}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: showAdvanced ? 'var(--accent)' : 'inherit', padding: 3, display: 'flex' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>
          </button>
        </div>
      </div>

      {/* 通道健康条：把「现在能不能用、用的是哪条通道」摆在最显眼处。
          之前的坑：云端 401 时界面照样显示一个模型名，用户以为能用，一发消息才报错。 */}
      {(cloudError || health) && (
        <div className={`ai-health ${engineStarting ? 'is-busy' : ''}`}>
          <span className={`ai-health-dot ${healthTone}`} />
          <span className="ai-health-text" title={healthText}>{healthText}</span>
          <button className="ai-health-fix" onClick={() => onOpenSettings?.()}>
            去设置
          </button>
        </div>
      )}
      {/* 本地引擎一键启动：独立成行，云端可用时不该把它挤掉 ——
          这就是「离线跑、不耗积分、代码不出本机」的入口，必须随时可达 */}
      {healthAction && health && (
        <div className="ai-health">
          <span className={`ai-health-dot ${engineStarting ? 'busy' : 'warn'}`} />
          <span className="ai-health-text" title={healthAction.title}>{healthAction.text}</span>
          <button
            className="ai-health-act"
            onClick={healthAction.onClick}
            disabled={healthAction.disabled}
            title={healthAction.title}
          >
            {healthAction.label}
          </button>
        </div>
      )}
      {engineMsg && (
        <div className={`ai-health-msg ${engineMsg.ok === true ? 'ok' : engineMsg.ok === false ? 'err' : 'busy'}`}>
          {engineMsg.text}
        </div>
      )}

      {showAdvanced && (
        <>
      {/* 模式切换 + 思考强度 */}
      <div className="ai-security-bar">
        <span className="ai-security-label">模式</span>
        <div className="ai-mode-switch" title={AGENT_MODES.find((m) => m.value === mode)?.hint}>
          {AGENT_MODES.map((m) => (
            <button
              key={m.value}
              className={`ai-mode-btn${mode === m.value ? ' active' : ''}${m.value === 'debug' ? ' debug' : ''}`}
              onClick={() => setMode(m.value)}
              disabled={busy}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="ai-security-label" style={{ marginLeft: 6 }}>思考</span>
        <select
          className="ai-security-select"
          value={thinkingLevel}
          onChange={(e) => {
            const v = e.target.value as 'light' | 'standard' | 'deep'
            setThinkingLevel(v)
            localStorage.setItem('codelab-thinking', v)
          }}
          title="思考强度"
        >
          {THINKING_LEVELS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
        </select>
          <button className="ai-head-icon" title="上下文使用统计" onClick={() => setShowTokenPanel((v) => !v)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 3, display: 'flex', marginLeft: 'auto' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>
          </button>
      </div>

      {/* 上下文使用统计（动态估算） */}
      {showTokenPanel && (
        <div className="ai-token-panel">
          <div className="ai-token-title">上下文使用</div>
          <div className="ai-token-row">
            <span>对话消息</span><span className="ai-token-bar"><i style={{ width: `${Math.min(100, dialogTokens / 16 / 1000 * 100)}%` }} /></span><span>{dialogTokens.toLocaleString()}</span>
          </div>
          <div className="ai-token-row">
            <span>引用上下文</span><span className="ai-token-bar"><i style={{ width: `${Math.min(100, contextItems.length * 4)}%` }} /></span><span>{contextItems.length} 项</span>
          </div>
          <div className="ai-token-row">
            <span>工具记录</span><span className="ai-token-bar"><i style={{ width: `${Math.min(100, stats.toolCalls * 8)}%` }} /></span><span>{stats.toolCalls} 次</span>
          </div>
          <div className="ai-token-total">消息 {messages.length} 条 · 估算 {dialogTokens.toLocaleString()} tokens（中文约 1.5 字符/token）· 16K 窗口 {Math.min(100, Math.round(dialogTokens / 16000 * 100))}%</div>
          <button className="ai-token-compact" onClick={() => setMessages((prev) => prev.slice(-10))}>压缩上下文（保留最近 10 条）</button>
        </div>
      )}

        </>
      )}

      {/* BYOK 提示（未配置时引导去设置页） */}
      {showByok && !state?.byok?.apiKey && (
        <div className="ai-login">
          <div className="ai-login-tip">自定义模型未配置，请前往「设置 → 模型」填写 Base URL / API Key / 模型名。</div>
        </div>
      )}
      {showByok && state?.byok?.apiKey && (
        <div className="ai-login">
          <div className="ai-ok">已连接自定义模型：{state.byok.model}</div>
          <div className="ai-login-tip">管理请前往「设置 → 模型」。</div>
        </div>
      )}

      {/* 上下文 chips */}
      {contextItems.length > 0 && (
        <div className="ai-context-bar">
          <span className="ai-context-title">引用 {contextItems.length}：</span>
          {contextItems.map((c) => (
            <span key={c.id} className="ai-context-chip" title={c.content.slice(0, 100)}>
              {c.name}<button onClick={() => removeContext(c.id)}>×</button>
            </span>
          ))}
        </div>
      )}

      {/* 斜杠命令 */}
      {showSlash && (
        <div className="ai-popup">
          {SLASH_COMMANDS.map((c) => (
            <div key={c.cmd} className="ai-popup-item" onClick={() => { setInput(c.cmd + ' '); setShowSlash(false) }}>
              <span className="ai-popup-cmd">{c.cmd}</span>
              <span className="ai-popup-desc">{c.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* @引用 */}
      {showMention && (
        <div className="ai-popup">
          <div className="ai-popup-title">引用当前打开的文件</div>
          {tabs.length === 0 && <div className="ai-popup-desc">暂无打开的文件</div>}
          {tabs.map((t) => (
            <div key={t.id} className={`ai-popup-item ${t.id === activePath ? 'active' : ''}`} onClick={() => addFileContext(t)}>
              <span className="ai-popup-cmd">{t.id === activePath ? '📄 ' : ''}{t.name}</span>
              <span className="ai-popup-desc">{t.language}</span>
            </div>
          ))}
        </div>
      )}

      {/* 上下文管理 */}
      {showContext && (
        <div className="ai-context-panel">
          <div className="ai-context-title">上下文管理（{contextItems.length}）</div>
          {contextItems.length === 0 && <div className="ai-popup-desc">暂无引用。输入 @ 或点击 📎 添加。</div>}
          {contextItems.map((c) => (
            <div key={c.id} className="ai-context-row">
              <span className="ai-context-name">{c.kind === 'attachment' ? '📎 ' : '📄 '}{c.name}</span>
              <button className="ai-linkbtn" onClick={() => removeContext(c.id)}>移除</button>
            </div>
          ))}
        </div>
      )}

      {/* 确认弹窗 */}
      {confirmReq && (
        <div className="agent-confirm-overlay">
          <div className="agent-confirm-dialog">
            <div className="agent-confirm-title">⚠ 确认执行</div>
            <div className="agent-confirm-tool">
              <span className="agent-confirm-name">{confirmReq.toolName}</span>
              <span className="agent-confirm-cat" style={{ background: categoryColor(confirmReq.toolCategory) }}>
                {categoryLabel(confirmReq.toolCategory)}
              </span>
            </div>
            <div className="agent-confirm-desc">{confirmReq.description}</div>
            <pre className="agent-confirm-args">{JSON.stringify(confirmReq.arguments, null, 2)}</pre>
            <div className="agent-confirm-actions">
              <button className="agent-confirm-btn allow" onClick={() => void respondConfirm('allow_once')}>允许一次</button>
              <button className="agent-confirm-btn allow-session" onClick={() => void respondConfirm('allow_session')}>本会话允许</button>
              <button className="agent-confirm-btn reject" onClick={() => void respondConfirm('reject')}>拒绝</button>
            </div>
          </div>
        </div>
      )}

      {/* 计划审批（submit_plan）：主进程会挂起等决策，批准后才继续执行 */}
      {planReq && (
        <div className="agent-confirm-overlay">
          <div className="agent-confirm-dialog">
            <div className="agent-confirm-title">执行计划 · 待批准</div>
            <pre className="agent-confirm-args">{planReq.plan}</pre>
            <input
              className="agent-confirm-args"
              placeholder="要求修改计划时写在这里（可留空）"
              value={planFeedback}
              onChange={(e) => setPlanFeedback(e.target.value)}
            />
            <div className="agent-confirm-actions">
              <button className="agent-confirm-btn allow" onClick={() => void submitPlan('approve')}>批准并执行</button>
              <button className="agent-confirm-btn allow-session" onClick={() => void submitPlan('feedback')}>要求修改</button>
              <button className="agent-confirm-btn reject" onClick={() => void submitPlan('reject')}>否决</button>
            </div>
          </div>
        </div>
      )}

      {/* AI 主动提问弹窗（ask_user） */}
      {askReq && (
        <div className="agent-confirm-overlay">
          <div className="agent-confirm-dialog agent-ask-dialog">
            <div className="agent-confirm-title">❓ AI 需要确认</div>
            {askReq.questions.map((q, i) => (
              <div key={i} className="agent-ask-item">
                <div className="agent-ask-q">Q{i + 1}. {q.question}</div>
                {q.type === 'choice' && q.options && q.options.length > 0 ? (
                  <select
                    className="agent-ask-input"
                    value={askAnswers[i] || ''}
                    onChange={(e) => setAskAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                  >
                    <option value="">请选择…</option>
                    {q.options.map((o, oi) => <option key={oi} value={o}>{o}</option>)}
                  </select>
                ) : q.type === 'yesno' ? (
                  <select
                    className="agent-ask-input"
                    value={askAnswers[i] || '是'}
                    onChange={(e) => setAskAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                  >
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
                ) : (
                  <input
                    className="agent-ask-input"
                    placeholder="请输入…"
                    value={askAnswers[i] || ''}
                    onChange={(e) => setAskAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                  />
                )}
              </div>
            ))}
            <div className="agent-confirm-actions">
              <button className="agent-confirm-btn allow" onClick={() => void submitAsk()}>提交回答</button>
              <button className="agent-confirm-btn reject" onClick={() => void skipAsk()}>跳过</button>
            </div>
          </div>
        </div>
      )}

      {/* 消息流 */}
      <div className="ai-messages">
        {messages.map((m, i) => (
          <MessageBubble
            key={i}
            msg={m}
            onApply={onApplyCode}
            onRunTerminal={onRunTerminal}
            onRegenerate={m.kind === 'user' ? () => regenerate(i) : undefined}
            onEdit={m.kind === 'user' ? () => editResend(i) : undefined}
            onRewind={(m.kind === 'user' || m.kind === 'assistant') && i > 0 ? () => rewindTo(i) : undefined}
          />
        ))}
        {/* 模型推理过程（reasoning 流）：与正文分开渲染，不覆盖正文 */}
        {streamingReasoning && busy && <ThinkingBlock text={streamingReasoning} />}
        {/* 系统提示类消息（协议纠正 / 反幻觉纠正 / 上下文压缩等，走 thinking 事件） */}
        {streamingThinking && busy && <ThinkingBlock text={streamingThinking + '…'} />}
        {/* 流式输出中 */}
        {streamingText && busy && (
          <div className="msg assistant">
            <div className="ai-text"><LightMarkdown text={streamingText} /><span className="cursor-blink">▌</span></div>
          </div>
        )}
        {busy && !streamingText && !streamingThinking && !streamingReasoning && agentStatus === 'thinking' && (
          <div className="msg assistant typing">思考中…</div>
        )}
        {busy && agentStatus === 'tool_calling' && (
          <div className="msg assistant typing">执行工具中…</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 统计栏（对齐 TrieCode：工作计时 + 工具计数 + token 计量；busy 时"已工作 Ns"实时跳动） */}
      {(busy || stats.turns > 0) && (
        <div className="agent-stats-bar">
          {busy ? (
            <span className="agent-work-timer" title="Agent 正在工作">▶ 已工作 {elapsedTick}s</span>
          ) : (
            <span>用时 {elapsedSec}s</span>
          )}
          <span>工具 {stats.toolCalls}</span>
          {busy && <span className="agent-status-indicator">{agentStatus === 'thinking' ? '思考中' : agentStatus === 'tool_calling' ? '执行工具' : agentStatus}</span>}
          {((stats.outputTokens ?? 0) > 0 || (stats.inputTokens ?? 0) > 0) && (
            <span className="agent-token-metrics" title="本次对话累计 token 用量（含上下文重发）">
              输入 {fmtTokens(stats.inputTokens ?? 0)} · 输出 {fmtTokens(stats.outputTokens ?? 0)}
            </span>
          )}
        </div>
      )}

      {/* 中断入口：必须常驻。
          之前它挂在「高级选项（showAdvanced）」里，而默认就是精简模式 ——
          结果 agent 跑飞时用户看不见停止按钮，发送按钮还 disabled，只能杀进程。
          中断是「正在发生的事」的逃生口，不能被折叠收走。 */}
      {busy && (
        <div className="ai-stopbar">
          <button className="ai-stop-btn" onClick={() => void stopAgent()} title="中断当前 Agent 运行">
            ⏹ 停止{agentStatus === 'tool_calling' ? '（正在执行工具）' : agentStatus === 'thinking' ? '（正在思考）' : ''}
          </button>
          <span className="ai-stopbar-hint">中断后本轮对话保留，可改写后重新发送</span>
        </div>
      )}

      {/* 快捷按钮 */}
      <div className="ai-quickbar">
        <button className="ai-quickbtn" title="上传附件作为上下文" onClick={() => fileInputRef.current?.click()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"/></svg>
        </button>
        <button className="ai-quickbtn" title="引用当前文件" onClick={() => activeTab && addFileContext(activeTab)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
        </button>
        <button className="ai-quickbtn" title="插入代码块" onClick={() => setInput((v) => v + '\n```\n\n```\n')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"/></svg>
        </button>
        <button className={`ai-quickbtn${listening ? ' ai-voice-on' : ''}`} title={listening ? '停止聆听' : '语音输入'} onClick={toggleVoice}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"/></svg>
        </button>
        <span className="ai-quicktip">Shift+Enter 换行，/ 命令，@ 引用</span>
      </div>
      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onPickAttachment} />

      {/* 输入框 */}
      <div className="ai-input">
        <textarea
          ref={inputRef}
          rows={2}
          placeholder="输入需求，我可以创建项目、写代码、执行命令…"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            if (e.key === 'Escape') { setShowSlash(false); setShowMention(false) }
          }}
        />
        <button onClick={() => void send()} disabled={busy}>
          {busy ? '…' : '发送'}
        </button>
      </div>
      {curModel && !curModel.available && state?.modelId !== 'byok' && !state?.modelId?.startsWith('byok:') && (
        <div className="ai-err">模型「{curModel.name}」暂未开通，请切换其它模型</div>
      )}
      {showSmallModelTip && (
        <div className="ai-small-model-tip">
          <span className="ai-small-model-tip-text">本地小模型工具调用能力有限，主动询问/复杂工具操作建议切换 3B 或云端模型</span>
          <button
            className="ai-small-model-tip-close"
            title="不再显示"
            onClick={() => { localStorage.setItem('codelab-small-model-tip', '1'); setSmallModelTipDismissed(true) }}
          >✕</button>
        </div>
      )}

    </aside>
  )
}

export default AiPanel

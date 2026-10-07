import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chatWithLocalModel, chatWithLocalModelStream, getEngineStatus, listLocalModels } from '../ai/modelRuntime'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiModel {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  costPerCall: number
  desc: string
  available: boolean
}

export interface AiState {
  token: string | null
  email: string | null
  planCredits: number | null
  rechargeCredits: number | null
  totalCredits: number | null
  planMonth: string | null
  modelId: string // 内置模型 id 或 'byok'（旧格式）/ 'byok:<profileId>'（多 profile）
  byok: { baseUrl: string; apiKey: string; model: string } | null
  // 多 BYOK profile
  byokProfiles: ByokProfile[]
  activeByokId: string | null
}

export interface ByokProfile {
  id: string          // 稳定 id（如 deepseek / qwen / custom-xxx）
  name: string        // 显示名
  baseUrl: string
  apiKey: string
  model: string
}

export interface UserInfo {
  email: string
  planCredits: number
  rechargeCredits: number
  totalCredits: number
  planMonth: string
}

// ---------- 网关地址 ----------
export function getServer(): string {
  return (process.env.CODELAB_AI_SERVER || 'https://bluebubai.work').replace(/\/$/, '')
}

// ---------- 本地状态持久化 ----------
function stateFile(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

function defaultState(): AiState {
  return {
    token: null, email: null, planCredits: null, rechargeCredits: null, totalCredits: null,
    planMonth: null, modelId: 'deepseek-flash', byok: null,
    byokProfiles: [], activeByokId: null
  }
}

export function getAiState(): AiState {
  try {
    const p = stateFile()
    if (!existsSync(p)) return defaultState()
    const raw = { ...defaultState(), ...JSON.parse(readFileSync(p, 'utf-8')) } as AiState
    // 迁移：旧版单 byok → byokProfiles[0]
    if (raw.byokProfiles.length === 0 && raw.byok && raw.byok.baseUrl) {
      const migrated: ByokProfile = {
        id: 'legacy', name: '自定义模型',
        baseUrl: raw.byok.baseUrl, apiKey: raw.byok.apiKey, model: raw.byok.model
      }
      raw.byokProfiles = [migrated]
      raw.activeByokId = raw.modelId === 'byok' ? 'legacy' : null
    }
    return raw
  } catch {
    return defaultState()
  }
}

function saveAiState(state: AiState): void {
  const p = stateFile()
  if (!existsSync(p)) mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8')
}

// ---------- 多 BYOK profile 管理 ----------
/** 根据当前 modelId 解析出生效的 BYOK 配置（支持 'byok' 旧格式 / 'byok:<id>' 新格式） */
export function resolveActiveByok(state: AiState = getAiState()): ByokProfile | null {
  if (state.modelId === 'byok') {
    // 旧格式：取 activeByokId 指向的 profile，或第一个
    const id = state.activeByokId
    return state.byokProfiles.find((p) => p.id === id) ?? state.byokProfiles[0] ?? null
  }
  if (state.modelId.startsWith('byok:')) {
    const id = state.modelId.slice(5)
    return state.byokProfiles.find((p) => p.id === id) ?? null
  }
  return null
}

export function listByokProfiles(): ByokProfile[] {
  return getAiState().byokProfiles
}

export function saveByokProfile(profile: ByokProfile): AiState {
  const s = getAiState()
  const idx = s.byokProfiles.findIndex((p) => p.id === profile.id)
  if (idx >= 0) s.byokProfiles[idx] = profile
  else s.byokProfiles.push(profile)
  saveAiState(s)
  return s
}

export function deleteByokProfile(id: string): AiState {
  const s = getAiState()
  s.byokProfiles = s.byokProfiles.filter((p) => p.id !== id)
  if (s.activeByokId === id) s.activeByokId = s.byokProfiles[0]?.id ?? null
  // 若当前正在用这个 profile，切回默认模型
  if (s.modelId === `byok:${id}`) s.modelId = 'deepseek-flash'
  saveAiState(s)
  return s
}

export function setActiveByok(id: string | null): AiState {
  const s = getAiState()
  if (id === null) {
    s.activeByokId = null
    s.modelId = 'deepseek-flash'
  } else {
    const p = s.byokProfiles.find((x) => x.id === id)
    if (!p) throw new Error(`BYOK profile 不存在: ${id}`)
    s.activeByokId = id
    s.modelId = `byok:${id}`
  }
  saveAiState(s)
  return s
}

// ---------- 内置模型列表（官方通道） ----------
/** 通道健康状态：让「能不能用」在界面上可见，而不是等发消息才报 401 */
export interface ChannelHealth {
  /** 是否已登录（本地 token 存在） */
  loggedIn: boolean
  /** 登录是否还有效（最近一次云端调用没报 401） */
  tokenHealthy: boolean | null
  /** 当前激活的 BYOK profile 名 */
  byokActive: string | null
  /** 本地引擎是否就绪（llama 已起且有模型） */
  localReady: boolean
  localModel: string | null
  /** 云端模型列表是否可用 */
  modelListOk: boolean | null
  /** 最近一次错误（用于界面提示） */
  lastError: string | null
  /** 引擎本体（llama-server.exe）是否已安装 */
  engineInstalled: boolean
  /** 引擎进程是否在运行 */
  engineRunning: boolean
  /** 已下载的 gguf 模型数 */
  localModelCount: number
  /**
   * 本地引擎可操作状态（界面据此决定显示「一键启动」还是「就绪」）：
   * running 已就绪 / idle 引擎已装且有模型但没启动（可一键启动）
   * / not-installed 引擎本体缺失 / no-models 引擎在但没下载模型
   */
  engineHint: 'running' | 'idle' | 'not-installed' | 'no-models'
}

let lastModelListOk: boolean | null = null
let lastError: string | null = null

export async function getChannelHealth(): Promise<ChannelHealth> {
  const state = getAiState()
  const local = getLocalModel()
  const byok = resolveActiveByok(state)
  // 引擎信息拿不到不能影响主判断（用户可能根本没装本地引擎），分别容错
  let engineInstalled = false
  let engineRunning = false
  let localModelCount = 0
  try {
    const [es, ms] = await Promise.all([getEngineStatus(), listLocalModels()])
    engineInstalled = es.installed
    engineRunning = es.running
    localModelCount = ms.length
  } catch { /* ignore */ }
  const engineHint: ChannelHealth['engineHint'] = engineRunning
    ? 'running'
    : !engineInstalled
      ? 'not-installed'
      : localModelCount === 0
        ? 'no-models'
        : 'idle'
  return {
    loggedIn: !!state.token,
    tokenHealthy: state.token ? lastModelListOk : null,
    byokActive: byok ? byok.name : null,
    localReady: !!local,
    localModel: local,
    modelListOk: lastModelListOk,
    lastError,
    engineInstalled,
    engineRunning,
    localModelCount,
    engineHint
  }
}

export function noteChannelError(msg: string | null): void {
  lastError = msg
}

export async function listModels(): Promise<AiModel[]> {
  let res: Response
  try {
    res = await fetch(`${getServer()}/api/models`)
  } catch (e) {
    lastModelListOk = false
    throw new Error(`无法连接内置模型服务（${getServer()}）：${(e as Error).message}。若使用本地模型，请到「设置 → 本地引擎」启动。`)
  }
  if (res.status === 401 || res.status === 403) {
    lastModelListOk = false
    // 这条最关键：未登录/登录过期时，界面必须显式说出来，
    // 否则用户会看到「有模型可选」却在发消息时才吃 401
    throw new Error('内置模型服务未登录或登录已过期。请在「设置 → 模型」里登录，或改用「自定义模型 / 本地引擎」。')
  }
  if (!res.ok) {
    lastModelListOk = false
    throw new Error(`获取模型列表失败（${res.status}）`)
  }
  lastModelListOk = true
  const data = (await res.json()) as { models: AiModel[] }
  return data.models
}

// ---------- 账号 ----------
async function postApi<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const res = await fetch(`${getServer()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

export async function authRegister(email: string, password: string): Promise<{ token: string; user: UserInfo }> {
  return postApi('/api/auth/register', { email, password })
}

export async function authLogin(email: string, password: string): Promise<{ token: string; user: UserInfo }> {
  return postApi('/api/auth/login', { email, password })
}

export async function refreshMe(token: string): Promise<UserInfo> {
  const res = await fetch(`${getServer()}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
  const data = (await res.json().catch(() => ({}))) as { user?: UserInfo; error?: string }
  if (!res.ok) throw new Error(data.error || `获取用户信息失败（${res.status}）`)
  if (!data.user) throw new Error('用户信息为空')
  return data.user
}

// ---------- 聊天 ----------
async function chatByok(messages: ChatMessage[], byok: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
  if (!byok.apiKey || !byok.baseUrl) throw new Error('自定义模型未配置完整（需 Base URL / API Key / 模型名）')
  const url = byok.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${byok.apiKey}` },
    body: JSON.stringify({ model: byok.model, messages })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`自定义模型调用失败（${res.status}）：${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

export interface ChatResult {
  content: string
  creditsLeft?: number
  cost?: number
}

/** 选了本地模型但引擎没就绪时抛错，避免静默改走云端（会上传代码 + 消耗积分） */
function assertLocalNotSelected(state: AiState): void {
  if (String(state.modelId || '').startsWith('local:')) {
    throw new Error(
      '你选择的是本地模型，但本地引擎当前未就绪。已阻止改走云端通道（那会把代码上传并消耗积分）。' +
        '请到「设置 → 本地引擎」下载并启动模型后再试。'
    )
  }
}

export async function aiChat(messages: ChatMessage[], state: AiState = getAiState()): Promise<ChatResult> {
  // 本地模型分支（与流式路径保持一致）：
  // 之前只有 aiChatStream 有本地分支，非流式调用会静默落到官方通道 →
  // 表现为「选了本地模型却报 401 未登录」，甚至悄悄消耗云端积分。
  const local = getLocalModel()
  if (local) {
    const content = await chatWithLocalModel(local, messages)
    return { content }
  }
  // 禁止静默降级：用户明确选了本地模型，但引擎没就绪时必须直说，
  // 否则会悄悄把代码发到云端并消耗积分 —— 这比报错危险得多。
  assertLocalNotSelected(state)

  // BYOK 模式：直连当前激活的 profile（OpenAI 兼容端点）
  const activeByok = resolveActiveByok(state)
  if (activeByok) {
    if (!activeByok.apiKey || !activeByok.baseUrl) throw new Error('自定义模型未配置完整（需 Base URL / API Key / 模型名）')
    const content = await chatByok(messages, activeByok)
    return { content }
  }

  // 官方通道：登录 + 内置模型，消耗积分
  if (!state.token) {
    throw new Error('使用内置模型需先登录（或改用「自定义模型」填入自己的 API Key）')
  }
  const data = await postApi<{ content: string; creditsLeft: number; cost: number }>(
    '/api/chat',
    { model: state.modelId, messages },
    state.token
  )
  // 更新本地积分缓存
  const next = { ...state, totalCredits: data.creditsLeft }
  saveAiState(next)
  return { content: data.content, creditsLeft: data.creditsLeft, cost: data.cost }
}

// ---------- 状态变更辅助（供 IPC 调用） ----------
export function setAiState(state: AiState): void {
  saveAiState(state)
}

export function clearAiState(): AiState {
  const s = defaultState()
  saveAiState(s)
  return s
}

// ---------- 本地模型（Ollama）状态 ----------
let activeLocalModel: string | null = null

export function setLocalModel(model: string | null): void {
  activeLocalModel = model
}

export function getLocalModel(): string | null {
  return activeLocalModel
}

// ---------- SSE 流式聊天（支持 tool_calls / function calling） ----------
export interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call_start' | 'tool_call_args'
  text?: string
  id?: string
  name?: string
}

export interface FunctionSchema {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

/**
 * 通用 OpenAI 兼容 SSE 流式解析（支持 tools / function calling 增量累积）。
 * 文本/推理边收边发；tool_calls 按 index 累积到流结束后按序发出（保证 start 在前、顺序正确），
 * 供 AgentRunner 的 function calling 解析使用。BYOK 与官方通道共用，避免各自维护解析逻辑。
 */
function fetchStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  onChunk: (chunk: StreamChunk) => void,
  signal: AbortSignal,
  onDone: (err: Error | null, usage?: { inputTokens: number; outputTokens: number }) => void
): void {
  fetch(url, { method: 'POST', headers, body, signal })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`流式请求失败（${res.status}）：${text.slice(0, 200)}`)
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error('响应体为空')
      const decoder = new TextDecoder()
      let buffer = ''
      const tcMap = new Map<number, { id: string; name: string; args: string }>()
      let tcMaxIndex = -1
      let usage: { inputTokens: number; outputTokens: number } | null = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') continue
          try {
            const data = JSON.parse(dataStr)
            if (data.usage && (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)) {
              usage = { inputTokens: Number(data.usage.prompt_tokens) || 0, outputTokens: Number(data.usage.completion_tokens) || 0 }
            }
            const delta = data.choices?.[0]?.delta
            if (!delta) continue
            if (delta.content) onChunk({ type: 'content', text: delta.content })
            if (delta.reasoning_content) onChunk({ type: 'reasoning', text: delta.reasoning_content })
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0
                if (!tcMap.has(idx)) tcMap.set(idx, { id: '', name: '', args: '' })
                const entry = tcMap.get(idx)!
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name = tc.function.name
                if (tc.function?.arguments) entry.args += tc.function.arguments
                if (idx > tcMaxIndex) tcMaxIndex = idx
              }
            }
          } catch {
            // 忽略单行解析失败
          }
        }
      }
      // 流结束：按 index 顺序逐个发出工具调用（start 在前、args 在后），对齐 AgentRunner 解析预期
      for (let i = 0; i <= tcMaxIndex; i++) {
        const entry = tcMap.get(i)
        if (!entry) continue
        onChunk({ type: 'tool_call_start', id: entry.id, name: entry.name })
        if (entry.args) onChunk({ type: 'tool_call_args', text: entry.args })
      }
      onDone(null, usage || undefined)
    })
    .catch((e) => {
      if (e.name === 'AbortError') onDone(null)
      else onDone(e)
    })
}

/**
 * SSE 流式调用。回调 onChunk 接收增量块，onDone 在流结束时调用。
 * 返回 cleanup 函数用于中断。
 */
export function aiChatStream(
  messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
  model: string,
  tools: FunctionSchema[],
  onChunk: (chunk: StreamChunk) => void,
  onDone: (err: Error | null, usage?: { inputTokens: number; outputTokens: number }) => void
): () => void {
  const state = getAiState()

  // 本地模型（Ollama）分支：支持 tools / function calling，无需登录、不耗积分
  const local = getLocalModel()
  if (local) {
    let cancelled = false
    chatWithLocalModelStream(local, messages, tools, (chunk) => {
      if (cancelled) return
      onChunk(chunk as StreamChunk)
    })
      .then((r) => { if (!cancelled) onDone(null, r?.usage) })
      .catch((e) => { if (!cancelled) onDone(e) })
    return () => { cancelled = true }
  }

  // 选了本地模型但引擎没起来 → 直说，别偷偷走云端
  try {
    assertLocalNotSelected(state)
  } catch (e) {
    onDone(e as Error)
    return () => undefined
  }

  console.error('[aiChatStream] state:', JSON.stringify({ token: state.token ? 'yes' : 'no', modelId: state.modelId, email: state.email }))
  console.error('[aiChatStream] stateFile:', stateFile())
  const controller = new AbortController()

  // BYOK 模式：走 OpenAI 兼容流式 SSE（支持 tools / function calling），让 Agent 能真正调用工具
  const activeByok = resolveActiveByok(state)
  if (activeByok) {
    if (!activeByok.apiKey || !activeByok.baseUrl) {
      onDone(new Error('自定义模型未配置完整（需 Base URL / API Key / 模型名）'))
      return () => controller.abort()
    }
    const url = activeByok.baseUrl.replace(/\/$/, '') + '/chat/completions'
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeByok.apiKey}`
    }
    const body = JSON.stringify({
      model: activeByok.model,
      messages,
      stream: true,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined
    })
    const byokController = new AbortController()
    fetchStream(url, headers, body, onChunk, byokController.signal, onDone)
    return () => byokController.abort()
  }

  if (!state.token) {
    onDone(new Error('使用内置模型需先登录'))
    return () => controller.abort()
  }

  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined
  })
  console.error('[aiChatStream] tools count:', tools.length, 'body length:', body.length)

  fetch(`${getServer()}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      Accept: 'text/event-stream'
    },
    body,
    signal: controller.signal
  })
    .then(async (res) => {
      console.error('[aiChatStream] response status:', res.status, res.statusText)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.error('[aiChatStream] error body:', text.slice(0, 500))
        throw new Error(`流式请求失败（${res.status}）：${text.slice(0, 200)}`)
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error('响应体为空')
      console.error('[aiChatStream] stream started, reading...')
      const decoder = new TextDecoder()
      let buffer = ''
      let usage: { inputTokens: number; outputTokens: number } | null = null
      // 工具调用按 index 累积（见下方 delta.tool_calls 处理处的说明）
      const tcMap = new Map<number, { id: string; name: string; args: string }>()
      let tcMaxIndex = -1

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          console.error('[aiChatStream] stream done (reader closed)')
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        let pendingEvent = '' // 记录当前 event 类型（如 credits）
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('event:')) {
            pendingEvent = trimmed.slice(6).trim()
            continue
          }
          if (!trimmed.startsWith('data:')) {
            console.error('[aiChatStream] non-data line:', trimmed.slice(0, 100))
            continue
          }
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') {
            console.error('[aiChatStream] received [DONE]')
            continue
          }
          try {
            const data = JSON.parse(dataStr)
            // token 用量（OpenAI 兼容 usage，若服务端返回）
            if (data.usage && (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)) {
              usage = { inputTokens: Number(data.usage.prompt_tokens) || 0, outputTokens: Number(data.usage.completion_tokens) || 0 }
            }
            // 积分事件（服务端 credits 事件：event: credits + data: {used, totalTokens, remaining}）
            if (pendingEvent === 'credits' && data.remaining !== undefined) {
              const next = { ...state, totalCredits: data.remaining }
              saveAiState(next)
              pendingEvent = ''
              continue
            }
            const delta = data.choices?.[0]?.delta
            if (!delta) {
              console.error('[aiChatStream] no delta in:', JSON.stringify(data).slice(0, 200))
              continue
            }
            if (delta.content) {
              console.error('[aiChatStream] content chunk:', delta.content.slice(0, 50))
              onChunk({ type: 'content', text: delta.content })
            }
            if (delta.reasoning_content) {
              onChunk({ type: 'reasoning', text: delta.reasoning_content })
            }
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              // 按 index 累积（与上面 fetchStream/BYOK 分支同一套）。
              // 原实现是「边收边发」：增量帧里 id/name 只在首帧出现，后续帧只有 arguments
              // 片段，于是每个片段都另起一次 tool_call_args；而 AgentRunner 的解析器用
              // 单指针 currentToolIndex 顺序配对 start/args，多工具交错时会把 args 配到
              // 别的 id 上。累积到流结束后按 index 顺序成对发出才对得上。
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0
                if (!tcMap.has(idx)) tcMap.set(idx, { id: '', name: '', args: '' })
                const entry = tcMap.get(idx)!
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name = tc.function.name
                if (tc.function?.arguments) entry.args += tc.function.arguments
                if (idx > tcMaxIndex) tcMaxIndex = idx
              }
            }
            // 积分更新（兼容旧格式 data: {creditsLeft}）
            if (data.creditsLeft !== undefined) {
              const next = { ...state, totalCredits: data.creditsLeft }
              saveAiState(next)
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }
      console.error('[aiChatStream] parsing complete, calling onDone(null)')
      // 流结束：按 index 顺序成对发出（start 在前、args 在后），对齐 AgentRunner 的解析预期
      for (let i = 0; i <= tcMaxIndex; i++) {
        const entry = tcMap.get(i)
        if (!entry) continue
        onChunk({ type: 'tool_call_start', id: entry.id, name: entry.name })
        if (entry.args) onChunk({ type: 'tool_call_args', text: entry.args })
      }
      onDone(null, usage || undefined)
    })
    .catch((e) => {
      console.error('[aiChatStream] fetch error:', e.message, e.name)
      if (e.name === 'AbortError') {
        onDone(null)
      } else {
        onDone(e)
      }
    })

  return () => controller.abort()
}

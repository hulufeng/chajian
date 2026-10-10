// AI 网关「脚本化模型」桩：给 check-agent-loop.mjs 用。
//
// 为什么不用真模型：真机测试要联网/要本地 gguf/要板子，跑不了也不可重复。
// 这里把模型换成「按脚本逐轮吐响应」的假模型，主循环、护栏、闸门、收尾这些
// **引擎自己的逻辑**就能被确定性验证——模型行为是被控变量，不是被测对象。
//
// 用法：测试脚本在每次 run 前往 globalThis.__MODEL_SCRIPT__ 里塞一串响应：
//   [{ content: '...', toolCalls: [{ id, name, arguments }] }, ...]
// 每调一次模型消费一条；队列空了就返回空内容（等价于模型主动 stop）。

function pickQueue(messages) {
  // auto-memory 的系统提示里有「记忆提炼器」，据此分流到独立的记忆队列，
  // 免得提炼调用把主循环的脚本顶掉。
  const head = String(messages && messages[0] ? messages[0].content : '')
  if (head.includes('记忆提炼器')) {
    return globalThis.__MEMORY_SCRIPT__ || []
  }
  return globalThis.__MODEL_SCRIPT__ || []
}

export function aiChatStream(messages, _model, _tools, onChunk, onDone) {
  const queue = pickQueue(messages)
  const step = queue && queue.length ? queue.shift() : { content: '' }
  // 走 setTimeout：真实网关是异步流式的，同步回调会让主循环的重入行为失真
  setTimeout(() => {
    try {
      const content = step.content || ''
      if (content) onChunk({ type: 'content', text: content })
      for (const tc of step.toolCalls || []) {
        const id = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        onChunk({ type: 'tool_call_start', id, name: tc.name })
        onChunk({ type: 'tool_call_args', text: JSON.stringify(tc.arguments ?? {}) })
      }
    } finally {
      onDone(null, { inputTokens: 10, outputTokens: 5 })
    }
  }, 0)
  return () => {}
}

export function getAiState() {
  return {
    token: 'stub',
    email: 'stub@test',
    planCredits: 0,
    rechargeCredits: 0,
    totalCredits: 0,
    planMonth: null,
    modelId: 'stub-model',
    byok: null,
    byokProfiles: [],
    activeByokId: null
  }
}

export function setLocalModel() {}
export function getLocalModel() { return null }
/** 读取预算（云端档位）：自检里给固定值，保证长文件截断行为可断言 */
export function currentReadBudget() { return 16000 }
export function resolveLocalModelForRun(m) { return m || null }
export function getChannelHealth() { return { local: 'unknown', gateway: 'unknown', byok: 'unknown' } }
export function noteChannelError() {}
export async function listModels() { return [] }
export function logout() { return getAiState() }
export function setAiState() {}
export function clearAiState() { return getAiState() }

// ask_user 工具（对齐 TrieCode ask-user：AI 主动向用户提问，最多 4 题）
// 引擎在 executeToolCall 拦截本工具走专用弹窗通道（见 agent-runner.ts），
// 用户答案作为工具结果注入上下文。本文件的 execute 不会真正被调用。
import type { ToolDefinition, ToolResult } from '../types'

export interface AskQuestion {
  question: string
  /** 可选：限定回答类型（text / choice / yesno），不填默认 text */
  type?: string
  /** type=choice 时的候选项 */
  options?: string[]
}

const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description:
    '向用户提问（1-4 题，最多 4 题）。仅当你需要用户才能决定的关键信息时使用：目标/约束/偏好/参数值/二选一决策。' +
    '不要用它对无关紧要的细节提问；能自己合理假设的先自行处理并在总结中说明假设。' +
    'questions 传 JSON 字符串数组，每项 { "question": "问题文本", "type": "text|choice|yesno", "options": ["选项1","选项2"] }。' +
    'type=choice 需给 options；type=yesno 回答会是 是/否。返回用户的回答数组（与 questions 顺序对应）。',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'string',
        description: 'JSON 字符串数组，1-4 个问题对象，如 [{"question":"项目放在哪个目录？","type":"choice","options":["D:/work/a","D:/work/b"]}]'
      }
    },
    required: ['questions']
  },
  category: 'query',
  execute: async (): Promise<ToolResult> => {
    // 引擎拦截处理，不会走到这里
    return { ok: false, content: '', error: 'ask_user 由引擎通道处理' }
  }
}

export const askUserTools: ToolDefinition[] = [askUserTool]

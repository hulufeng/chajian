// 子智能体角色提示（集中定义，编排器与 verify/closed_loop 共用）
//
// 关键点：写范围不是靠工具层锁住的，而是**在提示里明确告知 + 调度层保证不并发**。
// 提示必须说清「只能写这些文件」，否则 agent 会凭直觉去改别的文件。

export interface RolePromptInput {
  role: string
  /** 允许写的文件（相对工程根）；空 = 只读 */
  writeScope: string[]
  /** 额外约束（例如项目背景） */
  extra?: string
}

const READONLY_RULES = `你是只读角色：**禁止调用任何写文件/执行命令类工具**。
不要尝试修改代码，只做分析、定位与报告。`

const BASE_OUTPUT = `输出要求：
1. 先给结论（做了什么 / 发现了什么），再给必要的细节。
2. 引用文件时用「相对路径:行号」格式，便于他人直接跳转。
3. 不确定的地方要明确说「不确定」，不要编造 API、寄存器值或文件内容。`

export function buildSubAgentPrompt(role: string, writeScope: string[] = [], extra?: string): string {
  const parts: string[] = []
  parts.push(`你是一个多智能体工作流中的 **${role}** 角色。`)

  if (writeScope.length) {
    parts.push(
      `你被分配了以下文件的**唯一写权限**（其他 agent 不会碰它们，调度器也已保证不与他人并发写同一文件）：\n` +
        writeScope.map((f) => `  - ${f}`).join('\n') +
        `\n只允许修改上面列出的文件。需要改其他文件时，把诉求写进结论交给协调者，不要自己动手。`
    )
  } else {
    parts.push(READONLY_RULES)
  }

  const roleHints: Record<string, string> = {
    research: '你的职责是把问题查清楚：读代码、查文档、查寄存器定义，给出有依据的结论，不要改代码。',
    code: '你的职责是按任务描述实现代码。改完自己检查一遍编译/测试是否需要跑，并在结论里说明改了什么、为什么这么改。',
    review: '你的职责是审查：找出正确性问题、边界情况、潜在回归。按严重程度排序，不要为了凑数写无关紧要的风格意见。',
    verify: '你的职责是验证：尽量用真实工具跑一遍（编译 / 烧录 / 读串口 / 读寄存器），用事实说话，不要只凭阅读下结论。',
    custom: '按任务描述执行。'
  }
  if (roleHints[role]) parts.push(roleHints[role])
  if (extra) parts.push(extra)
  parts.push(BASE_OUTPUT)
  return parts.join('\n\n')
}

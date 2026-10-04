// 只读研究子智能体（research）
// 主 agent 派发一个研究任务：子智能体只能用只读工具（读文件/列目录/联网搜索/抓取），
// 不能改文件、不能跑构建/写命令，研究完把结论作为工具结果返回主 agent。
import { aiChatStream, getAiState } from '../../services/aiGateway'
import { toolRegistry } from '../tool-registry'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

// 只读工具白名单：子智能体只能调用这些。search_content 提供跨文件 grep，
// LSP 读工具（definition/references/hover/diagnostics/symbols）提供精确的代码追踪能力。
const READONLY_TOOLS = [
  'list_files', 'read_file', 'search_content',
  'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics', 'code_symbols',
  'web_search', 'web_fetch'
]
const MAX_TURNS = 10

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

function callOnce(messages: ChatMsg[], tools: unknown[]): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: string }> }> {
  return new Promise((resolve, reject) => {
    let content = ''
    const buf: Array<{ id: string; name: string; args: string }> = []
    let idx = -1
    const model = getAiState().modelId || 'glm-4.7-flash'
    aiChatStream(
      messages as Array<{ role: 'user' | 'assistant'; content: string }>,
      model,
      tools as never,
      (chunk) => {
        if (chunk.type === 'content') content += chunk.text
        else if (chunk.type === 'tool_call_start') {
          idx++
          buf[idx] = { id: chunk.id || `res_${Date.now()}_${idx}`, name: chunk.name || '', args: '' }
        } else if (chunk.type === 'tool_call_args' && idx >= 0) {
          buf[idx].args += chunk.text
        }
      },
      (err) => {
        if (err) reject(err)
        else resolve({ content, toolCalls: buf.filter((t) => t.name) })
      }
    )
  })
}

export const researchTool: ToolDefinition = {
  name: 'research',
  description:
    '派一个只读研究子智能体去调查问题（对齐 TrieCode 的 task），主 agent 不会被长过程刷屏。子智能体只能用只读工具：列目录、读文件、跨文件搜索(search_content)、LSP 代码追踪(lsp_definition/references/hover/diagnostics/symbols)、联网搜索/抓取——绝不修改任何文件或运行构建/写操作。' +
    '适合：批量重构影响分析（找所有旧 API 调用点）、安全审计（找 SQL 拼接/eval/system 调用）、死代码检测、接口追踪（某参数在哪些文件传递）、新项目上手、Bug 溯源、依赖/协议分析、文档与变更总结、日志/崩溃分析。' +
    '返回结构化报告：发现 / 涉及文件(路径:行号) / 未决问题 / 置信度。把要查的问题写清楚作为 query。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要研究的问题，越具体越好；若需限定范围说明目录或关键词' }
    },
    required: ['query']
  },
  category: 'query',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const query = String(args.query || '').trim()
    if (!query) return { ok: false, content: '', error: 'query 不能为空' }

    const readonlySchemas = toolRegistry.toFunctionSchemas().filter((s) => READONLY_TOOLS.includes(s.function.name))
    if (readonlySchemas.length === 0) {
      return { ok: false, content: '', error: '只读工具未就绪，无法启动研究子智能体' }
    }

    const sys = `你是一个只读研究子智能体（对齐 TrieCode 的 task）。任务：调查用户问题并给出结论。
严格规则：
1. 你只能使用这些只读工具：${READONLY_TOOLS.join(', ')}。禁止写文件、禁止运行编译/测试/删除类命令。
2. 调查方法自主选择：
   - 跨文件检索代码用 search_content（正则/文本，可 glob 限定语言），例如找所有 "digitalWrite"、".map("、"eval("、SQL 拼接；
   - 追踪符号定义/引用/调用关系用 LSP 读工具（lsp_definition / lsp_references / lsp_hover / code_symbols），做接口追踪、死代码、依赖分析；
   - 看单文件内容用 read_file，看目录结构用 list_files，查外部资料用 web_search / web_fetch。
3. 给主 agent 的结论必须是如下固定结构（用中文，四段都给，没有就写"无"）：
   ## 发现
   （调查得到的关键信息与结论）
   ## 涉及文件
   （每条证据写成 路径:行号 形式，便于主 agent 直接定位；可附一句话说明）
   ## 未决问题
   （还无法确定或需要主 agent 进一步确认的点）
   ## 置信度
   （高/中/低，并说明依据）
4. 不要复述你查了多少次工具，直接给上面的结构化结论。`

    const messages: ChatMsg[] = [
      { role: 'system', content: sys },
      { role: 'user', content: `研究问题：${query}\n（项目根：${ctx.projectRoot || '未指定'}）` }
    ]

    let conclusion = ''
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const r = await callOnce(messages, readonlySchemas)
        if (r.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })) })
          for (const tc of r.toolCalls) {
            const tool = toolRegistry.get(tc.name)
            let out: ToolResult
            if (!tool || !READONLY_TOOLS.includes(tc.name)) {
              out = { ok: false, content: '', error: `只读子智能体不允许调用 ${tc.name}` }
            } else {
              let parsed: Record<string, unknown> = {}
              try { parsed = JSON.parse(tc.args || '{}') } catch { parsed = {} }
              out = await tool.execute(parsed, ctx)
            }
            const toolContent = out.error ? `Error: ${out.error}` : out.content
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: String(toolContent || '(无输出)').slice(0, 12000) })
          }
          continue
        }
        conclusion = r.content
        break
      }
    } catch (e) {
      return { ok: false, content: '', error: `研究子智能体运行失败: ${(e as Error).message}` }
    }

    return {
      ok: true,
      content: conclusion.trim() || '（子智能体未产出结论）',
      data: { query, conclusion }
    }
  }
}

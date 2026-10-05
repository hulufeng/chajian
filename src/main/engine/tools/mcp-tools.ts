// MCP 外部工具（第四批④）：让 Agent 能看到并调用外部 MCP server 提供的工具
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition, ToolResult } from '../types'
import { loadMcpServers } from '../../services/mcpConfig'
import { listExternalTools, callExternalTool } from '../../services/mcpManager'

function serverTable(projectRoot: string | null | undefined): string {
  const { servers, globalPath, projectPath } = loadMcpServers(projectRoot)
  if (servers.length === 0) {
    return (
      `没有配置任何 MCP 服务器。\n` +
      `全局配置：${globalPath}\n` +
      `项目配置：${projectPath ?? '（未打开工程）'}\n` +
      `格式与 Claude Desktop 的 mcp.json 一致：{"mcpServers":{"名字":{"command":"npx","args":["-y","包名"]}}}\n` +
      `注意：新增的服务器默认「未信任」，需要在设置里点「信任」后才会被拉起。`
    )
  }
  return (
    `全局配置：${globalPath}\n` +
    `项目配置：${projectPath ?? '（未打开工程）'}\n` +
    servers
      .map((s) => {
        const state = !s.enabled ? '已禁用' : s.trusted ? '已信任' : '未信任（不会被启动）'
        return `- ${s.name}  [${s.source === 'project' ? '工程' : '全局'}] ${state}\n    ${s.command} ${s.args.join(' ')}`
      })
      .join('\n')
  )
}

const mcpTools: ToolDefinition = {
  name: 'mcp_tools',
  description:
    '查看外部 MCP 服务器提供的工具（stdio 传输）。**只有已信任的服务器才会被拉起并出现在这里。**' +
    '需要用外部能力（文档检索、数据库、浏览器自动化等）时先查这个清单，再决定是否调用。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程根目录，默认当前工作区根目录' },
      server: { type: 'string', description: '只看某个服务器提供的工具' }
    },
    required: []
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const root = args.project ? String(args.project) : null
    const table = serverTable(root)
    try {
      const tools = await listExternalTools(root)
      const filtered = args.server ? tools.filter((t) => t.server === String(args.server)) : tools
      if (filtered.length === 0) {
        return { ok: true, content: `${table}\n\n当前没有已连接服务器提供的工具（未信任 / 未启动都会这样）。` }
      }
      const lines = filtered.map((t) => `- ${t.server}/${t.name}${t.description ? ` —— ${t.description}` : ''}`)
      return { ok: true, content: `${table}\n\n可用外部工具（${filtered.length}）：\n${lines.join('\n')}\n\n用 mcp_call 调用。` }
    } catch (e) {
      return { ok: false, content: `读取外部工具失败：${(e as Error).message}\n\n${table}` }
    }
  }
}

const mcpCall: ToolDefinition = {
  name: 'mcp_call',
  description:
    '调用外部 MCP 服务器的工具（stdio）。**调用前必须先用 mcp_tools 确认 server/tool 存在。**' +
    '未信任的服务器会被拒绝调用 —— 需要用户在设置里显式信任。',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: '服务器名（配置里的 key）' },
      tool: { type: 'string', description: '工具名' },
      args: { type: 'object', description: '工具参数，按该工具的 inputSchema 传' },
      project: { type: 'string', description: '工程根目录，默认当前工作区根目录' }
    },
    required: ['server', 'tool']
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const server = String(args.server || '')
    const tool = String(args.tool || '')
    if (!server || !tool) return { ok: false, content: '需要 server 与 tool 两个参数' }
    const root = args.project ? String(args.project) : null
    const r = await callExternalTool(root, server, tool, (args.args as Record<string, unknown>) || {})
    return { ok: r.ok, content: r.ok ? r.content : `调用失败：${r.error || '未知原因'}`, error: r.error }
  }
}

/** 工具清单：未打开工程时也能用，所以不检查工程是否存在 */
export const mcpExternalTools: ToolDefinition[] = [mcpTools, mcpCall]

/** 供 UI/诊断使用：把已连接工具的清单导出成文本 */
export function describeExternalTools(projectRoot: string | null): string {
  const dir = projectRoot ? join(projectRoot, '.labcode') : ''
  const exists = dir ? existsSync(join(dir, 'mcp.json')) : false
  return exists ? `项目级 mcp.json 存在：${join(dir, 'mcp.json')}（其中的服务器需要你逐个信任）` : '项目级没有 mcp.json'
}

// 跨会话记忆 + 可复用技能（兼容 Claude Code SKILL.md）工具
import * as memory from '../../services/memoryService'
import * as skills from '../../services/skillService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

const saveMemoryTool: ToolDefinition = {
  name: 'save_memory',
  description:
    '把一条对未来会话有用的事实写入长期记忆（当前项目级，必要时 tags 标记主题）。' +
    '适合记：项目关键决策、架构约定、用户偏好、踩过的坑、特定命令/配置。不要把临时调试输出或敏感密钥写入。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的事实，一句话说清，包含关键名词' },
      tags: { type: 'string', description: '可选，逗号分隔的主题标签，如 "架构,串口,ESP32"' }
    },
    required: ['content']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const content = String(args.content || '').trim()
    if (!content) return { ok: false, content: '', error: 'content 不能为空' }
    const tags = String(args.tags || '').split(',').map((t) => t.trim()).filter(Boolean)
    const entry = memory.saveMemory(content, ctx.projectRoot, tags)
    return { ok: true, content: `已记住（id=${entry.id}）：${content}`, data: { id: entry.id } }
  }
}

const recallMemoryTool: ToolDefinition = {
  name: 'recall_memory',
  description:
    '从长期记忆里检索与 query 相关的事实（自动跨本会话历史）。开始一个相关任务前先调用，避免重复踩坑或忘掉用户既定约定。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '想回忆的主题/关键词' },
      limit: { type: 'number', description: '返回条数，默认 8' }
    },
    required: ['query']
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const limit = Number(args.limit) || 8
    const hits = memory.searchMemory(String(args.query || ''), ctx.projectRoot, limit)
    if (hits.length === 0) return { ok: true, content: '（没有相关历史记忆）' }
    const text = hits
      .map((h) => `- [${new Date(h.ts).toLocaleString()}] ${h.content}${h.tags.length ? '  #' + h.tags.join(' #') : ''}`)
      .join('\n')
    return { ok: true, content: `相关记忆（${hits.length}条）：\n${text}`, data: { entries: hits } }
  }
}

const listSkillsTool: ToolDefinition = {
  name: 'list_skills',
  description:
    '列出所有已安装的可复用技能（兼容 Claude Code SKILL.md 生态）。每个技能是一套可复用的流程/领域知识。先列清单，需要时用 read_skill 读取完整说明。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'query',
  execute: async (): Promise<ToolResult> => {
    const all = skills.listSkills()
    if (all.length === 0) return { ok: true, content: '（暂无可复用技能。可在 userData/skills/<名字>/SKILL.md 放置，或使用 ~/.claude/skills 下的技能）' }
    const text = all.map((s) => `- ${s.name}（${s.id}，来源:${s.source}）：${s.description}`).join('\n')
    return { ok: true, content: `可用技能（${all.length}）：\n${text}`, data: { skills: all } }
  }
}

const readSkillTool: ToolDefinition = {
  name: 'read_skill',
  description: '读取指定技能的完整说明（SKILL.md 正文），然后按其中的流程/规范执行任务。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能 id（来自 list_skills）' } },
    required: ['name']
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    const hit = skills.readSkill(String(args.name || ''))
    if (!hit) return { ok: false, content: '', error: `未找到技能: ${args.name}` }
    return { ok: true, content: `# ${hit.name}\n\n${hit.content}`, data: { name: hit.name } }
  }
}

const createSkillTool: ToolDefinition = {
  name: 'create_skill',
  description:
    '把一段可复用的流程/领域知识沉淀成全局技能（SKILL.md，存 userData/skills/<id>/，跨项目、跨会话复用，兼容 Claude Code 生态）。' +
    '适合：排查某类编译/烧录/接线错误的完整诊断流程、搭建某类外设或电路的步骤、某类配置/操作手册。' +
    '正文按「触发场景 → 操作步骤 → 示例代码/命令 → 常见坑」组织，做到未来遇到相似任务可直接照做。' +
    '不要为一次性琐事创建；同名会覆盖更新。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（简短，如 esp32-i2c-debug），将作为目录 id' },
      description: { type: 'string', description: '一句话说明何时使用（触发场景），将写入 frontmatter' },
      content: { type: 'string', description: 'SKILL.md 正文：触发场景 → 操作步骤 → 示例代码/命令 → 常见坑' }
    },
    required: ['name', 'description', 'content']
  },
  category: 'write',
  execute: async (args): Promise<ToolResult> => {
    const name = String(args.name || '').trim()
    const description = String(args.description || '').trim()
    const content = String(args.content || '').trim()
    if (!name || !description || !content) {
      return { ok: false, content: '', error: 'name/description/content 都不能为空' }
    }
    if (content.length < 80) {
      return { ok: false, content: '', error: '技能正文过短（<80 字符），请写完整：触发场景、操作步骤、示例、常见坑。' }
    }
    const meta = skills.writeSkill(name, description, content)
    return {
      ok: true,
      content: `已创建全局技能「${meta.name}」（id: ${meta.id}）。后续 list_skills 可见、read_skill 可读取复用；如后续发现更优做法，用同名 create_skill 覆盖更新。`,
      data: { id: meta.id, path: meta.path }
    }
  }
}

export const memoryTools: ToolDefinition[] = [saveMemoryTool, recallMemoryTool, listSkillsTool, readSkillTool, createSkillTool]

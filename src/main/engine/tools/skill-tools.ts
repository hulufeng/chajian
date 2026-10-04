// 项目级可复用技能（指令模板）工具：单工具多 action
// 存储：<projectRoot>/.labcode/skills.json（数组：{name, description, content}）
// 与全局 skillService（扫描 SKILL.md 目录）互补：这里是「本项目内可随时编辑的指令模板」。
// 用法：Agent 用 get 取回模板正文，自行遵循 = 自定义复用指令。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

interface ProjectSkill {
  name: string
  description: string
  content: string
}

function skillsFilePath(root: string | null): string | null {
  if (!root) return null
  return join(root, '.labcode', 'skills.json')
}

function readSkills(root: string | null): ProjectSkill[] {
  const f = skillsFilePath(root)
  if (!f || !existsSync(f)) return []
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ProjectSkill[]) : []
  } catch {
    return []
  }
}

function writeSkills(root: string | null, skills: ProjectSkill[]): void {
  const f = skillsFilePath(root)
  if (!f) return
  const idx = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'))
  const dir = idx >= 0 ? f.slice(0, idx) : f
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(f, JSON.stringify(skills, null, 2), 'utf8')
}

const skillTool: ToolDefinition = {
  name: 'skill',
  description:
    '项目级可复用指令模板（存于 项目根/.labcode/skills.json）。' +
    'action="list" 列出本项目全部模板名称与简介；action="get" 读取某模板全文（Agent 拿到后按其中步骤/规范自行执行）；' +
    'action="create" 新增或覆盖模板（提供 name/description/content）；action="delete" 删除模板。' +
    '用于把「常用操作流程/编码规范/部署步骤」沉淀为可复用指令，避免每次重新解释。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'delete'], description: '操作类型' },
      name: { type: 'string', description: '模板名称（get/create/delete 必填）' },
      description: { type: 'string', description: 'create 时的模板简介' },
      content: { type: 'string', description: 'create 时的模板正文（详细操作步骤/规范文本）' }
    },
    required: ['action']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const action = String(args.action)
    const root = ctx.projectRoot
    if (!root) {
      return { ok: false, content: '', error: '当前未打开项目（projectRoot 为空），无法操作项目级技能。请先打开一个项目。' }
    }

    if (action === 'list') {
      const skills = readSkills(root)
      if (skills.length === 0) {
        return { ok: true, content: '（本项目暂无技能模板。用 action=create 新增一个，如"ESP32 编译烧录流程"。）' }
      }
      const lines = skills.map((s) => `- ${s.name}：${s.description || '(无描述)'}`)
      return { ok: true, content: `本项目技能模板（${skills.length}）：\n${lines.join('\n')}` }
    }

    if (action === 'get') {
      const name = String(args.name || '').trim()
      if (!name) return { ok: false, content: '', error: 'get 需要 name 参数' }
      const hit = readSkills(root).find((s) => s.name === name)
      if (!hit) return { ok: false, content: '', error: `未找到技能模板: ${name}` }
      return { ok: true, content: `# ${hit.name}\n\n${hit.content}`, data: { name: hit.name } }
    }

    if (action === 'create') {
      const name = String(args.name || '').trim()
      if (!name) return { ok: false, content: '', error: 'create 需要 name 参数' }
      const content = String(args.content || '').trim()
      if (!content) return { ok: false, content: '', error: 'create 需要 content 参数（模板正文）' }
      const description = String(args.description || '').trim() || name
      const skills = readSkills(root)
      const idx = skills.findIndex((s) => s.name === name)
      const isUpdate = idx >= 0
      if (isUpdate) {
        skills[idx] = { name, description, content }
      } else {
        skills.push({ name, description, content })
      }
      writeSkills(root, skills)
      return {
        ok: true,
        content: `已${isUpdate ? '更新' : '新增'}技能模板「${name}」（${description}）。\n后续用 action=get 取回正文，Agent 即可按此模板执行。`,
        data: { name }
      }
    }

    if (action === 'delete') {
      const name = String(args.name || '').trim()
      if (!name) return { ok: false, content: '', error: 'delete 需要 name 参数' }
      const skills = readSkills(root)
      const next = skills.filter((s) => s.name !== name)
      if (next.length === skills.length) return { ok: false, content: '', error: `未找到技能模板: ${name}` }
      writeSkills(root, next)
      return { ok: true, content: `已删除技能模板「${name}」。` }
    }

    return { ok: false, content: '', error: `未知 action: ${action}（应为 list/get/create/delete）` }
  }
}

export const skillTools: ToolDefinition[] = [skillTool]

// 可复用技能（Skill）扫描器/写入器 —— 兼容 Claude Code 生态的 SKILL.md 格式
// 每个技能是一个目录，内含 SKILL.md，头部为 YAML frontmatter（name / description）
// 扫描两处：用户技能目录(userData/skills) 与 Claude Code 目录(~/.claude/skills，只读兼容)
// 写入：writeSkill 将新技能落盘到 userData/skills/<id>/SKILL.md（学习循环：任务完成后自动沉淀）
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface SkillMeta {
  id: string
  name: string
  description: string
  source: 'local' | 'claude'
  path: string
}

/** 极简 frontmatter 解析（不引 yaml 依赖），只取 name/description */
function parseFrontmatter(text: string): { name: string; description: string } | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const fm = text.slice(3, end)
  let name = ''
  let description = ''
  for (const line of fm.split('\n')) {
    const m = /^(name|description)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (m[1] === 'name') name = val
    else description = val
  }
  return { name, description }
}

function scanDir(dir: string, source: SkillMeta['source']): SkillMeta[] {
  const out: SkillMeta[] = []
  if (!existsSync(dir)) return out
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return out
  }
  for (const name of entries) {
    const skillFile = join(dir, name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      const text = readFileSync(skillFile, 'utf8')
      const fm = parseFrontmatter(text)
      out.push({
        id: name,
        name: fm?.name || name,
        description: fm?.description || '(无描述)',
        source,
        path: skillFile
      })
    } catch {
      /* 单个技能读取失败不影响整体 */
    }
  }
  return out
}

export function listSkills(): SkillMeta[] {
  const local = scanDir(join(app.getPath('userData'), 'skills'), 'local')
  const claude = scanDir(join(homedir(), '.claude', 'skills'), 'claude')
  // 同名以 local 优先
  const seen = new Set<string>()
  const merged: SkillMeta[] = []
  for (const s of [...local, ...claude]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    merged.push(s)
  }
  return merged
}

export function readSkill(id: string): { name: string; content: string } | null {
  const all = listSkills()
  const meta = all.find((s) => s.id === id)
  if (!meta) return null
  try {
    return { name: meta.name, content: readFileSync(meta.path, 'utf8') }
  } catch {
    return null
  }
}

/** 用户技能目录绝对路径（writeSkill 落盘处） */
export function userSkillsDir(): string {
  const dir = join(app.getPath('userData'), 'skills')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 写入/覆盖一个全局可复用技能（学习循环落盘入口）。
 * id 由 name 归一化（小写、非字母数字转 -、去首尾 -、限长）；同名即覆盖。
 */
export function writeSkill(name: string, description: string, content: string): SkillMeta {
  const raw = name.trim()
  const id = raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `skill-${Date.now()}`
  const dir = join(userSkillsDir(), id)
  mkdirSync(dir, { recursive: true })
  const desc = description.replace(/[\r\n]+/g, ' ').trim()
  const body = content.trim()
  const frontmatter = `---\nname: ${raw}\ndescription: ${desc}\n---\n\n`
  writeFileSync(join(dir, 'SKILL.md'), frontmatter + body + '\n', 'utf8')
  return { id, name: raw, description: desc, source: 'local', path: join(dir, 'SKILL.md') }
}

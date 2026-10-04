// 跨会话记忆：全局 + 项目级，JSON 持久化在 userData/memory/
// agent 通过 save_memory / recall_memory 工具读写；run 启动时自动注入相关记忆
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MemoryEntry {
  id: string
  ts: number
  tags: string[]
  content: string
}

function memoryDir(): string {
  const dir = join(app.getPath('userData'), 'memory')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function projectFile(projectRoot: string | null): string {
  if (!projectRoot) return join(memoryDir(), 'global.json')
  // 把路径压成安全目录名（盘符冒号、斜杠等替换为 -，截断）
  const safe = projectRoot.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(-60).replace(/^-|-$/g, '')
  const dir = join(memoryDir(), 'projects')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${safe}.json`)
}

function readJson(path: string): MemoryEntry[] {
  if (!existsSync(path)) return []
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8')) as MemoryEntry[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeJson(path: string, entries: MemoryEntry[]): void {
  writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8')
}

export function saveMemory(content: string, projectRoot: string | null, tags: string[] = []): MemoryEntry {
  const entry: MemoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    tags,
    content: content.trim()
  }
  const path = projectFile(projectRoot)
  const arr = readJson(path)
  arr.push(entry)
  // 上限 500 条，防止无限膨胀
  while (arr.length > 500) arr.shift()
  writeJson(path, arr)
  return entry
}

export function listMemory(projectRoot: string | null): MemoryEntry[] {
  const local = readJson(projectFile(projectRoot))
  const global = readJson(join(memoryDir(), 'global.json'))
  // 本地在前（新的在上），全局补充
  return [...local.sort((a, b) => b.ts - a.ts), ...global.sort((a, b) => b.ts - a.ts)]
}

export function forgetMemory(id: string, projectRoot: string | null): boolean {
  let changed = false
  for (const path of [projectFile(projectRoot), join(memoryDir(), 'global.json')]) {
    const arr = readJson(path)
    const next = arr.filter((e) => e.id !== id)
    if (next.length !== arr.length) {
      writeJson(path, next)
      changed = true
    }
  }
  return changed
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,，。;；、:：()（）"'`]+/).filter((t) => t.length >= 2)
}

/** 简单关键词打分检索（不引向量依赖），返回最相关记忆 */
export function searchMemory(query: string, projectRoot: string | null, limit = 8): MemoryEntry[] {
  const entries = listMemory(projectRoot)
  if (!query.trim()) return entries.slice(0, limit)
  const qTokens = new Set(tokenize(query))
  const scored = entries
    .map((e) => {
      const text = (e.content + ' ' + e.tags.join(' ')).toLowerCase()
      let score = 0
      for (const t of qTokens) {
        if (text.includes(t)) score += t.length
      }
      // 新鲜度轻微加权（30 天内）
      const ageDays = (Date.now() - e.ts) / 86400000
      if (ageDays < 30) score += 1
      return { e, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return entries.slice(0, limit)
  return scored.slice(0, limit).map((x) => x.e)
}

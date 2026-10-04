/**
 * 内置教学知识库 —— ESP32 基础硬件编程学习
 * 数据源：resources/knowledge/*.md（独立目录，可用 IMA/任意编辑工具维护，重启生效）
 * 文件格式：头部注释块 `<!-- id: xxx / keywords: a,b,c -->` + 正文（教学四段式）
 * 加载：启动时同步扫描首个可用目录（开发 resources/knowledge / 打包 process.resourcesPath/knowledge）
 * 检索：关键词长度加权（轻量，无需向量库），命中 1-3 条注入系统提示
 */
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

export interface KnowledgeItem {
  id: string
  keywords: string[]
  block: string
}

/** 知识库目录候选（用户级插件更新目录优先，其次内置 resources：开发/打包双环境） */
function getKnowledgeDirs(): string[] {
  return [
    path.join(app.getPath('appData'), 'codelab-desktop', 'knowledge'),
    path.join(process.resourcesPath || '', 'knowledge'),
    path.join(app.getAppPath(), 'resources', 'knowledge'),
    path.join(process.cwd(), 'resources', 'knowledge'),
  ]
}

/** 从首个可用目录扫描加载全部 .md 条目 */
function loadKnowledge(): KnowledgeItem[] {
  for (const dir of getKnowledgeDirs()) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
      if (files.length === 0) continue
      const items: KnowledgeItem[] = []
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), 'utf-8')
        const idm = /^<!--\s*id:\s*([^\s]+)/m.exec(text)
        const kwm = /^keywords:\s*([^\n]+)/m.exec(text)
        // 去掉头部注释块
        const body = text.replace(/^<!--[\s\S]*?-->\s*/, '').trim()
        items.push({
          id: idm ? idm[1].trim() : f.replace(/\.md$/, ''),
          keywords: kwm ? kwm[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
          block: body + '\n',
        })
      }
      if (items.length > 0) return items
    } catch { /* 尝试下一个候选 */ }
  }
  return []
}

const KNOWLEDGE: KnowledgeItem[] = loadKnowledge()

/** 检索：query 命中关键词的条目，按关键词长度加权（更精确的条目排前），返回 topN 条 markdown 块 */
export function searchKnowledge(query: string, topN = 3): string[] {
  if (!query) return []
  const q = query.toLowerCase()
  const scored: Array<{ item: KnowledgeItem; score: number }> = []
  for (const item of KNOWLEDGE) {
    let score = 0
    for (const kw of item.keywords) {
      const k = kw.toLowerCase()
      if (k.length >= 2 && q.includes(k)) score += k.length // 长关键词权重高，精确命中排前
    }
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN).map((s) => s.item.block)
}

export function knowledgeCount(): number {
  return KNOWLEDGE.length
}

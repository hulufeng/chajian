/**
 * 烧录历史与回滚（差异化功能 #4）
 *
 * 记什么：每次编译/烧录成功后，把源码树快照 + 元信息落盘。
 * 怎么回滚：回滚 = 把那次成功的源码快照写回工程目录（覆盖同名文件），随后重新编译烧录。
 * 为什么这样设计：arduino-cli 烧录的是构建产物（build 目录），快照源码后再编译就能还原出当时的固件，
 * 比「回滚 bin 文件」更可靠（bin 还要匹配分区表/引导程序）。
 *
 * 存储：%APPDATA%/codelab-desktop/burn-history/index.json（最近 50 条）+ 每条一个源码快照目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import crypto from 'node:crypto'

export interface BurnRecordInput {
  projectRoot: string
  fqbn?: string
  port?: string
  ok: boolean
  /** 成功/失败与耗时摘要（来自编译/烧录输出尾部） */
  logTail?: string
  durationMs?: number
  /** 用户手工补充的备注 */
  note?: string
}

export interface BurnRecord {
  id: string
  ts: number
  projectRoot: string
  projectName: string
  fqbn: string
  port: string
  ok: boolean
  logTail: string
  durationMs?: number
  note?: string
  files: Array<{ rel: string; bytes: number; sha1: string }>
}

const SRC_EXT = ['.ino', '.cpp', '.c', '.h', '.hpp', '.cc', '.txt', '.json', '.h', '.ino']
const SKIP_DIRS = new Set(['build', '.git', 'node_modules', '.labcode', 'dist', 'out', 'sketchbook', 'bin', 'obj'])
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 60
const MAX_RECORDS = 50

function historyDir(): string {
  return path.join(app.getPath('appData'), 'codelab-desktop', 'burn-history')
}

function indexFile(): string {
  return path.join(historyDir(), 'index.json')
}

function readIndex(): BurnRecord[] {
  try {
    const raw = fs.readFileSync(indexFile(), 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as BurnRecord[]) : []
  } catch {
    return []
  }
}

function writeIndex(list: BurnRecord[]): void {
  fs.mkdirSync(historyDir(), { recursive: true })
  const trimmed = list.slice(0, MAX_RECORDS)
  fs.writeFileSync(indexFile(), JSON.stringify(trimmed, null, 2), 'utf-8')
}

/** 采集项目源码树（相对路径 + sha1 + 大小），跳过构建产物。 */
function snapshotSources(projectRoot: string): Array<{ rel: string; bytes: number; sha1: string }> {
  const root = path.resolve(projectRoot)
  if (!fs.existsSync(root)) return []
  const out: Array<{ rel: string; bytes: number; sha1: string }> = []
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop() || ''
    const abs = rel ? path.join(root, rel) : root
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return out
      const relPath = rel ? rel + '/' + e.name : e.name
      const absPath = path.join(root, relPath)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(relPath)
        continue
      }
      if (!e.isFile() || !SRC_EXT.includes(path.extname(e.name).toLowerCase())) continue
      let st: fs.Stats
      try {
        st = fs.statSync(absPath)
      } catch {
        continue
      }
      if (st.size > MAX_FILE_BYTES) continue
      const buf = fs.readFileSync(absPath)
      out.push({ rel: relPath, bytes: st.size, sha1: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) })
    }
  }
  return out
}

/** 记录一次编译/烧录。返回落盘的快照记录。 */
export function recordBurn(input: BurnRecordInput): BurnRecord {
  const root = path.resolve(input.projectRoot || '')
  if (!fs.existsSync(root)) throw new Error(`工程目录不存在：${root}`)
  const files = snapshotSources(root)
  const record: BurnRecord = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    projectRoot: root,
    projectName: path.basename(root),
    fqbn: input.fqbn || '',
    port: input.port || '',
    ok: !!input.ok,
    logTail: (input.logTail || '').slice(-1500),
    durationMs: input.durationMs,
    note: input.note,
    files
  }
  // 必须先落盘快照再写索引：rollbackBurn 从 <history>/<id>/ 读原始内容，
  // 少了这一步回滚会全部落到 missing，等于空操作。
  ensureSnapshot(record)

  const list = readIndex()
  list.unshift(record)
  writeIndex(list)
  return record
}

export function listBurnHistory(limit = 50): BurnRecord[] {
  return readIndex().slice(0, limit)
}

export function getBurn(id: string): BurnRecord | null {
  return readIndex().find((r) => r.id === id) || null
}

export interface RollbackResult {
  id: string
  written: string[]
  changed: string[]
  missing: string[]
}

/**
 * 回滚到某次烧录时的源码状态：把快照文件写回工程（同名覆盖）。
 * 只还原记录里存在的文件；工程里新增的文件不会被删除（安全取向：不删用户新代码）。
 */
export function rollbackBurn(id: string, targetRoot?: string): RollbackResult {
  const rec = getBurn(id)
  if (!rec) throw new Error(`烧录记录不存在：${id}`)
  const root = path.resolve(targetRoot || rec.projectRoot)
  if (!fs.existsSync(root)) throw new Error(`回滚目标目录不存在：${root}`)
  const srcDir = path.join(historyDir(), id)
  const written: string[] = []
  const changed: string[] = []
  const missing: string[] = []

  for (const f of rec.files) {
    const dest = path.join(root, f.rel)
    const snap = path.join(srcDir, f.rel)
    let content: Buffer
    try {
      content = fs.readFileSync(snap)
    } catch {
      missing.push(f.rel)
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const before = fs.existsSync(dest) ? fs.readFileSync(dest) : null
    fs.writeFileSync(dest, content)
    written.push(f.rel)
    if (before && !before.equals(content)) changed.push(f.rel)
  }
  return { id, written, changed, missing }
}

/** 快照落盘（recordBurn 时同步写入，保证回滚有 source）。 */
export function ensureSnapshot(rec: BurnRecord): number {
  const dir = path.join(historyDir(), rec.id)
  let n = 0
  for (const f of rec.files) {
    const src = path.join(rec.projectRoot, f.rel)
    const dest = path.join(dir, f.rel)
    try {
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, fs.readFileSync(src))
      n++
    } catch {
      /* 单个文件失败不阻断记录 */
    }
  }
  return n
}

export function removeBurn(id: string): boolean {
  const list = readIndex()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return false
  writeIndex(next)
  return true
}

/** 给 UI 的精简视图（不含 files 详情）。 */
export function summarizeBurn(rec: BurnRecord): {
  id: string
  ts: number
  projectName: string
  fqbn: string
  port: string
  ok: boolean
  fileCount: number
  /** 日志尾部（列表里够用；完整版走 burn:get） */
  logTail: string
  note?: string
} {
  return {
    id: rec.id,
    ts: rec.ts,
    projectName: rec.projectName,
    fqbn: rec.fqbn,
    port: rec.port,
    ok: rec.ok,
    fileCount: rec.files.length,
    logTail: rec.logTail || '',
    note: rec.note
  }
}

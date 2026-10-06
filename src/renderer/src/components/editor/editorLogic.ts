import type { EditorTab } from './types'

/** 大文件保护阈值（1MB）。 */
export const BIG_FILE_BYTES = 1024 * 1024
/** 二进制扩展名（图片走预览分支，不在此列）。 */
export const BINARY_EXT = new Set<string>([
  'bin', 'exe', 'dll', 'so', 'o', 'a', 'elf', 'uf2', 'img', 'hex'
])

export interface FileMeta {
  size: number
  mtimeMs: number
}

/** 大文件 / 二进制判定：返回是否只读保护 + 原因。 */
export function classifyFile(name: string, meta: FileMeta): { readOnly: boolean; reason?: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (BINARY_EXT.has(ext)) return { readOnly: true, reason: '二进制文件' }
  if (meta.size > BIG_FILE_BYTES) {
    const mb = (meta.size / 1024 / 1024).toFixed(1)
    return { readOnly: true, reason: `文件过大（${mb} MB）` }
  }
  return { readOnly: false }
}

/**
 * 所有分支都带 mtimeMs：调用方（App.openFile）不是逐个判别式的去取，
 * 而是统一 patch `mtimeMs: d.mtimeMs`，缺它就编译不过。
 */
export type OpenDecision =
  | { kind: 'add'; content: string; mtimeMs: number }
  | { kind: 'protect'; notice: string; mtimeMs: number }
  | { kind: 'reload'; content: string; mtimeMs: number }
  | { kind: 'keep-dirty'; mtimeMs: number; warn: string }
  | { kind: 'noop'; mtimeMs: number }

/**
 * 打开文件的纯判定（不碰 React / IPC，便于单测）：
 * - 二进制 / 过大 → protect（只读提示，不读内容）
 * - 新文件 → add
 * - 已存在 + 外部 mtime 更新 → reload（清 dirty）
 * - 已存在 + 外部更新 + 本地脏 → keep-dirty（保留本地 + 警告，不静默覆盖）
 * - 已存在 + 未变 + 已有内容 → noop
 */
export function decideOpen(
  existing: EditorTab | undefined,
  name: string,
  meta: FileMeta,
  content: string
): OpenDecision {
  const cls = classifyFile(name, meta)
  if (cls.readOnly) {
    const notice = `${name}\n${cls.reason}，已设为只读。\n请在外部编辑器打开，或在文件管理器中查看。`
    return { kind: 'protect', notice, mtimeMs: meta.mtimeMs }
  }
  if (!existing) return { kind: 'add', content, mtimeMs: meta.mtimeMs }
  const changed = existing.mtimeMs !== undefined && meta.mtimeMs > existing.mtimeMs
  if (changed && existing.dirty) {
    return {
      kind: 'keep-dirty',
      mtimeMs: meta.mtimeMs,
      warn: `⚠ ${name} 在外部被修改，且你有未保存的改动，已保留本地版本。需要外部版本请先保存，或关闭该标签后重新打开。`
    }
  }
  if (changed || !existing.content) return { kind: 'reload', content, mtimeMs: meta.mtimeMs }
  return { kind: 'noop', mtimeMs: meta.mtimeMs }
}

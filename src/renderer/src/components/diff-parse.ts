// 统一 diff 解析器（与 UI 解耦，纯函数，可单测）
//
// 支持两种输入：
//   1) 标准 unified diff（带 @@ -a,b +c,d @@ hunk 头）—— 行首标记 1 个字符（' ' / '-' / '+'）
//   2) 本项目 edit_file 生成的简式 diff —— 行首标记 2 个字符（'  ' / '- ' / '+ '），无 @@ 头
//
// 产出结构化 hunk / 行号 / 增删统计，并做「行内词级」差异标注（成对的删+增行）。

export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffSegment {
  text: string
  /** 该片段在本行内是否属于变更部分（用于词级高亮） */
  changed: boolean
}

export interface DiffLine {
  type: DiffLineType
  /** 旧文件行号（add 行为 null） */
  oldNo: number | null
  /** 新文件行号（del 行为 null） */
  newNo: number | null
  text: string
  /** 仅当该行参与词级比对时有值 */
  segments?: DiffSegment[]
}

export interface DiffHunk {
  /** 原始 hunk 头（无 @@ 时为 null） */
  header: string | null
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/** 把一行拆成「词 / 空白 / 单字符」三类 token，供词级比对使用。 */
export function tokenize(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_]+|[^\s]/g) ?? []
}

/** 基于最长公共子序列（LCS）的词级差异，返回两端各自的片段序列。 */
export function wordDiff(oldLine: string, newLine: string): { old: DiffSegment[]; new: DiffSegment[] } {
  const a = tokenize(oldLine)
  const b = tokenize(newLine)
  const n = a.length
  const m = b.length
  // 线段很常见是短的；为稳妥仍用 O(n*m) DP，并对超长行做降级（整行视为变更）
  if (n * m > 40000) {
    return {
      old: [{ text: oldLine, changed: oldLine !== newLine }],
      new: [{ text: newLine, changed: oldLine !== newLine }]
    }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const oldSeg: DiffSegment[] = []
  const newSeg: DiffSegment[] = []
  const pushSeg = (arr: DiffSegment[], text: string, changed: boolean): void => {
    if (!text) return
    const last = arr[arr.length - 1]
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { pushSeg(oldSeg, a[i], false); pushSeg(newSeg, b[j], false); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { pushSeg(oldSeg, a[i], true); i++ }
    else { pushSeg(newSeg, b[j], true); j++ }
  }
  while (i < n) { pushSeg(oldSeg, a[i], true); i++ }
  while (j < m) { pushSeg(newSeg, b[j], true); j++ }
  return { old: oldSeg, new: newSeg }
}

/**
 * 解析 unified diff 文本。容忍 CRLF 与末尾空行。
 * 无效/空输入返回空 hunk。
 */
export function parseUnifiedDiff(input: string): ParsedDiff {
  const rawLines = String(input ?? '').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  // 去掉仅由末尾换行带来的最后一行空串
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  const standard = rawLines.some((l) => HUNK_RE.test(l))
  const markerLen = standard ? 1 : 2

  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0

  const ensureHunk = (): DiffHunk => {
    if (!cur) {
      cur = { header: null, oldStart: 1, newStart: 1, lines: [] }
      hunks.push(cur)
    }
    return cur
  }

  for (const line of rawLines) {
    const hm = HUNK_RE.exec(line)
    if (hm) {
      oldNo = Number(hm[1]) || 1
      newNo = Number(hm[3]) || 1
      cur = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(cur)
      continue
    }
    const marker = line.slice(0, markerLen)
    const text = line.slice(markerLen)
    if (marker.startsWith('+')) {
      ensureHunk().lines.push({ type: 'add', oldNo: null, newNo: newNo++, text })
      added++
    } else if (marker.startsWith('-')) {
      ensureHunk().lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text })
      removed++
    } else {
      // 上下文行：标准模式为 1 个空格 + 文本；简式模式为 2 个空格 + 文本
      ensureHunk().lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text })
    }
  }

  annotateWordDiffs(hunks)
  return { hunks, added, removed }
}

/** 给「成对的删+增行」附加词级 segments（不成对时保持整行变更）。 */
function annotateWordDiffs(hunks: DiffHunk[]): void {
  for (const h of hunks) {
    let i = 0
    while (i < h.lines.length) {
      if (h.lines[i].type === 'del') {
        let d = i
        while (d < h.lines.length && h.lines[d].type === 'del') d++
        let a = d
        while (a < h.lines.length && h.lines[a].type === 'add') a++
        const delCount = d - i
        const addCount = a - d
        const pair = Math.min(delCount, addCount)
        for (let k = 0; k < pair; k++) {
          const dl = h.lines[i + k]
          const al = h.lines[d + k]
          const { old: os, new: ns } = wordDiff(dl.text, al.text)
          dl.segments = os
          al.segments = ns
        }
        i = a > i ? a : i + 1
      } else {
        i++
      }
    }
  }
}

/** 一行内是否存在真正变更的片段（用于决定要不要做词级高亮）。 */
export function hasChangedSegment(line: DiffLine): boolean {
  return !!line.segments && line.segments.some((s) => s.changed)
}

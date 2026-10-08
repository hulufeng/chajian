import { useMemo, useState } from 'react'
import { parseUnifiedDiff, hasChangedSegment, type DiffLine, type ParsedDiff } from './diff-parse'

/**
 * 整文件可视化 diff（对齐 TrieCode 的 diff 预览精细度）。
 *
 * 相比旧的「行级 <pre> 着色」，补齐：
 *  - 行号栏（旧号 / 新号，空号留白）
 *  - hunk 头（@@ … @@）识别与展示
 *  - 增删统计徽标（+N −M）
 *  - 词级高亮（成对的删+增行做行内字符级差异）
 *  - 统一视图 / 并排视图切换
 *  - 长 diff 折叠（超过阈值默认折叠，可展开）
 *
 * 颜色全部走 theme token（--success / --danger 的 soft 底 + 主色文字），无 hex 字面量。
 */

interface DiffViewProps {
  text: string
  /** 超过多少行默认折叠；<=0 表示不折叠 */
  collapseAfter?: number
  /** 初始视图 */
  defaultView?: 'unified' | 'split'
}

const COLLAPSE_DEFAULT = 40

function LineContent({ line }: { line: DiffLine }): React.JSX.Element {
  if (line.segments && hasChangedSegment(line)) {
    return (
      <>
        {line.segments.map((s, i) =>
          s.changed ? <mark key={i} className="diff-mark">{s.text}</mark> : <span key={i}>{s.text}</span>
        )}
      </>
    )
  }
  return <>{line.text || '\u00a0'}</>
}

function markerOf(t: DiffLine['type']): string {
  return t === 'add' ? '+' : t === 'del' ? '-' : ' '
}

function UnifiedBody({ hunks }: { hunks: ParsedDiff['hunks'] }): React.JSX.Element {
  return (
    <div className="diff-body">
      {hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk">
          {h.header && <div className="diff-hunk-head">{h.header}</div>}
          {h.lines.map((l, li) => (
            <div key={li} className={`diff-line diff-${l.type}`}>
              <span className="diff-ln diff-ln-old">{l.oldNo ?? ''}</span>
              <span className="diff-ln diff-ln-new">{l.newNo ?? ''}</span>
              <span className="diff-sign">{markerOf(l.type)}</span>
              <span className="diff-text"><LineContent line={l} /></span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** 把 hunk 的行归并成并排的行对：删+增成对并排，多出的单侧占位。 */
interface SplitRow { left: DiffLine | null; right: DiffLine | null }
function toSplitRows(hunks: ParsedDiff['hunks']): SplitRow[][] {
  return hunks.map((h) => {
    const rows: SplitRow[] = []
    let i = 0
    while (i < h.lines.length) {
      const cur = h.lines[i]
      if (cur.type === 'context') {
        rows.push({ left: cur, right: cur })
        i++
        continue
      }
      let d = i
      while (d < h.lines.length && h.lines[d].type === 'del') d++
      let a = d
      while (a < h.lines.length && h.lines[a].type === 'add') a++
      const dels = h.lines.slice(i, d)
      const adds = h.lines.slice(d, a)
      const n = Math.max(dels.length, adds.length)
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
      i = a > i ? a : i + 1
    }
    return rows
  })
}

function splitCell(line: DiffLine | null, side: 'left' | 'right'): React.JSX.Element {
  if (!line) return <div className="diff-line diff-empty"><span className="diff-ln" /><span className="diff-text"> </span></div>
  const ln = side === 'left' ? line.oldNo : line.newNo
  return (
    <div className={`diff-line diff-${line.type}`}>
      <span className="diff-ln">{ln ?? ''}</span>
      <span className="diff-sign">{markerOf(line.type)}</span>
      <span className="diff-text"><LineContent line={line} /></span>
    </div>
  )
}

function SplitBody({ hunks }: { hunks: ParsedDiff['hunks'] }): React.JSX.Element {
  const grouped = useMemo(() => toSplitRows(hunks), [hunks])
  return (
    <div className="diff-body diff-split">
      {grouped.map((rows, hi) => (
        <div key={hi} className="diff-hunk">
          {hunks[hi].header && <div className="diff-hunk-head">{hunks[hi].header}</div>}
          {rows.map((r, ri) => (
            <div key={ri} className="diff-split-row">
              <div className="diff-col diff-col-left">{splitCell(r.left, 'left')}</div>
              <div className="diff-col diff-col-right">{splitCell(r.right, 'right')}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function DiffView({ text, collapseAfter = COLLAPSE_DEFAULT, defaultView = 'unified' }: DiffViewProps): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(text), [text])
  const [view, setView] = useState<'unified' | 'split'>(defaultView)
  const [expanded, setExpanded] = useState(false)

  const total = parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
  if (total === 0) {
    return <pre className="diff-empty-note">{text}</pre>
  }

  const needCollapse = collapseAfter > 0 && total > collapseAfter
  const shownHunks = needCollapse && !expanded
    ? [{ ...parsed.hunks[0], lines: parsed.hunks[0].lines.slice(0, collapseAfter) }]
    : parsed.hunks

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-stat diff-stat-add">+{parsed.added}</span>
        <span className="diff-stat diff-stat-del">−{parsed.removed}</span>
        <span className="diff-stat-total">{total} 行变更区</span>
        <div className="diff-view-toggle">
          <button className={`diff-view-btn${view === 'unified' ? ' active' : ''}`} onClick={() => setView('unified')} title="统一视图">统一</button>
          <button className={`diff-view-btn${view === 'split' ? ' active' : ''}`} onClick={() => setView('split')} title="并排视图">并排</button>
        </div>
      </div>
      {view === 'unified' ? <UnifiedBody hunks={shownHunks} /> : <SplitBody hunks={shownHunks} />}
      {needCollapse && (
        <button className="diff-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '▲ 收起' : `▼ 展开全部（共 ${total} 行）`}
        </button>
      )}
    </div>
  )
}

export default DiffView

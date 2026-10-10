import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { btnPrimary, btnStyle, catColor, footerBar, headerBar, input, modalPanel, overlay, td, th, toneColor, toneSoft } from './modalStyles'

interface PartitionRow {
  name: string
  type: string
  subtype: string
  offset: string
  size: string
  flags: string
}

interface Props {
  projectRoot: string
  onClose: () => void
}

/** 本弹窗比通用宽度略窄一点，其余外观全部复用 modalStyles */
const panel: CSSProperties = { ...modalPanel, width: 'min(920px, 94vw)' }
const cellInput: CSSProperties = { ...input, width: '100%', padding: '3px 5px' }

function colorFor(i: number): string {
  return catColor(i)
}

function parseSize(s: string): number | null {
  const t = (s || '').trim()
  if (!t || t === 'remaining') return null
  const hex = t.match(/^0x([0-9a-fA-F]+)$/)
  if (hex) return parseInt(hex[1], 16)
  const m = t.match(/^(\d+)([KMGkmg]?)$/)
  if (m) {
    const n = parseInt(m[1], 10)
    const u = m[2].toUpperCase()
    return n * (u === 'K' ? 1024 : u === 'M' ? 1048576 : u === 'G' ? 1073741824 : 1)
  }
  return null
}

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a
}

interface RowStatus {
  level: 'ok' | 'warn' | 'err'
  msg: string
}

function validate(rows: PartitionRow[]): { per: Record<number, RowStatus>; errs: number; warns: number } {
  const per: Record<number, RowStatus> = {}
  rows.forEach((_, i) => (per[i] = { level: 'ok', msg: '' }))

  rows.forEach((r, i) => {
    const ob = parseSize(r.offset)
    const sz = parseSize(r.size)
    const errMsgs: string[] = []
    const warnMsgs: string[] = []
    if (ob != null && ob % 0x1000 !== 0) errMsgs.push('offset 未 4KB 对齐')
    // T2-a：app 分区偏移硬性 64KB 对齐（ESP-IDF 要求 app 镜像按 64KB 扇区擦除）
    if (r.type === 'app' && ob != null && ob % 0x10000 !== 0) errMsgs.push('app 分区偏移须 64KB(0x10000) 对齐')
    if (r.type === 'app' && r.subtype === 'factory' && ob != null && ob < 0x10000) errMsgs.push('factory 分区偏移须 >= 0x10000')
    // T2-a：nvs 分区大小硬性要求为 0x1000(4KB) 整数倍（NVS 页 = 4KB）
    if (r.type === 'data' && r.subtype === 'nvs' && sz != null && sz % 0x1000 !== 0) errMsgs.push('nvs 分区大小须为 0x1000(4KB) 整数倍')
    if (sz != null && sz % 0x1000 !== 0 && !(r.type === 'data' && r.subtype === 'nvs')) warnMsgs.push('size 未 4KB 对齐')
    const msgs = [...errMsgs, ...warnMsgs]
    if (msgs.length) per[i] = { level: errMsgs.length ? 'err' : 'warn', msg: msgs.join('；') }
  })

  const ordered = rows
    .map((r, i) => ({ i, r, ob: parseSize(r.offset), sz: parseSize(r.size) }))
    .filter((p) => p.ob != null)
    .sort((a, b) => (a.ob as number) - (b.ob as number))

  for (let k = 0; k < ordered.length; k++) {
    const cur = ordered[k]
    if ((cur.r.size || '').trim() === 'remaining' && k < ordered.length - 1) {
      per[cur.i] = { level: 'err', msg: (per[cur.i].msg ? per[cur.i].msg + '；' : '') + 'remaining 必须置于最后' }
    }
    if (k > 0) {
      const prev = ordered[k - 1]
      const prevEnd = (prev.ob as number) + (prev.sz ?? 0)
      if ((cur.ob as number) < prevEnd) {
        const m = `与「${prev.r.name}」重叠（其结束于 0x${prevEnd.toString(16)}）`
        per[cur.i] = { level: 'err', msg: (per[cur.i].msg ? per[cur.i].msg + '；' : '') + m }
      }
    }
  }

  let errs = 0
  let warns = 0
  Object.values(per).forEach((s) => {
    if (s.level === 'err') errs++
    else if (s.level === 'warn') warns++
  })
  return { per, errs, warns }
}

function autoLayout(rows: PartitionRow[]): PartitionRow[] {
  const withOff = rows.map((r, i) => ({ r, i, ob: parseSize(r.offset) }))
  const sorted = withOff.slice().sort((a, b) => {
    if (a.ob != null && b.ob != null) return a.ob - b.ob
    if (a.ob != null) return -1
    if (b.ob != null) return 1
    return a.i - b.i
  })
  const explicit = sorted.filter((x) => x.ob != null).map((x) => x.ob as number)
  let cur = explicit.length ? Math.min(...explicit) : 0x9000
  const result = sorted.map((x) => {
    const r = { ...x.r }
    if (x.ob != null) {
      cur = x.ob
    } else {
      const a = alignUp(cur, r.type === 'app' ? 0x10000 : 0x1000)
      r.offset = '0x' + a.toString(16)
      cur = a
    }
    const sz = parseSize(r.size)
    if (sz != null) cur += sz
    return r
  })
  const out = rows.slice()
  sorted.forEach((x, k) => (out[x.i] = result[k]))
  return out
}

export default function PartitionEditor({ projectRoot, onClose }: Props) {
  const [rows, setRows] = useState<PartitionRow[]>([])
  const [path, setPath] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.espIdf
      .readPartitions(projectRoot)
      .then((r) => {
        if (r.ok && r.rows) {
          setRows(r.rows)
          setPath(r.path || '')
          setIsNew(!!r.isNew)
        } else {
          setError(r.error || '读取失败')
        }
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [projectRoot])

  const update = (i: number, key: keyof PartitionRow, val: string): void => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)))
  }
  const addRow = (): void =>
    setRows((rs) => [...rs, { name: 'new_part', type: 'data', subtype: 'nvs', offset: '', size: '0x1000', flags: '' }])
  const delRow = (i: number): void => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const validation = useMemo(() => validate(rows), [rows])

  const save = (): void => {
    if (validation.errs > 0) {
      if (!window.confirm(`检测到 ${validation.errs} 处分区冲突，仍要保存吗？`)) return
    }
    window.api.espIdf
      .writePartitions(path, rows)
      .then((r) => {
        if (r.ok) onClose()
        else setError(r.error || '保存失败')
      })
      .catch((e) => setError(String(e)))
  }

  const segs = rows.map((r) => ({ name: r.name, bytes: parseSize(r.size) }))
  const hasRemaining = rows.some((r) => (r.size || '').trim() === 'remaining')
  // 顶部状态条的整体语气：有错是错、其次警告、否则正常
  const level: 'ok' | 'warn' | 'err' = validation.errs ? 'err' : validation.warns ? 'warn' : 'ok'

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={headerBar}>
          <strong>分区表编辑（{isNew ? '新建 ' : ''}{path || 'partitions.csv'}）</strong>
          <button style={btnStyle} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: 12, overflow: 'auto' }}>
          {loading && <div>读取中…</div>}
          {error && <div style={{ color: 'var(--error)' }}>{error}</div>}
          {!loading && !error && (
            <>
              <div
                style={{
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-2xs)',
                  marginBottom: 10,
                  fontSize: 13,
                  background: toneSoft(level),
                  border: `1px solid ${toneColor(level)}`
                }}
              >
                {validation.errs
                  ? `⚠ ${validation.errs} 处分区冲突，请修正后再保存`
                  : validation.warns
                    ? `⚠ ${validation.warns} 处布局提示（可保存）`
                    : '✓ 分区表布局合法（无重叠 / 对齐正确）'}
              </div>
              <div style={{ display: 'flex', height: 26, borderRadius: 'var(--radius-2xs)', overflow: 'hidden', marginBottom: 10, border: '1px solid var(--border)' }}>
                {segs.map((s, i) => (
                  <div
                    key={i}
                    title={`${s.name} · ${rows[i].size}`}
                    style={{
                      flexGrow: hasRemaining && (rows[i].size || '').trim() === 'remaining' ? 4 : s.bytes || 1,
                      background: colorFor(i),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      color: 'var(--on-accent)',
                      minWidth: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {s.name}
                  </div>
                ))}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--accent)' }}>
                    <th style={th}>Name</th>
                    <th style={th}>Type</th>
                    <th style={th}>SubType</th>
                    <th style={th}>Offset</th>
                    <th style={th}>Size</th>
                    <th style={th}>Flags</th>
                    <th style={th}>校验</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const st = validation.per[i]
                    const mark = { c: st.level === 'ok' ? '✓' : st.level === 'warn' ? '!' : '×', col: toneColor(st.level) }
                    return (
                      <tr key={i}>
                        <td style={td}><input style={cellInput} value={r.name} onChange={(e) => update(i, 'name', e.target.value)} /></td>
                        <td style={td}><input style={cellInput} value={r.type} onChange={(e) => update(i, 'type', e.target.value)} /></td>
                        <td style={td}><input style={cellInput} value={r.subtype} onChange={(e) => update(i, 'subtype', e.target.value)} /></td>
                        <td style={td}><input style={cellInput} value={r.offset} onChange={(e) => update(i, 'offset', e.target.value)} placeholder="0x1000" /></td>
                        <td style={td}><input style={cellInput} value={r.size} onChange={(e) => update(i, 'size', e.target.value)} placeholder="1M / 0x1000 / remaining" /></td>
                        <td style={td}><input style={cellInput} value={r.flags} onChange={(e) => update(i, 'flags', e.target.value)} placeholder="encrypted" /></td>
                        <td style={{ ...td, color: mark.col, cursor: 'help' }} title={st.msg || '合法'}>{mark.c}</td>
                        <td style={td}><button style={btnStyle} onClick={() => delRow(i)}>删</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button style={btnStyle} onClick={addRow}>+ 新增分区</button>
                <button style={btnStyle} onClick={() => setRows(autoLayout(rows))}>自动排布 offset</button>
              </div>
            </>
          )}
        </div>
        <div style={footerBar}>
          <button style={btnStyle} onClick={onClose}>取消</button>
          <button style={btnPrimary} onClick={save}>保存分区表</button>
        </div>
      </div>
    </div>
  )
}

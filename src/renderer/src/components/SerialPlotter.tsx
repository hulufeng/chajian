import { useEffect, useRef, useState } from 'react'

interface Props {
  serialLog: string
  serialOpen: boolean
  theme: 'light' | 'dark'
  /** 环形缓冲最大采样点（每通道），超出后左移丢弃 */
  maxPoints?: number
}

type ChannelState = {
  channels: number[][]
  count: number
}

const CHANNEL_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231',
  '#911eb4', '#46c4f0', '#f032e6', '#bcf60c'
]

const WIN_BG = { light: 'var(--panel)', dark: 'var(--terminal-bg)' }
const WIN_TEXT = { light: 'var(--text-dim)', dark: 'var(--text-dim)' }
const GRID = { light: 'var(--ink-1)', dark: 'var(--white-1)' }

/**
 * 解析一行文本，判断其是否为可绘制的数值行（兼容 Arduino Serial Plotter 约定）：
 *  - 每行一个数值，或多列逗号 / 制表符 / 空白分隔的数值
 *  - 所有 token 都必须是有限数字，否则视为文本行跳过
 * 返回 null 表示该行不是数据行。
 */
function parseNumericLine(line: string): number[] | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let tokens: string[]
  if (trimmed.includes(',')) tokens = trimmed.split(',')
  else if (trimmed.includes('\t')) tokens = trimmed.split('\t')
  else tokens = trimmed.split(/\s+/)

  if (tokens.length === 0) return null
  const nums: number[] = []
  for (const t of tokens) {
    const v = parseFloat(t)
    if (!Number.isFinite(v)) return null // 含非数字 token，视为文本行
    nums.push(v)
  }
  return nums.length === 0 ? null : nums
}

export default function SerialPlotter({
  serialLog,
  serialOpen,
  theme,
  maxPoints = 300
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buffersRef = useRef<ChannelState>({ channels: [], count: 0 })
  const lastIndexRef = useRef(0)
  const pausedRef = useRef(false)

  const [paused, setPaused] = useState(false)
  const [autoScale, setAutoScale] = useState(true)
  const [manualMin, setManualMin] = useState(0)
  const [manualMax, setManualMax] = useState(1024)
  const [stats, setStats] = useState<{ ch: number; points: number }>({ ch: 0, points: 0 })
  // AI 解读（差异化功能 #3：串口日志 → 当前 AI 通道解读，先给规则命中的证据再下结论）
  const [explainBusy, setExplainBusy] = useState(false)
  const [explainOut, setExplainOut] = useState<{ text: string; channel: string; findings: Array<{ kind: string; line: number; text: string }> } | null>(null)
  const [explainErr, setExplainErr] = useState('')

  const runExplain = (): void => {
    if (explainBusy) return
    if (!serialLog || !serialLog.trim()) {
      setExplainErr('串口还没有输出，先让设备发点数据（或打开串口监视器产生日志）再解读。')
      setExplainOut(null)
      return
    }
    setExplainBusy(true)
    setExplainErr('')
    setExplainOut(null)
    void window.api.serial
      .explain({ logs: serialLog })
      .then((r) => setExplainOut({ text: r.text, channel: r.channel, findings: r.findings }))
      .catch((e: Error) => setExplainErr(e.message))
      .finally(() => setExplainBusy(false))
  }

  // 把 ref 的 paused 与 state 同步
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  const draw = () => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = WIN_BG[theme]
    ctx.fillRect(0, 0, w, h)

    const { channels, count } = buffersRef.current
    const len0 = count > 0 ? channels[0].length : 0
    if (count === 0 || len0 === 0) {
      ctx.fillStyle = WIN_TEXT[theme]
      ctx.font = '13px system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(
        serialOpen
          ? '等待数值数据…（每行一个数值，或多列逗号分隔，例如 512 或 3.1,4.2,5.0）'
          : '串口未打开',
        12,
        h / 2
      )
      return
    }

    // 计算纵向范围
    let min = autoScale ? Infinity : manualMin
    let max = autoScale ? -Infinity : manualMax
    if (autoScale) {
      for (const ch of channels) for (const v of ch) {
        if (v < min) min = v
        if (v > max) max = v
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0
        max = 1
      }
      if (min === max) {
        min -= 1
        max += 1
      }
    } else {
      if (manualMin === manualMax) max = manualMin + 1
    }

    // 网格
    ctx.strokeStyle = GRID[theme]
    ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const y = (h / 4) * g + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    // 刻度文字
    ctx.fillStyle = WIN_TEXT[theme]
    ctx.font = '11px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillText(max.toFixed(1), 4, 4)
    ctx.textBaseline = 'bottom'
    ctx.fillText(min.toFixed(1), 4, h - 4)

    const pad = 6
    const plotH = h - pad * 2
    const n = len0

    channels.forEach((ch, ci) => {
      if (ch.length < 2) return
      ctx.beginPath()
      ctx.strokeStyle = CHANNEL_COLORS[ci % CHANNEL_COLORS.length]
      ctx.lineWidth = 1.6
      for (let i = 0; i < ch.length; i++) {
        const x = pad + (w - pad * 2) * (i / (n - 1))
        const y = pad + plotH * (1 - (ch[i] - min) / (max - min))
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    })

    // 图例
    const legendY = 4
    ctx.font = '11px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    let lx = 48
    channels.forEach((_, ci) => {
      const label = `CH${ci + 1}`
      ctx.fillStyle = CHANNEL_COLORS[ci % CHANNEL_COLORS.length]
      ctx.fillRect(lx, legendY + 2, 10, 10)
      ctx.fillStyle = WIN_TEXT[theme]
      ctx.fillText(label, lx + 14, legendY)
      lx += 14 + ctx.measureText(label).width + 14
    })
  }

  // 解析新增的串口文本尾部，追加到环形缓冲
  useEffect(() => {
    const full = serialLog
    // serialLog 被重置（如清空/切换工程）→ 重置缓冲
    if (full.length < lastIndexRef.current) {
      buffersRef.current = { channels: [], count: 0 }
      lastIndexRef.current = 0
    }
    const tail = full.slice(lastIndexRef.current)
    lastIndexRef.current = full.length

    if (!pausedRef.current && tail) {
      const lines = tail.split('\n')
      const { channels, count } = buffersRef.current
      for (const raw of lines) {
        const nums = parseNumericLine(raw)
        if (!nums) continue
        if (count === 0) {
          buffersRef.current.channels = nums.map(() => [])
          buffersRef.current.count = nums.length
        } else if (nums.length !== count) {
          continue // 通道数不匹配，跳过该行
        }
        nums.forEach((v, i) => {
          const arr = buffersRef.current.channels[i]
          arr.push(v)
          if (arr.length > maxPoints) arr.shift()
        })
      }
      const newCount = buffersRef.current.count
      const newPoints = newCount > 0 ? buffersRef.current.channels[0].length : 0
      setStats({ ch: newCount, points: newPoints })
    }
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialLog, maxPoints, theme, autoScale, manualMin, manualMax])

  // 自适应容器尺寸重绘
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearPlot = () => {
    buffersRef.current = { channels: [], count: 0 }
    lastIndexRef.current = serialLog.length // 不清空文本日志，仅清空波形缓冲
    setStats({ ch: 0, points: 0 })
    draw()
  }

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? (theme === 'dark' ? 'var(--panel-hover)' : 'var(--panel-2)') : 'transparent',
    color: theme === 'dark' ? 'var(--text)' : 'var(--text-dim)',
    border: `1px solid ${theme === 'dark' ? 'var(--border-strong)' : 'var(--border)'}`,
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 12,
    cursor: 'pointer',
    marginRight: 6
  })

  const ctrlRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    padding: '6px 8px',
    borderBottom: `1px solid ${theme === 'dark' ? 'var(--border-strong)' : 'var(--border)'}`,
    background: theme === 'dark' ? 'var(--panel-hover)' : 'var(--panel-2)'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={ctrlRow}>
        <button style={btnStyle(paused)} onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
        <button style={btnStyle()} onClick={clearPlot}>
          🗑 清空
        </button>
        <button style={btnStyle()} onClick={runExplain} disabled={explainBusy}>
          {explainBusy ? '🤖 解读中…' : '🤖 AI 解读日志'}
        </button>
        <label style={{ fontSize: 12, color: theme === 'dark' ? 'var(--text-dim)' : 'var(--border-strong)', marginLeft: 6 }}>
          <input
            type="checkbox"
            checked={autoScale}
            onChange={(e) => setAutoScale(e.target.checked)}
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          自动缩放
        </label>
        {!autoScale && (
          <span style={{ fontSize: 12, color: theme === 'dark' ? 'var(--text-dim)' : 'var(--border-strong)' }}>
            <input
              type="number"
              value={manualMin}
              onChange={(e) => setManualMin(Number(e.target.value))}
              style={{ width: 56, marginLeft: 6 }}
            />
            ~
            <input
              type="number"
              value={manualMax}
              onChange={(e) => setManualMax(Number(e.target.value))}
              style={{ width: 56, marginLeft: 2 }}
            />
          </span>
        )}
        <span style={{ fontSize: 11, color: theme === 'dark' ? 'var(--text-muted)' : 'var(--text-muted)', marginLeft: 'auto' }}>
          {stats.ch} 通道 · {stats.points} 点/通道
        </span>
      </div>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
      {explainErr && (
        <div style={expStyle(theme)}>
          <div style={{ color: 'var(--danger)' }}>解读失败：{explainErr}</div>
        </div>
      )}
      {explainOut && (
        <div style={expStyle(theme)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <strong style={{ fontSize: 12 }}>AI 解读</strong>
            <span style={{ fontSize: 11, color: theme === 'dark' ? 'var(--text-muted)' : 'var(--text-dim)' }}>
              通道：{explainOut.channel} · 规则命中 {explainOut.findings.length} 条
            </span>
            <button
              style={{ marginLeft: 'auto', ...btnStyle(false) }}
              onClick={() => {
                // 命中证据也一并展示，便于人工复核（不让 AI 结论变成黑箱）
                void navigator.clipboard?.writeText(
                  [explainOut.text, '', '【规则命中证据】', ...explainOut.findings.map((f) => `- [${f.kind}] 第${f.line}行 ${f.text}`)].join('\n')
                )
              }}
            >
              复制
            </button>
          </div>
          {(explainOut.findings.length > 0 || explainOut.text) && (
            <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{explainOut.text}</div>
          )}
          {explainOut.findings.length > 0 && (
            <div style={{ marginTop: 6, maxHeight: 96, overflow: 'auto', fontSize: 11, color: theme === 'dark' ? 'var(--text-dim)' : 'var(--text-dim)' }}>
              {explainOut.findings.map((f, i) => (
                <div key={i}>
                  <span style={{ fontFamily: 'var(--mono)' }}>[{f.kind}]</span> 第 {f.line} 行：{f.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function expStyle(theme: 'light' | 'dark'): React.CSSProperties {
  return {
    borderTop: `1px solid ${theme === 'dark' ? 'var(--border-strong)' : 'var(--border)'}`,
    padding: 8,
    background: theme === 'dark' ? 'var(--terminal-bg)' : 'var(--panel)',
    maxHeight: 240,
    overflow: 'auto'
  }
}

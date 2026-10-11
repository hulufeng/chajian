import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstrumentData, InstrumentStatus, LogicAnalyzerConfig, ScopeConfig } from '../../../preload'

// 逻辑分析仪通道 → GPIO 固定映射（固件侧一致）
const LA_GPIO = [4, 5, 6, 7, 15, 16, 17, 18]
// 示波器通道：ADC1_CH0..9 → GPIO1..GPIO10
const SCOPE_GPIO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const BAUD_OPTIONS = [921600, 2000000, 3000000]
const LA_RATES = [1000000, 2000000, 5000000, 10000000, 20000000]
const SCOPE_RATES = [100000, 200000, 500000, 1000000]
const SCOPE_NSAMP_OPTS = [1000, 2000, 4000, 8000]

type Mode = 'la' | 'scope' | 'power'

export default function InstrumentsPanel({ theme }: { theme?: string }): React.JSX.Element {
  const [ports, setPorts] = useState<string[]>([])
  const [port, setPort] = useState('')
  const [baud, setBaud] = useState(2000000)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<InstrumentStatus>({})
  const [logs, setLogs] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('la')

  // 逻辑分析仪配置
  const [laMask, setLaMask] = useState(0x0f)
  const [laRate, setLaRate] = useState(2000000)
  const [laPre, setLaPre] = useState(100)
  const [laPost, setLaPost] = useState(1000)
  const [laTrig, setLaTrig] = useState(-1)
  const [laEdge, setLaEdge] = useState<0 | 1>(1)

  // 示波器配置
  const [scopeCh, setScopeCh] = useState(5) // ADC1_CH5 = GPIO6
  const [scopeRate, setScopeRate] = useState(500000)
  const [scopeNsamp, setScopeNsamp] = useState(2000)

  const [frame, setFrame] = useState<InstrumentData | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const dark = theme === 'dark'
  const pushLog = useCallback((l: string) => {
    setLogs((prev) => {
      const n = [...prev, l]
      return n.length > 400 ? n.slice(-400) : n
    })
  }, [])

  useEffect(() => {
    void window.api.instruments.listPorts().then((ps) => {
      const paths = ps.map((p) => p.path)
      setPorts(paths)
      if (!port && paths.length) setPort(paths[0])
    })
    const offData = window.api.instruments.onData((d) => setFrame(d))
    const offLog = window.api.instruments.onLog((l) => pushLog(l))
    const offStatus = window.api.instruments.onStatus((s) => {
      setStatus(s)
      if (s.connected === true) setConnected(true)
      if (s.connected === false) setConnected(false)
      if (s.idn) pushLog(`设备：${s.idn}`)
    })
    return () => {
      offData()
      offLog()
      offStatus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onConnect = useCallback(async () => {
    if (!port) return
    pushLog(`连接 ${port} @ ${baud} …`)
    const r = await window.api.instruments.connect({ port, baud })
    if (!r.ok) pushLog('连接失败：' + (r.error || ''))
  }, [port, baud, pushLog])

  const onDisconnect = useCallback(async () => {
    const r = await window.api.instruments.disconnect()
    if (!r.ok) pushLog('断开失败：' + (r.error || ''))
    setConnected(false)
  }, [pushLog])

  const onArmLA = useCallback(() => {
    const cfg: LogicAnalyzerConfig = {
      channelMask: laMask, sampleRate: laRate, preSamples: laPre, postSamples: laPost, trigChannel: laTrig, trigEdge: laEdge
    }
    pushLog(`逻辑分析仪采集 ch=0x${laMask.toString(16)} rate=${laRate} pre=${laPre} post=${laPost} trig=${laTrig} edge=${laEdge}`)
    void window.api.instruments.armLogicAnalyzer(cfg)
  }, [laMask, laRate, laPre, laPost, laTrig, laEdge, pushLog])

  const onArmScope = useCallback(() => {
    const cfg: ScopeConfig = { channel: scopeCh, sampleRate: scopeRate, sampleCount: scopeNsamp }
    pushLog(`示波器采集 GPIO${SCOPE_GPIO[scopeCh] ?? scopeCh} rate=${scopeRate} nsamp=${scopeNsamp}`)
    void window.api.instruments.armScope(cfg)
  }, [scopeCh, scopeRate, scopeNsamp, pushLog])

  const onReadPower = useCallback(() => {
    pushLog('读取功率 …')
    void window.api.instruments.readPower()
  }, [pushLog])

  const toggleLaCh = (i: number) => setLaMask((m) => (m ^ (1 << i)))

  // ── 画布绘制 ──
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const w = cv.clientWidth || 600
    const h = cv.clientHeight || 240
    cv.width = w
    cv.height = h
    const bg = dark ? '#0d1117' : '#ffffff'
    const fg = dark ? '#c9d1d9' : '#24292f'
    const grid = dark ? '#21262d' : '#ececec'
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    if (!frame || frame.kind === 'power') {
      ctx.fillStyle = fg
      ctx.font = '13px ui-monospace, monospace'
      ctx.fillText(frame ? '' : '未采集到数据 —— 先连接 ESP32-S3 仪器固件，再点击「采集」', 14, 28)
      if (frame && frame.kind === 'power') {
        ctx.fillText('功率读数见下方数值面板', 14, 28)
      }
      return
    }

    ctx.strokeStyle = grid
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    }

    if (frame.kind === 'la') drawLA(ctx, frame, w, h, dark)
    else drawScope(ctx, frame, w, h, dark)
  }, [frame, mode, dark])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: dark ? '#c9d1d9' : '#24292f', fontSize: 13 }}>
      {/* 连接栏 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: `1px solid ${dark ? '#21262d' : '#e5e5e5'}` }}>
        <select value={port} onChange={(e) => setPort(e.target.value)} style={sel(dark)}>
          {ports.length === 0 && <option value="">（无串口）</option>}
          {ports.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} style={sel(dark)}>
          {BAUD_OPTIONS.map((b) => <option key={b} value={b}>{b} baud</option>)}
        </select>
        {!connected
          ? <button style={btn(dark)} onClick={onConnect}>连接</button>
          : <button style={btn(dark)} onClick={onDisconnect}>断开</button>}
        <span style={{ opacity: 0.8 }}>
          {connected ? `● 已连接${status.idn ? ' · ' + status.idn : ''}` : '○ 未连接'}
        </span>
        {!status.power?.supported && <span style={{ opacity: 0.55, fontSize: 12 }}>（功率计需外接 INA219）</span>}
      </div>

      {/* 模式切换 */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 10px' }}>
        {(['la', 'scope', 'power'] as Mode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            style={{ ...btn(dark), background: mode === m ? (dark ? '#1f6feb' : '#0969da') : (dark ? '#21262d' : '#f0f0f0'),
              color: mode === m ? '#fff' : (dark ? '#c9d1d9' : '#24292f') }}>
            {m === 'la' ? '逻辑分析仪' : m === 'scope' ? '示波器' : '功率计'}
          </button>
        ))}
      </div>

      {/* 配置区 */}
      <div style={{ padding: '4px 10px 8px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {mode === 'la' && (
          <>
            <span>通道：</span>
            {LA_GPIO.map((g, i) => (
              <label key={i} style={{ display: 'inline-flex', gap: 3, alignItems: 'center', opacity: laMask & (1 << i) ? 1 : 0.5 }}>
                <input type="checkbox" checked={!!(laMask & (1 << i))} onChange={() => toggleLaCh(i)} />
                CH{i}(GPIO{g})
              </label>
            ))}
            <span>采样率：</span>
            <select value={laRate} onChange={(e) => setLaRate(Number(e.target.value))} style={sel(dark)}>
              {LA_RATES.map((r) => <option key={r} value={r}>{r / 1e6} MHz</option>)}
            </select>
            <span>预采样：</span>
            <input type="number" value={laPre} onChange={(e) => setLaPre(Number(e.target.value))} style={{ ...sel(dark), width: 70 }} />
            <span>后采样：</span>
            <input type="number" value={laPost} onChange={(e) => setLaPost(Number(e.target.value))} style={{ ...sel(dark), width: 80 }} />
            <span>触发：</span>
            <select value={laTrig} onChange={(e) => setLaTrig(Number(e.target.value))} style={sel(dark)}>
              <option value={-1}>无</option>
              {LA_GPIO.map((g, i) => (laMask & (1 << i)) ? <option key={i} value={i}>CH{i}</option> : null)}
            </select>
            <select value={laEdge} onChange={(e) => setLaEdge(Number(e.target.value) as 0 | 1)} style={sel(dark)}>
              <option value={1}>上升沿</option>
              <option value={0}>下降沿</option>
            </select>
            <button style={btn(dark)} onClick={onArmLA}>采集</button>
          </>
        )}
        {mode === 'scope' && (
          <>
            <span>通道：</span>
            <select value={scopeCh} onChange={(e) => setScopeCh(Number(e.target.value))} style={sel(dark)}>
              {SCOPE_GPIO.map((g, i) => <option key={i} value={i}>ADC1_CH{i}(GPIO{g})</option>)}
            </select>
            <span>采样率：</span>
            <select value={scopeRate} onChange={(e) => setScopeRate(Number(e.target.value))} style={sel(dark)}>
              {SCOPE_RATES.map((r) => <option key={r} value={r}>{r / 1000} kHz</option>)}
            </select>
            <span>点数：</span>
            <select value={scopeNsamp} onChange={(e) => setScopeNsamp(Number(e.target.value))} style={sel(dark)}>
              {SCOPE_NSAMP_OPTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button style={btn(dark)} onClick={onArmScope}>采集</button>
          </>
        )}
        {mode === 'power' && (
          <>
            <button style={btn(dark)} onClick={onReadPower}>读取一次</button>
            <span style={{ opacity: 0.7 }}>INA219 接 I2C（SDA=GPIO12，SCL=GPIO13，0x40）；未接则显示「未检测到」</span>
          </>
        )}
      </div>

      {/* 画布 / 功率读数 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        {frame && frame.kind === 'power' && (
          <div style={{ position: 'absolute', top: 8, left: 12, right: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {!frame.present && <div style={{ gridColumn: '1 / -1', color: '#f85149' }}>未检测到功率计（INA219）。请检查 I2C 接线与地址。</div>}
            <Metric label="总线电压" value={frame.busV.toFixed(3)} unit="V" />
            <Metric label="分流电压" value={frame.shuntV.toFixed(4)} unit="V" />
            <Metric label="电流" value={frame.currentA.toFixed(4)} unit="A" />
            <Metric label="功率" value={frame.powerW.toFixed(4)} unit="W" />
          </div>
        )}
      </div>

      {/* 日志 */}
      <div style={{ height: 96, overflowY: 'auto', borderTop: `1px solid ${dark ? '#21262d' : '#e5e5e5'}`, padding: '4px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', opacity: 0.9 }}>
        {logs.length === 0 ? '（仪器日志）' : logs.join('\n')}
      </div>
    </div>
  )
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }): React.JSX.Element {
  return (
    <div style={{ background: 'rgba(127,127,127,0.12)', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value} <span style={{ fontSize: 13, opacity: 0.7 }}>{unit}</span></div>
    </div>
  )
}

function sel(dark: boolean): React.CSSProperties {
  return {
    background: dark ? '#0d1117' : '#fff', color: dark ? '#c9d1d9' : '#24292f',
    border: `1px solid ${dark ? '#30363b' : '#d0d7de'}`, borderRadius: 6, padding: '3px 6px'
  }
}
function btn(dark: boolean): React.CSSProperties {
  return {
    background: dark ? '#21262d' : '#f0f0f0', color: dark ? '#c9d1d9' : '#24292f',
    border: `1px solid ${dark ? '#30363b' : '#d0d7de'}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer'
  }
}

function drawLA(ctx: CanvasRenderingContext2D, f: Extract<InstrumentData, { kind: 'la' }>, w: number, h: number, dark: boolean): void {
  const chans: number[] = []
  for (let i = 0; i < 8; i++) if (f.channelMask & (1 << i)) chans.push(i)
  if (chans.length === 0) {
    ctx.fillStyle = dark ? '#c9d1d9' : '#24292f'
    ctx.fillText('未选择通道', 14, 28)
    return
  }
  const n = f.sampleCount
  const padL = 130
  const rowH = h / chans.length
  const xOf = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL))
  chans.forEach((ch, idx) => {
    const yBase = rowH * idx + rowH * 0.5
    const hi = Math.max(6, rowH * 0.32)
    ctx.fillStyle = dark ? '#8b949e' : '#57606a'
    ctx.font = '12px ui-monospace, monospace'
    ctx.fillText(`CH${ch} GPIO${LA_GPIO[ch]}`, 6, rowH * idx + 16)
    ctx.strokeStyle = dark ? '#30363b' : '#ddd'
    ctx.beginPath(); ctx.moveTo(padL, yBase); ctx.lineTo(w, yBase); ctx.stroke()
    ctx.strokeStyle = '#2f81f7'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const v = ((f.samples[i] ?? 0) >> ch) & 1
      const y = v ? yBase - hi : yBase + hi
      const x = xOf(i)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.lineWidth = 1
  })
  if (f.triggerIndex < n && f.triggerIndex !== 0xffffffff) {
    const x = xOf(f.triggerIndex)
    ctx.strokeStyle = '#f85149'
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    ctx.fillStyle = '#f85149'
    ctx.fillText('TRIG', x + 4, 14)
  }
  ctx.fillStyle = dark ? '#8b949e' : '#57606a'
  ctx.fillText(`${f.sampleRate / 1e6} MHz · ${n} 点`, padL, h - 6)
}

function drawScope(ctx: CanvasRenderingContext2D, f: Extract<InstrumentData, { kind: 'scope' }>, w: number, h: number, dark: boolean): void {
  const n = f.sampleCount
  const padL = 12
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < n; i++) { const v = f.values[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  if (!isFinite(mn)) { ctx.fillText('无数据', 14, 28); return }
  const range = mx - mn || 1
  const mid = h / 2
  const xOf = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL))
  const yOf = (v: number) => mid - ((v - mn) / range) * (h * 0.42)
  // 零线
  ctx.strokeStyle = dark ? '#30363b' : '#ddd'
  ctx.beginPath(); ctx.moveTo(padL, mid); ctx.lineTo(w, mid); ctx.stroke()
  ctx.strokeStyle = '#3fb950'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = xOf(i), y = yOf(f.values[i])
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.fillStyle = dark ? '#8b949e' : '#57606a'
  ctx.font = '12px ui-monospace, monospace'
  ctx.fillText(`GPIO${SCOPE_GPIO[f.channel] ?? f.channel} · ${f.sampleRate / 1000} kHz · ${n} 点`, padL, 16)
  ctx.fillText(`min ${mn}  max ${mx}  (ADC 12bit, Vref 3.3V → ${(mn * 3.3 / 4095).toFixed(2)}~${(mx * 3.3 / 4095).toFixed(2)}V)`, padL, h - 8)
}

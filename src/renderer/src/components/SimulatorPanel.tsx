import { useState, useRef, useEffect, useCallback } from 'react'
import { VirtualRuntime, transpile, drawText, clearRam } from '../simulator'

interface Props {
  inoCode: string
  lastBuildPath?: string
  lastCompileFqbn?: string
  onClose: () => void
}

interface SimChip {
  id: string
  name: string
  revision: string
  mac: string
}

interface SimDemo {
  id: string
  name: string
  chip: string
  baud: number
  files: Array<{ label: string; path: string; addr: number }>
}

/** 模拟烧录视图：虚拟开发板 + 固件来源（演示/当前代码）+ 烧录进度 + 日志 */
function SimBurnView({ lastBuildPath, lastCompileFqbn }: { lastBuildPath: string; lastCompileFqbn: string }) {
  const [chips, setChips] = useState<SimChip[]>([])
  const [demos, setDemos] = useState<SimDemo[]>([])
  const [chipId, setChipId] = useState('esp32c3')
  const [demoId, setDemoId] = useState('demo-blink')
  const [srcKind, setSrcKind] = useState<'demo' | 'build'>('demo')
  const [buildFiles, setBuildFiles] = useState<Array<{ label: string; path: string; addr: number }> | null>(null)
  const [buildError, setBuildError] = useState('')
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [log, setLog] = useState('')
  const [percent, setPercent] = useState(0)
  const [taskId, setTaskId] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const doneFiles = useRef<Set<number>>(new Set())
  const unsubs = useRef<Array<() => void>>([])

  const cleanupListeners = useCallback(() => {
    unsubs.current.forEach((fn) => fn())
    unsubs.current = []
  }, [])

  useEffect(() => {
    window.api.simBurn.list().then((cs) => {
      setChips(cs)
      if (cs.length > 0) setChipId(cs[0].id)
    })
    window.api.simBurn.demos().then((ds) => {
      setDemos(ds)
      if (ds.length > 0) setDemoId(ds[0].id)
    })
  }, [])

  // 自动匹配虚拟板卡：内置演示按 demo.chip 联动
  useEffect(() => {
    const d = demos.find((x) => x.id === demoId)
    if (srcKind === 'demo' && d && chips.some((c) => c.id === d.chip)) setChipId(d.chip)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoId, demos, srcKind])

  // 自动匹配虚拟板卡：编译目标 esp32c3 / esp32s3 → 对应虚拟板卡
  useEffect(() => {
    if (!lastCompileFqbn || srcKind !== 'build') return
    const m = lastCompileFqbn.match(/esp32:esp32:(esp32\w+)/)
    const target = m ? m[1] : ''
    if (target && chips.some((c) => c.id === target)) setChipId(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCompileFqbn, srcKind, chips])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log])

  const burnRunning = state === 'running'

  const stopBurn = useCallback(() => {
    cleanupListeners()
    if (taskId) {
      window.api.simBurn.kill(taskId)
      setTaskId(null)
    }
    setState('idle')
    setPercent(0)
    doneFiles.current = new Set()
  }, [taskId, cleanupListeners])

  const startBurn = useCallback(async () => {
    stopBurn()
    setLog('')
    setPercent(0)
    doneFiles.current = new Set()

    // 固件来源：内置演示 / 当前编译产物
    let files: Array<{ label: string; path: string; addr: number }> | null = null
    let baud = 921600
    if (srcKind === 'demo') {
      const demo = demos.find((d) => d.id === demoId) ?? demos[0]
      if (!demo) return
      files = demo.files
      baud = demo.baud
    } else {
      if (!lastBuildPath) {
        setBuildError('还没有编译产物：请先在顶部点「编译」（烧录到开发板旁）生成固件，再回来模拟烧录')
        setState('error')
        return
      }
      setBuildError('')
      const res = await window.api.simBurn.collectBuild({ buildPath: lastBuildPath })
      if (!res.ok) {
        setBuildError(res.error || '产物收集失败')
        setState('error')
        return
      }
      files = res.files!
      setBuildFiles(files)
    }
    if (!files || files.length === 0) return
    setState('running')

    const onOut = (d: { id: string; chunk: string }) => {
      if (!d.id.startsWith('simburn-')) return
      setLog((p) => p + d.chunk)
      // 识别每个文件完成（Hash of data verified）
      if (d.chunk.includes('Hash of data verified.')) {
        const n = doneFiles.current.size + 1
        doneFiles.current.add(n)
      }
    }
    const onProg = (d: { id: string; percent: number; message: string }) => {
      if (!d.id.startsWith('simburn-')) return
      setPercent(d.percent)
    }
    const onExit = (d: { id: string; code: number }) => {
      if (!d.id.startsWith('simburn-')) return
      cleanupListeners()
      setTaskId(null)
      setPercent(d.code === 0 ? 100 : percent)
      setState(d.code === 0 ? 'done' : 'error')
    }

    unsubs.current.push(window.api.onTaskOutput(onOut as any))
    unsubs.current.push(window.api.onTaskExit(onExit as any))
    unsubs.current.push(window.api.onTaskProgress(onProg as any))
    const { id } = await window.api.simBurn.start({
      chipId,
      files,
      baud,
    })
    setTaskId(id)
  }, [chipId, demoId, demos, srcKind, lastBuildPath, stopBurn, cleanupListeners, percent])

  const demo = demos.find((d) => d.id === demoId) ?? demos[0]
  const chip = chips.find((c) => c.id === chipId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* 虚拟板卡选择 */}
      <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#a6adc8', width: 56 }}>虚拟板卡</span>
          <select
            data-testid="sim-chip"
            value={chipId}
            onChange={(e) => setChipId(e.target.value)}
            disabled={burnRunning}
            style={{
              flex: 1, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a',
              borderRadius: 6, padding: '5px 8px', fontSize: 12,
            }}
          >
            {chips.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#a6adc8', width: 56 }}>固件来源</span>
          <select
            data-testid="sim-src"
            value={srcKind}
            onChange={(e) => setSrcKind(e.target.value as 'demo' | 'build')}
            disabled={burnRunning}
            style={{
              flex: 1, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a',
              borderRadius: 6, padding: '5px 8px', fontSize: 12,
            }}
          >
            <option value="demo">内置演示固件</option>
            <option value="build">当前代码（编译产物）</option>
          </select>
        </div>
        {srcKind === 'demo' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#a6adc8', width: 56 }}>演示固件</span>
            <select
              data-testid="sim-demo"
              value={demoId}
              onChange={(e) => setDemoId(e.target.value)}
              disabled={burnRunning}
              style={{
                flex: 1, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a',
                borderRadius: 6, padding: '5px 8px', fontSize: 12,
              }}
            >
              {demos.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
        )}
        {srcKind === 'build' && (
          <div style={{ fontSize: 10, color: lastBuildPath ? '#a6e3a1' : '#f9e2af', lineHeight: 1.4 }}>
            {lastBuildPath
              ? `✓ 已就绪：${lastBuildPath.split(/[\\/]/).pop()}`
              : '⚠ 尚未编译：先点顶部「编译」生成固件，再回来模拟烧录'}
          </div>
        )}
        {buildError && (
          <div style={{ fontSize: 10, color: '#f38ba8', lineHeight: 1.4 }}>{buildError}</div>
        )}
        {chip && (
          <div style={{ fontSize: 10, color: '#585b70' }}>
            {chip.name} {chip.revision} · MAC {chip.mac}
          </div>
        )}
      </div>

      {/* 烧录控制 */}
      <div style={{ padding: '6px 14px 10px', display: 'flex', gap: 8 }}>
        <button
          onClick={() => (burnRunning ? stopBurn() : startBurn())}
          style={{
            flex: 1, padding: '8px', borderRadius: 6, border: 'none',
            background: burnRunning ? '#f38ba8' : '#a6e3a1',
            color: '#1e1e2e', fontWeight: 700, cursor: 'pointer',
          }}
        >
          {burnRunning ? '■ 停止烧录' : state === 'done' ? '✅ 烧录成功 · 再烧一次' : state === 'error' ? '⚠ 重试烧录' : '▶ 模拟烧录'}
        </button>
      </div>

      {/* 分区进度 */}
      {(srcKind === 'demo' ? demo : (buildFiles ?? demo)) && (
        <div style={{ padding: '0 14px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 10, color: '#a6adc8', marginBottom: 2 }}>
            烧录进度 {Math.round(percent)}%
          </div>
          <div style={{ height: 8, background: '#313244', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%', width: `${percent}%`, borderRadius: 4,
                background: 'linear-gradient(90deg,#89b4fa,#a6e3a1)',
                transition: 'width 0.2s',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
            {(srcKind === 'build' && buildFiles ? buildFiles : (demo?.files ?? [])).map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                <span style={{ color: doneFiles.current.has(i + 1) ? '#a6e3a1' : '#585b70', width: 14 }}>
                  {doneFiles.current.has(i + 1) ? '✓' : '•'}
                </span>
                <span style={{ color: '#cdd6f4', flex: 1, fontFamily: 'Consolas, monospace' }}>{f.label}</span>
                <span style={{ color: '#89b4fa', fontFamily: 'Consolas, monospace' }}>
                  0x{f.addr.toString(16).padStart(4, '0')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 烧录日志 */}
      <div style={{ flex: 1, minHeight: 0, padding: '4px 14px 10px' }}>
        <div style={{
          height: '100%', background: '#0f0f17', border: '1px solid #313244', borderRadius: 6,
          padding: '8px 10px', overflow: 'auto',
          fontFamily: 'Consolas, monospace', fontSize: 10.5, lineHeight: 1.55,
          color: '#a6e3a1', whiteSpace: 'pre-wrap',
        }}>
          {log || <span style={{ color: '#585b70' }}>点 ▶ 模拟烧录，在软件内走完整烧录链路（连接 → 识别 → stub → 烧写 → 校验 → 复位）…</span>}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  )
}

export default function SimulatorPanel({ inoCode, lastBuildPath = '', lastCompileFqbn = '', onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'sim' | 'burn'>('sim')
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle')
  const [serialOut, setSerialOut] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [led2, setLed2] = useState(false)
  const [led8, setLed8] = useState(false)
  const [pwm2, setPwm2] = useState(0)
  const [potMv, setPotMv] = useState(1650)
  const [adcMv, setAdcMv] = useState<number[]>([1650, 820, 2470, 0])
  const [shtTemp, setShtTemp] = useState(25.5)
  const [shtHumi, setShtHumi] = useState(60)
  const [oledRam, setOledRam] = useState<Uint8Array>(new Uint8Array(1024))
  const [oledText, setOledText] = useState('')

  const runtimeRef = useRef<VirtualRuntime | null>(null)
  const oledCanvasRef = useRef<HTMLCanvasElement>(null)
  const serialEndRef = useRef<HTMLDivElement>(null)
  const scopeCanvasRef = useRef<HTMLCanvasElement>(null)
  const waveRef = useRef<{ g2: number[]; g8: number[]; adc: number[] }>({ g2: [], g8: [], adc: [] })

  // 渲染 OLED
  useEffect(() => {
    const canvas = oledCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000022'
    ctx.fillRect(0, 0, 128, 64)
    ctx.fillStyle = '#7fdbff'
    for (let p = 0; p < 8; p++) {
      for (let c = 0; c < 128; c++) {
        const b = oledRam[p * 128 + c]
        for (let bit = 0; bit < 8; bit++) {
          if (b & (1 << bit)) ctx.fillRect(c, p * 8 + bit, 1, 1)
        }
      }
    }
  }, [oledRam])

  useEffect(() => {
    serialEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [serialOut])

  const stop = useCallback(() => {
    runtimeRef.current?.stop()
    runtimeRef.current = null
    setState('idle')
    setLed2(false); setLed8(false); setPwm2(0)
  }, [])

  const start = useCallback(async () => {
    stop()
    setSerialOut('')
    setError('')
    setWarnings([])

    try {
      const { setup, loop, warnings, needsFlash } = transpile(inoCode)
      setWarnings(warnings)
      if (needsFlash) {
        setError('此代码需要真实硬件（WiFi/蓝牙等），请使用烧录功能')
        setState('error')
        return
      }

      const rt = new VirtualRuntime({
        onPinChange: (pin, val) => {
          if (pin === 2) setLed2(val === 1)
          if (pin === 8) setLed8(val === 1)
        },
        onPwmChange: (pin, duty) => {
          if (pin === 2) setPwm2(duty)
        },
        onSerialData: (data) => setSerialOut((p) => p + data),
        onOledRam: (ram) => setOledRam(new Uint8Array(ram)),
      })

      rt.adc.setMillivolts(0, potMv)
      adcMv.forEach((mv, i) => rt.adc.setMillivolts(i + 1, mv))
      rt.wire.setEnvironment(shtTemp, shtHumi)
      rt.env.setEnvironment(shtTemp, shtHumi)
      runtimeRef.current = rt
      setState('running')

      // 运行 setup，然后循环 loop
      ;(async () => {
        try {
          await rt.run(setup, loop)
        } catch (e: any) {
          setError('运行错误: ' + (e?.message || e))
          setState('error')
        }
      })()
    } catch (e: any) {
      setError('转译错误: ' + (e?.message || e))
      setState('error')
    }
  }, [inoCode, potMv, shtTemp, shtHumi, stop])

  useEffect(() => {
    if (runtimeRef.current) runtimeRef.current.adc.setMillivolts(0, potMv)
  }, [potMv])
  useEffect(() => {
    if (!runtimeRef.current) return
    adcMv.forEach((mv, i) => runtimeRef.current!.adc.setMillivolts(i + 1, mv))
  }, [adcMv])
  useEffect(() => {
    if (runtimeRef.current) {
      runtimeRef.current.wire.setEnvironment(shtTemp, shtHumi)
      runtimeRef.current.env.setEnvironment(shtTemp, shtHumi)
    }
  }, [shtTemp, shtHumi])

  // 示波器：模拟运行期间每 60ms 采样 GPIO2 / GPIO8 / ADC0 并绘制
  useEffect(() => {
    if (state !== 'running') return
    const rt = runtimeRef.current
    if (!rt) return
    const canvas = scopeCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const MAX = 260
    const draw = () => {
      const w = canvas.width, h = canvas.height
      ctx.fillStyle = '#0b0f1a'
      ctx.fillRect(0, 0, w, h)
      // 网格
      ctx.strokeStyle = '#1a2135'
      ctx.lineWidth = 1
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke()
      }
      for (let i = 0; i <= 6; i++) {
        ctx.beginPath(); ctx.moveTo((w / 6) * i, 0); ctx.lineTo((w / 6) * i, h); ctx.stroke()
      }
      const drawLine = (data: number[], color: string, label: string, labelY: number) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 1.6
        ctx.beginPath()
        for (let i = 0; i < data.length; i++) {
          const x = w - (data.length - 1 - i) * (w / MAX)
          const y = h - (data[i] / 100) * h
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.fillStyle = color
        ctx.font = '9px Consolas'
        ctx.fillText(label, 4, labelY)
      }
      drawLine(waveRef.current.g2, '#f38ba8', 'GPIO2', 10)
      drawLine(waveRef.current.g8, '#89b4fa', 'GPIO8', 20)
      drawLine(waveRef.current.adc, '#a6e3a1', 'ADC0', 30)
    }
    const tick = () => {
      const w = waveRef.current
      w.g2.push(rt.gpio.digitalRead(2) * 100)
      w.g8.push(rt.gpio.digitalRead(8) * 100)
      w.adc.push((rt.adc.readVoltage(0) / 3.3) * 100)
      if (w.g2.length > MAX) w.g2.shift()
      if (w.g8.length > MAX) w.g8.shift()
      if (w.adc.length > MAX) w.adc.shift()
      draw()
    }
    tick()
    const iv = setInterval(tick, 60)
    return () => clearInterval(iv)
  }, [state])

  return (
    <div style={{
      width: 380, flexShrink: 0,
      background: '#1e1e2e', borderLeft: '1px solid #333',
      display: 'flex', flexDirection: 'column',
      boxShadow: '-4px 0 20px rgba(0,0,0,0.2)',
    }}>
      <div style={{
        padding: '10px 14px', background: '#181825', borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 600, color: '#cdd6f4', fontSize: 13 }}>
            🔬 ESP32 辅助
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#11111b', borderRadius: 6, padding: 2 }}>
            <button
              onClick={() => setActiveTab('sim')}
              style={{
                border: 'none', background: activeTab === 'sim' ? '#313244' : 'transparent',
                color: activeTab === 'sim' ? '#cdd6f4' : '#6c7086',
                fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              }}
            >
              仿真
            </button>
            <button
              onClick={() => setActiveTab('burn')}
              style={{
                border: 'none', background: activeTab === 'burn' ? '#313244' : 'transparent',
                color: activeTab === 'burn' ? '#cdd6f4' : '#6c7086',
                fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              }}
            >
              烧录
            </button>
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a6adc8', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      {activeTab === 'burn' ? (
        <SimBurnView lastBuildPath={lastBuildPath} lastCompileFqbn={lastCompileFqbn} />
      ) : (<>
      <div style={{ padding: '8px 14px', display: 'flex', gap: 8 }}>
        <button
          onClick={() => (state === 'running' ? stop() : start())}
          style={{
            flex: 1, padding: '8px', borderRadius: 6, border: 'none',
            background: state === 'running' ? '#f38ba8' : '#a6e3a1',
            color: '#1e1e2e', fontWeight: 700, cursor: 'pointer',
          }}>
          {state === 'running' ? '■ 停止' : '▶ 模拟运行当前代码'}
        </button>
      </div>

      {warnings.length > 0 && (
        <div style={{ padding: '0 14px' }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 10, color: '#f9e2af', padding: '2px 0' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 12, background: '#11111b' }}>
        <div style={{ background: '#e8e6e3', borderRadius: 4, padding: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
          <div style={{
            background: '#1a4b8c', borderRadius: 4, padding: '10px 8px',
            marginBottom: 10, border: '2px solid #0d2d5c', position: 'relative',
          }}>
            <div style={{
              position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
              width: 70, height: 36, background: 'linear-gradient(145deg,#888,#555)',
              borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#ddd', fontSize: 7, fontWeight: 700,
            }}>ESP32</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#aaccff' }}>
              <span>ESP32-C3</span>
              <span>GPIO8 ● {led8 ? 'ON' : 'OFF'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 22, height: 30, margin: '0 auto', borderRadius: 3,
                background: led2 ? `rgba(231,76,60,${0.3 + pwm2/255*0.7})` : '#552222',
                boxShadow: led2 && pwm2 > 10 ? `0 0 ${pwm2/4}px #e74c3c` : 'none',
              }} />
              <div style={{ fontSize: 8, color: '#555', marginTop: 2 }}>GPIO2</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 22, height: 30, margin: '0 auto', borderRadius: 3,
                background: led8 ? '#3498db' : '#1a3a5c',
                boxShadow: led8 ? '0 0 12px #3498db' : 'none',
              }} />
              <div style={{ fontSize: 8, color: '#555', marginTop: 2 }}>GPIO8</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <button
                onMouseDown={() => runtimeRef.current?.gpio.setExternal(0, 0)}
                onMouseUp={() => runtimeRef.current?.gpio.setExternal(0, 1)}
                style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'radial-gradient(circle at 35% 35%, #e74c3c, #922b21)',
                  border: '2px solid #666', cursor: 'pointer',
                }}
              />
              <div style={{ fontSize: 8, color: '#555', marginTop: 2 }}>GPIO0</div>
            </div>
          </div>

          <div style={{ background: '#2d5a27', padding: 8, marginTop: 10, borderRadius: 4 }}>
            <canvas ref={oledCanvasRef} width={128} height={64}
              style={{ width: '100%', display: 'block', imageRendering: 'pixelated' }} />
            <div style={{ display: 'flex', justifyContent: 'space-around', fontSize: 7, color: '#aaffaa' }}>
              <span>GND</span><span>VCC</span><span>SDA(21)</span><span>SCL(22)</span>
            </div>
            {/* OLED 文本演示（教学：display.print → 屏幕文字） */}
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              <input
                value={oledText}
                onChange={(e) => setOledText(e.target.value)}
                placeholder="OLED 文本（display.print）"
                style={{
                  flex: 1, background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 4,
                  color: '#cdd6f4', fontSize: 10, padding: '4px 6px', outline: 'none',
                }}
              />
              <button
                onClick={() => runtimeRef.current?.wire.printToOled(oledText || 'HELLO')}
                style={{ background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}
              >显示</button>
              <button
                onClick={() => runtimeRef.current?.wire.oledClear()}
                style={{ background: '#313244', color: '#cdd6f4', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}
              >清屏</button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ background: '#313244', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: '#a6adc8', marginBottom: 4 }}>
              🎛️ GPIO0 电位器 — {(potMv/1000).toFixed(2)}V
            </div>
            <input type="range" min={0} max={3300} value={potMv}
              onChange={(e) => setPotMv(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
          {/* ADC1 多通道（GPIO1-4） */}
          <div style={{ background: '#313244', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: '#a6adc8', marginBottom: 4 }}>
              📡 ADC1 多通道（GPIO1-4，analogRead）
            </div>
            {adcMv.map((mv, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: '#f9e2af', width: 56 }}>GPIO{i + 1}</span>
                <input type="range" min={0} max={3300} value={mv}
                  onChange={(e) => setAdcMv((p) => p.map((v, j) => (j === i ? Number(e.target.value) : v)))}
                  style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#89b4fa', width: 45 }}>{(mv / 1000).toFixed(2)}V</span>
              </div>
            ))}
          </div>
          <div style={{ background: '#313244', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: '#a6adc8', marginBottom: 4 }}>
              🌡️ 环境（SHT30 · DHT22 共享）— dht.readTemperature()/readHumidity()
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: '#f9e2af', width: 30 }}>温度</span>
              <input type="range" min={-10} max={50} step={0.5} value={shtTemp}
                onChange={(e) => setShtTemp(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#f9e2af', width: 45 }}>{shtTemp.toFixed(1)}°C</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#89b4fa', width: 30 }}>湿度</span>
              <input type="range" min={0} max={100} value={shtHumi}
                onChange={(e) => setShtHumi(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#89b4fa', width: 45 }}>{shtHumi.toFixed(0)}%</span>
            </div>
          </div>
          {/* 示波器：GPIO2 / GPIO8 / ADC0 三通道滚动波形 */}
          <div style={{ background: '#313244', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: '#a6adc8', marginBottom: 4 }}>
              📈 示波器 — GPIO2 / GPIO8 / ADC0
            </div>
            <canvas ref={scopeCanvasRef} width={336} height={96}
              style={{ width: '100%', height: 96, display: 'block', borderRadius: 4, background: '#0b0f1a' }} />
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 8, padding: 8, background: '#302028', border: '1px solid #f38ba8', borderRadius: 6, color: '#f38ba8', fontSize: 11 }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ height: 120, borderTop: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '4px 14px', fontSize: 11, color: '#a6adc8', background: '#181825', borderBottom: '1px solid #333' }}>
          串口监视器 115200
        </div>
        <div style={{
          flex: 1, padding: '6px 14px', overflow: 'auto',
          fontFamily: 'Consolas, monospace', fontSize: 11, color: '#a6e3a1',
          whiteSpace: 'pre-wrap', background: '#11111b',
        }}>
          {serialOut || <span style={{ color: '#585b70' }}>点 ▶ 模拟运行当前编辑器中的代码...</span>}
          <div ref={serialEndRef} />
        </div>
      </div>
      </>)}
    </div>
  )
}

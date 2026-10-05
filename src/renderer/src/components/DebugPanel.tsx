import { useCallback, useEffect, useState } from 'react'
import type { DebugChip, DebugState, MemoryReadResult, RegisterValue, ThreadInfo } from '../../../preload'

interface Props {
  /** 当前板卡 FQBN（用于推断调试芯片，如 esp32:esp32:esp32s3 → esp32s3） */
  fqbn?: string
  onClose: () => void
}

/** 把字节数组按 16B 一行拼成 hex + ascii 两栏 */
function formatHex(bytes: number[]): string {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16)
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    // eslint-disable-next-line no-control-regex
    const ascii = chunk.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
    rows.push(`${hex.padEnd(47)}  ${ascii}`)
  }
  return rows.join('\n')
}

export default function DebugPanel({ fqbn, onClose }: Props): React.JSX.Element {
  const [info, setInfo] = useState<{ installed: boolean; path: string; scripts: string; chips: DebugChip[] } | null>(null)
  const [ installing, setInstalling ] = useState(false)
  const [ installErr, setInstallErr ] = useState('')
  const [ state, setState ] = useState<DebugState | null>(null)
  const [ chip, setChip ] = useState('esp32s3')
  const [ busy, setBusy ] = useState(false)
  const [ err, setErr ] = useState('')
  const [ regs, setRegs ] = useState<RegisterValue[]>([])
  const [ threads, setThreads ] = useState<ThreadInfo[]>([])
  const [ memAddr, setMemAddr ] = useState('0x60004000')
  const [ memCount, setMemCount ] = useState(64)
  const [ mem, setMem ] = useState<MemoryReadResult | null>(null)
  const [ bpAddr, setBpAddr ] = useState('')
  const [bps, setBps] = useState<string[]>([])
  const [ execCmd, setExecCmd] = useState('')
  const [ execOut, setExecOut] = useState('')

  const loadInfo = useCallback((): void => {
    window.api.debug.info().then(setInfo).catch((e: Error) => setInstallErr(e.message))
  }, [])

  useEffect(() => {
    loadInfo()
    // 烧录等外部动作会停掉会话 → 面板自动回落
    const off = window.api.debug.onStopped(setState)
    return () => off()
  }, [loadInfo])

  /** 用当前板卡 FQBN 推断默认芯片（只做一次） */
  useEffect(() => {
    if (!fqbn || !info || info.chips.length === 0) return
    const seg = fqbn.split(':').pop() || ''
    const hit = info.chips.find((c) => seg.toLowerCase().startsWith(c.chip))
    if (hit) setChip(hit.chip)
  }, [fqbn, info])

  const refresh = useCallback((): void => {
    window.api.debug.state().then(setState).catch(() => undefined)
  }, [])

  const connect = async (): Promise<void> => {
    setBusy(true); setErr('')
    try {
      const s = await window.api.debug.start({ chip })
      setState(s)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      const s = await window.api.debug.stop()
      setState(s)
      setRegs([]); setThreads([]); setMem(null); setBps([]); setExecOut('')
    } catch (e) { setErr((e as Error).message) }
  }

  const readRegs = async (): Promise<void> => {
    try { setRegs(await window.api.debug.registers()) } catch (e) { setErr((e as Error).message) }
  }

  const readMem = async (): Promise<void> => {
    try { setMem(await window.api.debug.memory({ addr: memAddr, count: memCount })) }
    catch (e) { setErr((e as Error).message) }
  }

  const readThreads = async (): Promise<void> => {
    try {
      const r = await window.api.debug.threads()
      setThreads(r.threads)
    } catch (e) { setErr((e as Error).message) }
  }

  const run = async (fn: () => Promise<string>): Promise<string> => {
    setBusy(true)
    try {
      const out = await fn()
      refresh()
      return out
    } catch (e) {
      setErr((e as Error).message)
      return ''
    } finally { setBusy(false) }
  }

  const install = async (): Promise<void> => {
    setInstalling(true); setInstallErr('')
    const off = window.api.debug.onProgress((p) => { if (p.phase === 'error') setInstallErr(p.message) })
    try {
      const r = await window.api.debug.install()
      if (!r.success) setInstallErr(r.error || '安装失败')
      loadInfo()
    } catch (e) { setInstallErr((e as Error).message) } finally { setInstalling(false); off() }
  }

  const running = state?.status === 'running'
  const disclosed = !info?.installed

  return (
    <div className="debug-panel">
      <div className="debug-head">
        <span className="debug-title">片上调试器</span>
        <span className={`debug-dot ${running ? 'on' : disclosed ? 'off' : 'idle'}`} />
        <span className="debug-meta">
          {state
            ? `${state.chip} · telnet:${state.telnetPort} · ${state.status}${state.target !== 'unknown' ? ` / ${state.target}` : ''}`
            : (info?.installed ? '未连接' : 'openocd 未安装')}
        </span>
        <span className="debug-spacer" />
        {running ? (
          <>
            <button className="btn" disabled={busy} onClick={() => void run(() => window.api.debug.halt())}>⏸ 暂停</button>
            <button className="btn" disabled={busy} onClick={() => void run(() => window.api.debug.resume())}>▶ 运行</button>
            <button className="btn" disabled={busy} onClick={() => void run(() => window.api.debug.step())}>⤼ 单步</button>
            <button className="btn" disabled={busy} onClick={() => void run(() => window.api.debug.reset())}>⟲ 复位</button>
            <button className="btn" disabled={busy} onClick={() => void readRegs()}>寄存器</button>
            <button className="btn" disabled={busy} onClick={() => void readThreads()}>线程</button>
            <button className="btn" disabled={busy} onClick={() => void run(() => window.api.debug.poll())}>轮询</button>
            <button className="btn danger" onClick={() => void disconnect()}>断开</button>
          </>
        ) : (
          <>
            <select className="toolbar-input debug-chip" value={chip} onChange={(e) => setChip(e.target.value)} disabled={busy}>
              {(info?.chips ?? [{ chip: 'esp32s3', cfg: 'board/esp32s3-builtin.cfg' }]).map((c) => (
                <option key={c.chip} value={c.chip}>{c.chip}</option>
              ))}
            </select>
            {disclosed ? (
              <button className="btn accent" disabled={installing} onClick={() => void install()}>
                {installing ? '安装中…' : '安装 openocd-esp32'}
              </button>
            ) : (
              <button className="btn accent" disabled={busy} onClick={() => void connect()}>连接调试器</button>
            )}
          </>
        )}
        <button className="btn icon" onClick={onClose} title="关闭调试面板">✕</button>
      </div>

      {installErr && <div className="debug-err">{installErr}</div>}
      {/* 会话级错误（state.error）与本地 err 只展示一条，避免内容重复 */}
      {(state?.status === 'error' && state.error ? state.error : err) && (
        <div className="debug-err">{state?.status === 'error' && state.error ? state.error : err}</div>
      )}

      {disclosed && !running && (
        <div className="debug-note">
          调试走 openocd 的 telnet（不做 gdb）：寄存器、内存、断点、单步、线程都由 openocd 自己实现。
          板子要插<b>原生 USB 口</b>，且「USB JTAG/serial debug unit」接口已绑 <b>WinUSB</b> 驱动（Zadig 绑）。
        </div>
      )}

      {running && (
        <div className="debug-body">
          <div className="debug-col">
            <div className="debug-block-title">寄存器 <span className="debug-hint">reg</span></div>
            <div className="debug-regs">
              {regs.length === 0 && <div className="debug-empty">点上面「寄存器」读取</div>}
              {regs.map((r) => (
                <div key={r.name} className="debug-reg">
                  <span className="debug-reg-name">{r.name}</span>
                  <span className="debug-reg-val">{r.value}</span>
                </div>
              ))}
            </div>

            <div className="debug-block-title">内存 <span className="debug-hint">mdb</span></div>
            <div className="debug-row">
              <input
                className="toolbar-input"
                value={memAddr}
                onChange={(e) => setMemAddr(e.target.value)}
                placeholder="0x60004000"
                spellCheck={false}
              />
              <input
                className="toolbar-input debug-count"
                type="number" min={1} max={512} value={memCount}
                onChange={(e) => setMemCount(Number(e.target.value) || 64)}
              />
              <button className="btn" disabled={busy} onClick={() => void readMem()}>读取</button>
            </div>
            <pre className="debug-mem">{mem ? formatHex(mem.bytes) : '（未读取）'}</pre>

            <div className="debug-block-title">断点 <span className="debug-hint">rbp</span></div>
            <div className="debug-row">
              <input
                className="toolbar-input"
                value={bpAddr}
                onChange={(e) => setBpAddr(e.target.value)}
                placeholder="0x42000000"
                spellCheck={false}
              />
              <button
                className="btn"
                disabled={busy || !bpAddr}
                onClick={() => void run(async () => {
                  const out = await window.api.debug.setBreakpoint(bpAddr)
                  setBps((p) => (p.includes(bpAddr) ? p : [...p, bpAddr]))
                  return out
                })}
              >添加</button>
              <button
                className="btn"
                disabled={busy || bps.length === 0}
                onClick={() => void run(async () => {
                  const a = bps[bps.length - 1]
                  setBps((p) => p.filter((x) => x !== a))
                  return await window.api.debug.removeBreakpoint(a)
                })}
              >移除</button>
            </div>
            <div className="debug-chips">
              {bps.length === 0 && <span className="debug-hint">暂无断点</span>}
              {bps.map((b) => (<span key={b} className="debug-tag">{b}</span>))}
            </div>
          </div>

          <div className="debug-col">
            <div className="debug-block-title">线程 / 调用栈 <span className="debug-hint">threads</span></div>
            <div className="debug-threads">
              {threads.length === 0 && <div className="debug-empty">点上面「线程」读取</div>}
              {threads.map((t) => (
                <div key={t.id + t.name} className="debug-thread">
                  <span className="debug-thread-id">{t.id}</span>
                  <span className="debug-thread-pc">{t.pc !== undefined ? `0x${t.pc.toString(16)}` : ''}</span>
                  <span className="debug-thread-state">{t.state || ''}</span>
                  <span className="debug-thread-name">{t.name}</span>
                </div>
              ))}
            </div>

            <div className="debug-block-title">openocd</div>
            <div className="debug-row">
              <input
                className="toolbar-input"
                value={execCmd}
                onChange={(e) => setExecCmd(e.target.value)}
                placeholder="如：dump_regs riscv.cpu0"
                spellCheck={false}
              />
              <button
                className="btn"
                disabled={busy || !execCmd}
                onClick={() => void run(async () => {
                  const out = await window.api.debug.exec(execCmd)
                  setExecOut(out)
                  return out
                })}
              >执行</button>
            </div>
            <pre className="debug-out">{execOut || '（无输出）'}</pre>

            <details className="debug-log">
              <summary>适配层日志（adapterLog）</summary>
              <pre className="debug-out">{state?.adapterLog || '（空）'}</pre>
            </details>
          </div>
        </div>
      )}
    </div>
  )
}

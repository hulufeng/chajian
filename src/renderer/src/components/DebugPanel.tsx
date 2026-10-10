import { useCallback, useEffect, useState } from 'react'
import type { DebugChip, DebugState, MemoryReadResult, NvsEntry, PartitionEntry, RegisterValue, ThreadInfo } from '../../../preload'
import { setDebugActive, setCurrentSource } from './editor/debugStore'
import { hint } from '../featureHints'

interface Props {
  /** 当前板卡 FQBN（用于推断调试芯片，如 esp32:esp32:esp32s3 → esp32s3） */
  fqbn?: string
  /** 显式指定调试芯片（硬件目标面板选中 STM32 时传 stm32f7 之类，优先于 fqbn 推断） */
  chipOverride?: string
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

export default function DebugPanel({ fqbn, chipOverride }: Props): React.JSX.Element {
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
  /** 当前暂停所在函数名（由 syncCurrentLine 从 PC 反查，空串表示无/未加载符号） */
  const [ curFn, setCurFn ] = useState('')
  /** 调用栈回溯结果（帧指针法；frames 为空/none 时看 note 如实说明原因） */
  const [ cs, setCs ] = useState<{ frames: Array<{ index: number; address: number; fn: string | null; file: string | null; line: number | null }>; method: string; note: string } | null>(null)
  /** Watch：全局变量候选 + 当前选中 + 读回值 */
  const [ globals, setGlobals ] = useState<Array<{ name: string; address: number; size: number; typeName?: string }>>([])
  const [ watchName, setWatchName ] = useState('')
  const [ watchVal, setWatchVal ] = useState<{ name: string; address: number; size: number; typeName?: string; hex: string; asInt: number | null; asFloat: number | null; hint: string } | null>(null)
  /** 局部变量（当前 PC 所在函数，栈地址；需帧指针） */
  const [ locals, setLocals ] = useState<Array<{ name: string; typeName: string; addr: number; offset: number; funcName?: string }>>([])
  const [ localName, setLocalName ] = useState('')
  const [ localVal, setLocalVal ] = useState<{ name: string; typeName?: string; hex: string; asInt: number | null; asFloat: number | null; hint: string } | null>(null)
  // 片内 Flash 存储：分区表 + NVS（复用 openocd 读内存，不需要另装 esptool）
  const [ parts, setParts ] = useState<PartitionEntry[]>([])
  const [ nvs, setNvs ] = useState<NvsEntry[]>([])
  const [ storeNote, setStoreNote ] = useState('')

  const loadInfo = useCallback((): void => {
    window.api.debug.info().then(setInfo).catch((e: Error) => setInstallErr(e.message))
  }, [])

  useEffect(() => {
    loadInfo()
    // 烧录等外部动作会停掉会话 → 面板自动回落
    const off = window.api.debug.onStopped(setState)
    return () => off()
  }, [loadInfo])

  /** 用当前板卡 FQBN 推断默认芯片（只做一次）。chipOverride 优先：硬件目标面板可指定 STM32 等非 FQBN 目标 */
  useEffect(() => {
    if (chipOverride) {
      setChip(chipOverride)
      return
    }
    if (!fqbn || !info || info.chips.length === 0) return
    const seg = fqbn.split(':').pop() || ''
    const hit = info.chips.find((c) => seg.toLowerCase().startsWith(c.chip))
    if (hit) setChip(hit.chip)
  }, [fqbn, info, chipOverride])

  const refresh = useCallback((): void => {
    window.api.debug.state().then(setState).catch(() => undefined)
  }, [])

  /** 停住后读 PC → 映射成源码 文件:行，写进 store 供编辑器高亮当前执行行 */
  const syncCurrentLine = useCallback(async (): Promise<void> => {
    try {
      const regs = await window.api.debug.registers()
      setRegs(regs)
      const pc = regs.find((r) => /^(pc|PC)$/i.test(r.name))?.num
      if (pc === undefined) { setCurrentSource('', null); return }
      const loc = (await window.api.debug.location(pc)) as
        | { source: { file: string; line: number } | null; fn: { name: string } | null }
        | null
      setCurrentSource(loc?.source?.file ?? '', loc?.source?.line ?? null)
      setCurFn(loc?.fn?.name ?? '')
    } catch {
      setCurrentSource('', null)
    }
  }, [])

  /** 拉当前函数的局部变量（停住后调用才有意义） */
  const loadLocals = useCallback(async (): Promise<void> => {
    try {
      setLocals((await window.api.debug.locals()) as Array<{ name: string; typeName: string; addr: number; offset: number; funcName?: string }>)
    } catch { setLocals([]) }
  }, [])

  /** 执行会「停在原地」的命令（暂停/单步/复位）后刷新当前行 + 局部变量 */
  const runAndSync = useCallback(
    async (fn: () => Promise<string>): Promise<string> => {
      const out = await run(fn)
      await syncCurrentLine()
      void loadLocals()
      return out
    },
    [syncCurrentLine, loadLocals]
  )

  const connect = async (): Promise<void> => {
    setBusy(true); setErr('')
    try {
      const s = await window.api.debug.start({ chip })
      setState(s)
      setDebugActive(true)
      await syncCurrentLine()
      void loadGlobals()
      void loadLocals()
    } catch (e) {
      setErr((e as Error).message)
      setDebugActive(false)
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
    finally {
      setDebugActive(false)
      setCurrentSource('', null)
      setCurFn('')
    }
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

  /** 回溯调用栈（帧指针法）。做不了就显示 note，不硬凑。 */
  const readCallStack = async (): Promise<void> => {
    setBusy(true); setErr('')
    try {
      setCs((await window.api.debug.callStack(32)) as any)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  /** 拉全局变量候选（Watch 下拉） */
  const loadGlobals = useCallback(async (): Promise<void> => {
    try {
      setGlobals((await window.api.debug.globals()) as Array<{ name: string; address: number; size: number }>)
    } catch { setGlobals([]) }
  }, [])

  /** 读取选中全局变量的当前值 */
  const readWatch = async (): Promise<void> => {
    if (!watchName) return
    setBusy(true); setErr('')
    try {
      setWatchVal((await window.api.debug.watch(watchName)) as any)
    } catch (e) { setWatchVal(null); setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  /** 读局部变量当前值 */
  const readLocal = async (): Promise<void> => {
    if (!localName) return
    setBusy(true); setErr('')
    try {
      setLocalVal((await window.api.debug.watchLocal(localName)) as any)
    } catch (e) { setLocalVal(null); setErr((e as Error).message) }
    finally { setBusy(false) }
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
        <span className="debug-title" {...hint('debugPanel')}>片上调试器</span>
        <span className={`debug-dot ${running ? 'on' : disclosed ? 'off' : 'idle'}`} />
        <span className="debug-meta">
          {state
            ? `${state.chip} · telnet:${state.telnetPort} · ${state.status}${state.target !== 'unknown' ? ` / ${state.target}` : ''}`
            : (info?.installed ? '未连接' : 'openocd 未安装')}
        </span>
        <span className="debug-spacer" />
        {running ? (
          <>
            <button className="btn" disabled={busy} onClick={() => void runAndSync(() => window.api.debug.halt())}>⏸ 暂停</button>
            <button className="btn" disabled={busy} onClick={() => { setCurrentSource('', null); setCurFn(''); void run(() => window.api.debug.resume()) }}>▶ 运行</button>
            <button className="btn" disabled={busy} onClick={() => void runAndSync(() => window.api.debug.step())}>⤼ 单步</button>
            <button className="btn" disabled={busy} onClick={() => void runAndSync(() => window.api.debug.reset())}>⟲ 复位</button>
            <button className="btn" disabled={busy} onClick={() => void readRegs()}>寄存器</button>
            <button className="btn" disabled={busy} onClick={() => void readThreads()}>线程</button>
            <button className="btn" disabled={busy} onClick={() => void readCallStack()}>调用栈</button>
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

            {cs && (
              <>
                <div className="debug-block-title">
                  调用栈 <span className="debug-hint">帧指针回溯</span>
                </div>
                <div className="debug-callstack">
                  <div className="debug-empty">{cs.note}</div>
                  {cs.frames.map((f) => (
                    <div key={f.index} className="debug-frame">
                      <span className="debug-frame-idx">#{f.index}</span>
                      <span className="debug-frame-fn">{f.fn ?? '(未知函数)'}</span>
                      <span className="debug-frame-loc">
                        {f.file ? `${f.file}:${f.line ?? '?'}` : '—'}
                      </span>
                      <span className="debug-frame-addr">0x{f.address.toString(16)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="debug-block-title">
              变量 Watch <span className="debug-hint">全局</span>
              <button className="btn mini" onClick={() => void loadGlobals()} title="刷新全局变量列表">⟳</button>
            </div>
            <div className="debug-row">
              <select
                className="toolbar-input"
                value={watchName}
                onChange={(e) => setWatchName(e.target.value)}
                spellCheck={false}
              >
                <option value="">{globals.length === 0 ? '（连接后拉取全局变量）' : '选择变量…'}</option>
                {globals.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.typeName ? `${g.typeName} ` : ''}{g.name}  (0x{g.address.toString(16)}, {g.size}B)
                  </option>
                ))}
              </select>
              <button className="btn" disabled={busy || !watchName} onClick={() => void readWatch()}>
                读取
              </button>
            </div>
            {watchVal && (
              <div className="debug-watch">
                <div className="debug-frame">
                  <span className="debug-frame-fn">{watchVal.name}</span>
                  <span className="debug-frame-addr">0x{watchVal.address.toString(16)}</span>
                </div>
                <div className="debug-watch-line">
                  <span className="debug-watch-k">hex</span>
                  <span className="debug-watch-v">{watchVal.hex}</span>
                </div>
                {watchVal.asInt !== null && (
                  <div className="debug-watch-line">
                    <span className="debug-watch-k">int</span>
                    <span className="debug-watch-v">{watchVal.asInt}</span>
                  </div>
                )}
                {watchVal.asFloat !== null && (
                  <div className="debug-watch-line">
                    <span className="debug-watch-k">float</span>
                    <span className="debug-watch-v">{watchVal.asFloat}</span>
                  </div>
                )}
                <div className="debug-empty">{watchVal.hint}</div>
              </div>
            )}

            <div className="debug-block-title">
              局部变量 <span className="debug-hint">栈</span>
              <button className="btn mini" onClick={() => void loadLocals()} title="刷新局部变量">⟳</button>
            </div>
            <div className="debug-row">
              <select
                className="toolbar-input"
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                spellCheck={false}
              >
                <option value="">{locals.length === 0 ? '（暂停/单步后拉取当前函数局部变量）' : '选择变量…'}</option>
                {locals.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.typeName} {l.name}  (fp{l.offset >= 0 ? '+' : ''}{l.offset})
                  </option>
                ))}
              </select>
              <button className="btn" disabled={busy || !localName} onClick={() => void readLocal()}>
                读取
              </button>
            </div>
            {localVal && (
              <div className="debug-watch">
                <div className="debug-frame">
                  <span className="debug-frame-fn">{localVal.typeName} {localVal.name}</span>
                </div>
                <div className="debug-watch-line"><span className="debug-watch-k">hex</span><span className="debug-watch-v">{localVal.hex}</span></div>
                {localVal.asInt !== null && <div className="debug-watch-line"><span className="debug-watch-k">int</span><span className="debug-watch-v">{localVal.asInt}</span></div>}
                {localVal.asFloat !== null && <div className="debug-watch-line"><span className="debug-watch-k">float</span><span className="debug-watch-v">{localVal.asFloat}</span></div>}
                <div className="debug-empty">{localVal.hint}</div>
              </div>
            )}

            <div className="debug-block-title">内存 <span className="debug-hint">mdb</span></div>            <div className="debug-row">
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

            <div className="debug-block-title">
              片内存储 <span className="debug-hint">0x8000 分区表 · nvs</span>
            </div>
            <div className="debug-row">
              <button
                className="btn"
                disabled={busy}
                onClick={() => void run(async () => {
                  const list = await window.api.debug.partitions()
                  setParts(list)
                  setStoreNote(list.length ? '' : '没读到分区表（0x8000 处无 Pi 魔数，确认芯片型号/烧录方式是否带分区表）')
                  return `读到 ${list.length} 个分区`
                })}
              >读分区表</button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void run(async () => {
                  const r = await window.api.debug.nvs()
                  setParts(r.partitions)
                  setNvs(r.entries)
                  setStoreNote(r.note || (r.entries.length ? '' : '没解析出 NVS 条目（分区为空或未写入过 NVS）'))
                  return `NVS 条目 ${r.entries.length} 条`
                })}
              >读 NVS</button>
            </div>
            {storeNote && <div className="debug-hint">{storeNote}</div>}
            {parts.length > 0 && (
              <div className="debug-threads">
                {parts.map((p) => (
                  <div key={`${p.address}-${p.name}`} className="debug-thread">
                    <span className="debug-thread-id">{p.name}</span>
                    <span className="debug-thread-state">{p.kind}/{p.subtypeName}</span>
                    <span className="debug-thread-pc">0x{p.address.toString(16)} · {(p.size / 1024).toFixed(1)}KB</span>
                  </div>
                ))}
              </div>
            )}
            {nvs.length > 0 && (
              <details className="debug-log">
                <summary>NVS 条目（{nvs.length}）</summary>
                <div className="debug-threads">
                  {nvs.slice(0, 100).map((e, i) => (
                    <div key={`${e.namespace}-${e.key}-${i}`} className="debug-thread">
                      <span className="debug-thread-id">{e.key}</span>
                      <span className="debug-thread-state">{e.type}</span>
                      <span className="debug-thread-name">{e.value === null ? '—' : String(e.value)}</span>
                    </div>
                  ))}
                </div>
                <div className="debug-hint">NVS 为尽力解析（按条目布局扫描、未做 CRC 校验），写操作请自行核对。</div>
              </details>
            )}
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

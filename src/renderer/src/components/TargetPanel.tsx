import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardTargetInfo, DetectedPort, SelfCheckReport } from '../../../preload'

interface Props {
  /** 当前工程根目录（写 platformio.ini 用） */
  projectRoot?: string | null
  /** 当前选中的 FQBN（用于高亮当前板） */
  fqbn?: string
  /** 已选串口 */
  port?: string
  /** 应用目标：把板卡/端口写回工程与全局状态 */
  onApply?: (t: BoardTargetInfo, opts: { port?: string; buildPath: string }) => void
  /** 打开片上调试面板（并带上该板的调试配置） */
  onOpenDebug?: (t: BoardTargetInfo) => void
  onClose: () => void
}

const BUILD_LABEL: Record<string, string> = {
  'arduino-cli': 'arduino-cli',
  platformio: 'PlatformIO',
  'esp-idf': 'ESP-IDF',
  stm32cube: 'STM32Cube'
}

const UPLOAD_LABEL: Record<string, string> = {
  serial: '串口',
  'usb-jtag': 'USB-JTAG',
  stlink: 'ST-Link',
  dfu: 'DFU'
}

const LINK_LABEL: Record<string, string> = {
  'builtin-usb-jtag': '板载 USB-JTAG',
  'onboard-stlink': '板载 ST-Link',
  'external-stlink': '外接 ST-Link',
  'cmsis-dap': 'CMSIS-DAP'
}

/** 家族分组的展示顺序与中文名 */
const FAMILY_ORDER: Array<{ id: 'esp32' | 'stm32'; label: string }> = [
  { id: 'esp32', label: 'ESP32 / esp-idf' },
  { id: 'stm32', label: 'STM32 / stm32cube' }
]

/**
 * 硬件目标面板（第四批②）
 * 把「板卡 / 构建路径 / 烧录通道 / 调试器 / SVD」收敛成一个对象，
 * 扩到 STM32 后用户不需要理解 arduino-cli 与 PlatformIO 的命名差异。
 */
export default function TargetPanel({
  projectRoot,
  fqbn,
  port,
  onApply,
  onOpenDebug
}: Props): React.JSX.Element {
  const [boards, setBoards] = useState<BoardTargetInfo[]>([])
  const [ports, setPorts] = useState<DetectedPort[]>([])
  const [selId, setSelId] = useState('')
  const [buildPath, setBuildPath] = useState('')
  const [selPort, setSelPort] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  /** 一键硬件自检结果（插板后先跑它，别盲试） */
  const [sc, setSc] = useState<SelfCheckReport | null>(null)
  const [scBusy, setScBusy] = useState(false)
  /** 改动过但还没应用 */
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, p] = await Promise.all([window.api.target.list(), window.api.target.detect()])
      setBoards(b)
      setPorts(p)
      // 默认选中：当前 FQBN 命中的板，否则第一块
      const byFqbn = fqbn ? b.find((x) => x.fqbn === fqbn) : undefined
      setSelId((prev) => prev || byFqbn?.id || b[0]?.id || '')
      setSelPort((prev) => prev || port || p[0]?.path || '')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [fqbn, port])

  useEffect(() => {
    void load()
  }, [load])

  const sel = useMemo(() => boards.find((b) => b.id === selId) || null, [boards, selId])

  // 换板卡时把构建路径重置为该板的第一条（推荐）
  useEffect(() => {
    if (sel) setBuildPath(sel.build[0]?.path || '')
  }, [selId]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 热插拔：端口下拉必须跟着真实串口走。
   * selPort 只在首次「为空」时赋值（load 里 `prev || port || p[0]?.path`），
   * 之前没有订阅 onPortsChanged —— 板子拔掉后下拉还留着那个已经消失的端口，
   * 点烧录就是对着一个不存在的 COM 口发命令；插上新板也不会自动补上。
   * 而且同一块信息 DevicePanel 那边会清成空，两个面板一个留一个清，直接自相矛盾。
   */
  useEffect(() => {
    const off = window.api.serial.onPortsChanged?.((d) => {
      const next: DetectedPort[] = (d?.ports as DetectedPort[]) || []
      setPorts(next)
      setSelPort((prev) => (prev && !next.some((p) => p.path === prev) ? '' : prev))
    })
    return () => { off?.() }
  }, [])

  const markDirty = (): void => {
    setDirty(true)
    setMsg('')
  }

  /** 硬件自检：把「缺什么」一次列清楚，而不是让用户盲试连接 */
  const selfCheck = async (): Promise<void> => {
    setScBusy(true)
    setErr('')
    try {
      setSc(await window.api.target.selfCheck())
    } catch (e) {
      setErr(`自检失败：${(e as Error).message}`)
    } finally {
      setScBusy(false)
    }
  }

  const apply = (): void => {
    if (!sel) return
    onApply?.(sel, { port: selPort || undefined, buildPath })
    setDirty(false)
    setMsg(`已应用：${sel.name}（${BUILD_LABEL[buildPath] || buildPath}${selPort ? ` · ${selPort}` : ''}）`)
  }

  const writeIni = async (): Promise<void> => {
    if (!sel || !projectRoot) {
      setErr('没有打开工程，无法生成 platformio.ini')
      return
    }
    try {
      const r = await window.api.target.writeIni({
        projectRoot,
        boardId: sel.id,
        uploadPort: selPort || undefined
      })
      setMsg(`已生成 ${r.path}`)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const familyBlocks = FAMILY_ORDER.map((f) => ({
    ...f,
    items: boards.filter((b) => b.family === f.id)
  })).filter((f) => f.items.length > 0)

  return (
    <div className="tgt">
      <div className="tgt-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.6" strokeLinecap="round">
          <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
          <path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5H6.5M3 14.5H6.5M17.5 9.5H21M17.5 14.5H21" />
        </svg>
        <span className="tgt-title">硬件目标</span>
        <span className="tgt-sub">
          {sel ? `${sel.chip} · ${BUILD_LABEL[buildPath] || buildPath} · ${LINK_LABEL[sel.debug.link]} · ${selPort || '未选端口'}` : '—'}
        </span>
        <span className="tgt-spacer" />
        {dirty && <span className="tgt-dirty">未应用</span>}
        <button className="btn" onClick={() => void selfCheck()} disabled={scBusy} title="检查工具链 / 调试器 / USB 驱动 / 串口占用">
          {scBusy ? '自检中…' : '一键自检'}
        </button>
        <button className="btn" onClick={() => void load()}>自动探测</button>
      </div>

      {sc && (
        <div className="sc">
          <div className="sc-head">
            <span className="sc-summary">{sc.summary}</span>
            <span className="sc-time">{new Date(sc.ts).toLocaleTimeString()}</span>
          </div>
          <div className="sc-list">
            {sc.items.map((it) => (
              <div key={it.id} className="sc-item">
                <span className={`sc-dot ${it.status}`} />
                <span className="sc-name">{it.name}</span>
                <span className="sc-detail">{it.detail}</span>
                {it.fix && <span className="sc-fix">→ {it.fix}</span>}
              </div>
            ))}
          </div>
          {sc.advice.length > 0 && (
            <div className="sc-advice">{sc.advice.map((a, i) => <div key={i}>{a}</div>)}</div>
          )}
        </div>
      )}

      {loading && <div className="tgt-hint">正在读取板卡库与串口…</div>}
      {err && <div className="debug-err">{err}</div>}
      {msg && <div className="tgt-msg">{msg}</div>}

      <div className="tgt-body">
        <div className="tgt-left">
          <div className="tgt-label">板卡家族</div>
          {familyBlocks.map((f) => (
            <div key={f.id} className="tgt-group">
              <div className="tgt-group-head">{f.label}</div>
              {f.items.map((b) => (
                <div
                  key={b.id}
                  className={`tgt-item ${b.id === selId ? 'active' : ''}`}
                  onClick={() => { setSelId(b.id); markDirty() }}
                >
                  <span className={`tgt-dot ${b.id === selId ? 'on' : ''}`} />
                  <span className="tgt-item-name">{b.name}</span>
                  <span className="tgt-item-flash">{b.flash}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="tgt-hint">
            选中板卡后右侧四段配置自动填好；改任意一项都会标记为「未应用」。
          </div>
        </div>

        <div className="tgt-right">
          {sel && (
            <>
              <div className="tgt-metrics">
                <div className="tgt-metric">
                  <div className="tgt-label">构建路径</div>
                  <div className="tgt-metric-v">{BUILD_LABEL[buildPath] || buildPath}</div>
                </div>
                <div className="tgt-metric">
                  <div className="tgt-label">烧录通道</div>
                  <div className="tgt-metric-v">{UPLOAD_LABEL[sel.upload.kind] || sel.upload.kind}</div>
                </div>
                <div className="tgt-metric">
                  <div className="tgt-label">调试器</div>
                  <div className="tgt-metric-v">{LINK_LABEL[sel.debug.link] || sel.debug.link}</div>
                </div>
              </div>

              <div className="tgt-sec">
                <div className="tgt-sec-row">
                  <span className="tgt-label">构建</span>
                  <span className="mono">{buildPath === 'platformio' ? `${sel.pioPlatform} / ${sel.pioBoard}` : sel.fqbn || sel.build[0]?.detail}</span>
                </div>
                <div className="tgt-sec-row">
                  <span className="tgt-label">切换</span>
                  <span className="tgt-chips">
                    {sel.build.map((b) => (
                      <span
                        key={b.path}
                        className={`tgt-chip ${b.path === buildPath ? 'on' : ''}`}
                        title={b.detail}
                        onClick={() => { setBuildPath(b.path); markDirty() }}
                      >
                        {BUILD_LABEL[b.path] || b.path}
                      </span>
                    ))}
                  </span>
                </div>
                <div className="tgt-sec-row">
                  <span className="tgt-label">芯片</span>
                  <span className="mono">{sel.mcu}</span>
                </div>
              </div>

              <div className="tgt-sec tgt-sec-2col">
                <div>
                  <div className="tgt-label">烧录</div>
                  <div className="tgt-kv">
                    端口
                    <select className="toolbar-input" value={selPort} onChange={(e) => { setSelPort(e.target.value); markDirty() }}>
                      <option value="">未选择</option>
                      {ports.map((p) => (
                        <option key={p.path} value={p.path}>
                          {p.path}
                          {p.targetName ? ` · ${p.targetName}` : p.usbId ? ` · ${p.usbId}` : ''}
                          {/* ESP32-S3/C3/P4 原生 USB 共用 303a:1001，只看 VID:PID 分不开。
                              这里把"没认准"说出来，别让列表把 C3 显示成 S3 就当定论。 */}
                          {p.candidateIds && p.candidateIds.length > 1 ? ' · 同 VID:PID 多板，请选准板卡' : ''}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const ids = ports.find((x) => x.path === selPort)?.candidateIds || []
                      if (ids.length <= 1) return null
                      return (
                        <div className="tgt-note tgt-warn">
                          该 VID:PID 对应 {ids.length} 块板（{ids.join(' / ')}），硬件上区分不了，
                          请在上方板卡里按型号选准。
                        </div>
                      )
                    })()}
                  </div>
                  <div className="tgt-kv">
                    方式 <span className="mono">{sel.upload.kind === 'serial' ? `serial @ ${sel.upload.baud}` : sel.upload.kind}</span>
                  </div>
                  <div className="tgt-note">{sel.upload.note}</div>
                </div>
                <div>
                  <div className="tgt-label">调试</div>
                  <div className="tgt-kv">
                    cfg <span className="mono">{sel.debug.cfg.join(' + ')}</span>
                  </div>
                  <div className="tgt-kv">
                    链路 <span className="mono">telnet（不拉 gdb）</span>
                  </div>
                  <div className="tgt-note">
                    {sel.debug.note}
                    {!sel.debugCfgExists && <b className="tgt-warn">（本机 openocd 缺少该 cfg，需装完整 openocd-esp32）</b>}
                  </div>
                </div>
              </div>

              <div className="tgt-sec">
                <div className="tgt-label">寄存器（SVD）</div>
                <div className="tgt-sec-row">
                  <span className="mono">
                    {sel.svdChip ? `espressif/svd · ${sel.svdChip}.svd` : '该芯片无在线 SVD 源'}
                  </span>
                  <span className={`tgt-badge ${sel.svdChip ? 'ok' : 'warn'}`}>{sel.svdChip ? '可安装' : '需导入本地 .svd'}</span>
                  <span className="tgt-link" onClick={() => onOpenDebug?.(sel)}>在调试面板里查寄存器</span>
                </div>
              </div>

              <div className="tgt-actions">
                <button className="btn" onClick={() => void load()}>自动探测</button>
                <button className="btn" disabled={!projectRoot} onClick={() => void writeIni()} title={projectRoot ? '生成 platformio.ini' : '先打开工程'}>
                  写入 platformio.ini
                </button>
                <button className="btn" onClick={() => onOpenDebug?.(sel)}>打开调试面板</button>
                <button className="btn primary" disabled={!sel} onClick={apply}>应用到当前工程</button>
                <span className="tgt-hint tgt-actions-hint">{sel.notes}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'

/**
 * 设备诊断面板（三合一）：
 *  - 引脚冲突：静态扫描工程源码里的 Arduino 引脚 API，对照芯片引脚模型判定越界 / strapping / JTAG / 复用冲突
 *  - 烧录历史：记录每次烧录前的源码 sha1 快照，支持按记录回滚（只写回快照内含的文件，不删用户新增代码）
 *  - 分享卡片：本地生成自包含 HTML 卡片并用系统浏览器打开（不上传任何数据）
 */

type TabId = 'pins' | 'burn' | 'share'

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'pins', label: '引脚冲突', icon: '🔎' },
  { id: 'burn', label: '烧录历史', icon: '🕘' },
  { id: 'share', label: '分享卡片', icon: '🖼️' }
]

interface PinIssueItem {
  level: string
  pin: number
  title: string
  detail: string
  refs?: Array<{ file: string; line: number; api: string }>
}

interface PinUnresolved {
  token: string
  api: string
  file: string
  line: number
  note: string
}

interface PinResult {
  chip: string
  scannedFiles: number
  issues: PinIssueItem[]
  unresolved: PinUnresolved[]
  summary: string
  text: string
}

interface BurnItem {
  id: string
  ts: number
  projectName: string
  fqbn: string
  port: string
  ok: boolean
  fileCount: number
  logTail?: string
  note?: string
}

interface RollbackResult {
  id: string
  written: string[]
  changed: string[]
  missing: string[]
  error?: string
}

interface ShareMetric {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'err'
  hint?: string
}

const LEVEL_ICON: Record<string, string> = { error: '⛔', warning: '⚠️', info: 'ℹ️' }
const LEVEL_CLASS: Record<string, string> = { error: 'pin-lvl-error', warning: 'pin-lvl-warn', info: 'pin-lvl-info' }

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 把 metrics 文本行 "标签|值|[ok|warn|err]" 解析成结构化指标，空行跳过、缺标签的整行忽略。 */
function parseMetrics(text: string): ShareMetric[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((s) => s.trim()))
    .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
    .map((parts) => {
      const tone = parts[2] === 'ok' || parts[2] === 'warn' || parts[2] === 'err' ? parts[2] : undefined
      return { label: parts[0], value: parts[1], tone, hint: parts[3] || undefined }
    })
}

interface DeviceDiagnosticsModalProps {
  projectRoot?: string | null
  board: string
  port: string
  onClose: () => void
  onOpenFile?: (path: string, name?: string) => void
}

function DeviceDiagnosticsModal({ projectRoot, board, port, onClose, onOpenFile }: DeviceDiagnosticsModalProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('pins')

  /* ── 引脚冲突 ── */
  const [pinBusy, setPinBusy] = useState(false)
  const [pinErr, setPinErr] = useState<string | null>(null)
  const [pinRes, setPinRes] = useState<PinResult | null>(null)

  const runPinCheck = useCallback(async () => {
    setPinBusy(true)
    setPinErr(null)
    setPinRes(null)
    try {
      const r = await window.api.pin.check({ projectRoot: projectRoot || undefined, fqbn: board })
      setPinRes(r as unknown as PinResult)
    } catch (e) {
      setPinErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPinBusy(false)
    }
  }, [projectRoot, board])

  /* ── 烧录历史 ── */
  const [burnList, setBurnList] = useState<BurnItem[]>([])
  const [burnLoading, setBurnLoading] = useState(false)
  const [burnMsg, setBurnMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadBurn = useCallback(async () => {
    setBurnLoading(true)
    try {
      const list = await window.api.burn.list(30)
      setBurnList(list)
    } catch (e) {
      setBurnMsg({ text: e instanceof Error ? e.message : String(e), ok: false })
    } finally {
      setBurnLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'burn') void loadBurn()
  }, [tab, loadBurn])

  const doRollback = async (item: BurnItem): Promise<void> => {
    if (!item) return
    const ok = window.confirm(
      `回滚到 ${fmtTime(item.ts)} 的烧录快照？\n\n` +
        `会把快照内的 ${item.fileCount} 个源码文件写回原路径（只覆盖当时记录过的文件），\n` +
        `此后你新增的文件不会被删除。此操作会直接改动工程源码。`
    )
    if (!ok) return
    setBurnMsg(null)
    try {
      const r = (await window.api.burn.rollback({ id: item.id, targetRoot: projectRoot || undefined })) as RollbackResult
      if (r.error) setBurnMsg({ text: `回滚失败：${r.error}`, ok: false })
      else setBurnMsg({ text: `已写回 ${r.written.length} 个文件（变更 ${r.changed.length} 个，快照外 ${r.missing.length} 个），请检查代码。`, ok: true })
    } catch (e) {
      setBurnMsg({ text: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const doRemoveBurn = async (item: BurnItem): Promise<void> => {
    if (!window.confirm(`删除这条烧录记录？\n${item.projectName} · ${fmtTime(item.ts)}\n（仅移除记录与快照，不影响工程源码）`)) return
    try {
      await window.api.burn.remove(item.id)
      setBurnMsg({ text: '记录已删除', ok: true })
      await loadBurn()
    } catch (e) {
      setBurnMsg({ text: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const doManualSnapshot = async (): Promise<void> => {
    if (!projectRoot) {
      setBurnMsg({ text: '请先打开一个工程', ok: false })
      return
    }
    setBurnMsg(null)
    try {
      await window.api.burn.record({ projectRoot, fqbn: board, port, ok: true, note: '手动快照' })
      setBurnMsg({ text: '已为当前工程源码拍下快照（可回滚）', ok: true })
      await loadBurn()
    } catch (e) {
      setBurnMsg({ text: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  /* ── 分享卡片 ── */
  const [shareTitle, setShareTitle] = useState('')
  const [shareSubtitle, setShareSubtitle] = useState('')
  const [shareChip, setShareChip] = useState('')
  const [shareMetrics, setShareMetrics] = useState('板卡|ESP32-S3|ok\n结果|烧录成功|ok\n端口|COM3|')
  const [shareCode, setShareCode] = useState('')
  const [shareMsg, setShareMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [shareBusy, setShareBusy] = useState<string | null>(null)
  const [shareHistory, setShareHistory] = useState<Array<{ path: string; name: string; bytes: number; ts: number }>>([])

  useEffect(() => {
    if (!shareTitle && projectRoot) {
      const base = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工程'
      setShareTitle(base)
    }
    if (!shareChip && board) setShareChip(board)
    if (!shareHistory.length) {
      window.api.share.list()
        .then((l) => setShareHistory(l))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, board])

  const buildShare = async (open: boolean): Promise<void> => {
    setShareBusy(open ? 'open' : 'save')
    setShareMsg(null)
    try {
      const input = {
        title: shareTitle || '未命名工程',
        subtitle: shareSubtitle || undefined,
        chip: shareChip || undefined,
        metrics: parseMetrics(shareMetrics),
        code: shareCode || undefined
      }
      const r = (open
        ? await window.api.share.open(input)
        : await window.api.share.card(input)) as { path: string; bytes: number; opened?: boolean; error?: string }
      if (open && r.error) {
        setShareMsg({ text: `生成失败：${r.error}`, ok: false })
      } else {
        setShareMsg({ text: `已生成卡片：${r.path}（${(r.bytes / 1024).toFixed(1)} KB）`, ok: true })
        window.api.share.list()
          .then((l) => setShareHistory(l))
          .catch(() => undefined)
      }
    } catch (e) {
      setShareMsg({ text: e instanceof Error ? e.message : String(e), ok: false })
    } finally {
      setShareBusy(null)
    }
  }

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal">
        <div className="settings-head">
          <span>🔧 设备诊断</span>
          <button className="settings-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="settings-body">
          <div className="settings-nav">
            {TABS.map((t) => (
              <div
                key={t.id}
                className={`settings-nav-item ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="settings-nav-icon">{t.icon}</span>
                <span>{t.label}</span>
              </div>
            ))}
          </div>

          <div className="settings-content">
            {!projectRoot && (
              <div className="settings-desc" style={{ marginBottom: 12 }}>
                当前没有打开工程——引脚冲突检测、烧录快照与回滚都依赖工程目录。先在左侧打开一个 ESP32 工程。
              </div>
            )}

            {/* ── 引脚冲突 ── */}
            {tab === 'pins' && (
              <div className="settings-section">
                <h3>引脚冲突检测</h3>
                <div className="settings-desc" style={{ marginBottom: 10 }}>
                  静态扫描工程里的 Arduino 引脚 API（pinMode / digitalWrite / ledcAttach / Wire / SPI / attachInterrupt …），
                  按芯片引脚模型判定：编号越界、驱动 strapping 启动脚、占用 JTAG 脚、同一脚既读又写、PWM 与 ADC 抢脚。
                  识别不出具体 GPIO 号的写法只提示、不猜编号。
                </div>
                <div className="settings-row">
                  <span>目标芯片（由开发板推断）</span>
                  <span className="settings-val">{board || '未选择开发板'}</span>
                </div>
                <div className="settings-actions">
                  <button className="settings-btn" onClick={() => void runPinCheck()} disabled={pinBusy || !projectRoot}>
                    {pinBusy ? '扫描中…' : '开始检测'}
                  </button>
                </div>
                {pinErr && <div className="svd-msg err" style={{ marginTop: 10 }}>{pinErr}</div>}
                {pinRes && (
                  <>
                    <div className="settings-row">
                      <span>芯片 / 扫描文件数 / 识别到的引脚调用</span>
                      <span className="settings-val">
                        {pinRes.chip} · {pinRes.scannedFiles} 个文件 · {pinRes.issues.length ? '' : '无冲突'}
                      </span>
                    </div>
                    <div className="svd-msg ok" style={{ marginTop: 8 }}>{pinRes.summary}</div>
                    {pinRes.issues.length > 0 && (
                      <div className="pin-issue-list">
                        {pinRes.issues.map((it, i) => (
                          <div key={`${it.pin}-${i}`} className={`pin-issue ${LEVEL_CLASS[it.level] || 'pin-lvl-info'}`}>
                            <div className="pin-issue-head">
                              <span className="pin-issue-icon">{LEVEL_ICON[it.level] || 'ℹ️'}</span>
                              <span className="pin-issue-pin">GPIO {it.pin}</span>
                              <span className="pin-issue-title">{it.title}</span>
                            </div>
                            <div className="pin-issue-detail">{it.detail}</div>
                            {it.refs && it.refs.length > 0 && (
                              <div className="pin-issue-refs">
                                {it.refs.map((rf, j) => (
                                  <span
                                    key={`${rf.file}:${rf.line}:${j}`}
                                    className="pin-issue-ref"
                                    title="点击跳转到该行"
                                    onClick={() => onOpenFile?.(rf.file, rf.file.split(/[\\/]/).pop())}
                                  >
                                    {rf.api ? `${rf.api} @ ` : ''}
                                    {String(rf.file).split(/[\\/]/).pop()}:{rf.line}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {pinRes.unresolved && pinRes.unresolved.length > 0 && (
                      <div className="pin-unresolved">
                        <div className="pin-unresolved-title">以下调用像是引脚但解析不到 GPIO 号（只提示，不臆断）：</div>
                        {pinRes.unresolved.map((u, i) => (
                          <div key={`${u.file}:${u.line}:${i}`} className="pin-unresolved-row">
                            <code>{u.token}</code> · {u.api} · {String(u.file).split(/[\\/]/).pop()}:{u.line}
                            <span className="pin-unresolved-note">{u.note}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── 烧录历史 ── */}
            {tab === 'burn' && (
              <div className="settings-section">
                <h3>烧录历史与回滚</h3>
                <div className="settings-desc" style={{ marginBottom: 10 }}>
                  每次烧录前会给工程源码拍 sha1 快照并落盘（最新的 50 条）。回滚只把快照里的文件写回原路径，
                  不会删除你以后新增的代码。
                </div>
                <div className="settings-actions" style={{ paddingTop: 0, paddingBottom: 12 }}>
                  <button className="settings-btn" onClick={() => void loadBurn()} disabled={burnLoading}>
                    {burnLoading ? '加载中…' : '刷新记录'}
                  </button>
                  <button className="settings-btn" onClick={() => void doManualSnapshot()} disabled={!projectRoot}>
                    为当前工程拍快照
                  </button>
                </div>
                {burnMsg && <div className={`svd-msg ${burnMsg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 10 }}>{burnMsg.text}</div>}
                {burnList.length === 0 ? (
                  <div className="svd-empty">还没有烧录记录。点顶栏「烧录」跑一次后，这里会出现可回滚的快照。</div>
                ) : (
                  <div className="burn-list">
                    {burnList.map((it) => (
                      <div key={it.id} className="burn-row">
                        <div className="burn-row-main">
                          <span className={`burn-dot ${it.ok ? 'ok' : 'bad'}`} />
                          <span className="burn-name">{it.projectName}</span>
                          <span className={`burn-badge ${it.ok ? 'ok' : 'bad'}`}>{it.ok ? '成功' : '失败'}</span>
                        </div>
                        <div className="burn-row-meta">
                          {fmtTime(it.ts)} · {it.port || '未指定端口'} · {it.fileCount} 个文件
                        </div>
                        {it.fqbn && <div className="burn-row-fqbn">{it.fqbn}</div>}
                        {expandedId === it.id && (
                          <pre className="burn-log">{it.logTail || '（该记录没有日志尾部）'}</pre>
                        )}
                        <div className="burn-row-actions">
                          <button className="settings-btn" onClick={() => setExpandedId((v) => (v === it.id ? null : it.id))}>
                            {expandedId === it.id ? '收起日志' : '查看日志'}
                          </button>
                          <button className="settings-btn" onClick={() => void doRollback(it)} disabled={!projectRoot}>
                            回滚到此版本
                          </button>
                          <button className="settings-btn" onClick={() => void doRemoveBurn(it)}>
                            删除记录
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── 分享卡片 ── */}
            {tab === 'share' && (
              <div className="settings-section">
                <h3>生成分享卡片</h3>
                <div className="settings-desc" style={{ marginBottom: 10 }}>
                  在本地拼一张自包含的 HTML 卡片并用系统浏览器打开，方便把烧录结果 / 项目状态发群里。
                  文件只落在用户目录，不上传任何服务器。
                </div>
                <div className="settings-row">
                  <span>标题</span>
                  <input className="settings-input" value={shareTitle} onChange={(e) => setShareTitle(e.target.value)} placeholder="工程名" />
                </div>
                <div className="settings-row">
                  <span>副标题</span>
                  <input className="settings-input" value={shareSubtitle} onChange={(e) => setShareSubtitle(e.target.value)} placeholder="可选，如 ESP32-S3 温控风扇" />
                </div>
                <div className="settings-row">
                  <span>芯片标识</span>
                  <input className="settings-input" value={shareChip} onChange={(e) => setShareChip(e.target.value)} placeholder="esp32:esp32:esp32s3" />
                </div>
                <div className="settings-row settings-row-col">
                  <span>指标（每行：标签|值|[ok|warn|err]）</span>
                  <textarea
                    className="settings-textarea"
                    rows={4}
                    value={shareMetrics}
                    onChange={(e) => setShareMetrics(e.target.value)}
                  />
                </div>
                <div className="settings-row settings-row-col">
                  <span>代码片段（可选，会渲染成代码块）</span>
                  <textarea className="settings-textarea" rows={4} value={shareCode} onChange={(e) => setShareCode(e.target.value)} placeholder="贴几行关键代码" />
                </div>
                <div className="settings-actions">
                  <button className="settings-btn" onClick={() => void buildShare(false)} disabled={shareBusy !== null}>
                    {shareBusy === 'save' ? '生成中…' : '仅生成卡片'}
                  </button>
                  <button className="settings-btn" onClick={() => void buildShare(true)} disabled={shareBusy !== null}>
                    {shareBusy === 'open' ? '生成中…' : '生成并打开'}
                  </button>
                </div>
                {shareMsg && <div className={`svd-msg ${shareMsg.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>{shareMsg.text}</div>}
                {shareHistory.length > 0 && (
                  <div className="share-history">
                    <div className="svd-block-title">历史卡片</div>
                    {shareHistory.map((h) => (
                      <div key={h.path} className="svd-row">
                        <a
                          className="svd-picker"
                          href="#"
                          onClick={(e) => { e.preventDefault(); void window.api.app.openPath(h.path).catch(() => undefined) }}
                        >
                          {h.name}
                        </a>
                        <span className="svd-meta">{(h.bytes / 1024).toFixed(1)} KB · {fmtTime(h.ts)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default DeviceDiagnosticsModal

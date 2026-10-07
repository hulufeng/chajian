import { useEffect, useMemo, useRef, useState } from 'react'
import BuildProgress from './BuildProgress'
import TerminalView, { type TerminalHandle } from './TerminalView'
import SerialPlotter from './SerialPlotter'
import { hint } from '../featureHints'
import type { Ref } from 'react'
import type { BuildStageInfo, SerialPortInfo, CrashSignatureResult } from '../../../preload'

type OutputKind = '输出' | '问题' | '串口监视器' | '终端'

const TABS: OutputKind[] = ['输出', '问题', '串口监视器', '终端']

interface Props {
  outputLog: string
  serialLog: string
  cwd: string
  ports: SerialPortInfo[]
  selectedPort: string
  setSelectedPort: (v: string) => void
  baud: number
  setBaud: (v: number) => void
  serialOpen: boolean
  onToggleSerial: () => void
  onRunCommand: (cmd: string) => void
  terminalRef: Ref<TerminalHandle>
  theme: 'light' | 'dark'
  shell?: 'powershell' | 'cmd' | 'pwsh' | 'bash'
  onClose?: () => void
  defaultTab?: OutputKind
  buildError?: string | null
  onDiagnose?: () => void
  onDebugFix?: () => void
  /** 编译过程：阶段条 / 结果卡（数据由 App 从主进程解析后传入） */
  buildVisible?: boolean
  buildActive?: boolean
  buildStage?: BuildStageInfo
  buildElapsedMs?: number
  buildCancellable?: boolean
  buildFailed?: boolean
  /** 真实写入百分比（esptool 给的数字才有值） */
  buildProgressPercent?: number | null
  onCancelBuild?: () => void
  buildUsage?: { flashBytes: number; flashPercent: number; ramBytes: number; ramPercent: number; rawFlash: string; rawRam: string } | null
}

/**
 * 渲染层用的行分类（与主进程 build-diagnostics 的 classifyOutputLine 规则一致）。
 * 为什么要着色：编译器把错误、警告、提示、上下文行全打进同一个纯文本框，
 * 用户看到一堆 `In file included from ...` 会以为编译失败（其实只是提示）。
 */
export function lineKind(line: string): 'error' | 'warning' | 'note' | 'context' | 'success' | 'plain' {
  const s = (line || '').trim()
  if (!s) return 'plain'
  if (/:\s*(fatal error|error)\s*:/i.test(s) || /^error(\s|:)/i.test(s) || /^Error during build/i.test(s)) return 'error'
  if (/:\s*warning\s*:/i.test(s) || /^warning(\s|:)/i.test(s)) return 'warning'
  if (/^In file included from\b/i.test(s)) return 'context'
  if (/:\s*note\s*:/i.test(s) || /#pragma\s+message/i.test(s) || /^note\s*:/i.test(s)) return 'note'
  if (/^(✓|✔|Success|成功)/i.test(s)) return 'success'
  return 'plain'
}

/** 已知无害的平台提示（用户常来问「这是不是错误」） */
const KNOWN_NOTE_RES: Array<{ re: RegExp; label: string }> = [
  { re: /BT: forcing BR\/EDR max sync conn eff to 1/i, label: 'ESP32 经典蓝牙栈提示' },
  { re: /#pragma message\(".*Skipping.*"\)/i, label: 'ESP32 平台提示' },
  { re: /this use of \w+ is deprecated/i, label: 'API 弃用提示（仍可编译）' }
]

/** 逐行着色的编译输出 */
function OutputLogView({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        const kind = lineKind(line)
        const known = kind === 'note' ? KNOWN_NOTE_RES.find((k) => k.re.test(line)) : undefined
        return (
          <div
            key={i}
            className={`olog ${kind}${known ? ' olog-known' : ''}`}
            title={known ? `${known.label}：不影响编译结果` : undefined}
          >
            {known && <span className="olog-tag">{known.label}</span>}
            {line || ' '}
          </div>
        )
      })}
    </>
  )
}

/** 输出底部计数条：一眼看出「有没有真错误」 */
function OutputLegend({ counts }: { counts: { error: number; warning: number; note: number } }): React.JSX.Element | null {
  if (counts.error === 0 && counts.warning === 0 && counts.note === 0) return null
  return (
    <div className="olog-legend">
      {counts.error > 0 && <span className="olog-chip err">{counts.error} 错误</span>}
      {counts.warning > 0 && <span className="olog-chip warn">{counts.warning} 警告</span>}
      {counts.note > 0 && <span className="olog-chip note" title="提示级输出（note / #pragma message），不影响编译成功">ⓘ {counts.note} 平台提示（不影响编译）</span>}
    </div>
  )
}

function OutputPanel({
  outputLog,
  serialLog,
  cwd,
  ports,
  selectedPort,
  setSelectedPort,
  baud,
  setBaud,
  serialOpen,
  onToggleSerial,
  onRunCommand,
  terminalRef,
  theme,
  shell,
  onClose,
  defaultTab,
  buildError,
  onDiagnose,
  onDebugFix,
  buildVisible = false,
  buildActive = false,
  buildStage = { stage: 'prepare' as const, label: '准备' },
  buildElapsedMs = 0,
  buildCancellable = false,
  buildFailed = false,
  buildProgressPercent = null,
  onCancelBuild = () => undefined,
  buildUsage = null
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<OutputKind>(defaultTab ?? '输出')
  const [serialView, setSerialView] = useState<'文本' | '波形'>('文本')
  // 崩溃签名分析（本地规则解析，不调 AI、不联网）
  const [crash, setCrash] = useState<CrashSignatureResult | null>(null)
  const [crashBusy, setCrashBusy] = useState(false)

  const runCrashAnalyze = (): void => {
    setCrashBusy(true)
    window.api.serial
      .crashAnalyze({ logs: serialLog })
      .then((r) => setCrash(r))
      .catch((e: unknown) => setCrash({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setCrashBusy(false))
  }

  // 轻量迹象检测：只在日志里出现崩溃关键字时给按钮加提示，避免每次刷新都跑完整解析
  const crashHint = useMemo(
    () =>
      /Guru Meditation|panic'ed|abort\(\)|assert failed|stack overflow|Stack canary|Brownout|watchdog/i.test(
        serialLog
      ),
    [serialLog]
  )
  const outputRef = useRef<HTMLDivElement>(null)
  const serialRef = useRef<HTMLDivElement>(null)

  /**
   * 编译/烧录一开跑就把页签拽到「输出」。
   * 本来这里的默认页签是「串口监视器」，输出其实在另一个页签里，
   * 于是点烧录后界面确实动了，但动的那一页没有过程——这是"看不到烧录过程"的主因。
   * 只在任务**刚刚开始**时拽一次（false→true 的那一帧），之后用户想回去看串口不会被抢。
   */
  const wasBuildActiveRef = useRef(false)
  useEffect(() => {
    if (buildActive && !wasBuildActiveRef.current) setTab('输出')
    wasBuildActiveRef.current = !!buildActive
  }, [buildActive])

  // 输出自动滚动到底部
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [outputLog])
  useEffect(() => {
    if (serialRef.current) serialRef.current.scrollTop = serialRef.current.scrollHeight
  }, [serialLog])

  // 解析问题行：必须与「输出」页签用**同一套判定**（lineKind）。
  // 原来这里用 /error|错误|undefined reference|fatal/i 宽匹配，会命中含 "error" 字样的
  // 成功行/路径行，而「输出」页签用的是严格的 `:error:` 判定 —— 两个页签给出的错误集
  // 对不上，用户会以为漏报或误报。另外它根本不看警告，空态却写着「无错误与警告」。
  const issues = outputLog
    .split('\n')
    .filter((l) => {
      const k = lineKind(l)
      return k === 'error' || k === 'warning'
    })
    .slice(0, 50)

  // 输出计数（用于底部计数条）：错误 / 警告 / 平台提示
  const outputCounts = useMemo(() => {
    let error = 0
    let warning = 0
    let note = 0
    for (const l of outputLog.split('\n')) {
      const k = lineKind(l)
      if (k === 'error') error++
      else if (k === 'warning') warning++
      else if (k === 'note' || k === 'context') note++
    }
    return { error, warning, note }
  }, [outputLog])

  return (
    <section className="output-panel">
      <div className="output-tabs">
        {TABS.map((t) => (
          <div
            key={t}
            className={`output-tab${t === tab ? ' active' : ''}`}
            onClick={() => setTab(t)}
            {...(t === '串口监视器' ? hint('serial') : {})}
          >
            {t}
          </div>
        ))}
        {onClose && (
          <button className="output-tabs-close" onClick={onClose} title="关闭面板">
            ×
          </button>
        )}
      </div>
      <div className="output-body">
        {buildError && (onDiagnose || onDebugFix) && (
          <div className="build-error-banner">
            <div className="build-error-head">
              <span className="build-error-title">⚠ 编译 / 烧录失败</span>
              <div className="build-error-actions">
                {onDiagnose && (
                  <button className="build-error-diagnose" onClick={onDiagnose}>🤖 一键 AI 诊断</button>
                )}
                {onDebugFix && (
                  <button className="build-error-fix" onClick={onDebugFix}>🛠 AI 自动修复</button>
                )}
              </div>
            </div>
            <pre className="build-error-text">{buildError.slice(0, 500)}</pre>
          </div>
        )}
        {tab === '输出' && (
          <div className="mono-log" ref={outputRef}>
            <BuildProgress
              visible={buildVisible}
              active={buildActive}
              stage={buildStage}
              elapsedMs={buildElapsedMs}
              cancellable={buildCancellable}
              failed={buildFailed}
              progressPercent={buildProgressPercent}
              onCancel={onCancelBuild}
              usage={buildUsage}
              port={selectedPort}
            />
            {outputLog ? (
              <>
                <OutputLogView text={outputLog} />
                <OutputLegend counts={outputCounts} />
              </>
            ) : (
              <span className="dim">尚未执行编译/命令，输出将显示在这里。</span>
            )}
          </div>
        )}
        {tab === '问题' && (
          <div className="mono-log">
            {issues.length === 0 ? (
              <span className="dim">无错误与警告。</span>
            ) : (
              issues.map((l, i) => (
                // 与「输出」页签同一套着色（olog-error / olog-warning），
                // 顺带让警告在这里显示成黄色而不是一律红色
                <div key={i} className={lineKind(l) === 'warning' ? 'olog olog-warning' : 'olog olog-error'}>
                  {l}
                </div>
              ))
            )}
          </div>
        )}
        {tab === '串口监视器' && (
          <div className="serial-wrap">
            <div className="serial-controls">
              <label>
                端口
                <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)}>
                  <option value="">选择端口</option>
                  {ports.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path}
                      {p.friendlyName ? ` (${p.friendlyName})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                波特率
                <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
                  {[9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={`btn ${serialOpen ? 'on' : ''}`}
                disabled={!selectedPort}
                onClick={onToggleSerial}
              >
                {serialOpen ? '■ 关闭' : '● 打开'}
              </button>
              <button
                className={`btn${crashHint ? ' crash-alert' : ''}`}
                onClick={runCrashAnalyze}
                disabled={crashBusy || !serialLog}
                title="解析串口日志里的崩溃信息（本地规则解析，不调用 AI、不联网）"
              >
                {crashBusy ? '分析中…' : crashHint ? '🧯 崩溃分析 · 检测到迹象' : '🧯 崩溃分析'}
              </button>
              <div className="serial-subtabs">
                <button
                  className={`subtab${serialView === '文本' ? ' active' : ''}`}
                  onClick={() => setSerialView('文本')}
                >
                  文本
                </button>
                <button
                  className={`subtab${serialView === '波形' ? ' active' : ''}`}
                  onClick={() => setSerialView('波形')}
                >
                  波形
                </button>
              </div>
            </div>
            {crash && (
              <div className={`crash-panel${crash.crashed ? ' crashed' : ''}`}>
                <div className="crash-head">
                  <span className="crash-title">
                    {crash.ok === false ? '⚠ 分析失败' : crash.crashed ? '🧯 检测到崩溃' : '✅ 未识别到崩溃'}
                  </span>
                  <button className="crash-close" onClick={() => setCrash(null)} title="收起">
                    ×
                  </button>
                </div>
                {crash.ok === false ? (
                  <div className="crash-error">{crash.error}</div>
                ) : (
                  <>
                    <div className="crash-summary">{crash.summary}</div>
                    {crash.crashed && (
                      <>
                        <div className="crash-fields">
                          {crash.exception && (
                            <span>
                              异常类型 <b>{crash.exception}</b>
                            </span>
                          )}
                          {crash.pc && (
                            <span>
                              PC <b>{crash.pc}</b>
                            </span>
                          )}
                          {crash.excvaddr && (
                            <span>
                              访问地址 <b>{crash.excvaddr}</b>
                            </span>
                          )}
                          {crash.core !== undefined && (
                            <span>
                              核 <b>Core {crash.core}</b>
                            </span>
                          )}
                        </div>
                        {crash.signature && (
                          <div className="crash-sig">
                            签名 <code>{crash.signature}</code>
                            <span className="crash-sig-tip">（同固件同位置崩溃签名相同，可用来去重计数）</span>
                          </div>
                        )}
                        {crash.backtrace && crash.backtrace.length > 0 && (
                          <div className="crash-bt">
                            调用栈 <code>{crash.backtrace.slice(0, 4).join(' ')}</code>
                          </div>
                        )}
                        {crash.advice && crash.advice.length > 0 && (
                          <ul className="crash-advice">
                            {crash.advice.map((a, i) => (
                              <li key={i}>{a}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
            {serialView === '文本' ? (
              <div className="mono-log" ref={serialRef}>
                {serialLog ? (
                  serialLog
                ) : (
                  <span className="dim">打开串口后，设备输出的数据将实时显示在这里。</span>
                )}
              </div>
            ) : (
              <SerialPlotter serialLog={serialLog} serialOpen={serialOpen} theme={theme} />
            )}
          </div>
        )}
        {tab === '终端' && (
          <TerminalView ref={terminalRef} cwd={cwd} onCommand={onRunCommand} theme={theme} shell={shell} />
        )}
      </div>
    </section>
  )
}

export default OutputPanel

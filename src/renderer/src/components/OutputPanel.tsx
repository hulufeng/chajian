import { useEffect, useRef, useState } from 'react'
import TerminalView, { type TerminalHandle } from './TerminalView'
import SerialPlotter from './SerialPlotter'
import type { Ref } from 'react'
import type { SerialPortInfo } from '../../../preload'

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
  onDebugFix
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<OutputKind>(defaultTab ?? '输出')
  const [serialView, setSerialView] = useState<'文本' | '波形'>('文本')
  const outputRef = useRef<HTMLDivElement>(null)
  const serialRef = useRef<HTMLDivElement>(null)

  // 输出自动滚动到底部
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [outputLog])
  useEffect(() => {
    if (serialRef.current) serialRef.current.scrollTop = serialRef.current.scrollHeight
  }, [serialLog])

  // 解析问题行
  const issues = outputLog
    .split('\n')
    .filter((l) => /error|错误|undefined reference|fatal/i.test(l))
    .slice(0, 50)

  return (
    <section className="output-panel">
      <div className="output-tabs">
        {TABS.map((t) => (
          <div
            key={t}
            className={`output-tab${t === tab ? ' active' : ''}`}
            onClick={() => setTab(t)}
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
            {outputLog ? (
              outputLog
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
                <div key={i} className="err-line">
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

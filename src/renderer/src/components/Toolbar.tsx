import type { ToolchainStatus, SerialPortInfo } from '../../../preload'

interface Props {
  toolchain: ToolchainStatus | null
  fqbn: string
  setFqbn: (v: string) => void
  ports: SerialPortInfo[]
  selectedPort: string
  setSelectedPort: (v: string) => void
  busy: boolean
  compileState: 'idle' | 'compiling' | 'uploading' | 'success' | 'error'
  serialOpen: boolean
  onCompile: () => void
  onUpload: () => void
  onToggleSerial: () => void
  onRefreshPorts: () => void
}

function Toolbar({
  toolchain,
  fqbn,
  setFqbn,
  ports,
  selectedPort,
  setSelectedPort,
  busy,
  compileState,
  serialOpen,
  onCompile,
  onUpload,
  onToggleSerial,
  onRefreshPorts
}: Props): React.JSX.Element {
  const compileLabel = (() => {
    switch (compileState) {
      case 'compiling': return '编译中…'
      case 'uploading': return '烧录中…'
      case 'success': return '✓ 成功'
      case 'error': return '✗ 失败'
      default: return '▶ 编译'
    }
  })()
  const uploadLabel = compileState === 'uploading' ? '烧录中…' : '烧录'
  return (
    <div className="toolbar">
      <span className={`tc-status ${toolchain?.available ? 'ok' : 'warn'}`}>
        {toolchain?.available ? `工具链 ${toolchain.version.split('\n')[0] || 'arduino-cli'}` : '工具链未安装'}
      </span>
      <label className="toolbar-field">
        板卡
        <input
          className="toolbar-input"
          value={fqbn}
          onChange={(e) => setFqbn(e.target.value)}
          placeholder="esp32:esp32:esp32c3"
          spellCheck={false}
        />
      </label>
      <label className="toolbar-field">
        端口
        <select className="toolbar-input" value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)}>
          <option value="">自动/无</option>
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}
            </option>
          ))}
        </select>
      </label>
      <button
        className={`btn accent ${compileState === 'success' ? 'success' : ''} ${compileState === 'error' ? 'error' : ''}`}
        disabled={busy}
        onClick={onCompile}
      >
        {compileLabel}
      </button>
      <button className="btn" disabled={busy || !selectedPort} onClick={onUpload}>
        {uploadLabel}
      </button>
      <button className={`btn ${serialOpen ? 'on' : ''}`} onClick={onToggleSerial}>
        {serialOpen ? '■ 关闭串口' : '串口监视'}
      </button>
      <button className="btn icon" onClick={onRefreshPorts} title="刷新端口">
        ↻
      </button>
    </div>
  )
}

export default Toolbar

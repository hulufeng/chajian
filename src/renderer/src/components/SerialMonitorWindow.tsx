import { useEffect, useRef, useState } from 'react'
import type { SerialPortInfo } from '../../../preload'

interface SerialMonitorWindowProps {
  port: string
  setPort: (v: string) => void
  baud: number
  setBaud: (v: number) => void
  serialOpen: boolean
  onToggle: () => void
  serialLog: string
  ports: SerialPortInfo[]
  onClose: () => void
  onClear: () => void
}

/** 独立串口监视器窗口（可拖拽浮窗） */
function SerialMonitorWindow({
  port,
  setPort,
  baud,
  setBaud,
  serialOpen,
  onToggle,
  serialLog,
  ports,
  onClose,
  onClear
}: SerialMonitorWindowProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const [hex, setHex] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const WIN_W = 520
  const WIN_H = 380
  // 位置：记忆优先（localStorage），否则默认停靠右下角（不遮挡编辑器/侧栏/AI 面板）
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('codelab-serial-pos')
      if (saved) {
        const p = JSON.parse(saved) as { x?: number; y?: number }
        if (typeof p.x === 'number' && typeof p.y === 'number' && p.x >= 0 && p.y >= 0) return { x: p.x, y: p.y }
      }
    } catch {
      /* 解析失败回退默认 */
    }
    const x = Math.max(8, window.innerWidth - WIN_W - 24)
    const y = Math.max(8, window.innerHeight - WIN_H - 24)
    return { x, y }
  })
  const [dragging, setDragging] = useState<{ dx: number; dy: number } | null>(null)
  const posRef = useRef(pos)
  posRef.current = pos
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [serialLog, autoScroll])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || !serialOpen || !port) return
    const res = await window.api.serial.write({ id: `serial-${port}`, data: text })
    if (res.ok) setInput('')
    else console.warn('serial write failed', res.error)
  }

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.sm-btn, .sm-select, .sm-input')) return
    setDragging({ dx: e.clientX - pos.x, dy: e.clientY - pos.y })
  }

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      // 边界钳制：窗口不跑出屏幕
      const nx = Math.min(Math.max(0, e.clientX - dragging.dx), window.innerWidth - WIN_W - 8)
      const ny = Math.min(Math.max(0, e.clientY - dragging.dy), window.innerHeight - WIN_H - 8)
      setPos({ x: Math.max(0, nx), y: Math.max(0, ny) })
    }
    const up = (): void => {
      setDragging(null)
      try {
        localStorage.setItem('codelab-serial-pos', JSON.stringify(posRef.current))
      } catch {
        /* 存储失败不影响使用 */
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])

  return (
    <div className="sm-window" style={{ left: pos.x, top: pos.y }}>
      <div className="sm-titlebar" onMouseDown={onMouseDown}>
        <span>🔌 串口监视器 {port ? `- ${port}` : ''}</span>
        <button className="sm-close" onClick={onClose} title="关闭">✕</button>
      </div>

      <div className="sm-controls">
        <select
          className="sm-select"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          disabled={serialOpen}
        >
          <option value="">选择端口</option>
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}
              {p.friendlyName ? ` (${p.friendlyName})` : ''}
            </option>
          ))}
        </select>
        <select
          className="sm-select"
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={serialOpen}
        >
          {[9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600].map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <button
          className={`sm-btn ${serialOpen ? 'on' : ''}`}
          onClick={onToggle}
          disabled={!port}
        >
          {serialOpen ? '■ 关闭' : '● 打开'}
        </button>
        <button className="sm-btn ghost" onClick={onClear}>清空</button>
        <label className="sm-check">
          <input type="checkbox" checked={hex} onChange={(e) => setHex(e.target.checked)} />
          Hex
        </label>
        <label className="sm-check">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
      </div>

      <div className="sm-log" ref={logRef}>
        {serialLog ? (
          hex
            ? hexEncode(serialLog)
            : serialLog
        ) : (
          <span className="dim">打开串口后，设备输出的数据将实时显示在这里。可在下方输入框向设备发送命令。</span>
        )}
      </div>

      <div className="sm-send">
        <input
          className="sm-input"
          placeholder={serialOpen ? '输入命令，Enter 发送…' : '请先打开串口'}
          value={input}
          disabled={!serialOpen}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button className="sm-btn accent" onClick={() => void send()} disabled={!serialOpen || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}

function hexEncode(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 16) {
    const chunk = text.slice(i, i + 16)
    const hexPart = [...chunk].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    const asciiPart = [...chunk].map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127 ? c : '.')).join('')
    out += `${(i / 16).toString(16).padStart(4, '0')}  ${hexPart.padEnd(47, ' ')}  ${asciiPart}\n`
  }
  return out
}

export default SerialMonitorWindow

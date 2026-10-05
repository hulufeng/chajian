import { useCallback, useEffect, useRef, useState } from 'react'

export type PanelId = 'output' | 'debug' | 'target' | 'platformio' | 'git'

export const PANEL_META: Array<{ id: PanelId; label: string; hint: string }> = [
  { id: 'output', label: '输出', hint: '编译输出 / 串口 / 终端 / 问题' },
  { id: 'debug', label: '调试', hint: '寄存器 / 内存 / 断点 / 分区表' },
  { id: 'target', label: '硬件目标', hint: '板卡 / 构建路径 / 烧录 / 自检' },
  { id: 'platformio', label: 'PlatformIO', hint: 'pio 构建 / 烧录 / 串口监视' },
  { id: 'git', label: 'Git', hint: '变更 / 分支 / 提交历史' }
]

interface Props {
  active: PanelId | null
  onChange: (id: PanelId | null) => void
  height: number
  onHeightChange: (h: number) => void
  /** 标签角标：如 output 显示问题数、git 显示变更数 */
  badges?: Partial<Record<PanelId, string | number>>
  /** 各面板内容 */
  render: (id: PanelId) => React.ReactNode
}

/**
 * 底部统一面板组（UI 重设计核心）
 *
 * 改之前：输出 / 调试 / 硬件目标 / PlatformIO 四个面板各自独立、都可同时展开，
 *         纵向空间被瓜分，且用户不知道该点哪个。
 * 改之后：底部只有一个容器，一次只显示一个面板；标签式切换 + 可拖拽高度 + 可折叠。
 *         打开另一个面板就是切标签，不会出现「同时开四个、谁也看不清」。
 */
export default function PanelDock({ active, onChange, height, onHeightChange, badges, render }: Props): React.JSX.Element | null {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 已经打开过的面板：保持挂载，只切显隐。
   *  否则每次切标签都会卸载重建 —— 终端滚动历史、波形缓冲、面板内滚动位置全丢。 */
  const [mounted, setMounted] = useState<PanelId[]>([])

  useEffect(() => {
    if (active && !mounted.includes(active)) setMounted((m) => [...m, active])
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      setDragging(true)
    },
    [height]
  )

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      // 往上拖 = 变高，所以用 startY - clientY
      const next = Math.min(Math.max(d.startH + (d.startY - e.clientY), 120), window.innerHeight - 220)
      onHeightChange(next)
    }
    const up = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging, onHeightChange])

  if (!active) return null

  return (
    <div className="dock" style={{ height }}>
      <div className="dock-resize" onMouseDown={onMouseDown} title="拖动调整高度" />
      <div className="dock-tabs">
        {PANEL_META.map((p) => (
          <span
            key={p.id}
            className={`dock-tab ${active === p.id ? 'on' : ''}`}
            title={p.hint}
            onClick={() => onChange(active === p.id ? null : p.id)}
          >
            {p.label}
            {badges?.[p.id] !== undefined && badges[p.id] !== 0 && <span className="dock-badge">{badges[p.id]}</span>}
          </span>
        ))}
        <span className="tgt-spacer" />
        <button className="dock-btn" title="折叠面板" onClick={() => onChange(null)}>▾</button>
      </div>
      <div className="dock-body">
        {mounted.map((id) => (
          <div key={id} className="dock-slot" style={{ display: id === active ? 'flex' : 'none' }}>
            {render(id)}
          </div>
        ))}
      </div>
    </div>
  )
}

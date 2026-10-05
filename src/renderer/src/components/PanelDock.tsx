import { useCallback, useEffect, useRef, useState } from 'react'

export type PanelId = 'output' | 'debug' | 'target' | 'platformio' | 'git' | 'agents'

/** label 用短名（工具栏空间有限），全名放 hint 走 tooltip */
export const PANEL_META: Array<{ id: PanelId; label: string; hint: string }> = [
  { id: 'output', label: '输出', hint: '输出 · 编译日志 / 串口监视 / 波形 / 终端 / 问题' },
  { id: 'debug', label: '调试', hint: '调试 · 寄存器 / 内存 / 断点 / 片内存储' },
  { id: 'target', label: '目标', hint: '硬件目标 · 板卡 / 构建路径 / 烧录 / 自检' },
  { id: 'platformio', label: 'Pio', hint: 'PlatformIO · pio run 构建 / 烧录 / 串口监视（从硬件目标面板进入）' },
  { id: 'git', label: 'Git', hint: 'Git · 变更 / 分支 / 提交历史' },
  { id: 'agents', label: '协作', hint: '多智能体协作 · 任务分解与并行执行看板' }
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
  /** 折叠时是否显示一条极简状态条（极简模式默认显示，替代常驻 6 个标签） */
  showMinibar?: boolean
  /** 状态条上的右侧状态文案，如「编译成功 3.2s」 */
  statusText?: string
}

/**
 * 底部统一面板组（UI 重设计核心）
 *
 * 改之前：输出 / 调试 / 硬件目标 / PlatformIO 四个面板各自独立、都可同时展开，
 *         纵向空间被瓜分，且用户不知道该点哪个。
 * 改之后：底部只有一个容器，一次只显示一个面板；标签式切换 + 可拖拽高度 + 可折叠。
 *         打开另一个面板就是切标签，不会出现「同时开四个、谁也看不清」。
 */
export default function PanelDock({
  active, onChange, height, onHeightChange, badges, render, showMinibar = true, statusText,
}: Props): React.JSX.Element | null {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 已经打开过的面板：保持挂载，只切显隐。
   *  否则每次切标签都会卸载重建 —— 终端滚动历史、波形缓冲、面板内滚动位置全丢。 */
  const [mounted, setMounted] = useState<PanelId[]>([])
  /** 记住最后打开过的面板：折叠后状态条点一下能原样展开回来 */
  const lastRef = useRef<PanelId | null>(null)
  if (active) lastRef.current = active
  const lastId = lastRef.current

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

  // 折叠态：极简模式下不常驻 6 个标签，只留一条细状态条（点一下原样展开）
  if (!active) {
    if (!showMinibar) return null
    const meta = PANEL_META.find((p) => p.id === lastId)
    return (
      <div className="dock-minibar" onClick={() => onChange(lastId || 'output')} title="展开面板">
        <span className="dock-minibar-chev">▴</span>
        <span className="dock-minibar-label">{meta ? meta.label : '输出'}</span>
        {statusText && <span className="dock-minibar-status">{statusText}</span>}
      </div>
    )
  }

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

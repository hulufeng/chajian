import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * FeatureHintLayer —— 全局「悬停即显示」功能介绍浮层
 * --------------------------------------------------------------------------
 * 设计取舍（为什么不是每个组件各写一个 title / 各包一层 Tooltip）：
 *   1. 事件委托到 document：任何元素只要挂上 hint 属性就能出卡片，
 *      组件里不用写 hover 状态、不用包一层容器 —— 不会动到现有布局（工具栏是
 *      flex 紧密排布，多包一个 wrapper 很容易把间距挤歪）。
 *   2. 延迟 420ms 才显示：鼠标扫过一排按钮时不会连闪一堆卡片，
 *      只有「停下来想看清楚这是什么」才弹 —— 这是悬停提示最容易做烦人的地方。
 *   3. 卡片 pointer-events: none：永不拦点击，不会出现「想点按钮却点到提示」。
 *   4. 挂 document.body 用 portal：避免被面板的 overflow 裁掉。
 *
 * 用法：App 根组件挂一次 <FeatureHintLayer enabled={hintsOn} />，
 *       需要介绍的按钮/图标上 {...hint('compile')} 即可。
 */

interface Card {
  /** 递增序号：同一元素重复悬停也要能触发定位重算 */
  seq: number
  title: string
  desc: string
  tip?: string
}

interface AnchorBox {
  left: number
  top: number
  bottom: number
  width: number
}

const CARD_WIDTH = 300
/** 悬停多久才显示：短了会连闪，长了像没反应 */
const SHOW_DELAY_MS = 420

export default function FeatureHintLayer({ enabled = true }: { enabled?: boolean }): React.JSX.Element | null {
  const [card, setCard] = useState<Card | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<AnchorBox | null>(null)
  const timerRef = useRef<number | null>(null)
  const anchorRef = useRef<Element | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    // 关掉开关：立刻收掉正在显示的卡片，也不再监听
    if (!enabled) {
      anchorRef.current = null
      setCard(null)
      return
    }

    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    const hide = (): void => {
      clearTimer()
      anchorRef.current = null
      boxRef.current = null
      setCard(null)
    }

    const onOver = (e: MouseEvent): void => {
      const t = e.target as Element | null
      // closest 找到最近的「带介绍的祖先」：按钮里的 <svg> 也能正确命中按钮本身
      const el = t?.closest?.('[data-hint-title]') ?? null
      if (!el) {
        if (anchorRef.current) hide()
        return
      }
      if (el === anchorRef.current) return // 同一个锚点内部移动，不重置计时
      clearTimer()
      anchorRef.current = el
      const r = el.getBoundingClientRect()
      boxRef.current = { left: r.left, top: r.top, bottom: r.bottom, width: r.width }
      seqRef.current += 1
      const seq = seqRef.current
      const title = el.getAttribute('data-hint-title') ?? ''
      const desc = el.getAttribute('data-hint-desc') ?? ''
      const tip = el.getAttribute('data-hint-tip') ?? ''
      if (!title || !desc) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setCard({ seq, title, desc, tip: tip || undefined })
      }, SHOW_DELAY_MS)
    }

    // 按下去就收：提示不该挡在点击之后
    const onDown = (): void => hide()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }
    // 滚动后锚点位置变了，与其跟着飘不如直接收掉（下一次悬停会重新定位）
    // 这里读 anchorRef 而不是读 card，免得监听器跟着卡片反复重新注册
    const onScroll = (): void => { if (anchorRef.current) hide() }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimer()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', hide)
    }
  }, [enabled])

  // 定位：先按锚点下方占位，mount 后量真实高度再纠偏（上方空间不够就翻到上面）
  useLayoutEffect(() => {
    const el = cardRef.current
    const box = boxRef.current
    if (!el || !box || !card) return
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 8
    const below = box.bottom + gap + h <= vh - gap
    const top = below ? box.bottom + gap : Math.max(gap, box.top - gap - h)
    const left = Math.min(Math.max(box.left + box.width / 2 - CARD_WIDTH / 2, gap), Math.max(gap, vw - CARD_WIDTH - gap))
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [card?.seq]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !card) return null

  return createPortal(
    <div
      ref={cardRef}
      className="fh-card"
      role="tooltip"
      style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
    >
      <div className="fh-title">{card.title}</div>
      <div className="fh-desc">{card.desc}</div>
      {card.tip ? <div className="fh-tip">{card.tip}</div> : null}
    </div>,
    document.body
  )
}

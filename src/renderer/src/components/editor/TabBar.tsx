import type { EditorTab } from './types'

interface Props {
  /** 所属组 id（拖拽跨组移动时需要） */
  groupId: string
  tabs: EditorTab[]
  activeId: string | null
  onSelect: (groupId: string, tabId: string) => void
  onClose: (tabId: string) => void
  onSave: (tabId: string) => void
}

/**
 * 编辑器标签栏（分屏感知，#25/#26）。
 * - onSelect 改为 (groupId, tabId)，由 EditorArea 下发；
 * - 每个 tab 可 HTML5 拖拽，dataTransfer 携带 tabId，供跨组移动落点识别；
 * - 关闭 / 保存按 tabId 触发（tab 全局唯一，父级自行定位所在组）。
 */
export default function TabBar({ groupId, tabs, activeId, onSelect, onClose, onSave }: Props) {
  const current = tabs.find((t) => t.id === activeId) ?? null

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`editor-tab${t.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(groupId, t.id)}
          title={t.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/tabid', t.id)
            e.dataTransfer.effectAllowed = 'move'
            e.stopPropagation()
          }}
        >
          {t.name}
          {t.dirty ? <span className="dirty-dot">●</span> : null}
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation()
              void onClose(t.id) // async 闸门（未保存确认）；显式丢弃避免未捕获 rejection
            }}
          >
            ×
          </span>
        </div>
      ))}
      <div className="tabbar-actions">
        {current?.dirty && (
          <button className="btn small" onClick={() => onSave(current.id)}>
            保存
          </button>
        )}
      </div>
    </div>
  )
}

import type { EditorTab } from './types'

interface Props {
  tabs: EditorTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onSave: (id: string) => void
}

/** 编辑器标签栏：切换 / 关闭 / 未保存指示 / 激活态保存按钮。 */
export default function TabBar({ tabs, activeId, onSelect, onClose, onSave }: Props) {
  const closeTab = (id: string): void => {
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) return
    onClose(id)
    // 父组件负责切换激活 tab；此处仅触发关闭
    void idx
    void next
  }

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`editor-tab${t.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(t.id)}
          title={t.id}
        >
          {t.name}
          {t.dirty ? <span className="dirty-dot">●</span> : null}
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.id)
            }}
          >
            ×
          </span>
        </div>
      ))}
      <div className="tabbar-actions">
        {tabs.find((t) => t.id === activeId)?.dirty && (
          <button className="btn small" onClick={() => onSave(activeId)}>
            保存
          </button>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, Fragment } from 'react'
import type { CSSProperties } from 'react'
import type { EditorTab } from './editor/types'
import type { EditorSettings } from './editor/editorSettings'
import type { Groups, EditorGroup } from './editor/editorGroups'
import type { BoardArch } from './editor/MonacoWrapper'
import TabBar from './editor/TabBar'
import MonacoWrapper from './editor/MonacoWrapper'
import ImagePreview from './editor/ImagePreview'

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
function isImagePath(p: string): boolean {
  const lower = p.toLowerCase()
  return IMG_EXT.some((e) => lower.endsWith(e))
}

interface Props {
  /** 分屏组：标签页的唯一真相源（单组时等价于旧 tabs） */
  groups: Groups
  /** 当前聚焦组（用于高亮标题栏） */
  activeGroupId: string
  onSelectTab: (groupId: string, tabId: string) => void
  /** 关闭 tab：按 tabId（tab 全局唯一，父级自行定位） */
  onCloseTab: (tabId: string) => void
  /** 在激活组右侧新增空组 */
  onSplit: () => void
  /** 关闭整个组（先过未保存闸门） */
  onCloseGroup: (groupId: string) => void
  /** 跨组移动 tab：把 tabId 移入 toGroupId（#26 拖拽落点） */
  onMoveTab?: (tabId: string, toGroupId: string) => void
  onChange: (id: string, content: string) => void
  onSave: (id: string) => void
  theme: 'light' | 'dark'
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自设置面板，实时下发 */
  settings: EditorSettings
  /** 板卡架构：影响内置硬件片段与悬停文档的取向（由 fqbn 推导） */
  arch?: BoardArch
}

/**
 * 编辑器区域编排器（#25 分屏多视图）：
 * - groups 驱动多个并排窗格，单组时等价于旧版单标签栏布局；
 * - 自研拖拽分隔条（不引三方 split 库），按 flexGrow 实时调宽；
 * - 组标题栏含「向右分屏 / 关闭此组」按钮；
 * - 支持 tab 跨组拖放（落在某组窗格即移入该组，配合 App 的 onMoveTab）。
 * 子组件拆分到 ./editor/ 便于单测（Phase 1 #21 解耦）。
 * 保留 `EditorTab` 导出，App.tsx / AiPanel.tsx 的导入路径不变。
 */
export type { EditorTab } from './editor/types'

/** 只读（大文件 / 二进制）提示块 */
function ReadOnlyNotice({ notice }: { notice: string }): React.JSX.Element {
  return (
    <div className="editor-readonly">
      <div className="editor-readonly-card">
        <div className="editor-readonly-title">只读文件</div>
        <pre className="editor-readonly-body">{notice}</pre>
      </div>
    </div>
  )
}

/** 单组激活宿主：图片 / 只读 / Monaco */
function HostView({
  tab,
  theme,
  settings,
  arch,
  onChange,
}: {
  tab: EditorTab
  theme: 'light' | 'dark'
  settings: EditorSettings
  arch: BoardArch
  onChange: (id: string, content: string) => void
}): React.JSX.Element {
  if (isImagePath(tab.id)) return <ImagePreview id={tab.id} name={tab.name} />
  if (tab.notice) return <ReadOnlyNotice notice={tab.notice} />
  return (
    <MonacoWrapper
      path={tab.id}
      language={tab.language}
      value={tab.content}
      theme={theme}
      settings={settings}
      arch={arch}
      onChange={(v) => onChange(tab.id, v ?? '')}
    />
  )
}

interface PaneProps {
  index: number
  group: EditorGroup
  isActive: boolean
  isFirst: boolean
  onSelectTab: (groupId: string, tabId: string) => void
  onCloseTab: (tabId: string) => void
  onSave: (tabId: string) => void
  onSplit: () => void
  onCloseGroup: (groupId: string) => void
  showCloseGroup: boolean
  onChange: (id: string, content: string) => void
  onMoveTab?: (tabId: string, toGroupId: string) => void
  theme: 'light' | 'dark'
  settings: EditorSettings
  arch?: BoardArch
  style?: CSSProperties
}

/** 单个分屏组：标题栏 + 标签栏 + 编辑宿主 */
function GroupPane({
  index,
  group,
  isActive,
  isFirst,
  onSelectTab,
  onCloseTab,
  onSave,
  onSplit,
  onCloseGroup,
  showCloseGroup,
  onChange,
  onMoveTab,
  theme,
  settings,
  arch = 'any',
  style,
}: PaneProps): React.JSX.Element {
  const active = group.tabs.find((t) => t.id === group.activeId) ?? group.tabs[0] ?? null

  return (
    <div
      className={`editor-pane${isActive ? ' active' : ''}`}
      style={style}
      onDragOver={(e) => {
        if (!onMoveTab) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        if (!onMoveTab) return
        e.preventDefault()
        const id = e.dataTransfer.getData('text/tabid')
        if (id) onMoveTab(id, group.id)
      }}
    >
      <div className="editor-pane-header">
        <span className="editor-pane-title">组 {index + 1}</span>
        <div className="editor-pane-actions">
          <button className="btn icon" title="向右分屏" onClick={onSplit}>
            ⊞
          </button>
          {showCloseGroup && (
            <button className="btn icon" title="关闭此组" onClick={() => void onCloseGroup(group.id)}>
              ×
            </button>
          )}
        </div>
      </div>
      <TabBar
        groupId={group.id}
        tabs={group.tabs}
        activeId={group.activeId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onSave={onSave}
      />
      <div className="editor-host">
        {active ? (
          <HostView tab={active} theme={theme} settings={settings} arch={arch} onChange={onChange} />
        ) : isFirst ? (
          <div className="editor-empty">
            <div className="editor-empty-inner">
              <div className="editor-empty-slogan">让每一个想法，成为伟大的产品</div>
              <div className="editor-empty-hint">从左侧项目树打开文件，或开始新建代码</div>
            </div>
          </div>
        ) : (
          <div className="editor-pane-empty">分屏组为空，打开文件即可并排对照</div>
        )}
      </div>
    </div>
  )
}

const MIN_GROW = 0.12

export default function EditorArea(props: Props): React.JSX.Element {
  const {
    groups,
    activeGroupId,
    onSelectTab,
    onCloseTab,
    onSplit,
    onCloseGroup,
    onMoveTab,
    onChange,
    onSave,
    theme,
    settings,
    arch = 'any',
  } = props

  const containerRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<number[]>(() => groups.map(() => 1))
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  // 组数变化时同步 sizes：保留已有比例，新增组默认 1
  useEffect(() => {
    setSizes((prev) => {
      if (prev.length === groups.length) return prev
      return groups.map((_, i) => prev[i] ?? 1)
    })
  }, [groups.length])

  const dragRef = useRef<{ index: number; startX: number; startSizes: number[] } | null>(null)

  // 自研分隔条拖拽：按 flexGrow 比例实时调宽（不引三方 split 库）
  const onDividerDown = (index: number) => (e: React.MouseEvent): void => {
    e.preventDefault()
    dragRef.current = { index, startX: e.clientX, startSizes: sizesRef.current.slice() }
    const move = (ev: MouseEvent): void => {
      const drag = dragRef.current
      const rect = containerRef.current?.getBoundingClientRect()
      if (!drag || !rect || rect.width === 0) return
      const totalGrow = drag.startSizes.reduce((a, b) => a + b, 0)
      const dGrow = ((ev.clientX - drag.startX) * totalGrow) / rect.width
      let left = drag.startSizes[drag.index] + dGrow
      let right = drag.startSizes[drag.index + 1] - dGrow
      if (left < MIN_GROW) {
        right -= MIN_GROW - left
        left = MIN_GROW
      }
      if (right < MIN_GROW) {
        left -= MIN_GROW - right
        right = MIN_GROW
      }
      setSizes((prev) => {
        const next = prev.slice()
        next[drag.index] = left
        next[drag.index + 1] = right
        return next
      })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragRef.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <section className="editor-area">
      <div className="editor-split" ref={containerRef}>
        {groups.map((g, i) => (
          <Fragment key={g.id}>
            <GroupPane
              index={i}
              group={g}
              isActive={g.id === activeGroupId}
              isFirst={i === 0}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              onSave={onSave}
              onSplit={onSplit}
              onCloseGroup={onCloseGroup}
              showCloseGroup={groups.length > 1}
              onChange={onChange}
              onMoveTab={onMoveTab}
              theme={theme}
              settings={settings}
              arch={arch}
              style={{ flexGrow: sizes[i] ?? 1 }}
            />
            {i < groups.length - 1 && (
              <div
                key={`divider-${g.id}`}
                className="split-divider"
                onMouseDown={onDividerDown(i)}
                title="拖拽调整分屏宽度"
                role="separator"
                aria-orientation="vertical"
              />
            )}
          </Fragment>
        ))}
      </div>
    </section>
  )
}

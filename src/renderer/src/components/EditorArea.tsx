import { useState } from 'react'
import type { EditorTab } from './editor/types'
import type { EditorSettings } from './editor/editorSettings'
import TabBar from './editor/TabBar'
import MonacoWrapper from './editor/MonacoWrapper'
import ImagePreview from './editor/ImagePreview'

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
function isImagePath(p: string): boolean {
  const lower = p.toLowerCase()
  return IMG_EXT.some((e) => lower.endsWith(e))
}

interface Props {
  tabs: EditorTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onChange: (id: string, content: string) => void
  onSave: (id: string) => void
  theme: 'light' | 'dark'
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自设置面板，实时下发 */
  settings: EditorSettings
}

/**
 * 编辑器区域编排器：标签栏 + 编辑宿主（Monaco 或图片预览）。
 * 子组件拆分到 ./editor/ 便于单测（Phase 1 #21 解耦）。
 * 保留 `EditorTab` 导出，App.tsx / AiPanel.tsx 的导入路径不变。
 */
export type { EditorTab } from './editor/types'

export default function EditorArea({
  tabs,
  activeId,
  onSelect,
  onClose,
  onChange,
  onSave,
  theme,
  settings,
}: Props): React.JSX.Element {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const activeIsImage = !!active && isImagePath(active.id)

  return (
    <section className="editor-area">
      <TabBar tabs={tabs} activeId={activeId} onSelect={onSelect} onClose={onClose} onSave={onSave} />
      <div className="editor-host">
        {activeIsImage ? (
          <ImagePreview id={active!.id} name={active!.name} />
        ) : active?.notice ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              overflow: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--bg)',
              padding: 24,
            }}
          >
            <div
              style={{
                maxWidth: 520,
                border: '1px solid var(--border)',
                borderRadius: 'var(--border-radius-md)',
                background: 'var(--warning-soft)',
                padding: '20px 24px',
                color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--warning)' }}>只读文件</div>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  fontFamily: 'inherit',
                  color: 'var(--text-dim)',
                  lineHeight: 1.6,
                }}
              >
                {active.notice}
              </pre>
            </div>
          </div>
        ) : active ? (
          <MonacoWrapper
            path={active.id}
            language={active.language}
            value={active.content}
            theme={theme}
            settings={settings}
            onChange={(v) => onChange(active.id, v ?? '')}
          />
        ) : (
          <div className="editor-empty">
            <div className="editor-empty-inner">
              <div className="editor-empty-slogan">让每一个想法，成为伟大的产品</div>
              <div className="editor-empty-hint">从左侧项目树打开文件，或开始新建代码</div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

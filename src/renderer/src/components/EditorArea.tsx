import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
function isImagePath(p: string): boolean {
  const lower = p.toLowerCase()
  return IMG_EXT.some((e) => lower.endsWith(e))
}

function MonacoEditor({
  path, language, initialValue, theme, onChange,
}: {
  path: string
  language: string
  initialValue: string
  theme: string
  onChange: (v: string) => void
}) {
  const editorRef = useRef<any>(null)
  const mounted = useRef(false)

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    mounted.current = true
    // 同步内容到 model
    const model = editor.getModel()
    if (model && model.getValue() !== initialValue) {
      model.setValue(initialValue)
    }
  }

  // 本地文件是「先建空 tab、再异步 fs.read 回填内容」：initialValue 仅在挂载时生效，
  // 异步回填后需再同步一次，否则打开本地文件编辑器一直空白（不显示）。
  // 用户正常输入时 model 已等于 initialValue，下面不会触发 setValue，无光标跳动。
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel?.()
    if (editor && model && model.getValue() !== initialValue) {
      model.setValue(initialValue)
    }
  }, [initialValue])

  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      theme={theme}
      onMount={handleMount}
      onChange={(v) => { if (mounted.current) onChange(v ?? '') }}
      options={{
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
        minimap: { enabled: true, scale: 1 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12, bottom: 12 },
        tabSize: 2,
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        folding: true,
        bracketPairColorization: { enabled: true },
        readOnly: false,
      }}
    />
  )
}

export interface EditorTab {
  id: string
  name: string
  language: string
  content: string
  dirty?: boolean
}
interface Props {
  tabs: EditorTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onChange: (id: string, content: string) => void
  onSave: (id: string) => void
  theme: 'light' | 'dark'
}

function EditorArea({ tabs, activeId, onSelect, onClose, onChange, onSave, theme }: Props): React.JSX.Element {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const [imgSrc, setImgSrc] = useState('')
  const [imgErr, setImgErr] = useState('')
  const activeIsImage = !!active && isImagePath(active.id)

  useEffect(() => {
    if (!active || !isImagePath(active.id)) {
      setImgSrc('')
      setImgErr('')
      return
    }
    let alive = true
    setImgErr('')
    window.api.fs
      .readImage(active.id)
      .then((u) => { if (alive) setImgSrc(u) })
      .catch((e) => { if (alive) { setImgSrc(''); setImgErr((e as Error).message) } })
    return () => { alive = false }
  }, [active?.id])

  const closeTab = (id: string): void => {
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) return
    onClose(id)
    // 若关闭的是当前激活 tab，父组件负责切换；此处仅触发关闭
    void idx
    void next
  }

  return (
    <section className="editor-area">
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
          {active?.dirty && (
            <button className="btn small" onClick={() => onSave(active.id)}>
              保存
            </button>
          )}
        </div>
      </div>
      <div className="editor-host">
        {activeIsImage ? (
          <div style={{ width: '100%', height: '100%', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ink-2)' }}>
            {imgErr ? (
              <div style={{ opacity: 0.7 }}>图片预览失败：{imgErr}</div>
            ) : imgSrc ? (
              <img src={imgSrc} alt={active!.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <div style={{ opacity: 0.6 }}>加载图片…</div>
            )}
          </div>
        ) : active ? (
          <MonacoEditor
            key={active.id}
            path={active.id}
            language={active.language}
            initialValue={active.content}
            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
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

export default EditorArea

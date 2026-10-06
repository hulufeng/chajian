import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { type EditorSettings } from './editorSettings'

interface Props {
  path: string
  language: string
  /** 当前应显示的内容（可能为异步回填后的最新值） */
  value: string
  theme: 'light' | 'dark'
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自设置面板，实时生效 */
  settings: EditorSettings
  onChange: (v: string) => void
}

/**
 * Monaco 编辑器外壳。
 * - 用 `path`(绝对路径) 作为 Monaco model URI：切换文件时 @monaco-editor/react
 *   按 URI 复用 model，从而保留每个文件的 undo/cursor（不再靠 key 重挂丢栈）。
 * - 本地文件是「先建空 tab、再异步 fs.read 回填」：挂载后内容才会从 '' 变真实值，
 *   故用 useEffect 在 value 变化时再同步一次。用户正常输入时 model 已等于 value，不触发。
 * - `suppress` ref：拦截「程序化 setValue」引发的 onChange，避免异步回填把文件误标 dirty。
 */
export default function MonacoWrapper({ path, language, value, theme, settings, onChange }: Props) {
  const editorRef = useRef<any>(null)
  const mounted = useRef(false)
  const suppress = useRef(false)

  const sync = (v: string): void => {
    const editor = editorRef.current
    const model = editor?.getModel?.()
    if (editor && model && model.getValue() !== v) {
      suppress.current = true
      model.setValue(v)
      suppress.current = false
    }
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    mounted.current = true
    sync(value)
  }

  // 设置变化时即时应用到已挂载的编辑器（避免依赖 <Editor> 内部对 options 的浅比较）
  useEffect(() => {
    const editor = editorRef.current
    if (editor) {
      editor.updateOptions({
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        tabSize: settings.tabSize,
        insertSpaces: settings.insertSpaces,
        detectIndentation: false,
        wordWrap: settings.wordWrap,
        minimap: { enabled: settings.minimap, scale: 1 },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  useEffect(() => {
    sync(value)
    // 仅 value 变化触发；path/theme/language 变化由 <Editor> 自身处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      onMount={handleMount}
      onChange={(v) => {
        if (suppress.current) return
        if (mounted.current) onChange(v ?? '')
      }}
      options={{
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        minimap: { enabled: settings.minimap, scale: 1 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12, bottom: 12 },
        tabSize: settings.tabSize,
        insertSpaces: settings.insertSpaces,
        detectIndentation: false,
        wordWrap: settings.wordWrap,
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

import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { type EditorSettings } from './editorSettings'
import { matchSnippets, toSuggestions } from './hardwareSnippets'
import { hoverFor, mergeHover } from './pinHover'

/** 板卡架构：决定给哪些硬件片段/文档（esp32 与 stm32 的 API 差别很大） */
export type BoardArch = 'esp32' | 'stm32' | 'any'

interface Props {
  path: string
  language: string
  /** 当前应显示的内容（可能为异步回填后的最新值） */
  value: string
  theme: 'light' | 'dark'
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自设置面板，实时生效 */
  settings: EditorSettings
  /** 是否启用语言服务（补全/悬停/跳转/诊断）。关掉即降级，不再发 IPC */
  enableLsp?: boolean
  /** 板卡架构：决定内置硬件片段与悬停文档的取向，默认 any */
  arch?: BoardArch
  onChange: (v: string) => void
}

/**
 * Monaco 编辑器外壳。
 * - 用 `path`(绝对路径) 作为 Monaco model URI：切换文件时 @monaco-editor/react
 *   按 URI 复用 model，从而保留每个文件的 undo/cursor（不再靠 key 重挂丢栈）。
 * - 本地文件是「先建空 tab、再异步 fs.read 回填」：挂载后内容才会从 '' 变真实值，
 *   故用 useEffect 在 value 变化时再同步一次。用户正常输入时 model 已等于 value，不触发。
 * - `suppress` ref：拦截「程序化 setValue」引发的 onChange，避免异步回填把文件误标 dirty。
 * - 语言服务（#29/#31）：注册补全/悬停/跳转 provider，并把 LSP 诊断画成 marker。
 *   clangd 没装时 IPC 返回 ok:false，全部静默降级，不影响正常编辑。
 */
export default function MonacoWrapper({ path, language, value, theme, settings, enableLsp = true, arch = 'any', onChange }: Props) {
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const mounted = useRef(false)
  const suppress = useRef(false)
  const registered = useRef(false)
  const diagTimer = useRef<number | null>(null)

  const sync = (v: string): void => {
    const editor = editorRef.current
    const model = editor?.getModel?.()
    if (editor && model && model.getValue() !== v) {
      suppress.current = true
      model.setValue(v)
      suppress.current = false
    }
  }

  /** LSP 诊断同步：用户输入时防抖触发，避免每敲一个字符就发一次 IPC */
  const scheduleDiagnostics = (file: string, text: string): void => {
    if (!enableLsp) return
    if (diagTimer.current !== null) window.clearTimeout(diagTimer.current)
    diagTimer.current = window.setTimeout(() => {
      diagTimer.current = null
      const monaco = monacoRef.current
      const model = editorRef.current?.getModel?.()
      if (!monaco || !model) return
      window.api.lsp
        .sync({ file, text })
        .then((r) => {
          // 服务不可用（clangd 没装）静默退出；可用则每次都重设标记，
          // 否则错误修好后波浪线不消失。
          if (!r.ok) return
          const markers = (r.data ?? []).map((d) => ({
            severity: d.severity,
            message: d.message,
            startLineNumber: d.startLine + 1, // LSP 0-based -> Monaco 1-based
            startColumn: d.startCharacter + 1,
            endLineNumber: d.endLine + 1,
            endColumn: d.endCharacter + 1,
            source: d.source
          }))
          monaco.editor.setModelMarkers(model, 'lsp', markers)
        })
        .catch(() => undefined)
    }, 800)
  }

  const registerProviders = (monaco: any): void => {
    // 只登记一次：本组件是无 key 的长实例，重复 register 会堆重复 provider。
    const langs = ['cpp', 'c']

    monaco.languages.registerCompletionItemProvider(langs, {
      triggerCharacters: ['.', '>', ':'],
      provideCompletionItems: async (model: any, position: any) => {
        if (!enableLsp) return { suggestions: [] }
        try {
          const file = model.uri?.fsPath || path
          const r = await window.api.lsp.completion({
            file,
            text: model.getValue(),
            line: position.lineNumber - 1, // Monaco 1-based -> LSP 0-based
            character: position.column - 1,
            triggerKind: 1
          })
          if (!r.ok || !r.data) return { suggestions: [] }
          const word = model.getWordUntilPosition(position)
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          }
          const lspItems = r.data.map((it, i) => ({
            label: it.label,
            kind: it.kind ?? 1,
            detail: it.detail,
            documentation: it.documentation,
            insertText: it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? 4 : 0, // 4 = InsertAsSnippet
            sortText: it.sortText ?? String(i).padStart(5, '0'),
            filterText: it.filterText ?? it.label,
            range
          }))
          // 内置硬件片段不依赖 clangd，永远给一份（#32）。放前面并加前缀排序权重，
          // 这样没装语言服务器时也能补出「连 WiFi / PWM / I2C 扫描」这类骨架。
          const hw = toSuggestions(matchSnippets(word.word, arch), range)
          const hwItems = hw.map((s, i) => ({ ...s, sortText: `0-${String(i).padStart(4, '0')}` }))
          return { suggestions: [...hwItems, ...lspItems] }
        } catch {
          // LSP 挂了也不该让补全彻底没有：只给内置片段
          const word = model.getWordUntilPosition(position)
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          }
          return { suggestions: toSuggestions(matchSnippets(word.word, arch), range) }
        }
      }
    })

    monaco.languages.registerHoverProvider(langs, {
      provideHover: async (model: any, position: any) => {
        try {
          const file = model.uri?.fsPath || path
          // 硬件知识（#33）不需要 IPC，先本地查出来（因此不能因为关了 LSP 就整体 return）
          const local = hoverFor(model.getWordAtPosition(position)?.word ?? '')
          const r = enableLsp
            ? await window.api.lsp.hover({
                file,
                text: model.getValue(),
                line: position.lineNumber - 1,
                character: position.column - 1
              })
            : null
          const text = mergeHover(r?.ok ? (r.data || null) : null, local)
          if (!text) return null
          return {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            },
            contents: [{ value: text }]
          }
        } catch {
          // LSP 异常时仍给本地硬件文档
          const local = hoverFor(model.getWordAtPosition(position)?.word ?? '')
          if (!local) return null
          return {
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            },
            contents: [{ value: mergeHover(null, local) ?? '' }]
          }
        }
      }
    })

    monaco.languages.registerDefinitionProvider(langs, {
      provideDefinition: async (model: any, position: any) => {
        if (!enableLsp) return null
        try {
          const file = model.uri?.fsPath || path
          const r = await window.api.lsp.definition({
            file,
            text: model.getValue(),
            line: position.lineNumber - 1,
            character: position.column - 1
          })
          if (!r.ok || !r.data || r.data.length === 0) return null
          // 只取第一个目标：Monaco 跳转用 Location 数组，这里保持够用即可
          const d = r.data[0]
          return [
            {
              uri: monaco.Uri.file(d.file),
              range: {
                startLineNumber: d.line + 1,
                startColumn: d.character + 1,
                endLineNumber: d.line + 1,
                endColumn: d.character + 1
              }
            }
          ]
        } catch {
          return null
        }
      }
    })
  }

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    mounted.current = true
    sync(value)
    if (!registered.current) {
      try {
        registerProviders(monaco)
      } catch {
        // provider 注册失败不影响编辑本身（语言服务不可用而已）
      }
      registered.current = true
    }
  }

  // 打开 / 切换新文件时拉一次诊断
  useEffect(() => {
    if (!enableLsp) return
    scheduleDiagnostics(path, value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(
    () => () => {
      if (diagTimer.current !== null) window.clearTimeout(diagTimer.current)
    },
    []
  )

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
        minimap: { enabled: settings.minimap, scale: 1 }
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
        if (mounted.current) scheduleDiagnostics(path, v ?? '')
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
        readOnly: false
      }}
    />
  )
}

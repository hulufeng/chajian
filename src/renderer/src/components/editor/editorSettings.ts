/**
 * 编辑器设置：单一数据源。
 * 所有可配置项都持久化到 localStorage，重启保留；App 持有 state 并实时下发给 MonacoWrapper。
 * 不依赖 React，方便后续抽单测（与 editorLogic / EditorTab 同目录）。
 */

export interface EditorSettings {
  /** 字号(px)，10–24 */
  fontSize: number
  /** Tab 宽度（列数），1–8 */
  tabSize: number
  /** true=空格缩进，false=Tab 字符缩进 */
  insertSpaces: boolean
  /** 自动换行 */
  wordWrap: 'on' | 'off'
  /** 是否显示 minimap */
  minimap: boolean
  /** 字体（CSS font-family 值） */
  fontFamily: string
}

export const EDITOR_FONT_FAMILIES: Array<{ value: string; label: string }> = [
  { value: "'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace", label: 'Cascadia Code（等宽）' },
  { value: "'JetBrains Mono', 'Fira Code', monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', monospace", label: 'Fira Code（连字）' },
  { value: "'Source Code Pro', 'Consolas', monospace", label: 'Source Code Pro' },
  { value: "'Consolas', 'Courier New', monospace", label: 'Consolas（系统）' },
]

const KEYS = {
  fontSize: 'codelab-fontsize',
  tabSize: 'codelab-tabsize',
  insertSpaces: 'codelab-insertspaces',
  wordWrap: 'codelab-wordwrap',
  minimap: 'codelab-minimap',
  fontFamily: 'codelab-fontfamily',
} as const

const clampNum = (raw: string | null, d: number, min: number, max: number): number => {
  const v = Number(raw)
  if (!Number.isFinite(v) || v <= 0) return d
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

const loadBool = (raw: string | null, d: boolean): boolean => {
  if (raw === null) return d
  return raw === '1' || raw === 'true'
}

const loadStr = (raw: string | null, d: string): string => (raw && raw.length > 0 ? raw : d)

export function loadEditorSettings(): EditorSettings {
  return {
    fontSize: clampNum(localStorage.getItem(KEYS.fontSize), 14, 10, 24),
    tabSize: clampNum(localStorage.getItem(KEYS.tabSize), 2, 1, 8),
    insertSpaces: loadBool(localStorage.getItem(KEYS.insertSpaces), true),
    wordWrap: loadStr(localStorage.getItem(KEYS.wordWrap), 'off') === 'on' ? 'on' : 'off',
    minimap: loadBool(localStorage.getItem(KEYS.minimap), true),
    fontFamily: loadStr(localStorage.getItem(KEYS.fontFamily), EDITOR_FONT_FAMILIES[0].value),
  }
}

/** 写回 localStorage，并同步 --editor-font-size（供其他等宽文本复用） */
export function saveEditorSettings(s: EditorSettings): void {
  localStorage.setItem(KEYS.fontSize, String(s.fontSize))
  localStorage.setItem(KEYS.tabSize, String(s.tabSize))
  localStorage.setItem(KEYS.insertSpaces, s.insertSpaces ? '1' : '0')
  localStorage.setItem(KEYS.wordWrap, s.wordWrap)
  localStorage.setItem(KEYS.minimap, s.minimap ? '1' : '0')
  localStorage.setItem(KEYS.fontFamily, s.fontFamily)
  document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`)
}

export interface EditorTab {
  id: string
  name: string
  language: string
  content: string
  dirty?: boolean
  /** 外部文件 mtime（毫秒），用于重开已打开 tab 时判断外部是否改动 */
  mtimeMs?: number
  /** 只读保护：大文件 / 二进制，不进 Monaco，显示 notice */
  readOnly?: boolean
  /** 只读提示文案（readOnly 为 true 时展示） */
  notice?: string
}

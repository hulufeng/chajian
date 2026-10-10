import type { CSSProperties } from 'react'

/**
 * 模态框（弹窗）共用样式 —— 颜色与尺度一律走 theme.css 令牌。
 *
 * 为什么要抽出来：PartitionEditor 与 KconfigEditor 各抄了一份
 * overlay / panel / headerBar / footerBar / btnStyle / input，且颜色全部写死成
 * 深色专用的字面值 —— 违反「theme.css 是唯一颜色源」，
 * 换主题（浅/深）时这两个弹窗不会跟着变。抽到这里后：
 *   - 颜色只在 theme.css 里改一次；
 *   - 两个编辑器的观感天然一致；
 *   - 以后再加模态框直接复用，不用再抄一遍。
 *
 * 约定：本文件不出现任何 hex / rgb 字面量。
 */

/** 遮罩层（用 --overlay 令牌，深浅主题遮罩浓度不同） */
export const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
}

/** 弹窗主体；宽度的默认值由各调用方给，这里只定「容器长相」 */
export const modalPanel: CSSProperties = {
  background: 'var(--surface-1)',
  color: 'var(--text)',
  maxHeight: '88vh',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-3)',
  overflow: 'hidden'
}

/** 顶部标题栏 */
export const headerBar: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)'
}

/** 底部操作栏（按钮右对齐） */
export const footerBar: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '10px 14px',
  borderTop: '1px solid var(--border)'
}

/** 次级按钮；主按钮在调用方用 `{ ...btnPrimary }` 覆盖 */
export const btnStyle: CSSProperties = {
  background: 'var(--surface-3)',
  color: 'var(--text)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-2xs)',
  padding: '4px 10px',
  cursor: 'pointer'
}

/** 主操作按钮（保存 / 确认） */
export const btnPrimary: CSSProperties = {
  ...btnStyle,
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: 'var(--on-accent)'
}

/** 输入框 / 下拉 */
export const input: CSSProperties = {
  background: 'var(--surface-0)',
  color: 'var(--text)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-2xs)',
  padding: '4px 6px',
  fontSize: 12
}

/** 表头 / 单元格 */
export const th: CSSProperties = { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)' }
export const td: CSSProperties = { padding: '3px 6px', borderBottom: '1px solid var(--border-weak)' }

/** 内嵌代码块（帮助文本、预览） */
export const codeBlock: CSSProperties = {
  whiteSpace: 'pre-wrap',
  background: 'var(--surface-0)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2xs)',
  padding: 8,
  fontSize: 12,
  margin: 0
}

/** 分类色循环（分区表图例等数据可视化，不用于 UI 控件） */
export const CAT_TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8']

export function catColor(i: number): string {
  return `var(${CAT_TOKENS[i % CAT_TOKENS.length]})`
}

/** 语义色：错误 / 警告 / 正常，统一走状态令牌 */
export function toneColor(level: 'ok' | 'warn' | 'err'): string {
  return level === 'err' ? 'var(--error)' : level === 'warn' ? 'var(--warning)' : 'var(--success)'
}

/** 语义底色（淡），用于整行/整块的状态提示 */
export function toneSoft(level: 'ok' | 'warn' | 'err'): string {
  return level === 'err' ? 'var(--error-soft)' : level === 'warn' ? 'var(--warning-soft)' : 'var(--success-soft)'
}

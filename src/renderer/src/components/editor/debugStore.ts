/**
 * 渲染层调试视图状态 store（极简，零依赖）。
 *
 * 解决「调试会话在 DebugPanel、断点要画在编辑器」的解耦问题：
 * DebugPanel 拥有 openocd 会话，写入本 store；MonacoWrapper 订阅本 store 画
 * 断点圆点/当前执行行。两者互不持有对方，避免把断点状态从 App 一路 prop-drilling。
 *
 * 纯前端状态 + 一个「下发到 openocd」的副作用；断点增删的纯逻辑在
 * debugBreakpoints.ts（可单测），地址翻译在主进程 debug-symbols-service。
 */
import { toggleBreakpoint as toggleBp, hasBreakpoint, breakpointsForFile, type SourceBreakpoint } from './debugBreakpoints'

export interface DebugViewState {
  /** 全部源码断点（跨文件） */
  breakpoints: SourceBreakpoint[]
  /** 当前暂停所在的源码文件（DWARF 里的文件名，可能是相对的，如 main.cpp） */
  currentFile: string
  /** 当前暂停所在行（1-based），无则 null */
  currentLine: number | null
  /** 调试会话是否活跃：决定编辑器是否显示字形槽(gutter) */
  active: boolean
}

let state: DebugViewState = { breakpoints: [], currentFile: '', currentLine: null, active: false }
const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}

export function subscribeDebugView(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
export function getDebugView(): DebugViewState {
  return state
}

// ── 供 DebugPanel / App 调用的写入动作 ──────────────────────────────
export function setDebugActive(active: boolean): void {
  if (state.active === active) return
  state = { ...state, active }
  emit()
}

/** 调试暂停后更新「当前文件+行」。file 传 '' 或 line 非法即清除高亮。 */
export function setCurrentSource(file: string, line: number | null): void {
  const f = file || ''
  const l = line && line > 0 ? line : null
  if (state.currentFile === f && state.currentLine === l) return
  state = { ...state, currentFile: f, currentLine: l }
  emit()
}

/** 重新编译/换固件后地址全失效 → 断点与高亮一并清空 */
export function resetDebugView(): void {
  state = { breakpoints: [], currentFile: '', currentLine: null, active: state.active }
  emit()
}

/** 同步一份来自主进程的断点集合（可选，供将来从 openocd 回读 rbp 列表对账） */
export function setBreakpoints(list: SourceBreakpoint[]): void {
  state = { ...state, breakpoints: [...list] }
  emit()
}

// ── 供编辑器字形槽点击调用：切断点 + 下发 openocd ──────────────────
/**
 * 在 file 的某行切换断点：先本地更新（乐观），再异步下发到 openocd。
 * 下发失败不回滚本地状态——调试器侧的真实断点以 openocd 为准，可后续对账。
 */
export async function toggleBreakpointAt(file: string, line: number): Promise<void> {
  if (!file || line <= 0) return
  const had = hasBreakpoint(state.breakpoints, file, line)
  state = { ...state, breakpoints: toggleBp(state.breakpoints, file, line) }
  emit()
  try {
    const api = (window as any).api?.debug
    await api?.toggleBreakpoint?.(file, line, !had)
  } catch {
    // 下发失败：保留本地标记，交由下一次对账/清空处理，不打断 UI
  }
}

/** 编辑器侧取某文件的断点行号（升序） */
export function linesForFile(file: string): number[] {
  return breakpointsForFile(state.breakpoints, file)
}

/** 编辑器 path（常为绝对路径）与 DWARF 文件名（常为相对，如 main.cpp）是否同一文件：
 *  后缀匹配，容忍 ./ 与 ../ 前缀差异。 */
export function sameSourceFile(editorPath: string, dwarfName: string): boolean {
  const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/^\.\//, '')
  const a = norm(editorPath)
  const b = norm(dwarfName)
  if (!a || !b) return false
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}
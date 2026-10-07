/**
 * 源码级断点的状态模型（纯函数，渲染层用，可测）。
 *
 * 只管「哪些文件的哪些行有断点」这一件事，不碰 Monaco、不碰 IPC。
 * Monaco 装饰、openocd 下发都交给上层，避免逻辑散进组件里。
 */

export interface SourceBreakpoint {
  file: string
  line: number
}

/** 路径归一：统一斜杠、去 ./ 前缀，用于跨平台匹配同一文件 */
export function normalizePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/** 断点唯一键：归一化路径 + 行号 */
export function bpKey(file: string, line: number): string {
  return `${normalizePath(file)}:${line}`
}

/** 某文件某行是否已有断点 */
export function hasBreakpoint(list: SourceBreakpoint[], file: string, line: number): boolean {
  const k = bpKey(file, line)
  return list.some((b) => bpKey(b.file, b.line) === k)
}

/**
 * 切换断点：已存在则移除，不存在则追加。返回新数组（不可变更新）。
 * 行号 ≤ 0 视为非法输入，直接忽略（Monaco 行号从 1 开始）。
 */
export function toggleBreakpoint(list: SourceBreakpoint[], file: string, line: number): SourceBreakpoint[] {
  if (!file || line <= 0) return list
  const k = bpKey(file, line)
  if (list.some((b) => bpKey(b.file, b.line) === k)) {
    return list.filter((b) => bpKey(b.file, b.line) !== k)
  }
  return [...list, { file: normalizePath(file), line }]
}

/** 取某文件所有断点行号（去重 + 升序），供 Monaco 装饰用 */
export function breakpointsForFile(list: SourceBreakpoint[], file: string): number[] {
  const target = normalizePath(file)
  const lines = new Set<number>()
  for (const b of list) {
    if (normalizePath(b.file) === target) lines.add(b.line)
  }
  return [...lines].sort((a, b) => a - b)
}

/** 移除某文件全部断点（切换固件/重新编译后旧地址失效时清空用） */
export function removeBreakpointsForFile(list: SourceBreakpoint[], file: string): SourceBreakpoint[] {
  const target = normalizePath(file)
  return list.filter((b) => normalizePath(b.file) !== target)
}

/** 某文件断点总数（状态栏展示用） */
export function countForFile(list: SourceBreakpoint[], file: string): number {
  return breakpointsForFile(list, file).length
}
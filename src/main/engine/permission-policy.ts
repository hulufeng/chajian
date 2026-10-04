// 三级安全模式策略
import type { SecurityMode, ToolCategory, ToolDefinition } from './types'

export class PermissionPolicy {
  private mode: SecurityMode = 'default'

  // 内部状态/轻量元操作/无副作用验证工具：即使 write/execute 也免确认（对齐 TrieCode：compile 属验证动作不弹窗，
  // todo/ask_user 属内部协议工具；烧录 upload 保留确认——真写硬件需用户点头）
  private static NO_CONFIRM_TOOLS = new Set(['todo_write', 'todo_done', 'ask_user', 'compile', 'serial_monitor', 'serial_send', 'serial_stop', 'serial_log_tail', 'serial_log_grep', 'analyze_crash'])

  setMode(mode: SecurityMode): void {
    this.mode = mode
  }

  getMode(): SecurityMode {
    return this.mode
  }

  // 判断工具是否需要用户确认
  needsConfirm(tool: ToolDefinition): boolean {
    if (PermissionPolicy.NO_CONFIRM_TOOLS.has(tool.name)) return false
    switch (this.mode) {
      case 'auto':
        // 自动模式：所有工具直接执行，无需确认
        return false
      case 'default':
        // 默认模式：只读工具自动执行，写入/执行工具需确认
        return tool.category === 'write' || tool.category === 'execute'
      case 'plan':
        // 计划模式：所有工具都需要确认（先探索后执行）
        return true
      default:
        return true
    }
  }

  // 计划模式下是否允许只读工具自动执行
  canAutoRunInPlanMode(tool: ToolDefinition): boolean {
    return tool.category === 'read' || tool.category === 'query'
  }

  // 获取工具类别的中文描述
  static categoryLabel(cat: ToolCategory): string {
    switch (cat) {
      case 'read': return '读取'
      case 'write': return '写入'
      case 'execute': return '执行'
      case 'query': return '查询'
    }
  }

  // 获取安全模式中文描述
  static modeLabel(mode: SecurityMode): string {
    switch (mode) {
      case 'auto': return '自动（除风险命令外直接执行）'
      case 'default': return '默认（增删改执行需确认）'
      case 'plan': return '计划（先计划后执行）'
    }
  }
}

export const permissionPolicy = new PermissionPolicy()

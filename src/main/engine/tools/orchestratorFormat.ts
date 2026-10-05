// 编排报告的人读格式化（Agent 与 UI 共用同一份渲染逻辑，避免两处口径不一致）
import type { OrchestrationReport, AgentTaskRun } from '../orchestrator'

const STATUS_ICON: Record<AgentTaskRun['status'], string> = {
  pending: '·',
  'awaiting-approval': '⏸',
  running: '⟳',
  done: '✓',
  failed: '✗',
  skipped: '→',
  blocked: '⊘'
}

const STATUS_TEXT: Record<AgentTaskRun['status'], string> = {
  pending: '待执行',
  'awaiting-approval': '待放行',
  running: '执行中',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
  blocked: '阻塞'
}

function oneLine(s: string, n = 160): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

export function formatReport(r: OrchestrationReport): string {
  const lines: string[] = []
  lines.push(r.summary)

  if (r.conflicts.length) {
    lines.push('')
    lines.push('写冲突处理（已强制串行，避免互相覆盖）：')
    for (const c of r.conflicts) {
      lines.push(`  ${c.a} ↔ ${c.b}：${c.files.join(', ')}`)
    }
  }

  const order: AgentTaskRun['status'][] = ['failed', 'blocked', 'awaiting-approval', 'running', 'done', 'skipped', 'pending']
  const sorted = [...r.tasks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))

  lines.push('')
  for (const t of sorted) {
    const time = t.elapsedMs !== undefined ? ` · ${(t.elapsedMs / 1000).toFixed(1)}s` : ''
    const scope = t.spec.writeScope?.length ? ` · 写:${t.spec.writeScope.join(',')}` : ' · 只读'
    lines.push(`${STATUS_ICON[t.status]} [${t.status}] ${t.spec.title}(${t.spec.id} / ${t.spec.role})${scope}${time}`)
    if (t.skipReason) lines.push(`    跳过原因：${t.skipReason}`)
    if (t.error) lines.push(`    错误：${oneLine(t.error)}`)
    if (t.blockedTools?.length) lines.push(`    越权被拒工具：${t.blockedTools.join(', ')}`)
    if (t.summary) lines.push(`    结论：${oneLine(t.summary, 400)}`)
  }
  return lines.join('\n')
}

export { STATUS_ICON, STATUS_TEXT }

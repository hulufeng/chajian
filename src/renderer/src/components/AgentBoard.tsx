import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTaskRun, OrchestrationReport, TaskSpecLite } from '../../../preload'

interface Props {
  projectRoot?: string | null
  onClose: () => void
}

type Draft = TaskSpecLite

const STATUS_META: Record<string, { icon: string; label: string; color: string }> = {
  pending: { icon: '·', label: '待执行', color: 'var(--text-dim)' },
  'awaiting-approval': { icon: '⏸', label: '待放行', color: 'var(--warning)' },
  running: { icon: '⟳', label: '执行中', color: 'var(--accent)' },
  done: { icon: '✓', label: '完成', color: 'var(--accent-2)' },
  failed: { icon: '✗', label: '失败', color: 'var(--danger)' },
  skipped: { icon: '→', label: '已跳过', color: 'var(--text-dim)' },
  blocked: { icon: '⊘', label: '阻塞', color: 'var(--danger)' }
}

const ROLE_LABEL: Record<string, string> = {
  research: '调研',
  code: '编码',
  review: '评审',
  verify: '验证',
  custom: '自定义'
}

const SAMPLE: Draft[] = [
  { id: 't1', title: '摸清现状', role: 'research', task: '读代码搞清楚当前实现与问题点，给出 文件:行号 依据' },
  {
    id: 't2',
    title: '实现修改',
    role: 'code',
    task: '按 t1 的结论实现修改，只改下面列出的文件',
    writeScope: ['src/main/services/example.ts'],
    dependsOn: ['t1']
  },
  { id: 't3', title: '验证', role: 'verify', task: '编译并验证改动', dependsOn: ['t2'] }
]

/**
 * 多智能体协作看板。
 * 重点：把「谁在干什么、能并行什么、哪里冲突、要不要你放行」四件事摆在同一屏，
 * 而不是让用户去猜多个 agent 背后发生了什么。
 */
export default function AgentBoard({ projectRoot, onClose }: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Draft[]>(SAMPLE)
  const [runs, setRuns] = useState<AgentTaskRun[]>([])
  const [report, setReport] = useState<OrchestrationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState<{ layers: string[][]; conflicts: Array<{ a: string; b: string; files: string[] }> } | null>(null)
  const [approved, setApproved] = useState<string[]>([])
  const startedRef = useRef(false)

  useEffect(
    () =>
      window.api.orchestra.onEvent((list) => {
        setRuns(list)
      }),
    []
  )

  // 面板打开时先做一次静态规划：让用户先看到并行/冲突，再决定要不要跑
  useEffect(() => {
    let alive = true
    window.api.orchestra
      .plan({ tasks: drafts, projectRoot })
      .then((p) => {
        if (alive) setPlan({ layers: p.layers, conflicts: p.conflicts })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [drafts, projectRoot])

  const run = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    setReport(null)
    setRuns([])
    startedRef.current = true
    try {
      const r = await window.api.orchestra.run({
        tasks: drafts,
        projectRoot,
        concurrency: 3,
        approvedIds: approved
      })
      setReport(r)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stats = useMemo(() => {
    const s: Record<string, number> = {}
    for (const r of runs) s[r.status] = (s[r.status] || 0) + 1
    return s
  }, [runs])

  const shown = runs.length ? runs : drafts.map((d) => ({ spec: d, status: 'pending', agentId: '', toolCalls: [], blockedTools: [] }) as AgentTaskRun)

  return (
    <div className="ab">
      <div className="ab-head">
        <span className="ab-title">多智能体协作</span>
        <span className="ab-sub">
          {runs.length ? `${runs.length} 个任务` : '编排预览'} ·{' '}
          {Object.entries(stats)
            .map(([k, v]) => `${STATUS_META[k]?.label || k} ${v}`)
            .join(' · ') || '尚未运行'}
        </span>
        <span className="tgt-spacer" />
        <button className="btn primary" disabled={busy || drafts.length === 0} onClick={() => void run()}>
          {busy ? '执行中…' : '开始并行执行'}
        </button>
        <button className="btn" onClick={onClose}>✕</button>
      </div>

      {err && <div className="debug-err">{err}</div>}

      {plan && plan.conflicts.length > 0 && (
        <div className="ab-warn">
          检测到 {plan.conflicts.length} 对写范围相交，编排器会强制串行：
          {plan.conflicts.map((c) => ` ${c.a}↔${c.b}[${c.files.join(',')}]`).join('；')}
        </div>
      )}
      {plan && plan.layers.length > 0 && (
        <div className="ab-layers">
          执行分层：
          {plan.layers.map((l, i) => (
            <span key={i} className="ab-layer">
              第{i + 1}层 {l.join(' + ')}
            </span>
          ))}
        </div>
      )}

      <div className="ab-body">
        {shown.map((r) => {
          const meta = STATUS_META[r.status] || STATUS_META.pending
          return (
            <div key={r.spec.id} className="ab-card">
              <div className="ab-card-head">
                <span className="ab-icon" style={{ color: meta.color }}>{meta.icon}</span>
                <span className="ab-card-title">{r.spec.title}</span>
                <span className="ab-role">{ROLE_LABEL[r.spec.role] || r.spec.role}</span>
                <span className="ab-id mono">{r.spec.id}</span>
                <span className="ab-status" style={{ color: meta.color }}>{meta.label}</span>
                {r.elapsedMs !== undefined && <span className="ab-time mono">{(r.elapsedMs / 1000).toFixed(1)}s</span>}
                {r.status === 'awaiting-approval' && (
                  <button
                    className="btn"
                    onClick={() => {
                      setApproved((prev) => [...new Set([...prev, r.spec.id])])
                      setTimeout(() => void run(), 0)
                    }}
                  >
                    放行并执行
                  </button>
                )}
              </div>
              <div className="ab-task">{r.spec.task}</div>
              <div className="ab-tags">
                {r.spec.writeScope?.length ? (
                  <span className="ab-tag write">可写：{r.spec.writeScope.join('、')}</span>
                ) : (
                  <span className="ab-tag">只读</span>
                )}
                {r.spec.dependsOn?.length ? <span className="ab-tag">依赖：{r.spec.dependsOn.join('、')}</span> : null}
                {r.spec.requireApproval ? <span className="ab-tag gate">需人工放行</span> : null}
                {r.toolCalls?.length ? <span className="ab-tag">工具 {r.toolCalls.length} 次</span> : null}
                {r.blockedTools?.length ? <span className="ab-tag bad">越权拒绝 {r.blockedTools.length}</span> : null}
              </div>
              {r.skipReason && <div className="ab-note">跳过原因：{r.skipReason}</div>}
              {r.error && <div className="ab-note bad">{r.error}</div>}
              {r.summary && <div className="ab-summary">{r.summary.slice(0, 400)}</div>}
            </div>
          )
        })}
      </div>

      {report && (
        <div className="ab-report">
          <div className="ab-report-head">汇总</div>
          <pre className="ab-report-body">{report.summary}</pre>
        </div>
      )}

      {!runs.length && (
        <details className="ab-edit">
          <summary>编辑任务（JSON）</summary>
          <textarea
            className="ab-json"
            value={JSON.stringify(drafts, null, 2)}
            onChange={(e) => {
              try {
                const v = JSON.parse(e.target.value)
                if (Array.isArray(v)) setDrafts(v as Draft[])
              } catch {
                /* 输入过程中非法 JSON 不重置，等用户改完 */
              }
            }}
            spellCheck={false}
          />
        </details>
      )}
    </div>
  )
}

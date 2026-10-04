import { useCallback, useEffect, useState } from 'react'
import type { GitStatus, GitFileChange } from '../../../preload'

interface Props {
  root: string | null
}

const STATUS_COLOR: Record<string, string> = {
  modified: '#d97706',
  added: '#16a34a',
  deleted: '#dc2626',
  renamed: '#2563eb',
  untracked: '#16a34a',
  copied: '#2563eb'
}

const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  copied: 'C'
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 把 unified diff 拆成 文件头 + hunks，供按块暂存 */
function splitHunks(diff: string): { head: string[]; hunks: string[][] } {
  const lines = diff.split('\n')
  const head: string[] = []
  const hunks: string[][] = []
  let cur: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push(cur)
      cur = [line]
    } else if (cur) {
      cur.push(line)
    } else {
      head.push(line)
    }
  }
  if (cur) hunks.push(cur)
  return { head, hunks }
}

interface Selected {
  path: string
  staged: boolean
}

function GitSidebar({ root }: Props): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [diff, setDiff] = useState('')
  const [diffHead, setDiffHead] = useState<string[]>([])
  const [hunks, setHunks] = useState<string[][]>([])
  const [hunkBusy, setHunkBusy] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!root) { setStatus(null); return }
    setLoading(true)
    try {
      const s = await window.api.git.status(root)
      setStatus(s)
      if (!s.isRepo) setMsg('')
    } catch (e) {
      setMsg(`加载失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => {
    void load()
    setSelected(null)
    setDiff('')
  }, [load])

  const showDiff = useCallback(async (path: string, staged: boolean): Promise<void> => {
    if (!root) return
    setSelected({ path, staged })
    setDiff('加载中…')
    try {
      const d = await window.api.git.diff({ root, path, staged })
      setDiff(d)
      const { head, hunks: hs } = splitHunks(d)
      setDiffHead(head)
      setHunks(hs)
    } catch (e) {
      setDiff(`无法获取差异：${(e as Error).message}`)
    }
  }, [root])

  const doStageHunk = useCallback(async (hunk: string[]) => {
    if (!root || !selected) return
    setHunkBusy(true)
    const patch = [...diffHead, ...hunk].join('\n') + '\n'
    const r = await window.api.git.applyPatch({ root, patch, cached: true })
    setHunkBusy(false)
    if (r.ok) {
      setMsg('✓ 已暂存所选块')
      setSelected(null); setDiff(''); setHunks([]); setDiffHead([])
      void load()
    } else {
      setMsg(`暂存块失败：${r.error}`)
    }
  }, [root, selected, diffHead, load])

  const doInit = useCallback(async () => {
    if (!root) return
    setBusy(true)
    const r = await window.api.git.init(root)
    setBusy(false)
    setMsg(r.ok ? '✓ 已初始化 Git 仓库' : `初始化失败：${r.error}`)
    if (r.ok) void load()
  }, [root, load])

  const doStage = useCallback(async (paths: string[]) => {
    if (!root) return
    setBusy(true)
    const r = await window.api.git.stage({ root, paths })
    setBusy(false)
    if (!r.ok) setMsg(`暂存失败（部分文件可能已暂存）：${r.error}`)
    else { setMsg(''); setSelected(null); setDiff(''); }
    void load() // 无论成败都刷新（git add 可能部分成功）
  }, [root, load])

  const doStageAll = useCallback(async () => {
    if (!root) return
    setBusy(true)
    const r = await window.api.git.stageAll(root)
    setBusy(false)
    if (!r.ok) setMsg(`全部暂存失败（部分文件可能已暂存）：${r.error}`)
    else if (r.skipped && r.skipped.length > 0) setMsg(`已暂存其余文件，跳过嵌入式仓库：${r.skipped.join('、')}`)
    else { setMsg(''); }
    void load() // 无论成败都刷新（git add 可能部分成功）
  }, [root, load])

  const doUnstage = useCallback(async (paths: string[]) => {
    if (!root) return
    setBusy(true)
    const r = await window.api.git.unstage({ root, paths })
    setBusy(false)
    if (!r.ok) setMsg(`取消暂存失败：${r.error}`)
    else { setMsg(''); setSelected(null); setDiff(''); void load() }
  }, [root, load])

  const doCommit = useCallback(async () => {
    if (!root) return
    if (!commitMsg.trim()) { setMsg('请填写提交信息'); return }
    setBusy(true)
    const r = await window.api.git.commit({ root, message: commitMsg })
    setBusy(false)
    if (!r.ok) { setMsg(`提交失败：${r.error}`); return }
    setMsg(`✓ 已提交 ${r.sha ?? ''}`)
    setCommitMsg('')
    setSelected(null); setDiff('')
    void load()
  }, [root, commitMsg, load])

  const doRemote = useCallback(async (kind: 'pull' | 'push') => {
    if (!root) return
    setBusy(true)
    const r = kind === 'pull' ? await window.api.git.pull(root) : await window.api.git.push(root)
    setBusy(false)
    setMsg(r.ok ? `✓ ${kind} 完成` : `${kind} 失败：${r.text || '未知错误'}`)
    void load()
  }, [root, load])

  if (!root) {
    return (
      <section className="project-section">
        <div className="section-title">🔀 源代码管理</div>
        <div className="tree-empty">尚未打开项目<br />请先在「文件」视图打开文件夹</div>
      </section>
    )
  }

  if (!status) {
    return (
      <section className="project-section">
        <div className="section-title">🔀 源代码管理</div>
        <div className="tree-empty">{loading ? '加载中…' : '无法读取仓库状态'}</div>
      </section>
    )
  }

  if (!status.isRepo) {
    return (
      <section className="project-section">
        <div className="section-title">🔀 源代码管理</div>
        <div className="tree-empty">
          当前文件夹还不是 Git 仓库
          <div style={{ marginTop: 10 }}>
            <button className="btn small" disabled={busy} onClick={() => void doInit()}>初始化仓库</button>
          </div>
          {msg && <div style={{ marginTop: 8, color: '#dc2626' }}>{msg}</div>}
        </div>
      </section>
    )
  }

  const changeCount = status.staged.length + status.unstaged.length + status.untracked.length

  const renderRow = (f: GitFileChange, stagedRow: boolean): React.JSX.Element => (
    <div
      key={`${stagedRow ? 's' : 'u'}-${f.path}`}
      className={`tree-item file${selected?.path === f.path && selected.staged === stagedRow ? ' active' : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}
      onClick={() => void showDiff(f.path, stagedRow)}
      title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}
    >
      <span style={{ color: STATUS_COLOR[f.status], fontWeight: 700, width: 14, flexShrink: 0 }}>
        {STATUS_LETTER[f.status] || '?'}
      </span>
      <span className="tree-label" style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {baseName(f.path)}
        <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 11 }}>{f.path.includes('/') || f.path.includes('\\') ? f.path.replace(/[\\/][^\\/]*$/, '') : ''}</span>
      </span>
      {stagedRow ? (
        <button className="btn small" title="取消暂存" style={{ padding: '0 6px', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); void doUnstage([f.path]) }}>−</button>
      ) : (
        <button className="btn small" title="暂存" style={{ padding: '0 6px', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); void doStage([f.path]) }}>+</button>
      )}
    </div>
  )

  return (
    <section className="project-section">
      <div className="section-title">
        🔀 源代码管理
        <button className="btn small" onClick={() => void load()} disabled={busy}>刷新</button>
      </div>

      <div style={{ padding: '6px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>🌿 {status.branch || '(HEAD)'}</strong>
        {status.upstream && (
          <span style={{ opacity: 0.7 }}>
            {status.ahead > 0 ? `↑${status.ahead} ` : ''}{status.behind > 0 ? `↓${status.behind}` : ''}
          </span>
        )}
        {status.upstream && (
          <>
            <button className="btn small" disabled={busy} onClick={() => void doRemote('pull')}>拉取</button>
            <button className="btn small" disabled={busy} onClick={() => void doRemote('push')}>推送</button>
          </>
        )}
      </div>

      <div style={{ padding: '0 10px 8px' }}>
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="提交信息（说明本次改动）"
          rows={2}
          style={{ width: '100%', resize: 'vertical', fontSize: 12, padding: 6, boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="btn small" style={{ flex: 1 }} disabled={busy || status.staged.length === 0}
            onClick={() => void doCommit()}>
            提交{status.staged.length > 0 ? `（${status.staged.length}）` : ''}
          </button>
          {(status.unstaged.length > 0 || status.untracked.length > 0) && (
            <button className="btn small" disabled={busy} onClick={() => void doStageAll()}>全部暂存</button>
          )}
        </div>
        {msg && <div style={{ marginTop: 6, fontSize: 11, color: msg.startsWith('✓') ? '#16a34a' : '#dc2626' }}>{msg}</div>}
      </div>

      <div className="tree-body" style={{ flex: 'none', maxHeight: '42%', overflowY: 'auto' }}>
        {changeCount === 0 && <div className="tree-empty">✓ 没有待提交的更改</div>}
        {status.staged.length > 0 && (
          <>
            <div style={{ padding: '4px 10px', fontSize: 11, opacity: 0.7, fontWeight: 600 }}>暂存的更改</div>
            {status.staged.map((f) => renderRow(f, true))}
          </>
        )}
        {status.unstaged.length > 0 && (
          <>
            <div style={{ padding: '4px 10px', fontSize: 11, opacity: 0.7, fontWeight: 600 }}>更改</div>
            {status.unstaged.map((f) => renderRow(f, false))}
          </>
        )}
        {status.untracked.length > 0 && (
          <>
            <div style={{ padding: '4px 10px', fontSize: 11, opacity: 0.7, fontWeight: 600 }}>未跟踪</div>
            {status.untracked.map((f) => renderRow(f, false))}
          </>
        )}
      </div>

      {selected && (
        <div style={{ flex: 1, minHeight: 120, borderTop: '1px solid var(--border, #333)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '4px 10px', fontSize: 11, opacity: 0.7, display: 'flex', justifyContent: 'space-between' }}>
            <span title={selected.path}>{baseName(selected.path)} 的差异</span>
            <span onClick={() => { setSelected(null); setDiff('') }} style={{ cursor: 'pointer' }}>✕</span>
          </div>
          <pre style={{ margin: 0, padding: '0 10px', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.55 }}>
            {diffHead.join('\n')}
          </pre>
          {hunks.length > 0 && !selected.staged
            ? hunks.map((h, i) => (
                <div key={i} style={{ margin: '4px 6px', border: '1px solid var(--border, #333)', borderRadius: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 8px', fontSize: 11, background: 'rgba(127,127,127,0.08)' }}>
                    <span style={{ opacity: 0.7 }}>{h[0]}</span>
                    <button className="btn small" disabled={hunkBusy} title="只暂存这一块改动"
                      onClick={() => void doStageHunk(h)}>＋暂存此块</button>
                  </div>
                  <pre style={{ margin: 0, padding: '4px 8px', fontSize: 11, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {h.join('\n')}
                  </pre>
                </div>
              ))
            : <pre style={{ margin: 0, padding: '0 10px 10px', fontSize: 11, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{diff}</pre>}
        </div>
      )}
    </section>
  )
}

export default GitSidebar

import { useCallback, useEffect, useState } from 'react'
import type { GitBranchView, GitFileChange, GitLogEntry, GitStatusInfo } from '../../../preload'

interface Props {
  projectRoot?: string | null
  /** 打开文件（点变更列表时用） */
  onOpenFile?: (path: string) => void
  onClose: () => void
}

type Section = 'changes' | 'branches' | 'log'

const STATUS_MARK: Record<GitFileChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U'
}

const STATUS_COLOR: Record<GitFileChange['status'], string> = {
  added: 'var(--accent-2)',
  modified: 'var(--warning)',
  deleted: 'var(--danger)',
  renamed: 'var(--accent)',
  copied: 'var(--accent)',
  untracked: 'var(--text-dim)'
}

/**
 * Git 面板（第四批③）
 * 三段：变更（暂存/未暂存/未跟踪）· 分支（新建/切换/合并/删除）· 提交历史。
 * 设计取向：不做「什么都不显示」的空态，非仓库时直接给「初始化仓库」动作。
 */
export default function GitPanel({ projectRoot, onOpenFile, onClose }: Props): React.JSX.Element {
  const [st, setSt] = useState<GitStatusInfo | null>(null)
  const [br, setBr] = useState<GitBranchView | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [sec, setSec] = useState<Section>('changes')
  const [msg, setMsg] = useState('')
  const [commitText, setCommitText] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const root = projectRoot || ''

  const refresh = useCallback(async (): Promise<void> => {
    if (!root) return
    try {
      const [s, b] = await Promise.all([window.api.git.status(root), window.api.git.branches(root)])
      setSt(s)
      setBr(b)
      if (sec === 'log') setLog(await window.api.git.log(root, 30))
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [root, sec])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; text?: string }>, okMsg?: string): Promise<void> => {
    if (busy) return
    setBusy(key)
    setErr('')
    try {
      const r = await fn()
      if (!r.ok) setErr(r.error || '操作失败')
      else if (okMsg) setMsg(okMsg)
      else if (r.text) setMsg(r.text.split('\n').slice(0, 3).join(' '))
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  // ── 没打开工程 ──
  if (!root) {
    return (
      <div className="gitp">
        <div className="gitp-head">
          <span className="gitp-title">Git</span>
          <span className="tgt-spacer" />
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="gitp-empty">
          <div>还没有打开工程。</div>
          <div className="gitp-hint">Git 面板需要工程目录才能读取仓库状态。先在文件菜单里打开一个工程（或新建工程）再回来。</div>
        </div>
      </div>
    )
  }

  // ── git 不可用 / 未初始化仓库 ──
  if (root && st && !st.isRepo) {
    const noGit = st.unavailable
    return (
      <div className="gitp">
        <div className="gitp-head">
          <span className="gitp-title">Git</span>
          <span className="gitp-sub mono">{root}</span>
          <span className="tgt-spacer" />
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="gitp-empty">
          <div>{noGit ? '未检测到 Git 可执行文件。' : '当前工程还不是 Git 仓库。'}</div>
          {noGit ? (
            <>
              <div className="gitp-hint">
                Git 常常是装了但没进 PATH，所以本 IDE 会主动去常见安装位置找（Program Files\Git、便携版目录等）。
                仍然找不到时请安装 Git，或把 <span className="mono">git.exe</span> 所在目录加入 PATH 后重启本 IDE。
              </div>
              <div className="gitp-hint">Agent 的 git 工具同样依赖它；装好后无需重启面板，点「刷新」即可。</div>
            </>
          ) : (
            <>
              <div className="gitp-hint">初始化后即可在面板里管理分支、暂存与提交；也可继续用 Agent 的 git 工具。</div>
              <div className="gitp-row">
                <button
                  className="btn primary"
                  disabled={!!busy}
                  onClick={() => void run('init', () => window.api.git.init(root, 'main'), '仓库已初始化')}
                >
                  初始化仓库（main）
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const staged = st?.staged ?? []
  const unstaged = st?.unstaged ?? []
  const untracked = st?.untracked ?? []
  const changeCount = staged.length + unstaged.length + untracked.length

  const rowFor = (f: GitFileChange, kind: 'staged' | 'unstaged' | 'untracked'): React.JSX.Element => (
    <div key={`${kind}-${f.path}`} className="gitp-file">
      <span className="gitp-mark" style={{ color: STATUS_COLOR[f.status] }}>{STATUS_MARK[f.status]}</span>
      <span className="gitp-path" title={f.path} onClick={() => onOpenFile?.(f.path)}>{f.path}</span>
      <span className="gitp-ops">
        {kind === 'staged' ? (
          <button className="gitp-mini" disabled={!!busy} title="取消暂存" onClick={() => void run('u', () => window.api.git.unstage(root, [f.path]))}>−暂存</button>
        ) : (
          <>
            <button className="gitp-mini" disabled={!!busy} title="暂存" onClick={() => void run('s', () => window.api.git.stageOne(root, f.path))}>+暂存</button>
            {kind === 'unstaged' && (
              <button className="gitp-mini danger" disabled={!!busy} title="丢弃改动（不可恢复）" onClick={() => void run('d', () => window.api.git.discard(root, [f.path]))}>丢弃</button>
            )}
          </>
        )}
      </span>
    </div>
  )

  return (
    <div className="gitp">
      <div className="gitp-head">
        <span className="gitp-title">Git</span>
        <span className="gitp-sub mono">
          {st?.branch || '—'}
          {st?.upstream ? ` · ${st.upstream}` : ' · 无远端'}
          {st && st.ahead > 0 && <span className="gitp-ahead"> ↑{st.ahead}</span>}
          {st && st.behind > 0 && <span className="gitp-behind"> ↓{st.behind}</span>}
        </span>
        <span className="tgt-spacer" />
        <button className="gitp-mini" disabled={!!busy} onClick={() => void run('f', () => window.api.git.fetch(root), '已 fetch')}>fetch</button>
        <button className="gitp-mini" disabled={!!busy || !st?.upstream} onClick={() => void run('pull', () => window.api.git.pull(root))}>拉取</button>
        <button className="gitp-mini" disabled={!!busy || !st?.upstream} onClick={() => void run('push', () => window.api.git.push(root))}>推送</button>
        <button className="gitp-mini" onClick={() => void refresh()}>刷新</button>
        <button className="btn" onClick={onClose} title="关闭 Git 面板">✕</button>
      </div>

      {err && <div className="gitp-err">{err}</div>}
      {msg && <div className="gitp-msg">{msg}</div>}

      <div className="gitp-tabs">
        {([['changes', `变更${changeCount ? ` (${changeCount})` : ''}`], ['branches', '分支'], ['log', '历史']] as Array<[Section, string]>).map(([id, label]) => (
          <span key={id} className={`gitp-tab ${sec === id ? 'on' : ''}`} onClick={() => setSec(id)}>{label}</span>
        ))}
      </div>

      {sec === 'changes' && (
        <div className="gitp-body">
          <div className="gitp-commit">
            <textarea
              className="gitp-text"
              placeholder="提交信息（描述「为什么改」，比「改了什么」更有用）"
              value={commitText}
              onChange={(e) => setCommitText(e.target.value)}
              spellCheck={false}
            />
            <div className="gitp-row">
              <button
                className="btn primary"
                disabled={!!busy || !commitText.trim() || staged.length === 0}
                title={staged.length === 0 ? '先暂存要提交的文件' : ''}
                onClick={() => void run('c', async () => {
                  const r = await window.api.git.commit(root, commitText.trim())
                  if (r.ok) setCommitText('')
                  return r
                }, '已提交')}
              >
                提交（{staged.length}）
              </button>
              <button className="btn" disabled={!!busy || unstaged.length + untracked.length === 0} onClick={() => void run('sa', () => window.api.git.stage(root, [...unstaged, ...untracked].map((f) => f.path)))}>
                全部暂存
              </button>
            </div>
          </div>

          <div className="gitp-sec">
            <div className="gitp-sec-title">已暂存（{staged.length}）</div>
            {staged.length === 0 && <div className="gitp-hint">没有待提交内容</div>}
            {staged.map((f) => rowFor(f, 'staged'))}
          </div>

          <div className="gitp-sec">
            <div className="gitp-sec-title">未暂存（{unstaged.length}）</div>
            {unstaged.length === 0 && <div className="gitp-hint">工作区干净</div>}
            {unstaged.map((f) => rowFor(f, 'unstaged'))}
          </div>

          {untracked.length > 0 && (
            <div className="gitp-sec">
              <div className="gitp-sec-title">未跟踪（{untracked.length}）</div>
              {untracked.map((f) => rowFor(f, 'untracked'))}
            </div>
          )}
        </div>
      )}

      {sec === 'branches' && (
        <div className="gitp-body">
          <div className="gitp-row">
            <input
              className="toolbar-input"
              placeholder="新分支名（如 feat/stm32-support）"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              spellCheck={false}
            />
            <button
              className="btn primary"
              disabled={!!busy || !newBranch.trim()}
              onClick={() => void run('nb', async () => {
                const r = await window.api.git.branchCreate(root, newBranch.trim(), true)
                if (r.ok) setNewBranch('')
                return r
              }, '分支已创建并切换')}
            >
              新建并切换
            </button>
          </div>

          {br?.detached && <div className="gitp-err">当前处于游离 HEAD 状态（detached），建议先切回某个分支</div>}

          <div className="gitp-sec">
            <div className="gitp-sec-title">本地分支（{br?.branches.length ?? 0}）</div>
            {(br?.branches ?? []).map((b) => (
              <div key={b.name} className={`gitp-file ${b.current ? 'on' : ''}`}>
                <span className="gitp-mark">{b.current ? '●' : '○'}</span>
                <span className="gitp-path mono" title={`${b.lastSubject}\n${b.lastTime}`}>
                  {b.name}
                  {b.upstream && <span className="gitp-dim"> → {b.upstream}</span>}
                  {b.ahead > 0 && <span className="gitp-ahead"> ↑{b.ahead}</span>}
                  {b.behind > 0 && <span className="gitp-behind"> ↓{b.behind}</span>}
                </span>
                <span className="gitp-ops">
                  {!b.current && (
                    <>
                      <button className="gitp-mini" disabled={!!busy} onClick={() => void run('co', () => window.api.git.branchCheckout(root, b.name), `已切到 ${b.name}`)}>切换</button>
                      <button className="gitp-mini" disabled={!!busy} title="合并到当前分支" onClick={() => void run('mg', () => window.api.git.branchMerge(root, b.name))}>合并</button>
                      <button className="gitp-mini danger" disabled={!!busy} title="删除分支" onClick={() => void run('rm', () => window.api.git.branchDelete(root, b.name, false))}>删</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div className="gitp-sec">
            <div className="gitp-sec-title">远端</div>
            {(br?.remotes ?? []).map((r) => (
              <div key={r.name} className="gitp-file">
                <span className="gitp-mark">→</span>
                <span className="gitp-path mono" title={r.fetchUrl || r.url}>{r.name} · {r.fetchUrl || r.url}</span>
              </div>
            ))}
            {(br?.remotes ?? []).length === 0 && <div className="gitp-hint">未配置远端。下面添加后即可推送。</div>}
            <div className="gitp-row">
              <input className="toolbar-input" style={{ width: 92 }} value={remoteName} onChange={(e) => setRemoteName(e.target.value)} placeholder="origin" />
              <input className="toolbar-input" style={{ flex: 1 }} value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo.git" spellCheck={false} />
              <button
                className="btn"
                disabled={!!busy || !remoteName.trim() || !remoteUrl.trim()}
                onClick={() => void run('ra', async () => {
                  const r = await window.api.git.remoteAdd(root, remoteName.trim(), remoteUrl.trim())
                  if (r.ok) setRemoteUrl('')
                  return r
                }, '远端已添加')}
              >
                添加远端
              </button>
            </div>
          </div>
        </div>
      )}

      {sec === 'log' && (
        <div className="gitp-body">
          <div className="gitp-sec-title">最近提交（{log.length}）</div>
          {log.length === 0 && <div className="gitp-hint">暂无提交记录</div>}
          {log.map((l) => (
            <div key={l.sha} className="gitp-file">
              <span className="gitp-mark mono">{l.short}</span>
              <span className="gitp-path" title={`${l.author} · ${l.date}`}>{l.subject || '(无标题)'}</span>
              <span className="gitp-ops gitp-dim">{l.author}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

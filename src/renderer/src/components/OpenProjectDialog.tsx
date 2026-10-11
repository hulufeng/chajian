import React, { useCallback, useEffect, useState } from 'react'

/**
 * 应用内「打开项目」目录选择器。
 *
 * 为什么不用原生 dialog.showOpenDialog：部分 Windows 机器上它的 Shell 视图
 * （左侧导航树/快速访问）不渲染，导航区空白，既没法手动点也没法脚本驱动。
 * 这里自绘一个轻量选择器：路径输入框 + 上级导航 + 子目录列表 + 打开，
 * 只依赖 fs:readDir / project:openPath，跨环境稳定。
 *
 * 组件只负责「选一个目录并回调路径」，真正的打开动作交给 App（onPick）。
 */

interface Props {
  /** 初始浏览目录（一般是当前工程根，没有则回落到盘符根） */
  initialPath?: string | null
  onClose: () => void
  /** 选中目录的绝对路径 */
  onPick: (path: string) => void
}

// 只处理 Windows 风格的路径拼接；渲染层不能引node:path
const joinPath = (base: string, name: string): string => {
  const b = base.replace(/[\\/]+$/, '')
  return `${b}/${name}`
}
const parentOf = (p: string): string => {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = norm.lastIndexOf('/')
  if (idx < 0) return norm
  const head = norm.slice(0, idx)
  if (/^[A-Za-z]:$/.test(head)) return `${head}/`
  return head || '/'
}
// 盘符根（C:/ D:/ …）优先，作为无工程时的兜底起点
const ROOTS = ['D:/', 'C:/', 'E:/', 'F:/']

export default function OpenProjectDialog({ initialPath, onClose, onPick }: Props): React.JSX.Element {
  const [cwd, setCwd] = useState<string>(initialPath || '')
  const [input, setInput] = useState<string>(initialPath || '')
  const [dirs, setDirs] = useState<string[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState<string>('')
  const [err, setErr] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (dir: string): Promise<void> => {
    if (!dir) return
    setLoading(true)
    setErr('')
    try {
      const r = await window.api.fs.readDir(dir)
      setCwd(r.path)
      setInput(r.path)
      setDirs(r.dirs)
      setFiles(r.files)
      setSel('')
    } catch (e) {
      setErr(`无法读取目录：${(e as Error).message || dir}`)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次进入：优先当前工程目录，否则找一个存在的盘符根
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (initialPath) {
        await load(initialPath)
        return
      }
      for (const r of ROOTS) {
        if (cancelled) return
        try {
          const res = await window.api.fs.readDir(r)
          if (!cancelled) {
            setCwd(res.path)
            setInput(res.path)
            setDirs(res.dirs)
            setFiles(res.files)
          }
          return
        } catch {
          /* 该盘不存在则试下一个 */
        }
      }
      if (!cancelled) setErr('未找到可浏览的盘符，请在上方直接输入工程路径')
    })()
    return () => { cancelled = true }
  }, [initialPath, load])

  const enter = (name: string) => void load(joinPath(cwd, name))
  const up = () => void load(parentOf(cwd))

  const openInput = () => {
    const target = (sel ? joinPath(cwd, sel) : input).trim()
    if (target) onPick(target)
  }

  const s: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
  const row: React.CSSProperties = { padding: '6px 10px', cursor: 'pointer', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8 }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div style={{ width: 640, height: 480, maxWidth: '90vw', background: 'var(--bg-panel,#1e1f22)', color: 'var(--fg,#e8e8e8)', border: '1px solid var(--border,#3a3b40)', borderRadius: 8, display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,.5)', ...s }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border,#3a3b40)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>打开项目文件夹</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={up} title="上级目录">上级</button>
          <button className="btn small" onClick={onClose}>取消</button>
        </div>

        <div style={{ padding: 12, display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (sel) enter(sel)
                else void load(input)
              }
            }}
            placeholder="输入工程根目录绝对路径，回车进入"
            style={{ flex: 1, padding: '6px 8px', background: 'var(--bg-input,#25262a)', color: 'inherit', border: '1px solid var(--border,#3a3b40)', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}
          />
          <button className="btn" onClick={openInput}>打开</button>
        </div>

        {err ? <div style={{ padding: '0 12px 8px', color: '#e06c6c', fontSize: 12 }}>{err}</div> : null}

        <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px', ...s }}>
          {loading ? <div style={{ padding: 12, opacity: 0.6 }}>加载中…</div> : null}
          {!loading && dirs.length === 0 && !err ? <div style={{ padding: 12, opacity: 0.6 }}>（此目录下没有子文件夹）</div> : null}
          {dirs.map((d) => (
            <div
              key={d}
              style={{ ...row, background: sel === d ? 'var(--bg-hover,#2f3034)' : 'transparent' }}
              onClick={() => { setSel(d); setInput(joinPath(cwd, d)) }}
              onDoubleClick={() => enter(d)}
              title="单击选中 · 双击进入"
            >
              <span>📁</span><span>{d}</span>
            </div>
          ))}
          {files.length > 0 ? (
            <div style={{ padding: '8px 10px 4px', opacity: 0.5, fontSize: 12 }}>（{files.length} 个文件，双击文件夹进入；选中文件夹后点「打开」把它作为工程根）</div>
          ) : null}
        </div>

        <div style={{ padding: 10, borderTop: '1px solid var(--border,#3a3b40)', fontSize: 12, opacity: 0.7, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          目标：{sel ? joinPath(cwd, sel) : input || '—'}
        </div>
      </div>
    </div>
  )
}
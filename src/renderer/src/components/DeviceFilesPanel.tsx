import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceFsNode } from '../../../preload'

interface Props {
  /** 已打开的串口会话 id（serial-<port>）；没有就提示先打开串口 */
  sessionId?: string | null
  /** 工程根目录，用作「同步本地文件夹」的默认值 */
  projectRoot?: string | null
}

const enc = (s: string): string => encodeURIComponent(s)

/**
 * 设备端文件浏览器 + 文件夹一键同步。
 * 协议：串口行协议（FS LS/CAT/PUT/MKDIR/RM/STAT），设备端固件按行回 OK/ERR 即可。
 */
export default function DeviceFilesPanel({ sessionId, projectRoot }: Props): React.JSX.Element {
  const [cwd, setCwd] = useState('/')
  const [nodes, setNodes] = useState<DeviceFsNode[]>([])
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [localDir, setLocalDir] = useState('')
  const [deviceDir, setDeviceDir] = useState('/data')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [log, setLog] = useState('')
  const [dirty, setDirty] = useState(false)
  const inited = useRef(false)

  useEffect(() => {
    if (!inited.current && projectRoot) {
      setLocalDir(`${projectRoot}\\data`)
      inited.current = true
    }
  }, [projectRoot])

  const refresh = useCallback(
    async (dir: string) => {
      if (!sessionId) {
        setErr('还没有打开串口。先在「设备」页打开串口监视器，本面板复用同一条串口做文件操作。')
        return
      }
      setBusy(true)
      setErr('')
      try {
        const list = await window.api.devicefs.list({ sessionId, path: dir })
        setNodes(list)
        setCwd(dir)
        setFile(null)
      } catch (e) {
        setErr((e as Error).message)
        setNodes([])
      } finally {
        setBusy(false)
      }
    },
    [sessionId]
  )

  useEffect(() => {
    if (sessionId) void refresh(cwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(
    () =>
      window.api.devicefs.onProgress((msg) => {
        setLog((p) => `${p}${msg}\n`)
      }),
    []
  )

  const openFile = async (p: string): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    setErr('')
    try {
      const content = await window.api.devicefs.read({ sessionId, path: p })
      setFile({ path: p, content })
      setDirty(false)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveFile = async (): Promise<void> => {
    if (!sessionId || !file) return
    setBusy(true)
    setErr('')
    try {
      await window.api.devicefs.write({ sessionId, path: file.path, content: file.content })
      setDirty(false)
      setLog((p) => `${p}已保存 ${file.path}\n`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const mkdir = async (): Promise<void> => {
    if (!sessionId || !newName) return
    const path = `${cwd === '/' ? '' : cwd}/${newName}`
    setBusy(true)
    setErr('')
    try {
      await window.api.devicefs.mkdir({ sessionId, path })
      setNewName('')
      await refresh(cwd)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: string): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    setErr('')
    try {
      await window.api.devicefs.remove({ sessionId, path: p })
      await refresh(cwd)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sync = async (): Promise<void> => {
    if (!sessionId) return
    setBusy(true)
    setErr('')
    setLog('')
    try {
      const r = await window.api.devicefs.sync({ sessionId, localDir, deviceDir })
      if (!r.ok) {
        setErr(r.error || '同步失败')
      } else {
        setLog((p) => `${p}同步完成：上传 ${r.uploaded.length} 个，跳过（未变化）${r.skipped.length} 个\n`)
        await refresh(cwd)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const parent = (): string => (cwd === '/' ? '/' : cwd.slice(0, cwd.lastIndexOf('/')) || '/')

  return (
    <div className="dfiles">
      <div className="dfiles-bar">
        <button className="btn" disabled={busy || !sessionId} onClick={() => void refresh(parent())}>
          上一级
        </button>
        <span className="dfiles-path" title={cwd}>
          {cwd}
        </span>
        <button className="btn" disabled={busy || !sessionId} onClick={() => void refresh(cwd)}>
          刷新
        </button>
      </div>

      {!sessionId && (
        <div className="debug-hint">
          设备文件浏览复用串口会话。先到「设备」页打开串口监视器（选串口 + 波特率），再回本页操作。
        </div>
      )}
      {err && <div className="debug-err">{err}</div>}

      <div className="dfiles-list">
        {nodes.length === 0 && <div className="debug-empty">{sessionId ? '（空目录）' : '未连接'}</div>}
        {nodes.map((n) => (
          <div key={n.path} className="dfiles-item">
            <span className={`dfiles-ico ${n.type === 'dir' ? 'is-dir' : ''}`}>{n.type === 'dir' ? '▸' : '·'}</span>
            <span
              className="dfiles-name"
              onClick={() => (n.type === 'dir' ? void refresh(n.path) : void openFile(n.path))}
            >
              {n.name}
            </span>
            <span className="dfiles-size">{n.type === 'file' ? `${n.size ?? 0}B` : ''}</span>
            <button
              className="dfiles-del"
              title="删除"
              disabled={busy || !sessionId}
              onClick={() => void remove(n.path)}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="dfiles-bar">
        <input
          className="toolbar-input"
          placeholder="新目录名"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          spellCheck={false}
        />
        <button className="btn" disabled={busy || !sessionId || !newName} onClick={() => void mkdir()}>
          新建目录
        </button>
      </div>

      {file && (
        <div className="dfiles-editor">
          <div className="dfiles-bar">
            <span className="dfiles-path" title={file.path}>
              {file.path}
              {dirty ? ' *' : ''}
            </span>
            <button className="btn" disabled={busy} onClick={() => void saveFile()}>
              保存到设备
            </button>
            <button className="btn" disabled={busy} onClick={() => setFile(null)}>
              关闭
            </button>
          </div>
          <textarea
            className="dfiles-text"
            value={file.content}
            spellCheck={false}
            onChange={(e) => {
              setFile({ ...file, content: e.target.value })
              setDirty(true)
            }}
          />
        </div>
      )}

      <div className="dfiles-bar">
        <span className="debug-hint">本地 → 设备同步（只传新增/变化）</span>
        <input
          className="toolbar-input"
          placeholder="本地文件夹"
          value={localDir}
          onChange={(e) => setLocalDir(e.target.value)}
          spellCheck={false}
        />
        <span className="debug-hint">→</span>
        <input
          className="toolbar-input"
          placeholder="设备目录"
          value={deviceDir}
          onChange={(e) => setDeviceDir(e.target.value)}
          spellCheck={false}
        />
        <button className="btn" disabled={busy || !sessionId || !localDir} onClick={() => void sync()}>
          同步
        </button>
      </div>
      {log && <pre className="dfiles-log">{log}</pre>}
      <div className="debug-hint">
        协议：<code>FS LS/CAT/PUT/MKDIR/RM/STAT</code> 行协议，设备端回一行 <code>OK</code> 或{' '}
        <code>ERR</code>；<code>PUT</code> 为分片上传（路径 空格 总片数 片序号 base64）。
      </div>
    </div>
  )
}

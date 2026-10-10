import { useCallback, useEffect, useRef, useState } from 'react'
import type { PioInfo } from '../../../preload'

interface Props {
  projectRoot?: string | null
  onClose: () => void
}

/**
 * PlatformIO 面板：探测/安装 pio Core、多 env 选择、构建、烧录、串口监视。
 * 输出走主进程 task:output 流式回传（和 arduino-cli 安装同一条通道）。
 */
export default function PlatformIOPanel({ projectRoot }: Props): React.JSX.Element {
  const [info, setInfo] = useState<PioInfo | null>(null)
  const [env, setEnv] = useState('')
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState('')
  const [installMsg, setInstallMsg] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const outRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    try {
      const i = await window.api.platformio.info(projectRoot ?? null)
      setInfo(i)
      setEnv((prev) => prev || i.project.defaultEnv || i.project.envs[0]?.name || '')
      setPort((prev) => prev || i.project.envs.find((e) => e.name === (prev || i.project.defaultEnv))?.uploadPort || '')
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [projectRoot])

  useEffect(() => {
    void load()
  }, [load])

  // pio-* 任务的流式输出
  useEffect(() => {
    const offOut = window.api.onTaskOutput((d) => {
      if (!d.id.startsWith('pio-')) return
      setOut((p) => p + d.chunk)
    })
    const offExit = window.api.onTaskExit((d) => {
      if (!d.id.startsWith('pio-')) return
      setBusy((b) => (b === 'monitor' ? '' : b))
    })
    return () => {
      offOut()
      offExit()
    }
  }, [])

  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out])

  const runBuild = async (): Promise<void> => {
    if (!projectRoot) return setErr('还没有打开工程')
    setBusy('build')
    setErr('')
    setOut('')
    try {
      const r = await window.api.platformio.build({ projectRoot, env: env || undefined })
      if (!r.ok) setErr(r.hint || '构建失败（详见下方输出）')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const runUpload = async (): Promise<void> => {
    if (!projectRoot) return setErr('还没有打开工程')
    setBusy('upload')
    setErr('')
    setOut('')
    try {
      const r = await window.api.platformio.upload({ projectRoot, env: env || undefined, port: port || undefined })
      if (!r.ok) setErr(r.hint || '烧录失败（详见下方输出）')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const runMonitor = async (): Promise<void> => {
    if (!projectRoot) return setErr('还没有打开工程')
    setErr('')
    setOut('')
    setBusy('monitor')
    try {
      await window.api.platformio.monitor({ projectRoot, env: env || undefined, port: port || undefined })
    } catch (e) {
      setErr((e as Error).message)
      setBusy('')
    }
  }

  const stopMonitor = async (): Promise<void> => {
    await window.api.platformio.stopMonitor()
    setBusy('')
  }

  const install = async (): Promise<void> => {
    setInstallMsg('正在安装…')
    setErr('')
    const off = window.api.platformio.onProgress((p) => setInstallMsg(p.message))
    try {
      const r = await window.api.platformio.install()
      off()
      setInstallMsg(r.success ? `安装成功：PlatformIO Core ${r.version || ''}` : '')
      if (!r.success) setErr(r.error || '安装失败')
      await load()
    } catch (e) {
      off()
      setInstallMsg('')
      setErr((e as Error).message)
    }
  }

  const envs = info?.project.envs ?? []
  const isPioProject = !!info?.project.found

  return (
    <div className="pio-panel">
      <div className="debug-head">
        <span className="debug-title">PlatformIO</span>
        <span className={`debug-dot ${info?.installed ? 'on' : 'off'}`} />
        <span className="debug-meta">
          {info
            ? info.installed
              ? `Core ${info.version} · ${info.command}（${info.source}）`
              : '未安装 PlatformIO Core'
            : '检测中…'}
          {isPioProject ? ` · 工程 ${info?.project.root}` : ''}
        </span>
        <span className="debug-spacer" />
        {info && !info.installed && (
          <button className="btn" onClick={() => void install()}>
            安装 PlatformIO
          </button>
        )}
        {info?.installed && (
          <>
            <select
              className="debug-chip"
              value={env}
              disabled={envs.length === 0}
              onChange={(e) => setEnv(e.target.value)}
              title="platformio.ini 里的 [env:xxx]"
            >
              {envs.length === 0 && <option value="">（无 env）</option>}
              {envs.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} · {e.board ?? e.platform ?? '?'}
                </option>
              ))}
            </select>
            <input
              className="toolbar-input"
              style={{ width: 90 }}
              placeholder={envs.find((e) => e.name === env)?.uploadPort ?? 'COMx'}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              spellCheck={false}
              title="烧录串口（留空用 ini 里的 upload_port）"
            />
            <button className="btn" disabled={!!busy || !isPioProject} onClick={() => void runBuild()}>
              {busy === 'build' ? '构建中…' : '构建'}
            </button>
            <button className="btn" disabled={!!busy || !isPioProject} onClick={() => void runUpload()}>
              {busy === 'upload' ? '烧录中…' : '烧录'}
            </button>
            {busy === 'monitor' ? (
              <button className="btn" onClick={() => void stopMonitor()}>
                停止监视
              </button>
            ) : (
              <button className="btn" disabled={!!busy || !isPioProject} onClick={() => void runMonitor()}>
                串口监视
              </button>
            )}
          </>
        )}
      </div>

      <div className="pio-body">
        {installMsg && <div className="debug-hint">{installMsg}</div>}
        {err && <div className="debug-err">{err}</div>}
        {info && !isPioProject && (
          <div className="debug-hint">
            {info.project.note}。装了 PlatformIO 之后，把工程根目录的 platformio.ini 补上（或用 arduino-cli 路径编译）。
          </div>
        )}
        {envs.length > 0 && (
          <div className="pio-envs">
            {envs.map((e) => (
              <span key={e.name} className="debug-tag" title={`framework=${e.framework ?? '-'} monitor_speed=${e.monitorSpeed ?? '-'}`}>
                {e.name} · {e.board ?? '?'} · {e.framework ?? '-'}
              </span>
            ))}
          </div>
        )}
        <pre className="pio-out" ref={outRef}>
          {out || '（输出会显示在这里：pio run / pio run -t upload / pio device monitor 的原始输出）'}
        </pre>
      </div>
    </div>
  )
}

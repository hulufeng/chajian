import { useEffect, useState } from 'react'

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })

  useEffect(() => {
    if (!window.api?.updater?.onEvent) return
    const off = window.api.updater.onEvent((type, payload) => {
      switch (type) {
        case 'checking':
          setState({ status: 'checking' })
          break
        case 'available':
          setState({ status: 'available', version: (payload as { version?: string })?.version })
          break
        case 'not-available':
          setState({ status: 'not-available' })
          setTimeout(() => setState({ status: 'idle' }), 3000)
          break
        case 'progress': {
          const p = payload as { percent?: number }
          setState((prev) => ({ ...prev, status: 'downloading', progress: p?.percent ?? 0 }))
          break
        }
        case 'downloaded':
          setState({ status: 'downloaded', version: (payload as { version?: string })?.version })
          break
        case 'error':
          setState({ status: 'error', error: (payload as string) || '更新检查失败' })
          setTimeout(() => setState({ status: 'idle' }), 5000)
          break
      }
    })
    return off
  }, [])

  if (state.status === 'idle' || state.status === 'checking' || state.status === 'not-available') {
    return null
  }

  return (
    <div className="update-banner">
      {state.status === 'available' && (
        <>
          <span className="update-text">
            发现新版本 v{state.version}，是否下载更新？
          </span>
          <button className="update-btn" onClick={() => window.api.updater.download()}>
            下载更新
          </button>
          <button className="update-btn-secondary" onClick={() => setState({ status: 'idle' })}>
            稍后
          </button>
        </>
      )}
      {state.status === 'downloading' && (
        <>
          <span className="update-text">正在下载更新… {state.progress?.toFixed(1)}%</span>
          <div className="update-progress">
            <div className="update-progress-bar" style={{ width: `${state.progress ?? 0}%` }} />
          </div>
        </>
      )}
      {state.status === 'downloaded' && (
        <>
          <span className="update-text">v{state.version} 已下载完成，重启后生效</span>
          <button className="update-btn" onClick={() => window.api.updater.install()}>
            立即重启安装
          </button>
        </>
      )}
      {state.status === 'error' && (
        <span className="update-text update-error">{state.error}</span>
      )}
    </div>
  )
}

export default UpdateBanner

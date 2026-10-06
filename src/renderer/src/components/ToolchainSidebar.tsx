import { useCallback, useEffect, useRef, useState } from 'react'
import DevicePanel from './DevicePanel'
import DeviceFilesPanel from './DeviceFilesPanel'

interface ToolchainSidebarProps {
  projectRoot?: string | null
  onBoardChange?: (fqbn: string, name?: string) => void
  onPortChange?: (port: string) => void
  onOpenSerialWindow?: () => void
  onGenerateWiring?: () => void
  onOpenFile?: (path: string, name?: string) => void
  /** 已打开的串口会话（设备文件浏览复用同一条串口） */
  serialSessionId?: string | null
}

type TabId = 'device' | 'files' | 'platforms' | 'libraries' | 'settings'

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'device', label: '设备', icon: '🔌' },
  { id: 'files', label: '设备文件', icon: '📁' },
  { id: 'platforms', label: '平台管理', icon: '📦' },
  { id: 'libraries', label: '库管理', icon: '📚' },
  { id: 'settings', label: '设置', icon: '⚙️' }
]

/** 走 iframe 的内置页面（device / files 是 React 组件，不在这列） */
const WEB_TABS: TabId[] = ['platforms', 'libraries', 'settings']

function ToolchainSidebar({ projectRoot, onBoardChange, onPortChange, onOpenSerialWindow, onGenerateWiring, onOpenFile, serialSessionId }: ToolchainSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('device')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  /**
   * Web UI 的 file:// 地址由主进程给出（见 `toolchain:ui-url`）。
   * 不能在这里拼 process.resourcesPath —— 渲染层的 nodeIntegration 是关的，
   * 那个变量在打包后根本不存在，拼了就是 render 阶段 ReferenceError、整个侧栏白屏。
   */
  const [uiUrl, setUiUrl] = useState('')
  const [uiErr, setUiErr] = useState('')

  const loadUiUrl = useCallback(async (tab: TabId): Promise<void> => {
    setUiUrl('')
    setUiErr('')
    try {
      const url = await window.api.toolchain.uiUrl(tab)
      if (url) setUiUrl(url)
      else setUiErr('该页面未随安装包分发（打包时漏了 plugins/arduino-toolchain/ui）。')
    } catch (e) {
      setUiErr((e as Error).message || '读取内置页面失败')
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'device' || activeTab === 'files') return
    void loadUiUrl(activeTab)
  }, [activeTab, loadUiUrl])

  // 监听 webview 的 postMessage，转发到主进程 IPC
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data
      if (!data || data.type !== 'plugin:invoke') return

      const { id, method, args } = data
      const api = window.api as Record<string, unknown>

      // 解析 method 路径，如 platform:list → api.core.list
      const [namespace, func] = method.split(':')
      // 命名空间映射：webview 用 platform，实际 API 是 core（避免与 process.platform 冲突）
      const nsMap: Record<string, string> = { platform: 'core', library: 'library', settings: 'settings' }
      const actualNs = nsMap[namespace] || namespace
      const ns = api[actualNs] as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined
      const fn = ns?.[func]

      if (typeof fn === 'function') {
        fn.call(ns, args)
          .then((result) => {
            iframeRef.current?.contentWindow?.postMessage({ id, result }, '*')
          })
          .catch((err: Error) => {
            iframeRef.current?.contentWindow?.postMessage({ id, error: err.message }, '*')
          })
      } else {
        iframeRef.current?.contentWindow?.postMessage({ id, error: `Unknown method: ${method}` }, '*')
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [activeTab])

  // 流式任务输出转发到 webview
  useEffect(() => {
    if (activeTab === 'device') return

    const offOutput = window.api.onTaskOutput((d) => {
      if (d.id.startsWith('platform-install-') || d.id.startsWith('library-install-')) {
        iframeRef.current?.contentWindow?.postMessage({
          type: activeTab === 'platforms' ? 'platform:install-progress' : 'library:install-progress',
          percent: 50,
          message: d.chunk.trim()
        }, '*')
      }
    })

    return () => offOutput()
  }, [activeTab])

  return (
    <div className="toolchain-sidebar">
      {/* 顶部选项卡 */}
      <div className="toolchain-tabs">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            className={`toolchain-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
          >
            <span className="toolchain-tab-icon">{tab.icon}</span>
            <span className="toolchain-tab-label">{tab.label}</span>
          </div>
        ))}
      </div>

      {/* 内容区 */}
      <div className="toolchain-content">
        {activeTab === 'device' && (
          <DevicePanel
            projectRoot={projectRoot}
            onBoardChange={onBoardChange}
            onPortChange={onPortChange}
            onOpenSerialWindow={onOpenSerialWindow}
            onGenerateWiring={onGenerateWiring}
            onOpenFile={onOpenFile}
          />
        )}
        {activeTab === 'files' && (
          <DeviceFilesPanel sessionId={serialSessionId} projectRoot={projectRoot} />
        )}
        {WEB_TABS.map((tab) => {
          if (activeTab !== tab) return null
          // 缺资源时给一行说明，而不是留个空面板让人以为页面是白的
          if (!uiUrl) {
            return (
              <div key={tab} className="toolchain-missing">
                <div className="toolchain-missing-title">{TABS.find((t) => t.id === tab)?.label ?? tab}</div>
                <div className="toolchain-missing-desc">{uiErr || '页面加载中…'}</div>
              </div>
            )
          }
          return (
            <iframe
              key={tab}
              ref={iframeRef}
              src={uiUrl}
              className="toolchain-webview"
              sandbox="allow-scripts allow-same-origin"
            />
          )
        })}
      </div>
    </div>
  )
}

export default ToolchainSidebar

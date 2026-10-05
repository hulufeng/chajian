import { useState, useEffect, useRef } from 'react'
import DevicePanel from './DevicePanel'

interface ToolchainSidebarProps {
  onBoardChange?: (fqbn: string, name?: string) => void
  onPortChange?: (port: string) => void
  onOpenSerialWindow?: () => void
  onGenerateWiring?: () => void
}

type TabId = 'device' | 'platforms' | 'libraries' | 'settings'

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'device', label: '设备', icon: '🔌' },
  { id: 'platforms', label: '平台管理', icon: '📦' },
  { id: 'libraries', label: '库管理', icon: '📚' },
  { id: 'settings', label: '设置', icon: '⚙️' }
]

function ToolchainSidebar({ onBoardChange, onPortChange, onOpenSerialWindow, onGenerateWiring }: ToolchainSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('device')
  const iframeRef = useRef<HTMLIFrameElement>(null)

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

  const getWebviewUrl = (tab: TabId): string => {
    // 开发模式：使用 file:// 协议加载本地 HTML
    const base = import.meta.env.DEV
      ? `file:///${window.location.pathname.replace(/\/[^/]*$/, '').replace('/renderer/src', '/main/plugins/arduino-toolchain/ui')}`
      : `file:///${process.resourcesPath}/plugins/arduino-cli-toolchain/ui`
    return `${base}/${tab}.html`
  }

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
            onBoardChange={onBoardChange}
            onPortChange={onPortChange}
            onOpenSerialWindow={onOpenSerialWindow}
            onGenerateWiring={onGenerateWiring}
          />
        )}
        {activeTab === 'platforms' && (
          <iframe
            ref={iframeRef}
            src={getWebviewUrl('platforms')}
            className="toolchain-webview"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {activeTab === 'libraries' && (
          <iframe
            ref={iframeRef}
            src={getWebviewUrl('libraries')}
            className="toolchain-webview"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {activeTab === 'settings' && (
          <iframe
            ref={iframeRef}
            src={getWebviewUrl('settings')}
            className="toolchain-webview"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
      </div>
    </div>
  )
}

export default ToolchainSidebar

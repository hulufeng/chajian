import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DevicePanel from './DevicePanel'
import DeviceFilesPanel from './DeviceFilesPanel'
import { hint } from '../featureHints'

interface ToolchainSidebarProps {
  projectRoot?: string | null
  onBoardChange?: (fqbn: string, name?: string) => void
  onPortChange?: (port: string) => void
  onOpenSerialWindow?: () => void
  onGenerateWiring?: () => void
  onOpenFile?: (path: string, name?: string) => void
  /** 已打开的串口会话（设备文件浏览复用同一条串口） */
  serialSessionId?: string | null
  /** 宿主要求切换到的 tab（命令面板 open-view 命令用，P2-20） */
  requestedTab?: string | null
  onRequestedTabHandled?: () => void
}

/** 内置 tab（React 组件或宿主自有页面）；插件贡献的 tab 用 `plugin:<插件名>:<viewId>` */
type BuiltinTabId = 'device' | 'files' | 'platforms' | 'libraries' | 'settings'
type TabId = BuiltinTabId | string

interface PluginView {
  plugin: string
  id: string
  title: string
  icon?: string
  slot: string
  type: string
  entry?: string
}

/** 侧边栏 tab id → 所属插件的 view（供 URL 解析用） */
const viewKey = (plugin: string, id: string): string => `plugin:${plugin}:${id}`

/** 走 iframe 的内置页面（device / files 是 React 组件，不在这列） */
const WEB_TABS: BuiltinTabId[] = ['platforms', 'libraries', 'settings']

const BUILTIN_TABS: Array<{ id: BuiltinTabId; label: string; icon: string }> = [
  { id: 'device', label: '设备', icon: '🔌' },
  { id: 'files', label: '设备文件', icon: '📁' },
  { id: 'platforms', label: '平台管理', icon: '📦' },
  { id: 'libraries', label: '库管理', icon: '📚' },
  { id: 'settings', label: '设置', icon: '⚙️' }
]

function ToolchainSidebar({ projectRoot, onBoardChange, onPortChange, onOpenSerialWindow, onGenerateWiring, onOpenFile, serialSessionId, requestedTab, onRequestedTabHandled }: ToolchainSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('device')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  /**
   * Web UI 的 file:// 地址由主进程给出（见 `toolchain:ui-url`）。
   * 不能在这里拼 process.resourcesPath —— 渲染层的 nodeIntegration 是关的，
   * 那个变量在打包后根本不存在，拼了就是 render 阶段 ReferenceError、整个侧栏白屏。
   */
  const [uiUrl, setUiUrl] = useState('')
  const [uiErr, setUiErr] = useState('')
  /**
   * P2-20：由插件 manifest.views[] 贡献侧边栏 tab。
   *
   * 此前侧边栏 5 个 tab 全写死在这里，其中「平台管理 / 库管理」其实就是 arduino 插件
   * manifest 里声明的 view，属于「声明了但没接线」的重复实现。现在改为：
   *   内置 tab（宿主自有 / React 组件）+ 插件声明的 sidebar view 动态合并，
   * 按 title 去重，避免与内置同名重复出现。
   */
  const [views, setViews] = useState<PluginView[]>([])
  useEffect(() => {
    let cancelled = false
    void window.api.plugin
      .views()
      .then((list) => {
        if (!cancelled) setViews(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        /* 插件系统不可用时退回纯内置 tab，不该带崩侧栏 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 插件贡献的 tab；title 与内置重复则跳过（保留内置实现） */
  const pluginTabs = useMemo(() => {
    const builtinLabels = new Set(BUILTIN_TABS.map((t) => t.label))
    return views
      .filter((v) => v.slot === 'sidebar' && v.type === 'webview' && v.entry)
      .filter((v) => !builtinLabels.has(v.title))
      .map((v) => ({ id: viewKey(v.plugin, v.id), label: v.title, icon: v.icon || '🧩' }))
  }, [views])

  /** tabId → 该 tab 对应的插件 view（用于解析 webview 地址） */
  const viewByTab = useMemo(() => {
    const m = new Map<string, PluginView>()
    for (const v of views) m.set(viewKey(v.plugin, v.id), v)
    return m
  }, [views])

  const TABS: Array<{ id: TabId; label: string; icon: string }> = [
    ...BUILTIN_TABS.map((t) => ({ ...t })),
    ...pluginTabs
  ]

  const loadUiUrl = useCallback(
    async (tab: TabId): Promise<void> => {
      setUiUrl('')
      setUiErr('')
      try {
        const view = viewByTab.get(tab)
        // 插件 view 走通用解析；内置页面沿用既有 toolchain:ui-url
        const url = view?.entry
          ? await window.api.plugin.viewUrl(view.plugin, view.entry)
          : await window.api.toolchain.uiUrl(tab)
        if (url) setUiUrl(url)
        else if (view)
          setUiErr(`插件「${view.plugin}」的页面 ${view.entry} 未随安装包分发。`)
        else setUiErr('该页面未随安装包分发（打包时漏了 plugins/arduino-toolchain/ui）。')
      } catch (e) {
        setUiErr((e as Error).message || '读取内置页面失败')
      }
    },
    [viewByTab]
  )

  useEffect(() => {
    if (activeTab === 'device' || activeTab === 'files') return
    void loadUiUrl(activeTab)
  }, [activeTab, loadUiUrl])

  /**
   * 响应宿主的 open-view 请求（命令面板里点某个插件视图时）。
   * views 是异步加载的，所以要等它到齐再判断目标 tab 是否存在——
   * 否则请求会比 views 先到，被误判成「不存在的视图」。
   */
  useEffect(() => {
    if (!requestedTab) return
    const exists =
      BUILTIN_TABS.some((t) => t.id === requestedTab) || pluginTabs.some((t) => t.id === requestedTab)
    if (!exists) return
    setActiveTab(requestedTab)
    onRequestedTabHandled?.()
  }, [requestedTab, pluginTabs, onRequestedTabHandled])

  // 监听 iframe 的 postMessage（页面 → 宿主），转发到主进程 IPC 并回包。
  // 插件页用 window.parent.postMessage 把请求发到宿主 window；宿主调主进程 API 后，
  // 再用 iframe.contentWindow.postMessage 把结果送回页面。纯 HTML5 跨文档通信，
  // 不依赖任何 <webview> preload（本机 Electron 44 下 webview 的 preload 始终不执行，
  // 这是插件页此前永远 timeout / 数据 undefined 的死结）。
  useEffect(() => {
    const handler = (data: unknown): void => {
      if (!data || typeof data !== 'object') return
      const d = data as Record<string, unknown>
      // 只处理插件桥协议：带 id + method 的请求。其余 window message（如插件 ready 心跳）
      // 一律忽略。注意页面 callHost 用 Date.now()+Math.random() 生成「数值」id，
      // 所以 id 可能是 number；只用「是否为空」校验，不要强求 string，否则会被早退。
      if (d.id == null || typeof d.method !== 'string') return

      const { id, method, args } = d as { id: string | number; method: string; args: unknown }
      const api = window.api as Record<string, unknown>

      // 解析 method 路径，如 platform:list → api.core.list
      const [namespace, func] = method.split(':')
      // 命名空间映射：插件页用 platform，实际 API 是 core（避免与 process.platform 冲突）
      const nsMap: Record<string, string> = { platform: 'core', library: 'library', settings: 'settings' }
      const actualNs = nsMap[namespace] || namespace
      const ns = api[actualNs] as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined
      const fn = ns?.[func]

      // 宿主 → 页面：iframe 是跨文档，用 contentWindow.postMessage 直发，
      // 插件页 window.addEventListener('message') 即可收到（无需 preload 中转）。
      const reply = (payload: unknown): void => {
        iframeRef.current?.contentWindow?.postMessage(payload, '*')
      }

      if (typeof fn === 'function') {
        // 页面总是传一个 args 对象（无参时传 {}），直接展开即可；无参 API 会忽略多出的实参。
        Promise.resolve(fn.call(ns, args))
          .then((result) => reply({ id, result }))
          .catch((err: Error) => reply({ id, error: err.message }))
      } else {
        reply({ id, error: `Unknown method: ${method}` })
      }
    }

    // 入向只走宿主 window 的 message 事件：iframe 里 window.parent === 真实宿主窗口，
    // 插件页 window.parent.postMessage 的请求直接落在这里。只接 type:'plugin:invoke'
    // 的桥协议请求，其余 window message（如页面 ready 心跳、第三方脚本）一律忽略；
    // 回包走 contentWindow，不经此监听，不会误触发。
    const winHandler = (e: MessageEvent): void => {
      if (!e.data || (e.data as Record<string, unknown>).type !== 'plugin:invoke') return
      handler(e.data)
    }
    window.addEventListener('message', winHandler)
    return () => window.removeEventListener('message', winHandler)
  }, [activeTab, uiUrl])

  // 流式任务输出转发到 iframe 插件页
  useEffect(() => {
    if (activeTab === 'device') return

    const offOutput = window.api.onTaskOutput((d) => {
      if (d.id.startsWith('platform-install-') || d.id.startsWith('library-install-')) {
        // iframe 跨文档回包：contentWindow.postMessage 直发，页面监听 message 即可收到
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
      {/* 顶部选项卡。P2-20：插件可继续贡献 tab，故必须用标准 tab 语义——
          裸 div+onClick 既无法被辅助技术/自动化命中，也不可键盘操作。 */}
      <div className="toolchain-tabs" role="tablist">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            aria-selected={activeTab === tab.id}
            className={`toolchain-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.id === 'device' ? undefined : tab.label}
            {...(tab.id === 'device' ? hint('target') : {})}
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
        {[...WEB_TABS, ...pluginTabs.map((t) => t.id)].map((tab) => {
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
          // 用普通 iframe 承载插件页：iframe 里 window.parent 就是真实宿主窗口，
          // 插件页用 window.parent.postMessage 把请求直接发到宿主 window 的 message 监听，
          // 宿主再用 iframe.contentWindow.postMessage 回包。纯 HTML5 跨文档通信，
          // 不依赖 <webview> 的 preload（本机 Electron 44 下 webview preload 始终不执行，
          // 是以往插件页永远 timeout / 数据 undefined 的死结）。
          return (
            <iframe
              key={tab}
              ref={iframeRef}
              src={uiUrl}
              className="toolchain-webview"
              title={TABS.find((t) => t.id === tab)?.label ?? tab}
            />
          )
        })}
      </div>
    </div>
  )
}

export default ToolchainSidebar

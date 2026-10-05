import { useEffect, useRef, useState } from 'react'

interface MenuItem {
  label: string
  shortcut?: string
  action: string
  separator?: boolean
}

const MENU_TREE: Record<string, MenuItem[]> = {
  文件: [
    { label: '新建工程…', shortcut: 'Ctrl+Shift+N', action: 'newProject' },
    { label: '新建文件', shortcut: 'Ctrl+N', action: 'newFile' },
    { label: '打开文件夹…', shortcut: 'Ctrl+O', action: 'openProject' },
    { label: '保存', shortcut: 'Ctrl+S', action: 'save' },
    { label: '关闭项目', shortcut: 'Ctrl+Shift+W', action: 'closeProject' },
    { label: '', action: '', separator: true },
    { label: '退出', shortcut: 'Ctrl+Q', action: 'exit' },
  ],
  编辑: [
    { label: '撤销', shortcut: 'Ctrl+Z', action: 'undo' },
    { label: '重做', shortcut: 'Ctrl+Y', action: 'redo' },
    { label: '', action: '', separator: true },
    { label: '剪切', shortcut: 'Ctrl+X', action: 'cut' },
    { label: '复制', shortcut: 'Ctrl+C', action: 'copy' },
    { label: '粘贴', shortcut: 'Ctrl+V', action: 'paste' },
    { label: '全选', shortcut: 'Ctrl+A', action: 'selectAll' },
  ],
  视图: [
    { label: '放大', shortcut: 'Ctrl+=', action: 'zoomIn' },
    { label: '缩小', shortcut: 'Ctrl+-', action: 'zoomOut' },
    { label: '重置缩放', shortcut: 'Ctrl+0', action: 'zoomReset' },
    { label: '', action: '', separator: true },
    { label: '切换主题（浅/深）', shortcut: 'Ctrl+T', action: 'toggleTheme' },
    { label: '全屏切换', shortcut: 'F11', action: 'toggleFullscreen' },
    { label: '切换终端', shortcut: 'Ctrl+`', action: 'toggleTerminal' },
    { label: '', action: '', separator: true },
    { label: '设置…', shortcut: 'Ctrl+,', action: 'openSettings' },
  ],
  帮助: [
    { label: '关于 LabCode', action: 'about' },
  ],
}

interface TitleBarProps {
  onNewProject: () => void
  onNewFile: () => void
  onOpenProject: () => void
  onSave: () => void
  onCloseProject: () => void
  onExit: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
  onCompile: () => void
  onUpload: () => void
  onToggleTerminal: () => void
  onToggleDebug: () => void
  debugVisible: boolean
  /** 底部「输出」面板是否打开（终端/串口/问题都在它里面） */
  terminalVisible: boolean
  onToggleTarget: () => void
  targetVisible: boolean
  onToggleGit: () => void
  gitVisible: boolean
  leftPanelVisible: boolean
  editorVisible: boolean
  onToggleLeftPanel: () => void
  onToggleEditor: () => void
  busy: boolean
  compileState: 'idle' | 'compiling' | 'uploading' | 'success' | 'error'
  theme: 'light' | 'dark'
}

function TitleBar({
  onNewProject, onNewFile, onOpenProject, onSave, onCloseProject, onExit,
  onToggleTheme, onOpenSettings, onCompile, onUpload,   onToggleTerminal, onToggleDebug, debugVisible, terminalVisible, onToggleTarget, targetVisible, onToggleGit, gitVisible,
  leftPanelVisible, editorVisible, onToggleLeftPanel, onToggleEditor,
  busy, compileState, theme
}: TitleBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const barRef = useRef<HTMLElement>(null)

  useEffect(() => {
    window.api?.window?.isMaximized?.().then(setIsMaximized).catch(() => {})
    const off = window.api?.window?.onStateChanged?.((s) => setIsMaximized(s.maximized))
    return () => off?.()
  }, [])

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setOpenMenu(null)
        onOpenSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpenSettings])

  const execEdit = (cmd: string): void => {
    try { document.execCommand(cmd) } catch { /* ignore */ }
  }

  const handleAction = (action: string): void => {
    setOpenMenu(null)
    switch (action) {
      case 'newProject': onNewProject(); break
      case 'newFile': onNewFile(); break
      case 'openProject': onOpenProject(); break
      case 'save': onSave(); break
      case 'closeProject': onCloseProject(); break
      case 'exit': onExit(); break
      case 'undo': case 'redo': case 'cut': case 'copy': case 'paste': case 'selectAll':
        execEdit(action); break
      case 'zoomIn': window.api?.view?.zoomIn?.().catch(() => {}); break
      case 'zoomOut': window.api?.view?.zoomOut?.().catch(() => {}); break
      case 'zoomReset': window.api?.view?.zoomReset?.().catch(() => {}); break
      case 'toggleFullscreen': window.api?.view?.toggleFullscreen?.().catch(() => {}); break
      case 'toggleTheme': onToggleTheme(); break
      case 'toggleTerminal': onToggleTerminal(); break
      case 'openSettings': onOpenSettings(); break
      case 'about':
        alert('LabCode 代码实验室\n通用软件开发智能体 · 插件系统 · 桌面客户端\n版本 0.1.9')
        break
    }
  }

  return (
    <header className="titlebar" ref={barRef}>
      <div className="titlebar-drag">
        <span className="titlebar-logo">
          <svg width="28" height="28" viewBox="0 0 64 64" fill="none">
            <defs>
              <filter id="lc-emboss" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2.5" stdDeviation="2" floodColor="#000" floodOpacity="0.45"/>
              </filter>
              <linearGradient id="lc-bevel" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ffffff"/>
                <stop offset="1" stopColor="#e8e8e8"/>
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="14" fill="url(#lc-bevel)"/>
            <rect x="2.5" y="2.5" width="59" height="59" rx="11.5" stroke="#111111" strokeWidth="2.5"/>
            <text x="32" y="45" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-size="34" font-weight="900" fill="#111111" filter="url(#lc-emboss)" letter-spacing="-1">LC</text>
            <text x="32" y="43" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-size="34" font-weight="900" fill="#ffffff" letter-spacing="-1" opacity="0.18">LC</text>
          </svg>
        </span>
        <button className="titlebar-quick" title="文件树" onClick={onToggleLeftPanel} style={{ opacity: leftPanelVisible ? 1 : 0.5 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
        </button>
        <button className="titlebar-quick" title={editorVisible ? "折叠编辑器" : "还原编辑器"} onClick={onToggleEditor} style={{ opacity: editorVisible ? 1 : 0.5 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
        </button>
      </div>
      <nav className="titlebar-menus">
        {Object.keys(MENU_TREE).map((name) => (
          <div key={name} className="menu-wrapper">
            <span
              className={`menu ${openMenu === name ? 'active' : ''}`}
              onClick={() => setOpenMenu((v) => (v === name ? null : name))}
              onMouseEnter={() => openMenu && setOpenMenu(name)}
            >
              {name}
            </span>
            {openMenu === name && (
              <div className="dropdown">
                {MENU_TREE[name].map((item, i) =>
                  item.separator ? (
                    <div key={i} className="dropdown-sep" />
                  ) : (
                    <div key={i} className="dropdown-item" onClick={() => handleAction(item.action)}>
                      <span>{item.label}</span>
                      {item.shortcut && <span className="dropdown-shortcut">{item.shortcut}</span>}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="titlebar-tools">
        <button
          className={`tb-btn ${compileState === 'success' ? 'tb-success' : ''} ${compileState === 'error' ? 'tb-error' : ''}`}
          title={compileState === 'compiling' ? '编译中…' : compileState === 'uploading' ? '烧录中…' : compileState === 'success' ? '编译成功' : compileState === 'error' ? '编译失败' : '编译'}
          onClick={onCompile}
          disabled={busy}
        >
          {compileState === 'compiling' || compileState === 'uploading' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19.952 15.002a.75.75 0 1 0-1.06 1.06 7.5 7.5 0 0 1-10.603 0 .75.75 0 0 0-1.061 1.06 9 9 0 0 0 12.723 0Z"/><path d="M17.474 12.53a.75.75 0 0 1 0 1.06l-1.061 1.06a.75.75 0 0 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Z"/><path d="M12 3a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 12 3Z"/></svg>
          ) : compileState === 'success' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          ) : compileState === 'error' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>
          )}
        </button>
        <button
          className="tb-btn"
          title="烧录到开发板"
          onClick={onUpload}
          style={{
            background: 'var(--accent, #3b82f6)',
            color: '#fff',
            borderRadius: 6,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        </button>
        <div className="tb-sep" />
        {/* 第二段：面板开关（都切底部面板组，顺序 = 日常工作流顺序） */}
        <button
          className={`tb-btn ${terminalVisible ? 'tb-success' : ''}`}
          title="输出（编译输出 / 串口 / 终端 / 问题）"
          onClick={onToggleTerminal}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
        </button>
        <button
          className={`tb-btn ${debugVisible ? 'tb-success' : ''}`}
          title="片上调试器（JTAG/DAP，openocd + telnet）"
          onClick={onToggleDebug}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11"/></svg>
        </button>
        <button
          className={`tb-btn ${gitVisible ? 'tb-success' : ''}`}
          title="Git（变更 / 分支 / 提交历史）"
          onClick={onToggleGit}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="6.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="17.5" cy="9.5" r="2.5"/><path d="M6.5 8v8M9 5.5h4a4.5 4.5 0 0 1 4.5 4M15 14.6a4.5 4.5 0 0 1-4.5 3.9H9"/></svg>
        </button>
        <button
          className={`tb-btn ${targetVisible ? 'tb-success' : ''}`}
          title="硬件目标（板卡 / 构建路径 / 烧录 / 调试器，ESP32 与 STM32 统一）"
          onClick={onToggleTarget}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5H6.5M3 14.5H6.5M17.5 9.5H21M17.5 14.5H21"/></svg>
        </button>
        <div className="tb-sep" />
        {/* PlatformIO 面板不再占工具栏位置：它属于「构建路径 = PlatformIO」时的操作面板，
            从硬件目标面板进入即可（选 PlatformIO 路径会自动切过去），避免两个入口含义重叠。 */}
        <button className="tb-btn" title="搜索">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
        </button>
      </div>
      <div className="titlebar-spacer" />
      <div className="titlebar-window">
        <button className="win-btn minimize" onClick={() => window.api?.window?.minimize?.()} title="最小化">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor"/></svg>
        </button>
        <button className="win-btn maximize" onClick={() => window.api?.window?.maximize?.()} title={isMaximized ? '还原' : '最大化'}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="0.5" y="2.5" width="7" height="7" fill="currentColor"/></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          )}
        </button>
        <button className="win-btn close" onClick={() => window.api?.window?.close?.()} title="关闭">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5,0.5 L9.5,9.5 M9.5,0.5 L0.5,9.5" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </header>
  )
}

export default TitleBar

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import DeviceDiagnosticsModal from './DeviceDiagnosticsModal'

interface DevicePanelInfo {
  plugin: string
  id: string
  title: string
  icon?: string
  selectors: Array<{
    id: string
    title: string
    key: string
    searchable?: boolean
    placeholder?: string
    source?: { transport: string; service?: string; method?: string }
  }>
  actions: Array<{
    id: string
    title: string
    kind: string
    transport?: string
    internal?: { service?: string; method?: string }
  }>
}

interface ToolchainState {
  checking: boolean
  available: boolean
  version: string
  installing: boolean
  installPhase: string
  installPercent: number
  installMessage: string
  installError: string
}

interface DevicePanelProps {
  projectRoot?: string | null
  onBoardChange?: (fqbn: string, name?: string) => void
  onPortChange?: (port: string) => void
  onOpenSerialWindow?: () => void
  onGenerateWiring?: () => void
  onOpenFile?: (path: string, name?: string) => void
}

// 插件未声明设备面板时的内置兜底面板：保证「开发板 / 端口 / 烧录」始终可见可用，
// 避免 panels 为空时整个设备面板空白（表现为烧录与端口识别"没有实现"）。
const FALLBACK_PANEL: DevicePanelInfo = {
  plugin: 'builtin',
  id: 'builtin-device',
  title: '设备',
  icon: '🔌',
  selectors: [
    {
      id: 'board',
      title: '开发板',
      key: 'fqbn',
      searchable: true,
      placeholder: '搜索开发板…',
      source: { transport: 'backend', service: 'toolchain', method: 'boardSearch' }
    },
    {
      id: 'port',
      title: '端口',
      key: 'port',
      source: { transport: 'backend', service: 'serialport', method: 'list' }
    }
  ],
  actions: [
    { id: 'open-monitor', title: '串口监视器', kind: 'action', transport: 'internal', internal: { service: 'serialLog', method: 'open' } },
    { id: 'wiring', title: '生成接线图', kind: 'action', transport: 'internal', internal: { service: 'wiring', method: 'generate' } }
  ]
}

function DevicePanel({ projectRoot, onBoardChange, onPortChange, onOpenSerialWindow, onGenerateWiring, onOpenFile }: DevicePanelProps): React.JSX.Element | null {
  const [diagOpen, setDiagOpen] = useState(false)
  const [panels, setPanels] = useState<DevicePanelInfo[]>([])
  const [boards, setBoards] = useState<Array<{ fqbn: string; name: string; platform?: string }>>([])
  const [ports, setPorts] = useState<Array<{ path: string; manufacturer?: string }>>([])
  const [deviceCtx, setDeviceCtx] = useState<{ board: string; port: string }>({ board: '', port: '' })
  const [boardSearch, setBoardSearch] = useState('')
  const [boardMenuOpen, setBoardMenuOpen] = useState(false)
  const [loadingBoards, setLoadingBoards] = useState(false)
  const [boardOptions, setBoardOptions] = useState<Array<{ option: string; label: string; values: Array<{ value: string; label: string }> }>>([])
  const [optionValues, setOptionValues] = useState<Record<string, Record<string, string>>>(() => {
    try { return JSON.parse(localStorage.getItem('codelab-board-options') || '{}') } catch { return {} }
  })
  // 与 optionValues 同步的最新值，供写盘路径读（避免用到渲染期快照）
  const optionValuesRef = useRef(optionValues)
  optionValuesRef.current = optionValues
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [toolchain, setToolchain] = useState<ToolchainState>({
    checking: true,
    available: false,
    version: '',
    installing: false,
    installPhase: '',
    installPercent: 0,
    installMessage: '',
    installError: ''
  })
  const initRef = useRef(false)

  // 检测工具链状态
  const checkToolchain = (): void => {
    setToolchain((prev) => ({ ...prev, checking: true }))
    window.api.toolchain.detectDirect()
      .then((s) => {
        setToolchain((prev) => ({
          ...prev,
          checking: false,
          available: s.available,
          version: s.version
        }))
      })
      .catch(() => setToolchain((prev) => ({ ...prev, checking: false, available: false })))
  }

  // 一键安装 arduino-cli
  const handleInstall = (): void => {
    if (toolchain.installing) return
    setToolchain((prev) => ({ ...prev, installing: true, installError: '', installPercent: 0, installMessage: '准备安装…' }))
    const off = window.api.toolchain.onInstallProgress((p) => {
      setToolchain((prev) => ({
        ...prev,
        installPhase: p.phase,
        installPercent: p.percent,
        installMessage: p.message
      }))
    })
    window.api.toolchain.install()
      .then((result) => {
        off()
        if (result.success) {
          setToolchain((prev) => ({
            ...prev,
            installing: false,
            available: true,
            version: result.path || '',
            installMessage: '安装成功'
          }))
          // 安装成功后自动加载板卡列表
          setTimeout(() => loadBoards(''), 500)
        } else {
          setToolchain((prev) => ({
            ...prev,
            installing: false,
            installError: result.error || '安装失败'
          }))
        }
      })
      .catch((err) => {
        off()
        setToolchain((prev) => ({ ...prev, installing: false, installError: String(err) }))
      })
  }

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    // 加载设备面板声明
    window.api.plugin.devicePanels().then((p) => setPanels(p as unknown as DevicePanelInfo[])).catch(() => setPanels([]))
    // 加载设备上下文
    window.api.device.get().then((d) => {
      setDeviceCtx({ board: d.board || '', port: d.port || '' })
      // 启动时已有板卡 → 自动加载配置项（分区方案等），对齐 TrieCode 行为
      if (d.board) loadOptions(d.board)
    }).catch(() => undefined)
    // 启动即加载板卡列表（默认按 ESP32 平台过滤，避免无关 AVR 老板卡刷屏；对齐 TrieCode 默认展示 ESP32-C3 系列）
    loadBoards('esp32')
    // 加载端口
    window.api.serial.list().then((p) => setPorts(p as Array<{ path: string; manufacturer?: string }>)).catch(() => undefined)
    // 检测工具链
    checkToolchain()
  }, [])

  // 热插拔：端口变化自动刷新下拉；自动选中事件同步本地选中态（与 App 全局状态一致）
  useEffect(() => {
    const offPorts = window.api.serial.onPortsChanged?.((d) => {
      setPorts(d.ports as Array<{ path: string; manufacturer?: string }>)
    })
    const offAuto = window.api.device.onAutoSelect?.((d) => {
      if (d.action === 'added') {
        setDeviceCtx((prev) => ({ board: d.fqbn || prev.board, port: d.port || prev.port }))
        if (d.fqbn) loadOptions(d.fqbn)
      } else if (d.action === 'removed') {
        setDeviceCtx((prev) => ({ ...prev, port: d.removed?.includes(prev.port) ? '' : prev.port }))
      }
    })
    return () => {
      offPorts?.()
      offAuto?.()
      // 卸载时把待触发的防抖查询也清掉，否则会对着已卸载的组件再发一次 IPC
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * board.list 背后是 spawnSync(arduino-cli board listall)，**同步阻塞主进程最多 20s**，
   * 而且输出有 1MB+。所以：
   *   1) 搜索框必须防抖 —— 之前每个击键都发一次 IPC，敲 "esp32" 就起 5 次子进程，
   *      主线程被卡住 → 整个 IDE 输入都掉帧，这是用户能直接感觉到的卡顿。
   *   2) 必须带请求序号 —— 并发请求谁先回来谁就 setBoards，会拿旧结果覆盖新结果
   *      （输入 "esp" 的慢请求后于 "esp32" 的快请求回来 → 列表变回少一条）。
   *      只认最后一次发出的请求，中间被淘汰的一律不落 state。
   */
  const boardSeqRef = useRef(0)
  const loadBoards = (keyword?: string): void => {
    const seq = ++boardSeqRef.current
    setLoadingBoards(true)
    window.api.board.list(keyword || '')
      .then((b) => { if (seq === boardSeqRef.current) setBoards(b) })
      .catch(() => { if (seq === boardSeqRef.current) setBoards([]) })
      .finally(() => { if (seq === boardSeqRef.current) setLoadingBoards(false) })
  }

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadBoardsDebounced = useCallback((kw: string): void => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null
      loadBoards(kw)
    }, 300)
  }, [])

  const selectBoard = (fqbn: string, name?: string): void => {
    setDeviceCtx((prev) => ({ ...prev, board: fqbn }))
    window.api.device.set({ board: fqbn }).catch(() => undefined)
    onBoardChange?.(fqbn, name)
    // 加载板卡选项
    loadOptions(fqbn)
  }

  const loadOptions = (fqbn: string): void => {
    if (!fqbn) { setBoardOptions([]); return }
    setLoadingOptions(true)
    window.api.board.details(fqbn)
      .then((d) => {
        setBoardOptions(d.options || [])
        // 恢复该板卡已保存的选项值
        const saved = optionValues[fqbn] || {}
        setOptionValues((prev) => ({ ...prev, [fqbn]: { ...saved } }))
      })
      .catch(() => setBoardOptions([]))
      .finally(() => setLoadingOptions(false))
  }

  const buildFullFqbn = (baseFqbn: string, opts: Record<string, string>): string => {
    const parts = Object.entries(opts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)
    return parts.length > 0 ? `${baseFqbn}:${parts.join(',')}` : baseFqbn
  }

  const changeOption = (opt: string, value: string): void => {
    const base = deviceCtx.board
    if (!base) return
    // 从 ref 读最新值再写盘：写的是渲染期 optionValues 快照，
    // 同一个 tick 里连改两项时第二项会把第一项从 localStorage 里抹掉。
    const nextAll = { ...optionValuesRef.current, [base]: { ...optionValuesRef.current[base], [opt]: value } }
    optionValuesRef.current = nextAll
    setOptionValues(nextAll)
    localStorage.setItem('codelab-board-options', JSON.stringify(nextAll))
    // 拼完整 fqbn 回调
    onBoardChange?.(buildFullFqbn(base, nextAll[base]))
  }

  const selectPort = (port: string): void => {
    setDeviceCtx((prev) => ({ ...prev, port }))
    window.api.device.set({ port }).catch(() => undefined)
    onPortChange?.(port)
  }

  const refreshPorts = (): void => {
    window.api.serial.list()
      .then((p) => setPorts(p as Array<{ path: string; manufacturer?: string }>))
      .catch(() => undefined)
  }

  const handleAction = (action: DevicePanelInfo['actions'][0]): void => {
    // 串口监视器 → 打开独立窗口
    if (action.internal?.service === 'serialLog' && action.internal?.method === 'open') {
      onOpenSerialWindow?.()
      return
    }
    // 生成接线图 → 调用主进程接线图服务并弹窗展示
    if (action.internal?.service === 'wiring' && action.internal?.method === 'generate') {
      onGenerateWiring?.()
      return
    }
    // 其他 action → 通过 capability 路由执行
    const capId = action.id.replace(/^.*?\./, '')
    try {
      void window.api.capability.run(capId, { port: deviceCtx.port, fqbn: deviceCtx.board })
    } catch {
      /* 忽略未绑定的能力 */
    }
  }

  // 插件未就绪时回退到内置面板，避免整块设备面板空白
  const renderPanels = panels.length > 0 ? panels : [FALLBACK_PANEL]

  const filteredBoards = boardSearch
    ? boards.filter((b) => b.name.toLowerCase().includes(boardSearch.toLowerCase()) || b.fqbn.toLowerCase().includes(boardSearch.toLowerCase()))
    : boards

  return (
    <div className="device-panel">
      {renderPanels.map((panel) => (
        <div key={panel.id} className="device-panel-section">
          <div className="device-panel-title">
            <span>{panel.icon || '🔌'} {panel.title}</span>
          </div>

          {/* 工具链状态：未检测到时显示一键安装按钮 */}
          {toolchain.checking ? (
            <div className="toolchain-status">
              <span className="toolchain-checking">正在检测工具链…</span>
            </div>
          ) : !toolchain.available ? (
            <div className="toolchain-install">
              <div className="toolchain-warning">
                ⚠️ 未检测到 Arduino CLI 工具链
              </div>
              {toolchain.installing ? (
                <div className="toolchain-progress">
                  <div className="toolchain-progress-bar">
                    <div
                      className="toolchain-progress-fill"
                      style={{ width: `${toolchain.installPercent}%` }}
                    />
                  </div>
                  <div className="toolchain-progress-text">
                    {toolchain.installMessage || `安装中… ${toolchain.installPercent}%`}
                  </div>
                </div>
              ) : (
                <>
                  <button className="toolchain-install-btn" onClick={handleInstall}>
                    一键安装 Arduino CLI
                  </button>
                  {toolchain.installError && (
                    <div className="toolchain-error">{toolchain.installError}</div>
                  )}
                  <div className="toolchain-hint">
                    自动下载并安装到用户目录，无需管理员权限
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="toolchain-ok">
              ✅ Arduino CLI 已就绪
            </div>
          )}

          {panel.selectors.map((sel) => {
            const isBoard = sel.source?.method === 'boardSearch' || (sel.source?.service === 'arduinoCli' && sel.source?.method === 'board.search')
            // 兼容两种 manifest 写法：插件注册的是 backend `serial.list`，
            // manifest 里可能写 service:"serialport" 或 "serial"，两者都识别为端口选择器
            const isPort = (sel.source?.service === 'serialport' || sel.source?.service === 'serial') && sel.source?.method === 'list'

            if (isBoard) {
              const selectedName = boards.find((b) => b.fqbn === deviceCtx.board)?.name || deviceCtx.board || ''
              return (
                // key 必须挂在外层 Fragment 上：React 列表的 key 校验看的是 map 的直接返回值，
                // 之前挂在里面那层 div 上，每次渲染都刷一条「Each child in a list should have a unique key」
                <Fragment key={sel.id}>
                  <div className="device-field">
                    <label>{sel.title}</label>
                    <div className="device-search-wrap">
                      {/* TrieCode 风格：点击展开可搜索板卡列表 */}
                      <div
                        className={`device-board-trigger ${boardMenuOpen ? 'open' : ''}`}
                        onClick={() => {
                          const next = !boardMenuOpen
                          setBoardMenuOpen(next)
                          if (next && boards.length === 0) loadBoards('')
                        }}
                      >
                        <span className={`device-board-trigger-name ${deviceCtx.board ? '' : 'placeholder'}`}>
                          {selectedName || '选择开发板…'}
                        </span>
                        <span className="device-board-caret">▾</span>
                      </div>
                      {boardMenuOpen && (
                        <div className="device-dropdown board-menu">
                          <input
                            className="device-search"
                            placeholder={sel.placeholder || '搜索…'}
                            value={boardSearch}
                            onChange={(e) => {
                              setBoardSearch(e.target.value)
                              // 防抖：见 loadBoards 注释，关键字查询不能每击键一次
                              loadBoardsDebounced(e.target.value)
                            }}
                            autoFocus
                          />
                          <div className="device-dropdown-list">
                            {filteredBoards.slice(0, 60).map((b) => (
                              <div
                                key={b.fqbn}
                                className={`device-option ${deviceCtx.board === b.fqbn ? 'active' : ''}`}
                                onClick={() => {
                                  selectBoard(b.fqbn, b.name)
                                  setBoardMenuOpen(false)
                                }}
                              >
                                <span className="device-option-name">{b.name}</span>
                                <span className="device-option-fqbn">{b.fqbn}</span>
                              </div>
                            ))}
                            {filteredBoards.length === 0 && (
                              <div className="device-option-empty">{loadingBoards ? '加载中…' : '无匹配板卡'}</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    <button className="device-refresh" onClick={() => loadBoards(boardSearch)} disabled={loadingBoards}>
                      {loadingBoards ? '加载中…' : '刷新板卡'}
                    </button>
                  </div>
                  {/* 板卡配置选项（分区方案 / CPU 频率 / Flash / 上传速度等），对齐 TrieCode 直列展示 */}
                  {deviceCtx.board && boardOptions.length > 0 && (
                    <div className="device-field device-options-block">
                      {loadingOptions ? (
                        <div className="device-option-loading">加载选项中…</div>
                      ) : (
                        boardOptions.map((opt) => (
                          <div key={opt.option} className="device-option-row">
                            <span className="device-option-label">{opt.label}</span>
                            <select
                              className="device-select device-option-select"
                              value={(optionValues[deviceCtx.board] || {})[opt.option] || opt.values[0]?.value || ''}
                              onChange={(e) => changeOption(opt.option, e.target.value)}
                            >
                              {opt.values.map((v) => (
                                <option key={v.value} value={v.value}>{v.label}</option>
                              ))}
                            </select>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Fragment>
              )
            }

            if (isPort) {
              return (
                <div key={sel.id} className="device-field">
                  <label>{sel.title}</label>
                  <div className="device-port-row">
                    <select className="device-select" value={deviceCtx.port} onChange={(e) => selectPort(e.target.value)}>
                      <option value="">未选择</option>
                      {ports.map((p) => (
                        <option key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` - ${p.manufacturer}` : ''}</option>
                      ))}
                    </select>
                    <button className="device-refresh" onClick={refreshPorts}>↻</button>
                  </div>
                </div>
              )
            }

            return null
          })}

          {panel.actions.length > 0 && (
            <div className="device-actions">
              {panel.actions.map((action) => (
                <button
                  key={action.id}
                  className="device-action-btn"
                  onClick={() => handleAction(action)}
                >
                  {action.title}
                </button>
              ))}
            </div>
          )}

          {/* 诊断工具组：引脚冲突 / 烧录历史 / 分享卡片 */}
          <div className="device-actions">
            <button className="device-action-btn" onClick={() => setDiagOpen(true)} title="引脚冲突检测、烧录快照回滚、生成分享卡片">
              🔧 诊断与回滚
            </button>
          </div>
        </div>
      ))}

      {diagOpen && (
        <DeviceDiagnosticsModal
          projectRoot={projectRoot}
          board={deviceCtx.board}
          port={deviceCtx.port}
          onClose={() => setDiagOpen(false)}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
}

export default DevicePanel

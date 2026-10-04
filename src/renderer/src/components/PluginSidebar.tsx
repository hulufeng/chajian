import { useState, useEffect } from 'react'

interface Plugin {
  id: string
  name: string
  version: string
  developer: string
  desc: string
  installed: boolean
  installing?: boolean
  icon: string
  iconBg: string
  downloadUrl: string
  installedCount: number
  updatedAt: string
}

interface ModelDef {
  id: string
  name: string
  displayName: string
  description: string
  parameters: string
  quantization: string
  sizeGB: number
  minRAMGB: number
  minVRAMGB: number
  ollamaTag: string
  ggufFile: string
  category: string
  tier: 'S' | 'M' | 'L' | 'XL'
  recommended?: boolean
  icon: string
}

interface HardwareInfo {
  cpu: { model: string; cores: number; threads: number }
  totalRAMGB: number
  gpus: Array<{ name: string; vendor: string; vramMB: number }>
  capability: { canRun7B: boolean; canRun13B: boolean; canRun34B: boolean; hasGPU: boolean; vramGB: number }
}

/** 根据硬件配置判定档位 */
function getHardwareTier(hw: HardwareInfo): 'S' | 'M' | 'L' | 'XL' {
  const { totalRAMGB, capability } = hw
  if (capability.hasGPU && totalRAMGB >= 24 && capability.vramGB >= 8) return 'XL'
  if (totalRAMGB >= 16) return 'L'
  if (totalRAMGB >= 8) return 'M'
  return 'S'
}

/** 根据模型规模判定档位（catalog 不返回 tier，由前端派生） */
function getModelTier(m: { sizeGB: number; minRAMGB: number }): 'S' | 'M' | 'L' | 'XL' {
  if (m.sizeGB >= 30 || m.minRAMGB >= 24) return 'XL'
  if (m.sizeGB >= 12 || m.minRAMGB >= 16) return 'L'
  if (m.sizeGB >= 5 || m.minRAMGB >= 8) return 'M'
  return 'S'
}

declare global {
  interface Window {
    api: import('../../../preload').Api
  }
}


function PluginSidebar(): React.JSX.Element {
  const [tab, setTab] = useState<'market' | 'installed' | 'models'>('market')
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [models, setModels] = useState<ModelDef[]>([])
  const [localModels, setLocalModels] = useState<string[]>([])
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<{ installed: boolean; running: boolean; version?: string; engineDir?: string }>({ installed: false, running: false })
  const [pulling, setPulling] = useState<Record<string, { percent: number; status: string }>>({})
  const [loading, setLoading] = useState(false)
  const [marketLoading, setMarketLoading] = useState(false)

  useEffect(() => {
    loadModelData()
    loadMarketPlugins()
    const unsub = window.api.model.onPullProgress((p) => {
      setPulling((prev) => ({ ...prev, [p.tag]: { percent: p.percent, status: p.status } }))
    })
    return unsub
  }, [])

  const loadMarketPlugins = async (): Promise<void> => {
    setMarketLoading(true)
    try {
      const list = await window.api.plugin.market()
      setPlugins(list.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        developer: p.developer,
        desc: p.description,
        installed: p.installed || false,
        icon: p.icon,
        iconBg: 'rgba(74,125,255,0.1)',
        downloadUrl: p.downloadUrl,
        installedCount: p.installedCount,
        updatedAt: p.updatedAt,
      })))
    } catch (e) {
      console.warn('加载插件市场失败:', e)
    }
    setMarketLoading(false)
  }

  const loadModelData = async (): Promise<void> => {
    setLoading(true)
    try {
      const [hw, catalog, local, status] = await Promise.all([
        window.api.hardware.info(),
        window.api.model.catalog(),
        window.api.model.local(),
        window.api.model.ollamaStatus(),
      ])
      setHardware(hw)
      setModels(catalog.map((m) => ({ ...m, tier: getModelTier(m) })))
      setLocalModels(local.map((m) => m.id))
      setOllamaStatus(status)
    } catch (e) {
      console.warn('加载模型数据失败:', e)
    }
    setLoading(false)
  }

  const installModel = async (model: ModelDef): Promise<void> => {
    // 内置 llama.cpp 引擎 + GGUF 直链下载，无需安装 Ollama
    setPulling((prev) => ({ ...prev, [model.ggufFile]: { percent: 1, status: '准备下载引擎...' } }))
    try {
      await window.api.model.pull(model.ollamaTag)
      setLocalModels((prev) => prev.includes(model.ggufFile) ? prev : [...prev, model.ggufFile])
      setOllamaStatus((prev) => ({ ...prev, installed: true }))
    } catch (e) {
      alert(`模型下载失败: ${(e as Error).message}`)
    }
    setPulling((prev) => {
      const next = { ...prev }
      delete next[model.ggufFile]
      return next
    })
  }

  const uninstallModel = async (file: string): Promise<void> => {
    if (!confirm(`确定要删除模型 ${file} 吗？`)) return
    const ok = await window.api.model.delete(file)
    if (ok) setLocalModels((prev) => prev.filter((m) => m !== file))
    else alert('删除失败：文件不存在或已被占用')
  }

  const installPlugin = async (plugin: Plugin): Promise<void> => {
    setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, installing: true } : p))
    try {
      const result = await window.api.plugin.install(plugin.id, plugin.downloadUrl)
      if (result.success) {
        setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, installed: true, installing: false } : p))
        alert(`插件 ${plugin.name} 安装成功！重启后生效。`)
      } else {
        setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, installing: false } : p))
        alert(`安装失败: ${result.message}`)
      }
    } catch (e) {
      setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, installing: false } : p))
      alert(`安装失败: ${(e as Error).message}`)
    }
  }

  const uninstallPlugin = async (plugin: Plugin): Promise<void> => {
    if (!confirm(`确定要卸载插件 ${plugin.name} 吗？`)) return
    try {
      const result = await window.api.plugin.uninstall(plugin.id)
      if (result.success) {
        setPlugins((prev) => prev.map((p) => p.id === plugin.id ? { ...p, installed: false } : p))
        alert(`插件 ${plugin.name} 已卸载。`)
      } else {
        alert(`卸载失败: ${result.message}`)
      }
    } catch (e) {
      alert(`卸载失败: ${(e as Error).message}`)
    }
  }

  const list = tab === 'installed' ? plugins.filter((p) => p.installed) : plugins
  const isModelInstalled = (tag: string): boolean => localModels.includes(tag)

  const canRunModel = (model: ModelDef): boolean => {
    if (!hardware) return true
    const params = parseInt(model.parameters, 10)
    if (params <= 4) return true
    if (params <= 8) return hardware.capability.canRun7B
    if (params <= 16) return hardware.capability.canRun13B
    return hardware.capability.canRun34B
  }

  return (
    <section className="plugin-section">
      <div className="sidebar-title">插件</div>
      <div className="sidebar-tabs">
        <div className={`sidebar-tab${tab === 'market' ? ' active' : ''}`} onClick={() => setTab('market')}>
          官方市场
        </div>
        <div className={`sidebar-tab${tab === 'models' ? ' active' : ''}`} onClick={() => setTab('models')}>
          大模型
        </div>
        <div className={`sidebar-tab${tab === 'installed' ? ' active' : ''}`} onClick={() => setTab('installed')}>
          已安装
        </div>
      </div>

      {tab === 'models' && (
        <div className="model-hardware-bar">
          {hardware ? (
            <div className="hardware-summary">
              <span className="hw-item">💻 {hardware.cpu.cores}核</span>
              <span className="hw-item">🧠 {hardware.totalRAMGB}GB</span>
              <span className="hw-item">
                {hardware.capability.hasGPU ? `🎮 ${hardware.capability.vramGB.toFixed(1)}GB显存` : '🎮 核显'}
              </span>
              <span className={`hw-badge tier-${getHardwareTier(hardware).toLowerCase()}`}>
                {getHardwareTier(hardware)}档配置
              </span>
              <span className={`hw-badge ${ollamaStatus.running ? 'ok' : 'warn'}`}>
                {ollamaStatus.running ? '本地引擎运行中' : ollamaStatus.installed ? '本地引擎已就绪' : '本地引擎未安装'}
              </span>
            </div>
          ) : (
            <div className="hardware-summary">检测硬件配置中...</div>
          )}
        </div>
      )}

      <div className="plugin-list">
        {tab !== 'models' && marketLoading && (
          <div className="plugin-empty">加载插件市场中...</div>
        )}
        {tab !== 'models' && !marketLoading && list.map((p) => (
          <div key={p.id} className="plugin-card-market">
            <div className="plugin-card-icon" style={{ background: p.iconBg }}>{p.icon}</div>
            <div className="plugin-card-body">
              <div className="plugin-card-title">
                <span className="plugin-card-name">{p.name}</span>
                <span className="plugin-card-ver">{p.version}</span>
              </div>
              <div className="plugin-card-desc" title={p.desc}>{p.desc}</div>
              <div className="model-meta">
                <span>👤 {p.developer}</span>
                <span>📥 {p.installedCount} 次安装</span>
                <span>📅 {p.updatedAt}</span>
              </div>
            </div>
            {p.installed ? (
              <button className="plugin-card-btn installed" onClick={() => uninstallPlugin(p)}>
                已安装 ✓
              </button>
            ) : p.installing ? (
              <button className="plugin-card-btn" disabled>
                安装中...
              </button>
            ) : (
              <button className="plugin-card-btn" onClick={() => installPlugin(p)}>
                安装
              </button>
            )}
          </div>
        ))}

        {tab !== 'models' && !marketLoading && list.length === 0 && (
          <div className="plugin-empty">{tab === 'installed' ? '暂无已安装插件' : '暂无可用插件'}</div>
        )}

        {tab === 'models' && models.map((m) => {
          const installed = isModelInstalled(m.ggufFile)
          const pullInfo = pulling[m.ggufFile]
          const canRun = canRunModel(m)
          return (
            <div key={m.id} className={`plugin-card-market model-card${m.recommended ? ' model-recommended' : ''}`}>
              <div className="plugin-card-icon" style={{ background: 'rgba(99,102,241,0.1)' }}>{m.icon}</div>
              <div className="plugin-card-body">
                <div className="plugin-card-title">
                  <span className="plugin-card-name">{m.displayName}</span>
                  <span className="plugin-card-ver">{m.parameters}</span>
                  <span className={`model-tier tier-${m.tier.toLowerCase()}`}>{m.tier}档</span>
                  {m.recommended && <span className="model-recommend-badge">推荐</span>}
                </div>
                <div className="plugin-card-desc" title={m.description}>{m.description}</div>
                <div className="model-meta">
                  <span>📦 {m.sizeGB}GB</span>
                  <span>⚡ {m.quantization}</span>
                  <span>🧠 需{m.minRAMGB}GB内存</span>
                  {!canRun && <span className="model-warn">⚠️ 配置可能不足</span>}
                </div>
                {pullInfo && (
                  <div className="model-progress">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${pullInfo.percent}%` }} />
                    </div>
                    <span className="progress-text">{pullInfo.status} {pullInfo.percent}%</span>
                  </div>
                )}
              </div>
              {installed ? (
                <button className="plugin-card-btn installed" onClick={() => uninstallModel(m.ggufFile)}>
                  已安装 ✓
                </button>
              ) : pullInfo ? (
                <button className="plugin-card-btn" disabled>
                  下载中
                </button>
              ) : (
                <button className="plugin-card-btn" onClick={() => installModel(m)}>
                  下载
                </button>
              )}
            </div>
          )
        })}

        {tab === 'models' && !loading && models.length === 0 && (
          <div className="plugin-empty">暂无可用模型</div>
        )}
        {tab !== 'models' && list.length === 0 && (
          <div className="plugin-empty">暂无已安装插件</div>
        )}
      </div>
    </section>
  )
}

export default PluginSidebar

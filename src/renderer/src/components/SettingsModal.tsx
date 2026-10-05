import { useEffect, useState } from 'react'

type ShellType = 'powershell' | 'cmd' | 'pwsh' | 'bash'

interface SettingsProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onClose: () => void
  shell: ShellType
  onShellChange: (s: ShellType) => void
  language: 'zh' | 'en'
  onLanguageChange: (l: 'zh' | 'en') => void
  defaultTab?: string
}

const SHELL_OPTIONS: Array<{ value: ShellType; label: string }> = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: '命令提示符 (cmd)' },
  { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
  { value: 'bash', label: 'Bash (WSL / Git Bash)' }
]

const BYOK_PROVIDERS: Array<{ value: string; label: string; baseUrl: string; modelHint: string }> = [
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat / deepseek-reasoner' },
  { value: 'qwen', label: '通义千问 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: 'qwen-turbo / qwen-plus / qwen-max' },
  { value: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', modelHint: 'MiniMax-M2.7 / MiniMax-M2.5' },
  { value: 'kimi', label: '月之暗面 (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', modelHint: 'kimi-k2 / moonshot-v1-8k' },
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini / gpt-4o / gpt-4.1' },
  { value: 'claude', label: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1', modelHint: 'claude-3-5-sonnet / claude-3-opus' },
  { value: 'ollama', label: '内置本地引擎 (llama.cpp)', baseUrl: 'http://127.0.0.1:8080/v1', modelHint: 'qwen2.5-coder-3b / qwen2.5-coder-1.5b（大模型页下载，推荐 3B）' },
  { value: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelHint: 'glm-4.7-flash / glm-4.6' },
  { value: 'doubao', label: '豆包 (字节)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelHint: 'doubao-seed-1-6 / ep-xxxx' },
  { value: 'custom', label: '自定义 (OpenAI 兼容)', baseUrl: '', modelHint: '任意 OpenAI 兼容端点' }
]

const CATEGORIES = [
  { id: 'models', label: '模型', icon: '🧠' },
  { id: 'engine', label: '本地引擎', icon: '🖥️' },
  { id: 'svd', label: '寄存器数据', icon: '🧾' },
  { id: 'general', label: '常规', icon: '⚙️' },
  { id: 'skills', label: '技能', icon: '✨' },
  { id: 'plugins', label: '插件', icon: '🧩' },
  { id: 'hooks', label: '钩子', icon: '🪝' },
]

interface PluginItem {
  manifest: { name: string; displayName: string; version: string }
  loaded: boolean
  error?: string
}

function SettingsModal({ theme, onToggleTheme, onClose, shell, onShellChange, language, onLanguageChange, defaultTab }: SettingsProps): React.JSX.Element {
  const [active, setActive] = useState(defaultTab || 'general')
  const [plugins, setPlugins] = useState<PluginItem[]>([])
  const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem('codelab-fontsize')) || 14)
  // BYOK 自定义模型（多 profile）
  interface ByokProfile { id: string; name: string; baseUrl: string; apiKey: string; model: string }
  const [byokProfiles, setByokProfiles] = useState<ByokProfile[]>([])
  const [activeByokId, setActiveByokId] = useState<string | null>(null)
  const [editingByokId, setEditingByokId] = useState<string | null>(null) // null = 新建
  const [byokName, setByokName] = useState('')
  const [byokProvider, setByokProvider] = useState('custom')
  const [byokBaseUrl, setByokBaseUrl] = useState('')
  const [byokApiKey, setByokApiKey] = useState('')
  const [byokModel, setByokModel] = useState('')
  const [byokSaved, setByokSaved] = useState(false)

  // ── 寄存器数据（CMSIS-SVD）──
  interface SvdChip { chip: string; bytes: number; mtime: number }
  const [svdList, setSvdList] = useState<{ dir: string; installed: SvdChip[]; known: string[] } | null>(null)
  const [svdBusy, setSvdBusy] = useState<string | null>(null) // 正在操作的芯片
  const [svdProgress, setSvdProgress] = useState<number | null>(null)
  const [svdMsg, setSvdMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [svdImportChip, setSvdImportChip] = useState('esp32s3')

  // ── 本地模型引擎（llama.cpp）──
  interface EngineModel { id: string; name: string; sizeGB: number; quantization: string; parameters: string }
  interface EngineStatus { installed: boolean; running: boolean; version: string; engineDir: string }
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [engineModels, setEngineModels] = useState<EngineModel[]>([])
  const [engineSel, setEngineSel] = useState('')
  const [engineBusy, setEngineBusy] = useState<string | null>(null) // 'start' | 'stop' | 'models'
  const [engineMsg, setEngineMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const refreshEngine = (): void => {
    window.api.engine.status()
      .then((s) => setEngineStatus(s))
      .catch(() => setEngineStatus(null))
    window.api.engine.models()
      .then((m) => {
        setEngineModels(m)
        if (m.length > 0) setEngineSel((prev) => prev || m[0].id)
      })
      .catch(() => setEngineModels([]))
  }

  const refreshSvd = (): void => {
    window.api.svd.list().then((r) => {
      setSvdList({ dir: r.dir, installed: r.installed, known: r.known })
    }).catch((e: Error) => setSvdMsg({ text: e.message, ok: false }))
  }

  useEffect(() => {
    refreshSvd()
    const off = window.api.svd.onProgress((p) => setSvdProgress(p.percent))
    return () => off()
  }, [])

  useEffect(() => {
    refreshEngine()
  }, [])

  useEffect(() => {
    window.api.ai.state().then((s) => {
      // 加载多 BYOK profile
      const profiles = s.byokProfiles || []
      setByokProfiles(profiles)
      // 当前激活 profile：modelId === 'byok:<id>'
      const m = s.modelId
      if (m.startsWith('byok:')) {
        setActiveByokId(m.slice(5))
      } else if (m === 'byok' && profiles.length > 0) {
        setActiveByokId(profiles[0].id)
      } else {
        setActiveByokId(null)
      }
    }).catch(() => undefined)
    window.api.plugin.list().then(setPlugins).catch(() => setPlugins([]))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const applyFontSize = (v: number): void => {
    setFontSize(v)
    localStorage.setItem('codelab-fontsize', String(v))
    document.documentElement.style.setProperty('--editor-font-size', `${v}px`)
  }

  const catLabel = (id: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal">
        <div className="settings-head">
          <span>设置</span>
          <button className="settings-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="settings-body">
          <aside className="settings-nav">
            {CATEGORIES.map((c) => (
              <div
                key={c.id}
                className={`settings-nav-item ${active === c.id ? 'active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                <span className="settings-nav-icon">{c.icon}</span>
                <span>{c.label}</span>
              </div>
            ))}
          </aside>
          <section className="settings-content">
            {active === 'models' && (
              <div className="settings-section">
                <h3>模型</h3>
                <p className="settings-desc">添加自己的 API Key 调用 DeepSeek、通义、Kimi、OpenAI 等模型。Key 仅保存在本地，不上传服务器。</p>

                {/* profile 卡片列表 */}
                {byokProfiles.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {byokProfiles.map((p) => (
                      <div key={p.id} className={`byok-card ${activeByokId === p.id ? 'active' : ''}`}>
                        <div className="byok-card-info">
                          <span className="byok-card-name">{p.name}</span>
                          <span className="byok-card-meta">{p.model} · {p.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        </div>
                        <div className="byok-card-actions">
                          {activeByokId === p.id
                            ? <span className="byok-badge-active">使用中</span>
                            : <button className="settings-btn" onClick={() => {
                                void window.api.ai.byokActivate(p.id).then((s) => {
                                  setActiveByokId(p.id)
                                })
                              }}>激活</button>
                          }
                          <button className="icon-btn" title="编辑" onClick={() => {
                            setEditingByokId(p.id)
                            setByokName(p.name)
                            setByokBaseUrl(p.baseUrl)
                            setByokApiKey(p.apiKey)
                            setByokModel(p.model)
                            const matched = BYOK_PROVIDERS.find((x) => p.baseUrl.startsWith(x.baseUrl))
                            setByokProvider(matched ? matched.value : 'custom')
                            setByokSaved(false)
                          }}>✎</button>
                          <button className="icon-btn" title="删除" onClick={() => {
                            void window.api.ai.byokDelete(p.id).then(() => {
                              void window.api.ai.byokProfiles().then(setByokProfiles)
                              setByokSaved(true)
                            })
                          }}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 空状态 */}
                {byokProfiles.length === 0 && editingByokId === null && (
                  <div className="byok-empty">
                    <div className="byok-empty-icon">🔑</div>
                    <div className="byok-empty-title">还没有自定义模型</div>
                    <div className="byok-empty-desc">添加你的 API Key，即可绕过服务器直接调用各厂商模型</div>
                    <button className="byok-primary-btn" onClick={() => {
                      setEditingByokId('')
                      setByokName('')
                      setByokProvider('deepseek')
                      setByokBaseUrl('https://api.deepseek.com/v1')
                      setByokApiKey('')
                      setByokModel('deepseek-chat')
                      setByokSaved(false)
                    }}>＋ 添加 API Key</button>
                  </div>
                )}

                {/* 新建按钮（有 profile 时） */}
                {byokProfiles.length > 0 && editingByokId === null && (
                  <div style={{ marginTop: 4 }}>
                    <button className="byok-primary-btn" onClick={() => {
                      setEditingByokId('')
                      setByokName('')
                      setByokProvider('deepseek')
                      setByokBaseUrl('https://api.deepseek.com/v1')
                      setByokApiKey('')
                      setByokModel('deepseek-chat')
                      setByokSaved(false)
                    }}>＋ 添加 API Key</button>
                  </div>
                )}

                {/* 编辑表单 */}
                {editingByokId !== null && (
                  <div className="byok-form">
                    <div className="settings-row">
                      <span>名称</span>
                      <input className="settings-input" value={byokName} onChange={(e) => { setByokName(e.target.value); setByokSaved(false) }} placeholder="如：DeepSeek 个人" />
                    </div>
                    <div className="settings-row">
                      <span>提供商</span>
                      <select
                        className="settings-select"
                        value={byokProvider}
                        onChange={(e) => {
                          const p = BYOK_PROVIDERS.find((x) => x.value === e.target.value)
                          setByokProvider(e.target.value)
                          if (p && p.baseUrl) {
                            setByokBaseUrl(p.baseUrl)
                            setByokModel(p.modelHint.split(' / ')[0])
                          }
                          setByokSaved(false)
                        }}
                      >
                        {BYOK_PROVIDERS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <span>Base URL</span>
                      <input className="settings-input" value={byokBaseUrl} onChange={(e) => { setByokBaseUrl(e.target.value); setByokSaved(false) }} placeholder="https://api.deepseek.com/v1" />
                    </div>
                    <div className="settings-row">
                      <span>API Key</span>
                      <input className="settings-input" type="password" value={byokApiKey} onChange={(e) => { setByokApiKey(e.target.value); setByokSaved(false) }} placeholder="sk-..." />
                    </div>
                    <div className="settings-row">
                      <span>模型名</span>
                      <input className="settings-input" value={byokModel} onChange={(e) => { setByokModel(e.target.value); setByokSaved(false) }} placeholder="deepseek-chat" />
                    </div>
                    <div className="settings-actions" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="byok-primary-btn" onClick={() => {
                        if (!byokName.trim() || !byokBaseUrl.trim() || !byokApiKey.trim() || !byokModel.trim()) return
                        const id = editingByokId || `custom-${Date.now()}`
                        void window.api.ai.byokSave({
                          id, name: byokName.trim(), baseUrl: byokBaseUrl.trim(), apiKey: byokApiKey.trim(), model: byokModel.trim()
                        }).then(() => {
                          void window.api.ai.byokProfiles().then((ps) => {
                            setByokProfiles(ps)
                            setEditingByokId(null)
                            setByokSaved(true)
                          })
                        })
                      }}>保存</button>
                      <button className="settings-btn" onClick={() => setEditingByokId(null)}>取消</button>
                    </div>
                  </div>
                )}

                {/* 支持提供商 chips */}
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>支持的提供商</div>
                  <div className="byok-chips">
                    <span className="byok-chip">DeepSeek</span>
                    <span className="byok-chip">通义千问</span>
                    <span className="byok-chip">Kimi</span>
                    <span className="byok-chip">OpenAI</span>
                    <span className="byok-chip">Claude</span>
                    <span className="byok-chip">智谱 GLM</span>
                    <span className="byok-chip">MiniMax</span>
                    <span className="byok-chip">豆包</span>
                    <span className="byok-chip">内置本地引擎</span>
                    <span className="byok-chip">其他兼容接口</span>
                  </div>
                </div>
              </div>
            )}
            {active === 'engine' && (
              <div className="settings-section">
                <h3>本地模型引擎（llama.cpp）</h3>
                <p className="settings-desc">
                  完全离线地跑模型：引擎本体已经在用户目录装好，下载好 gguf 模型后可给 Agent 当 GPT 兼容性端点用（http://127.0.0.1:8080/v1），不花钱、不联网、代码不上传。
                </p>
                {!engineStatus ? (
                  <div className="svd-empty">正在读取引擎状态…</div>
                ) : !engineStatus.installed ? (
                  <div className="svd-empty">
                    未检测到本地引擎（engine 目录为空）。引擎随安装包附带；若被杀毒软件清过，请在设置→插件里重新拉取，或到
                    <code> llama.cpp release </code> 下载 <code>llama-server</code> 后放进 <code>{engineStatus.engineDir}</code>。
                  </div>
                ) : (
                  <>
                    <div className="settings-row">
                      <span>引擎</span>
                      <span className="settings-val">
                        {engineStatus.installed ? `已安装${engineStatus.version ? ` · ${engineStatus.version}` : ''}` : '缺失'} ·{' '}
                        {engineStatus.running ? <span style={{ color: '#2e9e5b' }}>运行中 :8080</span> : <span style={{ color: 'var(--text-dim)' }}>已停止</span>}
                      </span>
                    </div>
                    <div className="settings-row">
                      <span>引擎目录</span>
                      <span className="settings-val">{engineStatus.engineDir}</span>
                    </div>

                    <div className="settings-actions" style={{ paddingTop: 8, paddingBottom: 8, display: 'flex', gap: 8 }}>
                      <button
                        className="settings-btn"
                        disabled={engineBusy !== null || engineStatus.running}
                        onClick={() => {
                          setEngineBusy('start')
                          setEngineMsg(null)
                          window.api.engine.start(engineSel ? { model: engineSel } : undefined)
                            .then((r) => {
                              setEngineMsg(r.ok
                                ? { text: `引擎已启动，模型 ${r.model || engineSel || '默认'} 已就绪（http://127.0.0.1:8080/v1）`, ok: true }
                                : { text: `启动失败：${r.error || '未知错误'}`, ok: false })
                            })
                            .catch((e: Error) => setEngineMsg({ text: e.message, ok: false }))
                            .finally(() => { setEngineBusy(null); refreshEngine() })
                        }}
                      >
                        {engineBusy === 'start' ? '启动中…' : '启动引擎'}
                      </button>
                      <button
                        className="settings-btn"
                        disabled={engineBusy !== null || !engineStatus.running}
                        onClick={() => {
                          setEngineBusy('stop')
                          setEngineMsg(null)
                          window.api.engine.stop()
                            .then(() => setEngineMsg({ text: '引擎已停止', ok: true }))
                            .catch((e: Error) => setEngineMsg({ text: e.message, ok: false }))
                            .finally(() => { setEngineBusy(null); refreshEngine() })
                        }}
                      >
                        {engineBusy === 'stop' ? '停止中…' : '停止引擎'}
                      </button>
                    </div>

                    <div className="svd-block-title" style={{ marginTop: 4 }}>已下载模型</div>
                    {engineModels.length === 0 ? (
                      <div className="svd-empty">还没有模型文件。到「模型」页添加 BYOK 时选「内置本地引擎 (llama.cpp)」即可边下边用，建议先取 qwen2.5-coder-3b。</div>
                    ) : (
                      <div className="engine-model-list">
                        {engineModels.map((m) => (
                          <div key={m.id} className={`engine-model ${engineSel === m.id ? 'active' : ''}`} onClick={() => setEngineSel(m.id)}>
                            <div className="engine-model-main">
                              <span className="engine-model-name">{m.name}</span>
                              <span className="engine-model-meta">{m.parameters}{m.quantization ? ` · ${m.quantization}` : ''} · {m.sizeGB.toFixed(2)} GB</span>
                            </div>
                            {engineSel === m.id && <span className="byok-badge-active">选中</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {engineMsg && <div className={`svd-msg ${engineMsg.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>{engineMsg.text}</div>}
                  </>
                )}
              </div>
            )}
            {active === 'svd' && (
              <div className="settings-section">
                <h3>寄存器数据（CMSIS-SVD）</h3>
                <p className="settings-desc">
                  查寄存器地址/位域时，AI 会读这里的数据（来自乐鑫官方仓库 <code>espressif/svd</code>），不会凭记忆编造。数据只在本地缓存，不进安装包、不上服务器。
                </p>

                <div className="svd-block">
                  <div className="svd-block-title">已安装</div>
                  {(svdList?.installed.length ?? 0) === 0 && (
                    <div className="svd-empty">还没有安装任何芯片的 SVD 数据</div>
                  )}
                  {(svdList?.installed ?? []).map((c) => (
                    <div key={c.chip} className="svd-row">
                      <span className="svd-chip">{c.chip}</span>
                      <span className="svd-meta">{(c.bytes / 1024).toFixed(0)} KB</span>
                      <button
                        className="settings-btn"
                        disabled={svdBusy === c.chip}
                        onClick={() => {
                          setSvdBusy(c.chip)
                          void window.api.svd.remove(c.chip).then(() => {
                            refreshSvd()
                            setSvdBusy(null)
                            setSvdMsg({ text: `已删除 ${c.chip}`, ok: true })
                          })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>

                <div className="svd-block">
                  <div className="svd-block-title">从官方仓库安装</div>
                  <div className="svd-picker">
                    <select
                      className="settings-select"
                      defaultValue="esp32s3"
                      onChange={(e) => { setSvdImportChip(e.target.value) }}
                    >
                      {(svdList?.known ?? []).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <button
                      className="settings-btn"
                      disabled={!!svdBusy}
                      onClick={() => {
                        const chip = svdImportChip || 'esp32s3'
                        setSvdBusy(chip)
                        setSvdProgress(0)
                        setSvdMsg(null)
                        void window.api.svd.install({ chip })
                          .then(() => {
                            refreshSvd()
                            setSvdMsg({ text: `${chip} 安装完成`, ok: true })
                          })
                          .catch((e: Error) => setSvdMsg({ text: e.message, ok: false }))
                          .finally(() => {
                            setSvdBusy(null)
                            setSvdProgress(null)
                          })
                      }}
                    >
                      下载安装
                    </button>
                  </div>
                  {svdProgress !== null && (
                    <div className="svd-progress">
                      <div className="svd-progress-bar" style={{ width: `${svdProgress}%` }} />
                      <span className="svd-progress-text">{svdProgress}%</span>
                    </div>
                  )}
                </div>

                <div className="svd-block">
                  <div className="svd-block-title">导入本地文件（离线/内网）</div>
                  <div className="svd-picker">
                    <input
                      className="settings-input"
                      placeholder="导入后使用的芯片名（如 esp32c3）"
                      value={svdImportChip}
                      onChange={(e) => setSvdImportChip(e.target.value)}
                    />
                    <button
                      className="settings-btn"
                      disabled={!!svdBusy}
                      onClick={() => {
                        void window.api.svd.pickFile().then((p) => {
                          if (!p) return
                          const auto = p.replace(/\\/g, '/').split('/').pop()?.replace(/\.svd$/i, '') || ''
                          setSvdImportChip(auto)
                          setSvdBusy(auto)
                          void window.api.svd.import({ chip: auto, filePath: p })
                            .then(() => {
                              refreshSvd()
                              setSvdMsg({ text: `已导入 ${auto}（${p}）`, ok: true })
                            })
                            .catch((e: Error) => setSvdMsg({ text: e.message, ok: false }))
                            .finally(() => setSvdBusy(null))
                        })
                      }}
                    >
                      选择 .svd 文件
                    </button>
                  </div>
                </div>

                {svdMsg && <div className={`svd-msg ${svdMsg.ok ? 'ok' : 'err'}`}>{svdMsg.text}</div>}

                {svdList?.dir && (
                  <div className="svd-note">缓存目录：{svdList.dir}</div>
                )}
              </div>
            )}
            {active === 'general' && (
              <div className="settings-section">
                <h3>常规</h3>
                <div className="settings-row">
                  <span>语言</span>
                  <select className="settings-select" value={language} onChange={(e) => onLanguageChange(e.target.value as 'zh' | 'en')}>
                    <option value="zh">中文（简体）</option>
                    <option value="en">English</option>
                  </select>
                </div>
                <div className="settings-row">
                  <span>主题</span>
                  <button className="settings-btn" onClick={onToggleTheme}>切换为{theme === 'light' ? '深色' : '浅色'}主题</button>
                </div>
                <div className="settings-row">
                  <span>终端 Shell</span>
                  <select className="settings-select" value={shell} onChange={(e) => onShellChange(e.target.value as ShellType)}>
                    {SHELL_OPTIONS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
                  </select>
                </div>
                <div className="settings-row">
                  <span>编辑器字体大小</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button className="settings-btn" onClick={() => applyFontSize(Math.max(10, fontSize - 1))}>−</button>
                    <span className="settings-val">{fontSize}px</span>
                    <button className="settings-btn" onClick={() => applyFontSize(Math.min(24, fontSize + 1))}>＋</button>
                  </div>
                </div>
              </div>
            )}
            {active === 'skills' && (
              <div className="settings-section">
                <h3>技能</h3>
                <div className="settings-skill">创建插件 <span className="settings-tag">插件</span></div>
                <div className="settings-skill">easyeda-agent <span className="settings-tag">共享</span></div>
                <p className="settings-desc">在 AI 输入框输入 / 可弹出技能列表。</p>
              </div>
            )}
            {active === 'plugins' && (
              <div className="settings-section">
                <h3>插件</h3>
                {plugins.length === 0 && <p className="settings-desc">暂无已安装插件</p>}
                {plugins.map((p) => (
                  <div key={p.manifest.name} className="settings-row">
                    <span>{p.manifest.displayName} v{p.manifest.version}</span>
                    <span className={`settings-tag ${p.loaded ? 'ok' : ''}`}>{p.loaded ? '已启用' : '已禁用'}</span>
                  </div>
                ))}
              </div>
            )}
            {active === 'hooks' && (
              <div className="settings-section">
                <h3>钩子</h3>
                <p className="settings-desc">在 AI 工具执行前（PreToolUse）/ 后（PostToolUse）调用外部脚本（JSON stdin/stdout）。命令必须是可执行路径（防 shell 注入）。钩子故障默认放行，不中断 AI。当前无配置钩子。</p>
              </div>
            )}
            <div className="settings-foot">{catLabel(active)} · LabCode v0.1.9</div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal

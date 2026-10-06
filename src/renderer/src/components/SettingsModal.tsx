import { useCallback, useEffect, useState } from 'react'
import type { McpRuntimeState } from '../../../preload'
import { type EditorSettings, EDITOR_FONT_FAMILIES } from './editor/editorSettings'
import PluginMarket from './PluginMarket'

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
  /** 当前工程根目录：MCP 需要读项目级 .labcode/mcp.json */
  projectRoot?: string | null
  /** 宿主真实版本。由 App 从主进程取来 —— 之前这里写死 v0.1.9，跟实际发出的包对不上 */
  version?: string
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自 App，实时回写 */
  editorSettings: EditorSettings
  onEditorSettingsChange: (s: EditorSettings) => void
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
  { id: 'editor', label: '编辑器', icon: '📝' },
  { id: 'general', label: '常规', icon: '⚙️' },
  { id: 'skills', label: '技能', icon: '✨' },
  { id: 'mcp', label: 'MCP', icon: '🔌' },
  { id: 'plugins', label: '插件', icon: '🧩' },
  { id: 'hooks', label: '钩子', icon: '🪝' },
]

/**
 * 导航分组：按「用户为什么来这儿」把分类收成 3 组。
 * 分组依据——AI 与模型（调模型）、硬件与工具链（板子/寄存器/编辑器/通用）、扩展能力（外部能力接入）。
 */
const CATEGORY_GROUPS: Array<{ title: string; items: typeof CATEGORIES }> = [
  { title: 'AI 与模型', items: CATEGORIES.filter((c) => c.id === 'models' || c.id === 'engine') },
  { title: '硬件与工具链', items: CATEGORIES.filter((c) => ['svd', 'editor', 'general'].includes(c.id)) },
  { title: '扩展能力', items: CATEGORIES.filter((c) => ['mcp', 'plugins', 'skills', 'hooks'].includes(c.id)) }
]

// 插件区（安装/卸载/换源/确认卡）在 PluginMarket 里自管数据，这里只负责挂载

function SettingsModal({ theme, onToggleTheme, onClose, shell, onShellChange, language, onLanguageChange, defaultTab, projectRoot, version, editorSettings, onEditorSettingsChange }: SettingsProps): React.JSX.Element {
  const [active, setActive] = useState(defaultTab || 'general')
  // MCP 服务器
  const [mcpServers, setMcpServers] = useState<McpRuntimeState[]>([])
  const [mcpGlobalPath, setMcpGlobalPath] = useState('')
  const [mcpProjectPath, setMcpProjectPath] = useState<string | null>(null)
  const [mcpTrustPath, setMcpTrustPath] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpMsg, setMcpMsg] = useState('')
  const [mcpDraft, setMcpDraft] = useState({ name: '', command: '' })
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
  /** 模型页自己的一处错误提示（删除/保存失败）。不复用 mcpMsg —— 那是 MCP 页的 */
  const [byokErr, setByokErr] = useState('')

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

  // MCP：进入设置页就拉一次概览；工程切换时重拉（项目级配置会变）
  const refreshMcp = useCallback(async (): Promise<void> => {
    try {
      const ov = await window.api.mcp.overview(projectRoot ?? null)
      setMcpServers(ov.servers)
      setMcpGlobalPath(ov.globalPath)
      setMcpProjectPath(ov.projectPath)
    } catch (e) {
      setMcpMsg(`读取失败：${(e as Error).message}`)
    }
  }, [projectRoot])

  useEffect(() => {
    if (active === 'mcp') void refreshMcp()
  }, [active, refreshMcp])

  const mcpAdd = async (): Promise<void> => {
    const name = mcpDraft.name.trim()
    const cmdline = mcpDraft.command.trim()
    if (!name || !cmdline) {
      setMcpMsg('名称与启动命令都要填')
      return
    }
    setMcpBusy(true)
    setMcpMsg('')
    try {
      // 命令串按空白拆成 command + args（用户习惯直接粘 npx -y 包名）
      const parts = cmdline.split(/\s+/).filter(Boolean)
      const r = await window.api.mcp.add({ name, command: parts[0], args: parts.slice(1) })
      if (!r.ok) {
        setMcpMsg(r.error || '添加失败')
      } else {
        setMcpDraft({ name: '', command: '' })
        setMcpMsg(`已添加到 ${r.path}。出于安全考虑，新服务器默认「未信任」，确认命令无误后再点「信任」。`)
        await refreshMcp()
      }
    } finally {
      setMcpBusy(false)
    }
  }

  const mcpSetTrust = async (name: string, trusted: boolean): Promise<void> => {
    setMcpBusy(true)
    setMcpMsg('')
    try {
      const r = await window.api.mcp.trust({ name, trusted, projectRoot: projectRoot ?? null })
      if (!r.ok) setMcpMsg(r.error || '操作失败')
      else if (trusted) {
        // 信任后立刻连上，用户能马上看到工具列表
        const ov = await window.api.mcp.start(projectRoot ?? null)
        setMcpServers(ov.servers)
      }
      await refreshMcp()
    } finally {
      setMcpBusy(false)
    }
  }

  const mcpSetEnabled = async (name: string, enabled: boolean): Promise<void> => {
    setMcpBusy(true)
    try {
      await window.api.mcp.enable({ name, enabled, projectRoot: projectRoot ?? null })
      if (!enabled) await window.api.mcp.stop(name)
      await refreshMcp()
    } finally {
      setMcpBusy(false)
    }
  }

  const mcpRemove = async (name: string): Promise<void> => {
    setMcpBusy(true)
    try {
      await window.api.mcp.stop(name)
      await window.api.mcp.remove(name)
      setMcpMsg(`已删除 ${name}`)
      await refreshMcp()
    } finally {
      setMcpBusy(false)
    }
  }

  const mcpConnectAll = async (): Promise<void> => {
    setMcpBusy(true)
    setMcpMsg('')
    try {
      const ov = await window.api.mcp.start(projectRoot ?? null)
      setMcpServers(ov.servers)
      setMcpMsg(`已连接 ${ov.servers.filter((s) => s.status === 'running').length} 个，共 ${ov.totalTools} 个工具`)
    } finally {
      setMcpBusy(false)
    }
  }

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
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 编辑器设置局部更新：合并补丁回写 App（App 负责持久化 + 下发 Monaco） */
  const patchEditor = (patch: Partial<EditorSettings>): void => {
    onEditorSettingsChange({ ...editorSettings, ...patch })
  }

  const catLabel = (id: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id

  /** 官方仓库可装的芯片；列表还没拉回来时给个空 —— 宁可不显示，也不让 UI 和真下载的对不上 */
  const knownChips = svdList?.known ?? []
  /** 受控下拉真正的高亮项：state 里的值若不在列表里（比如刚导入过别的芯片），退到列表首项 */
  const svdPick = knownChips.includes(svdImportChip) ? svdImportChip : (knownChips[0] ?? '')

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal">
        <div className="settings-head">
          <span>设置</span>
          <button className="settings-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="settings-body">
          <aside className="settings-nav">
            {CATEGORY_GROUPS.map((g) => (
              <div key={g.title} className="settings-nav-group">
                <div className="settings-nav-group-title">{g.title}</div>
                {g.items.map((c) => (
                  <div
                    key={c.id}
                    className={`settings-nav-item ${active === c.id ? 'active' : ''}`}
                    onClick={() => setActive(c.id)}
                  >
                    <span className="settings-nav-icon">{c.icon}</span>
                    <span>{c.label}</span>
                  </div>
                ))}
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
                            setByokErr('')
                            void window.api.ai.byokDelete(p.id)
                              .then(async () => {
                                const ps = await window.api.ai.byokProfiles()
                                setByokProfiles(ps)
                                // 主进程的 deleteByokProfile 已经把 modelId 切回默认、
                                // activeByokId 也挪到第一个了；这里唯一漏的是**渲染层这张卡的
                                // activeByokId** —— 不复位它就永远顶着「使用中」，
                                // 看着像在用、实际已经在跑内置模型。
                                if (activeByokId === p.id) setActiveByokId(ps.length > 0 ? ps[0].id : null)
                                setByokSaved(true)
                              })
                              .catch((e: Error) => setByokErr(`删除失败：${e.message}`))
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

                {byokErr && <div className="svd-msg err" style={{ marginTop: 8 }}>{byokErr}</div>}

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
                        {engineStatus.running ? <span style={{ color: 'var(--success)' }}>运行中 :8080</span> : <span style={{ color: 'var(--text-dim)' }}>已停止</span>}
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
                  {knownChips.length === 0 && (
                    <div className="svd-empty">正在读取可用的芯片列表…</div>
                  )}
                  <div className="svd-picker">
                    {/*
                      必须受控。之前是 defaultValue（非受控）却和下面「导入本地文件」共用
                      svdImportChip 这一个 state：用户在下拉里选了 esp32c3，DOM 变了、state 没变，
                      点「下载安装」还是拿旧值去下 —— 界面显示的芯片和实际下载的芯片对不上。
                    */}
                    <select
                      className="settings-select"
                      value={svdPick || ''}
                      disabled={knownChips.length === 0}
                      onChange={(e) => { setSvdImportChip(e.target.value); setSvdMsg(null) }}
                    >
                      {knownChips.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <button
                      className="settings-btn"
                      disabled={!!svdBusy}
                      onClick={() => {
                        // 必须取 svdPick（下拉当前显示的那块）而不是 svdImportChip state：
                        // 后者可能不在 knownChips 里，svdPick 会回落到 knownChips[0]，
                        // 界面显示 A、实际下载 B —— 同一个坑只修一半等于没修。
                        const chip = svdPick || 'esp32s3'
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
              </div>
            )}
            {active === 'editor' && (
              <div className="settings-section">
                <h3>编辑器</h3>
                <p className="settings-desc">调整代码编辑区的外观与缩进行为。改动即时生效，并保存到本机，重启后保留。</p>

                <div className="settings-row">
                  <span>字体大小</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button className="settings-btn" onClick={() => patchEditor({ fontSize: Math.max(10, editorSettings.fontSize - 1) })}>−</button>
                    <span className="settings-val">{editorSettings.fontSize}px</span>
                    <button className="settings-btn" onClick={() => patchEditor({ fontSize: Math.min(24, editorSettings.fontSize + 1) })}>＋</button>
                  </div>
                </div>

                <div className="settings-row">
                  <span>字体</span>
                  <select
                    className="settings-select"
                    value={editorSettings.fontFamily}
                    onChange={(e) => patchEditor({ fontFamily: e.target.value })}
                  >
                    {EDITOR_FONT_FAMILIES.map((f) => (<option key={f.value} value={f.value}>{f.label}</option>))}
                  </select>
                </div>

                <div className="settings-row">
                  <span>Tab 宽度</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button className="settings-btn" onClick={() => patchEditor({ tabSize: Math.max(1, editorSettings.tabSize - 1) })}>−</button>
                    <span className="settings-val">{editorSettings.tabSize} 列</span>
                    <button className="settings-btn" onClick={() => patchEditor({ tabSize: Math.min(8, editorSettings.tabSize + 1) })}>＋</button>
                  </div>
                </div>

                <div className="settings-row">
                  <span>缩进方式</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={`settings-btn ${editorSettings.insertSpaces ? 'active' : ''}`}
                      onClick={() => patchEditor({ insertSpaces: true })}
                    >空格</button>
                    <button
                      className={`settings-btn ${!editorSettings.insertSpaces ? 'active' : ''}`}
                      onClick={() => patchEditor({ insertSpaces: false })}
                    >Tab</button>
                  </div>
                </div>

                <div className="settings-row">
                  <span>自动换行</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={`settings-btn ${editorSettings.wordWrap === 'on' ? 'active' : ''}`}
                      onClick={() => patchEditor({ wordWrap: 'on' })}
                    >开启</button>
                    <button
                      className={`settings-btn ${editorSettings.wordWrap === 'off' ? 'active' : ''}`}
                      onClick={() => patchEditor({ wordWrap: 'off' })}
                    >关闭</button>
                  </div>
                </div>

                <div className="settings-row">
                  <span>缩略图 (minimap)</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={`settings-btn ${editorSettings.minimap ? 'active' : ''}`}
                      onClick={() => patchEditor({ minimap: true })}
                    >显示</button>
                    <button
                      className={`settings-btn ${!editorSettings.minimap ? 'active' : ''}`}
                      onClick={() => patchEditor({ minimap: false })}
                    >隐藏</button>
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
            {active === 'plugins' && <PluginMarket />}
            {active === 'mcp' && (
              <div className="settings-section">
                <h3>外部 MCP 服务器</h3>
                <p className="settings-desc">
                  MCP 服务器是在本机执行命令的外部进程，因此默认<strong>不被信任、不会被拉起</strong>。
                  信任状态只记录在本机（{mcpTrustPath || 'mcp-trust.json'}），工程仓库里的配置无法替你做决定。
                </p>

                <div className="settings-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <input
                    className="toolbar-input"
                    style={{ width: 130 }}
                    placeholder="名称（如 files）"
                    value={mcpDraft.name}
                    onChange={(e) => setMcpDraft((d) => ({ ...d, name: e.target.value }))}
                    spellCheck={false}
                  />
                  <input
                    className="toolbar-input"
                    style={{ flex: 1, minWidth: 220 }}
                    placeholder="启动命令，如 npx -y @modelcontextprotocol/server-filesystem D:/work"
                    value={mcpDraft.command}
                    onChange={(e) => setMcpDraft((d) => ({ ...d, command: e.target.value }))}
                    spellCheck={false}
                  />
                  <button className="btn" disabled={mcpBusy} onClick={() => void mcpAdd()}>添加</button>
                  <button className="btn" disabled={mcpBusy || mcpServers.length === 0} onClick={() => void mcpConnectAll()}>
                    连接已信任的
                  </button>
                </div>
                {mcpMsg && <p className="settings-desc" style={{ color: mcpMsg.startsWith('已') ? 'var(--accent-2)' : 'var(--danger)' }}>{mcpMsg}</p>}

                {mcpServers.length === 0 && <p className="settings-desc">还没有配置任何 MCP 服务器。</p>}
                {mcpServers.map((s) => (
                  <div key={s.name} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`settings-tag ${s.status === 'running' ? 'ok' : ''}`}>
                        {s.status === 'running' ? `运行中 · ${s.tools.length} 工具`
                          : s.status === 'failed' ? '启动失败'
                          : s.status === 'not-trusted' ? '未信任'
                          : s.status === 'disabled' ? '已停用'
                          : '已停止'}
                      </span>
                      <strong>{s.name}</strong>
                      <span className="settings-desc" style={{ margin: 0 }}>
                        {s.source === 'project' ? '工程配置' : '全局配置'}
                      </span>
                      <span className="settings-desc mono" style={{ margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.command} {s.args.join(' ')}
                      </span>
                      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                        <input type="checkbox" checked={s.enabled} onChange={(e) => void mcpSetEnabled(s.name, e.target.checked)} />
                        启用
                      </label>
                      <button
                        className="btn"
                        disabled={mcpBusy}
                        title={s.trusted ? '取消信任后不会再被自动拉起' : '信任后才会被拉起；等于允许它在你的机器上执行命令'}
                        onClick={() => void mcpSetTrust(s.name, !s.trusted)}
                      >
                        {s.trusted ? '取消信任' : '信任'}
                      </button>
                      {s.source === 'global' && (
                        <button className="btn" disabled={mcpBusy} onClick={() => void mcpRemove(s.name)}>删除</button>
                      )}
                    </div>
                    {s.error && <p className="settings-desc" style={{ color: 'var(--danger)', margin: 0 }}>{s.error}</p>}
                    {s.tools.length > 0 && (
                      <p className="settings-desc" style={{ margin: 0 }}>
                        工具：{s.tools.map((t) => t.name).join('、')}
                      </p>
                    )}
                  </div>
                ))}

                <p className="settings-desc">
                  配置文件：<span className="mono">{mcpGlobalPath || 'mcp.json'}</span>
                  {mcpProjectPath && <>（工程级：<span className="mono">{mcpProjectPath}</span>，同名以工程级为准）</>}
                </p>
              </div>
            )}
            {active === 'hooks' && (
              <div className="settings-section">
                <h3>钩子</h3>
                <p className="settings-desc">在 AI 工具执行前（PreToolUse）/ 后（PostToolUse）调用外部脚本（JSON stdin/stdout）。命令必须是可执行路径（防 shell 注入）。钩子故障默认放行，不中断 AI。当前无配置钩子。</p>
              </div>
            )}
            <div className="settings-foot">{catLabel(active)} · LabCode v{version || '—'}</div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal

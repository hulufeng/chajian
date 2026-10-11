import { useCallback, useEffect, useState } from 'react'
import type { McpRuntimeState } from '../../../preload'
import { type EditorSettings, EDITOR_FONT_FAMILIES } from './editor/editorSettings'
import { isChimeEnabled, playChime, setChimeEnabled } from '../lib/sound'
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
  /** 动效偏好：跟随系统（尊重 prefers-reduced-motion）/ 全部开启 / 全部关闭 */
  motion: 'system' | 'on' | 'off'
  onMotionChange: (m: 'system' | 'on' | 'off') => void
  defaultTab?: string
  /** 当前工程根目录：MCP 需要读项目级 .labcode/mcp.json */
  projectRoot?: string | null
  /** 宿主真实版本。由 App 从主进程取来 —— 之前这里写死 v0.1.9，跟实际发出的包对不上 */
  version?: string
  /** 编辑器偏好（字号/缩进/换行/minimap/字体），来自 App，实时回写 */
  editorSettings: EditorSettings
  onEditorSettingsChange: (s: EditorSettings) => void
  /** 层2 深度编译预检（实验性）开关 */
  deepPrecheckOn: boolean
  onDeepPrecheckChange: () => void
  /** 悬停功能介绍开关（默认开；熟了可以关掉，界面回归安静） */
  featureHintsOn: boolean
  onFeatureHintsChange: () => void
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

/**
 * 常用 MCP 服务器一键预设（对齐 TrieCode 的插件生态体验：免手填命令）。
 * 全部走 Node/npx（跨平台最稳）；点击只「填入名称+命令」，仍需用户手动点「添加」并「信任」——
 * 预设不自动信任，信任门控保持不变。
 */
const MCP_PRESETS: Array<{ key: string; label: string; icon: string; desc: string; command: (dir: string) => string }> = [
  {
    key: 'filesystem', label: '文件系统', icon: '📁',
    desc: '读写指定目录下的文件（最常用；默认用当前工程目录）',
    command: (dir) => `npx -y @modelcontextprotocol/server-filesystem ${dir}`
  },
  {
    key: 'memory', label: '记忆', icon: '🧠',
    desc: '持久化知识图谱记忆，跨会话记住事实',
    command: () => 'npx -y @modelcontextprotocol/server-memory'
  },
  {
    key: 'sequential-thinking', label: '顺序思考', icon: '🪜',
    desc: '结构化多步推理，适合复杂问题拆解',
    command: () => 'npx -y @modelcontextprotocol/server-sequential-thinking'
  },
  {
    key: 'playwright', label: '浏览器自动化', icon: '🌐',
    desc: '打开网页、点击、截图、抓取（Playwright 官方 MCP）',
    command: () => 'npx -y @playwright/mcp@latest'
  },
  {
    key: 'everything', label: '演示调试', icon: '🧪',
    desc: '官方「everything」样例服务器，用于验证连通与工具列表',
    command: () => 'npx -y @modelcontextprotocol/server-everything'
  }
]

const CATEGORIES = [
  { id: 'models', label: '模型', icon: '🧠' },
  { id: 'engine', label: '本地引擎', icon: '🖥️' },
  { id: 'svd', label: '寄存器数据', icon: '🧾' },
  { id: 'editor', label: '编辑器', icon: '📝' },
  { id: 'general', label: '常规', icon: '⚙️' },
  { id: 'diag', label: '测试与诊断', icon: '🧪' },
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
  { title: '硬件与工具链', items: CATEGORIES.filter((c) => ['svd', 'editor', 'general', 'diag'].includes(c.id)) },
  { title: '扩展能力', items: CATEGORIES.filter((c) => ['mcp', 'plugins', 'skills', 'hooks'].includes(c.id)) }
]

// 插件区（安装/卸载/换源/确认卡）在 PluginMarket 里自管数据，这里只负责挂载

function SettingsModal({ theme, onToggleTheme, onClose, shell, onShellChange, language, onLanguageChange, motion, onMotionChange, defaultTab, projectRoot, version, editorSettings, onEditorSettingsChange, deepPrecheckOn, onDeepPrecheckChange, featureHintsOn, onFeatureHintsChange }: SettingsProps): React.JSX.Element {
  const [active, setActive] = useState(defaultTab || 'general')
  // 提示音：开关状态只影响 UI 显示 + 试听，真正播放的判定在 AiPanel 里（done 事件）
  const [chimeOn, setChimeOn] = useState<boolean>(() => isChimeEnabled())
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
  // 测试与诊断：自检结果 / 导出反馈（开发的我拿这份报告定位真机问题）
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagReport, setDiagReport] = useState<Record<string, unknown> | null>(null)
  const [diagMsg, setDiagMsg] = useState('')
  const [diagInfoText, setDiagInfoText] = useState('')
  /** 模型页自己的一处错误提示（删除/保存失败）。不复用 mcpMsg —— 那是 MCP 页的 */
  const [byokErr, setByokErr] = useState('')

  // ── 官方通道（内置模型 / 积分）：登录态 + 模型列表 + 登录表单 ──
  interface OfficialState {
    token: string | null
    email: string | null
    planCredits: number | null
    rechargeCredits: number | null
    totalCredits: number | null
    planMonth: string | null
    modelId: string
  }
  interface OfficialModel {
    id: string
    name: string
    provider: string
    desc: string
    costPerCall: number
    available: boolean
  }
  const [officialState, setOfficialState] = useState<OfficialState>({
    token: null, email: null, planCredits: null, rechargeCredits: null,
    totalCredits: null, planMonth: null, modelId: 'deepseek-flash'
  })
  const [officialModels, setOfficialModels] = useState<OfficialModel[]>([])
  const [authEmail, setAuthEmail] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [codeCountdown, setCodeCountdown] = useState(0)
  const [authBusy, setAuthBusy] = useState(false)
  const [authErr, setAuthErr] = useState('')
  const [authMsg, setAuthMsg] = useState('')

  /** 拉官方通道状态；已登录则顺带拉内置模型列表 */
  const refreshOfficial = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api.ai.state()
      const st: OfficialState = {
        token: s.token, email: s.email, planCredits: s.planCredits, rechargeCredits: s.rechargeCredits,
        totalCredits: s.totalCredits, planMonth: s.planMonth, modelId: s.modelId
      }
      setOfficialState(st)
      if (st.token) {
        const ms = await window.api.ai.models().catch(() => [] as OfficialModel[])
        setOfficialModels(ms)
      } else {
        setOfficialModels([])
      }
    } catch {
      /* 读取失败不阻塞其它设置页 */
    }
  }, [])

  useEffect(() => {
    if (active === 'models') void refreshOfficial()
  }, [active, refreshOfficial])

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
  interface CatalogModel {
    id: string; displayName: string; description: string; parameters: string
    sizeGB: number; minRAMGB: number; tier: string; icon: string; ggufFile: string; downloaded: boolean
  }
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [engineModels, setEngineModels] = useState<EngineModel[]>([])
  const [engineSel, setEngineSel] = useState('')
  const [engineBusy, setEngineBusy] = useState<string | null>(null) // 'start' | 'stop' | 'models' | 'dl:<id>'
  const [engineMsg, setEngineMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [engineCatalog, setEngineCatalog] = useState<CatalogModel[]>([])
  const [engineDl, setEngineDl] = useState<{ modelId: string; percent: number; downloadedMB: number; totalMB: number } | null>(null)

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
    // 可下载目录（含 7B 档位）：downloaded 标记让 UI 区分「下载 / 已下载」，避免重复下
    window.api.engine.catalog()
      .then((c) => setEngineCatalog(c))
      .catch(() => setEngineCatalog([]))
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

  // 模型下载进度：主进程经 engine:downloadProgress 推送（断点续传会多次回调）
  useEffect(() => {
    const off = window.api.engine.onDownloadProgress((p) => {
      setEngineDl({ modelId: p.modelId, percent: p.percent, downloadedMB: p.downloadedMB, totalMB: p.totalMB })
    })
    return off
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

  /** 首次进「测试与诊断」时把日志目录显示出来：用户至少要能自己找到、自己删 */
  useEffect(() => {
    if (active !== 'diag' || diagInfoText) return
    window.api.diag.info().then((i) => {
      setDiagInfoText(i.dir ? `当前日志：${i.file}` : '（日志目录不可用，诊断已停用）')
    }).catch(() => undefined)
  }, [active, diagInfoText])

  const runDiagSelfTest = async (): Promise<void> => {
    setDiagBusy(true)
    setDiagMsg('')
    try {
      const rep = await window.api.diag.selfTest()
      setDiagReport(rep)
      setDiagMsg('自检完成（结果如下，也已写入日志）')
    } finally {
      setDiagBusy(false)
    }
  }

  const exportDiag = async (): Promise<void> => {
    setDiagBusy(true)
    setDiagMsg('')
    try {
      const r = await window.api.diag.export()
      if (r.path) setDiagMsg(`已导出：${r.path}\n把这个文件发给我即可（含本机路径，发送前你自己过一眼）。`)
      else if (!r.canceled) setDiagMsg(`导出失败：${r.error ?? '未知原因'}`)
    } finally {
      setDiagBusy(false)
    }
  }

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

                {/* ── 官方通道：登录 / 注册 / 积分 / 内置模型选择 ── */}
                <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                  <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>官方账户（内置模型 · 消耗积分）</h4>
                  <p className="settings-desc">登录后可选官方内置模型（如 DeepSeek 等），由官方服务器提供、按次消耗积分。未登录时请改用下方「自定义模型 / 本地引擎」。</p>

                  {!officialState.token ? (
                    <div className="byok-form">
                      <div className="settings-row">
                        <span>邮箱</span>
                        <input className="settings-input" type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="you@example.com" />
                      </div>
                      <div className="settings-row">
                        <span>验证码</span>
                        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                          <input className="settings-input" value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder="6位验证码" maxLength={6} style={{ flex: 1 }} />
                          <button
                            className="settings-btn"
                            disabled={codeCountdown > 0 || authBusy || !authEmail.includes('@')}
                            onClick={async () => {
                              setAuthBusy(true); setAuthErr(''); setAuthMsg('')
                              try {
                                await window.api.ai.sendCode(authEmail.trim())
                                setAuthMsg('验证码已发送（10分钟有效）')
                                setCodeCountdown(60)
                                const timer = setInterval(() => {
                                  setCodeCountdown((c) => { if (c <= 1) { clearInterval(timer); return 0 } return c - 1 })
                                }, 1000)
                              } catch (e) { setAuthErr((e as Error).message) } finally { setAuthBusy(false) }
                            }}
                          >{codeCountdown > 0 ? `${codeCountdown}s` : '发送验证码'}</button>
                        </div>
                      </div>
                      <div className="settings-actions" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button
                          className="byok-primary-btn"
                          disabled={authBusy || !authCode || !authEmail}
                          onClick={async () => {
                            setAuthBusy(true); setAuthErr(''); setAuthMsg('')
                            try {
                              const s = await window.api.ai.loginWithCode(authEmail.trim(), authCode.trim())
                              setOfficialState({
                                token: s.token, email: s.email, planCredits: s.planCredits, rechargeCredits: s.rechargeCredits,
                                totalCredits: s.totalCredits, planMonth: s.planMonth, modelId: s.modelId
                              })
                              setAuthCode('')
                              const ms = await window.api.ai.models().catch(() => [] as OfficialModel[])
                              setOfficialModels(ms)
                              setAuthMsg('登录成功，已送 100 次免费额度')
                            } catch (e) { setAuthErr((e as Error).message) } finally { setAuthBusy(false) }
                          }}
                        >{authBusy ? '处理中…' : '登录 / 注册'}</button>
                      </div>
                      <p className="settings-desc" style={{ marginTop: 8, fontSize: 11 }}>首次登录自动注册，无需密码。验证码发送到邮箱，10 分钟有效。</p>
                      {authErr && <div className="svd-msg err" style={{ marginTop: 8 }}>{authErr}</div>}
                      {authMsg && <div className="svd-msg ok" style={{ marginTop: 8 }}>{authMsg}</div>}
                    </div>
                  ) : (
                    <div>
                      <div className="settings-row">
                        <span>账户</span>
                        <span className="settings-val">{officialState.email}</span>
                      </div>
                      <div className="settings-row">
                        <span>积分</span>
                        <span className="settings-val">
                          {officialState.totalCredits == null
                            ? '—'
                            : `共 ${officialState.totalCredits}（套餐 ${officialState.planCredits ?? 0} · 充值 ${officialState.rechargeCredits ?? 0}）`}
                          {officialState.planMonth ? ` · 有效期至 ${officialState.planMonth}` : ''}
                        </span>
                      </div>
                      <div className="settings-actions" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button className="settings-btn" onClick={async () => {
                          const s = await window.api.ai.refreshMe().catch(() => null)
                          if (s) setOfficialState({
                            token: s.token, email: s.email, planCredits: s.planCredits, rechargeCredits: s.rechargeCredits,
                            totalCredits: s.totalCredits, planMonth: s.planMonth, modelId: s.modelId
                          })
                        }}>刷新积分</button>
                        <button className="settings-btn" onClick={async () => {
                          try {
                            const s = await window.api.ai.logout()
                            setOfficialState({
                              token: s.token, email: s.email, planCredits: s.planCredits, rechargeCredits: s.rechargeCredits,
                              totalCredits: s.totalCredits, planMonth: s.planMonth, modelId: s.modelId
                            })
                            setOfficialModels([])
                          } catch (e) { setAuthErr((e as Error).message) }
                        }}>退出登录</button>
                      </div>

                      <div className="svd-block-title" style={{ marginTop: 12 }}>选择内置模型（官方通道）</div>
                      {officialModels.length === 0 ? (
                        <div className="svd-empty">暂无可用的内置模型（拉取失败或服务不可用）。请确认后端已上线 /api/models。</div>
                      ) : (
                        <div className="engine-model-list">
                          {officialModels.map((m) => (
                            <div
                              key={m.id}
                              className={`engine-model ${officialState.modelId === m.id ? 'active' : ''}`}
                              onClick={async () => {
                                const s = await window.api.ai.setModel(m.id).catch(() => null)
                                if (s) setOfficialState((prev) => ({ ...prev, modelId: s.modelId }))
                              }}
                            >
                              <div className="engine-model-main">
                                <span className="engine-model-name">{m.name}</span>
                                <span className="engine-model-meta">
                                  {m.provider}{m.desc ? ` · ${m.desc}` : ''}{m.costPerCall ? ` · ${m.costPerCall} 积分/次` : ''}
                                </span>
                              </div>
                              {officialState.modelId === m.id && <span className="byok-badge-active">使用中</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

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
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>支持的提供商</div>
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
                        {engineStatus.running ? <span style={{ color: 'var(--success)' }}>运行中 :8080</span> : <span style={{ color: 'var(--text-2)' }}>已停止</span>}
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
                    <div className="svd-block-title" style={{ marginTop: 10 }}>可下载模型（3B 不够用时可升 7B）</div>
                    {engineCatalog.length === 0 ? (
                      <div className="svd-empty">正在读取模型目录…</div>
                    ) : (
                      <div className="engine-model-list">
                        {engineCatalog.map((m) => {
                          const dl = engineDl && engineDl.modelId === m.id ? engineDl : null
                          return (
                            <div key={m.id} className="engine-model">
                              <div className="engine-model-main">
                                <span className="engine-model-name">{m.icon} {m.displayName}</span>
                                <span className="engine-model-meta">{m.description} · 建议 {m.minRAMGB}GB+ 内存</span>
                              </div>
                              {m.downloaded ? (
                                <span className="byok-badge-active">已下载</span>
                              ) : dl ? (
                                <span className="engine-model-meta">
                                  下载中 {dl.percent}%（{dl.downloadedMB}/{dl.totalMB} MB）
                                </span>
                              ) : (
                                <button
                                  className="settings-btn"
                                  disabled={engineBusy !== null}
                                  onClick={() => {
                                    setEngineBusy(`dl:${m.id}`)
                                    setEngineMsg(null)
                                    setEngineDl({ modelId: m.id, percent: 0, downloadedMB: 0, totalMB: 0 })
                                    window.api.engine.download(m.id)
                                      .then((r) => setEngineMsg(r.ok
                                        ? { text: `${m.displayName} 下载完成 —— 在上方「已下载模型」里选中它，再点「启动引擎」`, ok: true }
                                        : { text: `下载失败：${r.error || '未知错误'}`, ok: false }))
                                      .catch((e: Error) => setEngineMsg({ text: e.message, ok: false }))
                                      .finally(() => { setEngineBusy(null); setEngineDl(null); refreshEngine() })
                                  }}
                                >
                                  下载 {m.sizeGB.toFixed(1)}GB
                                </button>
                              )}
                            </div>
                          )
                        })}
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
                <div className="settings-row">
                  <span>AI 完成提示音</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={chimeOn}
                      onChange={(e) => {
                        setChimeEnabled(e.target.checked)
                        setChimeOn(e.target.checked)
                        if (e.target.checked) playChime()
                      }}
                      title="AI 跑完一轮时响一声。长任务可以切走干别的，靠这声叫你回来。"
                    />
                    <button className="settings-btn" onClick={() => playChime()} title="立刻试听一声">
                      试听
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>动效偏好</span>
                  <select className="settings-select" value={motion} onChange={(e) => onMotionChange(e.target.value as 'system' | 'on' | 'off')}>
                    <option value="system">跟随系统</option>
                    <option value="on">全部开启</option>
                    <option value="off">全部关闭</option>
                  </select>
                </div>
                <div className="settings-row">
                  <span>悬停功能介绍</span>
                  <input
                    type="checkbox"
                    checked={featureHintsOn}
                    onChange={onFeatureHintsChange}
                    title="鼠标在按钮 / 图标上停半秒，弹出一张卡片说明这个功能是做什么的、什么时候用。熟悉界面后可以关掉。"
                  />
                </div>
                <div className="settings-row">
                  <span>层2 深度编译预检（实验性）</span>
                  <input
                    type="checkbox"
                    checked={deepPrecheckOn}
                    onChange={onDeepPrecheckChange}
                    title="保存即预检时额外跑一次真实编译，提前发现依赖缺失 / 语法错 / 库找不到。默认关闭（真实编译耗时几十秒，且会随编辑防抖触发）。"
                  />
                </div>
              </div>
            )}
            {active === 'diag' && (
              <div className="settings-section">
                <h3>测试与诊断</h3>
                <p className="settings-desc">
                  你在本机每跑一遍，软件都会把关键链路（启动环境、工具链探测、板卡/端口识别、编译、烧录、串口、打开文件、界面报错）
                  记成日志，**只写在你自己的电脑上，不会自动外发**。测完点「导出测试报告」，把生成的 txt 发给我，我就能照着真实数据定位问题，而不是靠猜。
                </p>
                <div className="settings-row">
                  <span>运行环境自检</span>
                  <button className="settings-btn" disabled={diagBusy} onClick={() => void runDiagSelfTest()}>
                    {diagBusy ? '检查中…' : '开始自检'}
                  </button>
                </div>
                <div className="settings-row">
                  <span>导出测试报告</span>
                  <button className="settings-btn" disabled={diagBusy} onClick={() => void exportDiag()}>导出到桌面…</button>
                </div>
                <div className="settings-row">
                  <span>日志所在目录</span>
                  <button className="settings-btn" onClick={() => void window.api.diag.openDir()}>打开目录</button>
                </div>
                {diagInfoText && <p className="settings-desc">{diagInfoText}</p>}
                {diagMsg && <p className="settings-desc">{diagMsg}</p>}
                {diagReport && (
                  <pre className="settings-desc" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto', background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>
                    {JSON.stringify(diagReport, null, 2)}
                  </pre>
                )}
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

                {/* 常用服务器一键预设：点击填入「名称+命令」，随后仍需手动「添加」并「信任」 */}
                <div className="mcp-presets">
                  <div className="mcp-presets-title">常用服务器（一键填入）</div>
                  <div className="mcp-presets-list">
                    {MCP_PRESETS.map((p) => {
                      const cmd = p.command((projectRoot || '').trim() || '.')
                      return (
                        <button
                          key={p.key}
                          className="mcp-preset-card"
                          disabled={mcpBusy}
                          title={`${p.desc}\n\n${cmd}`}
                          onClick={() => {
                            setMcpDraft({ name: p.label, command: cmd })
                            setMcpMsg(`已填入「${p.label}」，点「添加」写入配置，再点「信任」才会拉起`)
                          }}
                        >
                          <span className="mcp-preset-icon">{p.icon}</span>
                          <span className="mcp-preset-body">
                            <span className="mcp-preset-name">{p.label}</span>
                            <span className="mcp-preset-desc">{p.desc}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="settings-desc" style={{ margin: '6px 0 0' }}>
                    预设基于 Node/npx，需本机已安装 Node。填入后记得按<strong>信任门控</strong>流程操作（点击预设不会替你信任）。
                  </p>
                </div>

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
                {mcpMsg && <p className="settings-desc" style={{ color: mcpMsg.startsWith('已') ? 'var(--accent-2)' : 'var(--error)' }}>{mcpMsg}</p>}

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
                    {s.error && <p className="settings-desc" style={{ color: 'var(--error)', margin: 0 }}>{s.error}</p>}
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

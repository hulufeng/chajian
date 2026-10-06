import { useCallback, useEffect, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import ActivityBar from './components/ActivityBar'
import ProjectTree, { type TreeNode } from './components/ProjectTree'
import EditorArea, { type EditorTab } from './components/EditorArea'
import OutputPanel from './components/OutputPanel'
import AiPanel from './components/AiPanel'
import NewProjectDialog, { type ProjectTypeItem } from './components/NewProjectDialog'
import DebugPanel from './components/DebugPanel'
import PlatformIOPanel from './components/PlatformIOPanel'
import TargetPanel from './components/TargetPanel'
import GitPanel from './components/GitPanel'
import PanelDock, { type PanelId } from './components/PanelDock'
import AgentBoard from './components/AgentBoard'
import type { BoardTargetInfo, BuildStageInfo, ChannelHealth, FlashStage } from '../../preload'
import DevicePanel from './components/DevicePanel'
import ToolchainSidebar from './components/ToolchainSidebar'
import CommandPalette from './components/CommandPalette'
import WelcomeView from './components/WelcomeView'
import StatusBar from './components/StatusBar'
import SettingsModal from './components/SettingsModal'
import type { TerminalHandle } from './components/TerminalView'
import type { ToolchainStatus, SerialPortInfo, UpdaterStatus } from '../../preload'

type ShellType = 'powershell' | 'cmd' | 'pwsh' | 'bash'

function langOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ino: 'cpp', cpp: 'cpp', c: 'c', h: 'cpp', hpp: 'cpp', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', html: 'html', css: 'css',
    py: 'python', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', txt: 'plaintext',
    csv: 'plaintext', sql: 'sql', java: 'java', go: 'go', rs: 'rust', xml: 'xml', sh: 'shell',
    bat: 'bat', ps1: 'powershell', vue: 'html'
  }
  return map[ext] ?? 'plaintext'
}

function findSketch(node: TreeNode | null): string | null {
  if (!node) return null
  if (node.type === 'file') return node.name.endsWith('.ino') ? node.path : null
  for (const c of node.children ?? []) {
    const hit = findSketch(c)
    if (hit) return hit
  }
  return null
}

/** 是否为磁盘上的绝对路径（虚拟文件如 welcome/welcome.ino 不是） */
function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')
}

interface SketchResolution {
  /** 命中的标签页（用于落盘最新编辑内容）；纯磁盘文件可能无对应 tab */
  tab: EditorTab | null
  /** sketch 路径：真实文件为绝对路径，虚拟文件为相对 id（后续暂存为真实路径） */
  sketch: string
  /** 是否虚拟文件（内置示例 / 未保存），需要暂存到临时目录再编译烧录 */
  virtual: boolean
  /** 来源说明，用于日志提示 */
  reason: string
}

/**
 * 解析要编译/烧录的 sketch —— 解决「打开项目后系统识别不到/识别错要烧录的文件」。
 * 优先级（最贴合用户直觉）：
 *  1) 当前正在编辑的「真实项目」.ino（绝对路径）—— 你看着/改着的就是要烧的
 *  2) 已打开项目树里的第一个 .ino —— 项目已打开时不该去烧内置示例
 *  3) 当前激活的虚拟 .ino（内置示例 / 未保存）
 *  4) 任意已打开的 .ino 标签页
 *  全部落空返回 null（由调用方给出可操作的报错）
 */
function resolveSketch(tabs: EditorTab[], activePath: string, tree: TreeNode | null): SketchResolution | null {
  const isIno = (t: EditorTab): boolean => t.name.toLowerCase().endsWith('.ino')
  const active = tabs.find((t) => t.id === activePath)
  // 1) 正在编辑的真实项目 .ino
  if (active && isIno(active) && isAbsPath(active.id)) {
    return { tab: active, sketch: active.id, virtual: false, reason: '当前编辑的项目 .ino' }
  }
  // 2) 已打开项目树里的第一个 .ino（优先于虚拟示例）
  const treeSketch = findSketch(tree)
  if (treeSketch) {
    return { tab: tabs.find((t) => t.id === treeSketch) ?? null, sketch: treeSketch, virtual: false, reason: '项目内的 .ino' }
  }
  // 3) 当前激活的虚拟 .ino（内置示例 / 未保存）
  if (active && isIno(active)) {
    return { tab: active, sketch: active.id, virtual: true, reason: '内置示例' }
  }
  // 4) 任意已打开的 .ino 标签页
  const anyIno = tabs.find(isIno)
  if (anyIno) {
    return { tab: anyIno, sketch: anyIno.id, virtual: !isAbsPath(anyIno.id), reason: '已打开的 .ino' }
  }
  return null
}

/**
 * 落盘 + 暂存：把命中标签页的最新内容写入磁盘（真实文件），或把虚拟文件暂存为真实临时工程。
 * 返回最终交给 arduino-cli 的 sketch 绝对路径；失败时返回 null（已输出错误日志）。
 */
async function prepareSketchForBuild(
  res: SketchResolution,
  log: (s: string) => void,
  markSaved: (id: string) => void
): Promise<string | null> {
  // 真实文件：先把最新编辑内容落盘（即使未手动保存，也以编辑器里的为准）
  if (res.tab && isAbsPath(res.tab.id)) {
    try {
      await window.api.fs.write(res.tab.id, res.tab.content)
      markSaved(res.tab.id)
    } catch {
      log('\n[错误] 保存失败，已中止：请检查磁盘空间或文件权限。\n')
      return null
    }
  }
  // 虚拟文件（内置示例 / 未保存）：暂存为真实临时工程再编译/烧录
  if (res.virtual) {
    try {
      const name = res.sketch.replace(/\.ino$/i, '').split('/').pop() || 'sketch'
      const staged = await window.api.fs.stageTemp(name, res.tab?.content ?? '')
      log(`\nℹ ${res.reason}已暂存到临时目录编译/烧录（不影响原文件）：${staged}\n`)
      return staged
    } catch (e) {
      log(`\n[错误] 示例暂存失败：${(e as Error).message}\n`)
      return null
    }
  }
  return res.sketch
}

// 从编译/烧录输出中提取错误上下文（供「一键 AI 诊断」使用）
function extractBuildError(log: string): string | null {
  // 主进程已输出结构化诊断块（分类 + 文件行号 + 修复建议），优先整块送给 AI
  const marker = log.indexOf('── 构建诊断 ──')
  if (marker >= 0) {
    const block = log.slice(marker).trim()
    return block.length > 2000 ? block.slice(0, 2000) + '\n…(已截断)' : block
  }
  const lines = log.split('\n')
  const errLines: number[] = []
  lines.forEach((l, i) => {
    if (/error:|error |错误|undefined reference|exit status|fatal error|Failed uploading|esptool|No such file|exception/i.test(l)) errLines.push(i)
  })
  if (errLines.length === 0) return null
  const last = errLines[errLines.length - 1]
  const start = Math.max(0, last - 8)
  const end = Math.min(lines.length, last + 10)
  let block = lines.slice(start, end).join('\n').trim()
  if (block.length > 1600) block = block.slice(0, 1600) + '\n…(已截断)'
  return block
}

const DEFAULT_TABS: EditorTab[] = [
  {
    id: 'welcome/welcome.ino',
    name: 'welcome.ino',
    language: 'cpp',
    content: `// ESP32 LED 闪烁示例
void setup() {
  pinMode(2, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(2, HIGH);
  delay(500);
  digitalWrite(2, LOW);
  delay(500);
}
`
  },
  {
    id: 'welcome/main.cpp',
    name: 'main.cpp',
    language: 'cpp',
    content: `#include <iostream>

int main() {
  std::cout << "Hello LabCode" << std::endl;
  return 0;
}
`
  },
  {
    id: 'welcome/README.md',
    name: 'README.md',
    language: 'markdown',
    content: `# 代码实验室 LabCode

通用软件开发智能体 · 插件系统 · 桌面客户端

界面采用桌面 IDE 四栏布局。
`
  }
]

function App(): React.JSX.Element {
  // 主题（默认浅色，可切换深色）
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('codelab-theme')
    return saved === 'dark' ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('codelab-theme', theme)
  }, [theme])
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])

  // 项目 / 文件
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [tabs, setTabs] = useState<EditorTab[]>(DEFAULT_TABS)
  const [activePath, setActivePath] = useState<string>(DEFAULT_TABS[0].id)

  // 工具链 / 串口
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null)
  const [fqbn, setFqbn] = useState('esp32:esp32:esp32c3')
  const [boardName, setBoardName] = useState('')
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [baud, setBaud] = useState(115200)
  const [serialOpen, setSerialOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [compileState, setCompileState] = useState<'idle' | 'compiling' | 'uploading' | 'success' | 'error'>('idle')
  const [compileProgress, setCompileProgress] = useState<{ percent: number; message: string } | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  // 编译过程可见化：阶段 / 已用时 / 资源用量（阶段与用量由主进程从真实输出解析）
  // 烧录阶段要走自己的 5 格（连接→擦除→写入→校验→复位），所以这里必须是完整的 BuildStageInfo，
  // 不能只写 { stage, label } —— 那样 flashStage 会被类型挡掉，烧录阶段条退化成一行文字。
  const [buildStage, setBuildStage] = useState<BuildStageInfo>({ stage: 'prepare', label: '准备' })
  const [buildUsage, setBuildUsage] = useState<{ flashBytes: number; flashPercent: number; ramBytes: number; ramPercent: number; rawFlash: string; rawRam: string } | null>(null)
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null)
  const [buildElapsedMs, setBuildElapsedMs] = useState(0)
  const [everBuilt, setEverBuilt] = useState(false)

  // AI 通道健康度：启动拉一次，之后低频刷新（状态栏与 AI 面板共用）
  useEffect(() => {
    let alive = true
    const pull = (): void => {
      window.api.aiHealth
        .get()
        .then((h) => {
          if (alive) setAiHealth(h)
        })
        .catch(() => undefined)
    }
    pull()
    const timer = setInterval(pull, 20000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 编译中：每 200ms 刷新已用时（真实计时，不编造进度百分比）
  useEffect(() => {
    if (buildStartedAt === null) return
    const t = setInterval(() => setBuildElapsedMs(Date.now() - buildStartedAt), 200)
    return () => clearInterval(t)
  }, [buildStartedAt])

  /**
   * 编译/烧录进行中 → 自动切到输出面板（否则用户看不到过程）。
   * 面板**折叠着也要展开**：原来这里 `cur === null` 时保持不变，
   * 结果面板收起状态下点编译，底部纹丝不动 —— 又变成"点了没反应"。
   */
  const ensureOutputVisible = useCallback((): void => {
    setBottomPanel('output')
  }, [])

  const cancelBuild = useCallback((): void => {
    if (!activeTaskId) return
    void window.api.cmd.kill(activeTaskId)
    setOutputLog((prev) => prev + '\n[取消] 已请求中断当前任务。\n')
    setCompileState('error')
    setBusy(false)
    buildStartedAtRef.current = null
    setBuildStartedAt(null)
    setActiveTaskId(null)
  }, [activeTaskId])

  // 日志
  const [outputLog, setOutputLog] = useState('')
  const [serialLog, setSerialLog] = useState('')
  // 底部面板重挂载 key（用于从设备面板"串口监视器"按钮切到串口 Tab）
  const [outputKey, setOutputKey] = useState(0)

  // 输出变化时让主进程解析当前阶段与用量（arduino-cli / gRPC 两条路径通用）
  useEffect(() => {
    if (!everBuilt) return
    let alive = true
    const id = setTimeout(() => {
      window.api.build
        .inspect(outputLog.slice(-20000))
        .then((r) => {
          if (!alive) return
          setBuildStage(r.stage)
          if (r.usage) setBuildUsage(r.usage)
        })
        .catch(() => undefined)
    }, 150)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [outputLog]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showNewProject, setShowNewProject] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('general')
  const [language, setLanguage] = useState<'zh' | 'en'>(() => (localStorage.getItem('codelab-lang') as 'zh' | 'en') || 'zh')
  const [shell, setShell] = useState<ShellType>(() => (localStorage.getItem('codelab-shell') as ShellType) || 'powershell')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  /**
   * 极简 / 专业界面。
   * 默认极简：整个窗口只有「编译 + 烧录」两个主按钮、左侧窄图标带、
   * 底部面板默认收起、首页只有一个输入框 —— 对齐 WorkBuddy / 豆包的消费级密度。
   * 想要全套 VSCode 面板的话，在 ☰ 菜单里切「专业界面」，功能一个不丢。
   */
  const [simple, setSimple] = useState<boolean>(() => localStorage.getItem('codelab-simple') !== '0')
  const toggleSimple = useCallback(() => {
    setSimple((v) => {
      const next = !v
      localStorage.setItem('codelab-simple', next ? '1' : '0')
      return next
    })
  }, [])
  const [pluginTypes, setPluginTypes] = useState<ProjectTypeItem[]>([])
  const [activeSidebar, setActiveSidebar] = useState('files')
  const [terminalVisible, setTerminalVisible] = useState(true)
  const [debugVisible, setDebugVisible] = useState(false)
  const [pioVisible, setPioVisible] = useState(false)
  const [targetVisible, setTargetVisible] = useState(false)
  /** 底部统一面板组：一次只显示一个（UI 重设计核心，见 PanelDock 注释） */
  // 极简模式默认收起底部面板（编译/烧录/报错时会自动弹开输出，用户不用去找）
  const [bottomPanel, setBottomPanel] = useState<PanelId | null>(simple ? null : 'output')
  const [panelHeight, setPanelHeight] = useState(280)
  /** Git 面板角标：变更文件数 */
  const [gitBadge, setGitBadge] = useState(0)
  /** 状态栏用：调试会话状态 + 当前目标摘要（只读，改动去硬件目标面板） */
  const [debugStatus, setDebugStatus] = useState<'idle' | 'starting' | 'running' | 'error'>('idle')
  const [aiHealth, setAiHealth] = useState<ChannelHealth | null>(null)
  const [targetLabel, setTargetLabel] = useState('')

  // 调试状态变化时更新状态栏（面板也会自己收，这里只取一份给状态栏用）
  useEffect(() => {
    let alive = true
    const read = (): void => {
      window.api.debug
        .state()
        .then((s) => {
          if (alive) setDebugStatus(s.status)
        })
        .catch(() => undefined)
    }
    read()
    const t = setInterval(read, 4000)
    const off = window.api.debug.onStopped(() => read())
    return () => {
      alive = false
      clearInterval(t)
      off()
    }
  }, [])

  /** 统一的面板开关：再点一次收起 */
  const openPanel = (id: PanelId): void => {
    setBottomPanel((cur) => {
      const next = cur === id ? null : id
      setTerminalVisible(next === 'output')
      setDebugVisible(next === 'debug')
      setPioVisible(next === 'platformio')
      setTargetVisible(next === 'target')
      return next
    })
  }

  // Git 变更数角标：打开工程时拉一次，之后低频刷新（git status 很轻）
  useEffect(() => {
    if (!projectRoot) {
      setGitBadge(0)
      return
    }
    let alive = true
    const pull = (): void => {
      window.api.git
        .status(projectRoot)
        .then((s) => {
          if (!alive) return
          setGitBadge(s.isRepo ? s.staged.length + s.unstaged.length + s.untracked.length : 0)
        })
        .catch(() => undefined)
    }
    pull()
    const timer = setInterval(pull, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [projectRoot])
  const [debugChip, setDebugChip] = useState<string | undefined>(undefined)
  const [leftPanelVisible, setLeftPanelVisible] = useState(!simple)
  const [editorVisible, setEditorVisible] = useState(true)
  const [aiPanelVisible, setAiPanelVisible] = useState(true)
  const [aiPrefill, setAiPrefill] = useState<{ text: string; nonce: number; autoSend?: boolean } | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [wiringSvg, setWiringSvg] = useState<string | null>(null)
  const buildLogRef = useRef<string>('')
  /** 单次烧录的输出累积（退出时用来取日志尾部写进烧录记录） */
  const uploadLogRef = useRef<string>('')
  // 烧录记录上下文：订阅回调是 [] deps，用 ref 取最新值避免闭包过期
  const burnCtxRef = useRef<{ projectRoot: string; fqbn: string; port: string }>({ projectRoot: '', fqbn: '', port: '' })
  useEffect(() => {
    burnCtxRef.current = { projectRoot: projectRoot || '', fqbn, port: selectedPort }
  }, [projectRoot, fqbn, selectedPort])
  const [examplesDir, setExamplesDir] = useState<string>('')

  // 更新（强制更新 / 自动更新）状态
  const [updater, setUpdater] = useState<UpdaterStatus | null>(null)

  const ex = useCallback((fileName: string) => {
    const base = examplesDir || `D:\\工作\\代码实验室\\codelab-desktop\\examples`
    return `${base}\\${fileName}`
  }, [examplesDir])

  const terminalRef = useRef<TerminalHandle>(null)
  const pendingTasksRef = useRef<Map<string, (code: number) => void>>(new Map())
  /**
   * 本次编译/烧录的真实起点。
   * 必须用 ref 而不是直接读 state：onTaskExit 的监听器是挂载时注册的（依赖数组为 []），
   * 读到的 buildStartedAt 永远是初始 null，耗时就永远算不出来。这里 ref 只进不出，退出时清空。
   */
  const buildStartedAtRef = useRef<number | null>(null)

  const toggleLeftPanel = useCallback(() => setLeftPanelVisible((v) => !v), [])
  const toggleEditor = useCallback(() => setEditorVisible((v) => !v), [])
  const onActivityChange = useCallback((id: string) => {
    if (id === 'ai') {
      setAiPanelVisible((v) => !v)
      return
    }
    // 极简模式下左侧栏默认收起：用户点「文件 / 烧录」图标时必须真的给他展开，
    // 否则图标点了没反应（原来 activeSidebar 改了但 leftPanelVisible 还是 false）
    if (!leftPanelVisible) setLeftPanelVisible(true)
    setActiveSidebar(id)
  }, [leftPanelVisible])

  /** 极简模式的两个轻量入口（⋯ 溢出菜单 / 左下角设置图标）统一回传，避免子组件各自造一套状态 */
  useEffect(() => {
    const onPanel = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      setBottomPanel(id as PanelId)
      setTerminalVisible(id === 'output')
      setDebugVisible(id === 'debug')
      setPioVisible(id === 'platformio')
      setTargetVisible(id === 'target')
    }
    const onSettings = (): void => {
      setSettingsTab('general')
      setShowSettings(true)
    }
    window.addEventListener('codelab:openPanel', onPanel)
    window.addEventListener('codelab:openSettings', onSettings)
    return () => {
      window.removeEventListener('codelab:openPanel', onPanel)
      window.removeEventListener('codelab:openSettings', onSettings)
    }
  }, [])

  // 欢迎页三大能力入口处理
  const handleFlash = useCallback(() => {
    setLeftPanelVisible(true)
    setActiveSidebar('device')
    setOutputLog((prev) => prev + '\n💡 请在左侧「设备」面板选择开发板和串口，然后点顶栏的「烧录」按钮一键烧录。\n')
  }, [])
  const focusAi = useCallback((text: string) => {
    setAiPanelVisible(true)
    setAiPrefill({ text, nonce: Date.now() })
  }, [])

  // 一键 AI 诊断：把捕获到的编译/烧录错误发给 AI 面板自动分析
  const diagnoseBuildError = useCallback(() => {
    if (!buildError) return
    setAiPanelVisible(true)
    setAiPrefill({
      text: `我执行编译/烧录时失败了，请帮我诊断原因并给出具体的修复步骤：\n\n${buildError}`,
      nonce: Date.now(),
      autoSend: true
    })
  }, [buildError])

  // 一键 AI 自动修复：进入 Debug 模式，让 Agent 直接定位并修复编译/烧录错误
  const debugFixBuildError = useCallback(() => {
    if (!buildError) return
    setAiPanelVisible(true)
    setAiPrefill({
      text:
        '我刚执行编译/烧录失败，请进入 Debug 模式：①定位报错根因；②直接编辑出错的源码文件修复它；③再次调用 compile 验证通过。' +
        '只改必要的代码，不要大改结构。报错信息如下：\n\n' +
        buildError,
      nonce: Date.now(),
      autoSend: true
    })
  }, [buildError])

  // 生成接线图：调用主进程 wiring 服务，弹窗展示 SVG
  const generateWiring = useCallback(async () => {
    try {
      const res = await window.api.wiring.generate({ fqbn, projectRoot: projectRoot || undefined })
      if (res && res.ok && res.svg) {
        setWiringSvg(res.svg)
      } else {
        setWiringSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="40" style="fill:var(--danger)" font-size="13">生成失败：${res?.error || '未知错误'}</text></svg>`)
      }
    } catch (e) {
      setWiringSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="40" style="fill:var(--danger)" font-size="13">生成异常：${(e as Error).message}</text></svg>`)
    }
  }, [fqbn, projectRoot])

  const cwd = projectRoot ?? (window.api.platform === 'win32' ? 'C:\\' : '/')

  // 初始化：工具链检测 + 端口枚举 + 插件列表 + 设备上下文
  useEffect(() => {
    window.api.toolchain.detect().then(setToolchain).catch(() => setToolchain(null))
    window.api.serial.list().then(setPorts).catch(() => setPorts([]))
    window.api.app.getExamplesDir().then(setExamplesDir).catch(() => undefined)
    window.api.device.get().then((d) => {
      if (d.board) setFqbn(d.board)
      if (d.port) setSelectedPort(d.port)
    }).catch(() => undefined)
    window.api.plugin
      .projectTypes()
      .then((pts) =>
        setPluginTypes(
          pts.map((p) => ({ id: p.id, name: p.title, icon: p.icon ?? '🔧', desc: '插件提供', scaffold: p.scaffold }))
        )
      )
      .catch(() => setPluginTypes([]))
  }, [])

  // 订阅主进程流式事件
  useEffect(() => {
    const offOutput = window.api.onTaskOutput((d) => {
      if (d.id.startsWith('cmd-')) {
        terminalRef.current?.append(d.chunk)
      } else {
        if (d.id.startsWith('grpc-compile-') || d.id.startsWith('cap-compile-') || d.id.startsWith('grpc-upload-') || d.id.startsWith('cap-upload-')) {
          buildLogRef.current += d.chunk
        }
        if (d.id.startsWith('grpc-upload-') || d.id.startsWith('cap-upload-')) {
          uploadLogRef.current += d.chunk
        }
        setOutputLog((prev) => prev + d.chunk)
      }
    })
    const offExit = window.api.onTaskExit((d) => {
      const line = d.id.startsWith('cmd-')
        ? `\x1b[90m[进程结束 code=${d.code}]\x1b[0m\r\n`
        : `\n[任务结束，退出码 ${d.code}]\n`
      if (d.id.startsWith('cmd-')) terminalRef.current?.append(line)
      else setOutputLog((prev) => prev + line)
      setBusy(false)
      // 编译 / 烧录任务：更新状态并捕获错误（供「一键 AI 诊断」）
      const isCompile = d.id.startsWith('cap-compile-') || d.id.startsWith('grpc-compile-')
      const isUpload = d.id.startsWith('cap-upload-') || d.id.startsWith('grpc-upload-')
      if (isCompile || isUpload) {
        setCompileState(d.code === 0 ? 'success' : 'error')
        setCompileProgress(null)
        // 过程可见化：停表并冻结最终耗时（结果卡要显示真实耗时）
        const startedAt = buildStartedAtRef.current
        if (startedAt !== null) {
          const spent = Date.now() - startedAt
          setBuildElapsedMs(spent)
          buildStartedAtRef.current = null
          setBuildStartedAt(null)
          // 收尾结论直接写进输出流：用户不用去猜「刚才那几秒到底成没成」
          if (d.code === 0) {
            setOutputLog((prev) =>
              prev + (isUpload
                ? `\n[完成] 烧录成功，用时 ${(spent / 1000).toFixed(1)}s\n`
                : `\n[完成] 编译成功，用时 ${(spent / 1000).toFixed(1)}s\n`)
            )
          }
        }
        setBuildStage(isUpload
          ? { stage: d.code === 0 ? 'flashed' : 'flashing', label: d.code === 0 ? '烧录完成' : '烧录失败' }
          : { stage: d.code === 0 ? 'done' : 'sketch', label: d.code === 0 ? '完成' : '编译失败' })
        if (d.code !== 0) {
          setBuildError(extractBuildError(buildLogRef.current))
        } else {
          setBuildError(null)
          buildLogRef.current = ''
        }
      }
      // 烧录收尾：把这次的源码快照记进烧录历史（供诊断面板回滚）。失败也记，便于回退到上一个能跑的版本。
      if (isUpload) {
        const ctx = burnCtxRef.current
        const tail = uploadLogRef.current
        uploadLogRef.current = ''
        if (ctx.projectRoot) {
          window.api.burn
            .record({ projectRoot: ctx.projectRoot, fqbn: ctx.fqbn, port: ctx.port, ok: d.code === 0, logTail: tail.slice(-2000) })
            .catch(() => undefined)
        }
      }
      setActiveTaskId(null)
      // resolve pending task
      const resolver = pendingTasksRef.current.get(d.id)
      if (resolver) {
        pendingTasksRef.current.delete(d.id)
        resolver(d.code)
      }
    })
    const offProgress = window.api.onTaskProgress?.((d) => {
      if (d.id.startsWith('grpc-compile-') || d.id.startsWith('grpc-upload-')) {
        setCompileProgress({ percent: d.percent, message: d.message })
      }
      // 烧录写入进度：主进程解析的是 esptool 真输出，直接铺到过程条上给用户看。
      // stage 是烧录子阶段（连接/擦除/写入/校验/复位），阶段条靠它一格一格往前走，
      // 不然点烧录后编译那排阶段条会整段消失，只剩一行文字，看着像过程条退化。
      if (d.id.startsWith('grpc-upload-') && d.message) {
        const flash = d.stage as FlashStage | undefined
        setBuildStage({ stage: 'flashing', label: d.message, flashStage: flash })
      }
      // 编译阶段条：主进程按真实输出推进（准备→编译草图→编译库→链接→生成二进制），
      // 界面只显示不猜测——不然编译那几十秒阶段条一直停在「准备」，看着像没在动
      if (d.id.startsWith('grpc-compile-') && d.message) {
        const order: Array<'prepare' | 'sketch' | 'libs' | 'link' | 'image' | 'done'> = [
          'prepare', 'sketch', 'libs', 'link', 'image', 'done'
        ]
        const st = order.find((s) => s === d.stage)
        setBuildStage({ stage: st ?? 'prepare', label: d.message })
      }
    })
    const offSerial = window.api.onSerialData((d) => setSerialLog((prev) => prev + d.data))
    const offClose = window.api.onSerialClose((d) => {
      setSerialLog((prev) => prev + `\n${d.msg}\n`)
      setSerialOpen(false)
    })
    // 串口热插拔：端口列表变化自动刷新（插上/拔出开发板）
    const offPorts = window.api.serial.onPortsChanged?.((d) => {
      setPorts(d.ports as SerialPortInfo[])
    })
    // 热插拔自动选中：插入开发板自动选端口 + 板卡 FQBN；拔出则清除选中
    const offAuto = window.api.device.onAutoSelect?.((d) => {
      if (d.action === 'added') {
        if (d.fqbn) {
          setFqbn(d.fqbn)
          window.api.device.set({ board: d.fqbn }).catch(() => undefined)
        }
        if (d.port) {
          setSelectedPort(d.port)
          window.api.device.set({ port: d.port }).catch(() => undefined)
        }
        if (d.name) setBoardName(d.name)
        setOutputLog(
          (prev) =>
            prev +
            `\n🔌 检测到开发板：${d.port}${d.fqbn ? ` · ${d.name || d.fqbn}` : '（未识别到板卡型号，仅选中端口）'}，已自动选中。\n`
        )
      } else if (d.action === 'removed') {
        setSelectedPort((prev) => (d.removed?.includes(prev) ? '' : prev))
        setOutputLog((prev) => prev + `\n🔌 串口已拔出：${(d.removed || []).join('、')}\n`)
      }
    })
    return () => {
      offOutput()
      offExit()
      offProgress?.()
      offSerial()
      offClose()
      offPorts?.()
      offAuto?.()
    }
  }, [])

  // 订阅主进程更新状态（检查中 / 可用 / 下载进度 / 已是最新 / 错误）
  useEffect(() => {
    const off = window.api.updater.onStatus(setUpdater)
    return off
  }, [])

  // 非阻塞状态（已是最新 / 未启用 / 已跳过 / 错误）自动收起，避免长期占用界面
  useEffect(() => {
    if (!updater) return
    if (updater.state === 'postponed') {
      setUpdater(null)
      return
    }
    if (updater.state === 'up-to-date' || updater.state === 'disabled') {
      const t = setTimeout(() => setUpdater(null), 3500)
      return () => clearTimeout(t)
    }
    if (updater.state === 'error') {
      const t = setTimeout(() => setUpdater(null), 8000)
      return () => clearTimeout(t)
    }
  }, [updater])

  // 命令面板快捷键 Ctrl+Shift+P
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setCommandPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 打开项目
  const openProject = useCallback(async () => {
    const res = await window.api.project.open()
    if (!res) return
    setProjectRoot(res.root)
    setTree(res.tree)
    setCwdHint(res.root)
  }, [])

  const setCwdHint = useCallback((_root: string) => {
    /* cwd 由 projectRoot 派生，无需额外状态 */
  }, [])

  // 打开文件
  const openFile = useCallback(async (path: string, name: string) => {
    setActivePath(path)
    setTabs((prev) => {
      if (prev.some((t) => t.id === path)) return prev
      return [...prev, { id: path, name, language: langOf(name), content: '' }]
    })
    try {
      const content = await window.api.fs.read(path)
      setTabs((prev) =>
        prev.map((t) => (t.id === path ? { ...t, content } : t))
      )
    } catch (e) {
      setOutputLog((prev) => prev + `\n[错误] 无法打开 ${path}：${(e as Error).message}\n`)
      setTabs((prev) => prev.filter((t) => t.id !== path))
    }
  }, [])

  // 编辑器变更
  const onChange = useCallback((id: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content, dirty: true } : t)))
  }, [])

  /**
   * 落盘一个 tab 的内容。
   * 刻意**不读 `tabs` 闭包**：批量保存时闭包里的 tabs 是旧的，靠外面把最新的 tab 对象
   * 传进来，才不会把过期内容写回磁盘（陈旧闭包这个坑在本文件里已经踩过两次）。
   */
  const saveTab = useCallback(async (tab: EditorTab): Promise<boolean> => {
    try {
      await window.api.fs.write(tab.id, tab.content)
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, dirty: false } : t)))
      setOutputLog((prev) => prev + `\n✓ 已保存 ${tab.name}\n`)
      return true
    } catch (e) {
      setOutputLog((prev) => prev + `\n[错误] 保存失败：${(e as Error).message}\n`)
      return false
    }
  }, [])

  // 保存
  const onSave = useCallback(async (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (tab) await saveTab(tab)
  }, [tabs, saveTab])

  /**
   * 未保存改动闸门（三选：保存 / 不保存 / 取消）。
   * 返回 true = 调用方可以继续执行那个动作；false = 用户选了取消、或保存失败。
   *
   * 凡是会**丢弃用户内容**的动作都必须先过这里：关标签页、关项目、关窗口。
   * 之前这三条路径都直接丢，dirty 标记明明算出来了却没人看 —— 属于静默数据丢失。
   */
  const guardUnsaved = useCallback(
    async (targets: EditorTab[]): Promise<boolean> => {
      if (targets.length === 0) return true
      const names = targets.map((t) => t.name || t.id.split(/[\\/]/).pop() || t.id)
      const shown = names.slice(0, 5).join('、')
      const more = names.length > 5 ? ` 等 ${names.length} 个文件` : ''
      const idx = await window.api.dialog.confirm({
        title: '有未保存的改动',
        message: `${shown}${more} 有未保存的改动。`,
        detail: '「保存」会先写入磁盘再关闭；「不保存」会直接丢弃这些改动。',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2
      })
      if (idx === 2) return false // 取消：什么都别做
      if (idx === 0) {
        for (const t of targets) {
          // 保存失败也当作"取消"：不然关掉之后内容照样没了
          if (!(await saveTab(t))) return false
        }
      }
      return true
    },
    [saveTab]
  )

  /** 关窗前的最新 tabs（用 ref 存，避免每次击键都重新注册监听器） */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // 关窗：主进程会把 close 事件拦住先问这里，直接点窗口 × 也不能把改动带走
  useEffect(() => {
    const off = window.api.onConfirmClose(() => {
      void (async () => {
        const dirty = tabsRef.current.filter((t) => t.dirty)
        const go = await guardUnsaved(dirty)
        await window.api.closeResult(go ? 'close' : 'cancel')
      })()
    })
    return off
  }, [guardUnsaved])

  // 关闭 tab（有未保存改动时先过闸门，不再静默丢弃）
  const onClose = useCallback(
    async (id: string) => {
      const tab = tabs.find((t) => t.id === id)
      if (tab?.dirty && !(await guardUnsaved([tab]))) return
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id)
        const next = prev.filter((t) => t.id !== id)
        if (id === activePath && next.length > 0) {
          setActivePath(next[Math.min(idx, next.length - 1)].id)
        }
        return next
      })
    },
    [tabs, activePath, guardUnsaved]
  )

  // 编译 / 烧录（对齐 TrieCode：门控 + 保存检查 + 状态机 + 流式输出）
  // 内置示例 / 未保存的 .ino 会自动暂存到临时目录再编译烧录（Arduino IDE 同款做法），无需先建项目。
  const runCompile = useCallback(async () => {
    // 门控最前：进行中再点击给明确反馈（而不是静默吞掉，避免"点了没反应像卡死"）
    if (compileState === 'compiling' || compileState === 'uploading') {
      setOutputLog((prev) => prev + '\n[提示] 已有编译/烧录任务在进行中，请等待完成或查看输出面板。\n')
      return
    }
    if (!toolchain?.available || !toolchain.path) {
      setOutputLog((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      return
    }
    // sketch 解析：优先识别你正在编辑的 .ino；其次项目树里的 .ino；再次任意已打开的 .ino
    const resolved = resolveSketch(tabs, activePath, tree)
    if (!resolved) {
      const msg = tree
        ? '\n[错误] 当前项目内未找到 .ino 工程文件。请在左侧「文件」面板点开项目里的 .ino 文件，或确认工程根目录/同名目录含 <工程名>.ino。\n'
        : '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再编译。\n'
      setOutputLog((prev) => prev + msg)
      setCompileState('error')
      return
    }
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }

    // 落盘最新编辑内容 / 暂存虚拟文件，得到最终交给 arduino-cli 的 sketch 路径
    const sketch = await prepareSketchForBuild(
      resolved,
      (s) => setOutputLog((p) => p + s),
      (id) => setTabs((p) => p.map((t) => (t.id === id ? { ...t, dirty: false } : t)))
    )
    if (!sketch) {
      setCompileState('error')
      return
    }

    setOutputLog((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    // 首次编译要现下板卡支持包（ESP32 core 几百 MB），那段时间 arduino-cli 几乎不打印东西，
    // 不提前说明就会以为卡死。已经在本会话编译过就不啰嗦了。
    if (!everBuilt) {
      setOutputLog((prev) => prev + '  首次编译需下载板卡支持包（ESP32 core 约 300MB），可能要 1–3 分钟才有新输出，属正常。\n')
    }
    setCompileState('compiling')
    // 过程可见化：记录开始时间并自动切到输出面板，否则用户看不到编译过程
    buildStartedAtRef.current = Date.now()
    setBuildStartedAt(Date.now())
    setBuildElapsedMs(0)
    setBuildStage({ stage: 'prepare', label: '准备' })
    setEverBuilt(true)
    ensureOutputVisible()
    setCompileProgress(null)
    setBusy(true)
    try {
      const result = await window.api.grpc.compile({ sketch, fqbn })
      if (result.id) {
        setActiveTaskId(result.id)
        // 180s 兜底：task:exit 事件万一丢失时复位状态，避免"永久编译中"假死
        pendingTasksRef.current.set(result.id, () => undefined)
        setTimeout(() => {
          if (pendingTasksRef.current.has(result.id)) {
            pendingTasksRef.current.delete(result.id)
            setOutputLog((prev) => prev + '\n[错误] 编译超过 180s 无响应，已复位状态。请重试；若反复出现请检查工具链。\n')
            setCompileState('error')
            setBusy(false)
          }
        }, 180000)
      } else {
        setOutputLog((prev) => prev + '[错误] 编译启动失败（gRPC）\n')
        setCompileState('error')
        setBusy(false)
      }
    } catch (e) {
      setOutputLog((prev) => prev + `[错误] 编译异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
    }
  }, [toolchain, tree, activePath, fqbn, compileState, tabs, everBuilt])

  const runUpload = useCallback(async () => {
    // 门控最前：进行中再点击给明确反馈（避免静默吞掉像"卡死"）
    if (compileState === 'compiling' || compileState === 'uploading') {
      setOutputLog((prev) => prev + '\n[提示] 已有编译/烧录任务在进行中，请等待完成或查看输出面板。\n')
      return
    }
    if (!toolchain?.available || !toolchain.path) {
      setOutputLog((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      return
    }
    if (!selectedPort) {
      setOutputLog((prev) => prev + '\n[错误] 请先在工具栏选择串口端口。\n')
      return
    }
    // sketch 解析：优先识别你正在编辑的 .ino；其次项目树里的 .ino；再次任意已打开的 .ino
    const resolved = resolveSketch(tabs, activePath, tree)
    if (!resolved) {
      const msg = tree
        ? '\n[错误] 当前项目内未找到 .ino 工程文件。请在左侧「文件」面板点开项目里的 .ino 文件，或确认工程根目录/同名目录含 <工程名>.ino。\n'
        : '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再烧录。\n'
      setOutputLog((prev) => prev + msg)
      setCompileState('error')
      return
    }
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }

    // 落盘最新编辑内容 / 暂存虚拟文件，得到最终交给 arduino-cli 的 sketch 路径
    const sketch = await prepareSketchForBuild(
      resolved,
      (s) => setOutputLog((p) => p + s),
      (id) => setTabs((p) => p.map((t) => (t.id === id ? { ...t, dirty: false } : t)))
    )
    if (!sketch) {
      setCompileState('error')
      return
    }

    // 烧录前暂停串口监视器
    const wasSerialOpen = serialOpen
    if (wasSerialOpen) {
      await window.api.serial.close(`serial-${selectedPort}`)
      setSerialOpen(false)
    }

    // 先编译
    setOutputLog((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    if (!everBuilt) {
      setOutputLog((prev) => prev + '  首次编译需下载板卡支持包（ESP32 core 约 300MB），可能要 1–3 分钟才有新输出，属正常。\n')
    }
    setCompileState('compiling')
    // 过程可见化：烧录是「编译 + 写入」两段，编译这段同样要让人看见——
    // 之前这里漏了，表现为点烧录后长时间没动静（面板不切、阶段条不动），像卡死。
    // 计时器不在下面 upload 段重置：烧录结束冻结的是「本次点烧录」的总耗时。
    buildStartedAtRef.current = Date.now()
    setBuildStartedAt(Date.now())
    setBuildElapsedMs(0)
    setBuildStage({ stage: 'prepare', label: '准备编译' })
    setEverBuilt(true)
    ensureOutputVisible()
    setCompileProgress(null)
    setBusy(true)

    const restoreSerial = async (): Promise<void> => {
      if (wasSerialOpen) {
        try {
          await window.api.serial.open({ port: selectedPort, baud })
          setSerialOpen(true)
        } catch { /* ignore */ }
      }
    }

    try {
      const compileResult = await window.api.grpc.compile({ sketch, fqbn })
      if (!compileResult.id) {
        setOutputLog((prev) => prev + '[错误] 编译启动失败（gRPC）\n')
        setCompileState('error')
        setBusy(false)
        await restoreSerial()
        return
      }
      setActiveTaskId(compileResult.id)
      // 等待编译完成（180s 超时兜底）
      const compileCode = await new Promise<number>((resolve) => {
        pendingTasksRef.current.set(compileResult.id, resolve)
        setTimeout(() => {
          if (pendingTasksRef.current.has(compileResult.id)) {
            pendingTasksRef.current.delete(compileResult.id)
            resolve(-1) // 超时
          }
        }, 180000)
      })
      if (compileCode !== 0) {
        setOutputLog((prev) => prev + `[错误] 编译失败（退出码 ${compileCode}），已中止烧录。\n`)
        setCompileState('error')
        setBusy(false)
        await restoreSerial()
        return
      }
    } catch (e) {
      setOutputLog((prev) => prev + `[错误] 编译异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
      await restoreSerial()
      return
    }

    // 编译成功，开始上传（grpc:upload；daemon 不可用时主进程自动降级 CLI，不会挂死）
    setOutputLog((prev) => prev + `\n▶ [烧录] arduino-cli upload --fqbn ${fqbn} --port ${selectedPort} ${sketch}\n`)
    setOutputLog((prev) => prev + `   正在写入 ${selectedPort}，期间请勿拔线…\n`)
    setCompileState('uploading')
    // 计时器保持连续（不重置），结束时冻结的是「编译 + 烧录」总耗时
    setBuildStage({ stage: 'flashing', label: `写入 ${selectedPort}` })
    ensureOutputVisible()
    try {
      const uploadResult = await window.api.grpc.upload({ sketch, fqbn, port: selectedPort })
      if (uploadResult.id) {
        setActiveTaskId(uploadResult.id)
        pendingTasksRef.current.set(uploadResult.id, async () => {
          setBusy(false)
          await restoreSerial()
        })
        // 120s 兜底：烧录事件丢失时复位状态，避免"永久烧录中"假死
        setTimeout(() => {
          if (pendingTasksRef.current.has(uploadResult.id)) {
            pendingTasksRef.current.delete(uploadResult.id)
            setOutputLog((prev) => prev + '\n[错误] 烧录超过 120s 无响应，已复位状态。请检查端口是否被占用/板子是否进入下载模式，再重试。\n')
            setCompileState('error')
            setBusy(false)
            void restoreSerial()
          }
        }, 120000)
      } else {
        setOutputLog((prev) => prev + '[错误] 烧录启动失败\n')
        setCompileState('error')
        setBusy(false)
        await restoreSerial()
      }
    } catch (e) {
      setOutputLog((prev) => prev + `[错误] 烧录异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
      await restoreSerial()
    }
  }, [toolchain, tree, activePath, fqbn, selectedPort, compileState, tabs, serialOpen, baud, everBuilt])

  // 串口开关
  const toggleSerial = useCallback(async () => {
    if (serialOpen) {
      await window.api.serial.close(`serial-${selectedPort}`)
      setSerialOpen(false)
      return
    }
    if (!selectedPort) return
    await window.api.serial.open({ port: selectedPort, baud })
    setSerialLog((prev) => prev + `\n—— 打开 ${selectedPort} @ ${baud} ——\n`)
    setSerialOpen(true)
  }, [serialOpen, selectedPort, baud])

  // 终端命令
  const runCommand = useCallback(async (cmd: string) => {
    await window.api.cmd.run({ cmd, cwd, shell })
  }, [cwd, shell])

  // 命令面板执行
  const handleExecuteCommand = useCallback(async (cmd: { id: string; title: string; kind: string; plugin: string; view?: string; transport?: string }) => {
    setOutputLog((prev) => prev + `\n[命令面板] 执行: ${cmd.title} (${cmd.id})\n`)
    if (cmd.kind === 'action') {
      // 尝试通过 capability 路由执行（命令 id 去掉插件前缀）
      const capId = cmd.id.replace(`${cmd.plugin}.`, '')
      try {
        const result = await window.api.capability.run(capId, {})
        if (!result.ok) {
          setOutputLog((prev) => prev + `[命令面板] ${result.error || '执行失败'}\n`)
        }
      } catch {
        setOutputLog((prev) => prev + `[命令面板] 命令 ${capId} 暂无绑定执行器\n`)
      }
    } else if (cmd.kind === 'open-view') {
      setOutputLog((prev) => prev + `[命令面板] 视图系统待实现: ${cmd.view || cmd.id}\n`)
    }
  }, [])

  // 刷新端口
  const refreshPorts = useCallback(async () => {
    const p = await window.api.serial.list()
    setPorts(p)
  }, [])

  // AI 代码应用到新文件
  const applyCodeToFile = useCallback((lang: string, content: string) => {
    const extMap: Record<string, { ext: string; language: string }> = {
      python: { ext: 'py', language: 'python' },
      py: { ext: 'py', language: 'python' },
      javascript: { ext: 'js', language: 'javascript' },
      js: { ext: 'js', language: 'javascript' },
      typescript: { ext: 'ts', language: 'typescript' },
      ts: { ext: 'ts', language: 'typescript' },
      cpp: { ext: 'cpp', language: 'cpp' },
      c: { ext: 'c', language: 'c' },
      rust: { ext: 'rs', language: 'rust' },
      go: { ext: 'go', language: 'go' },
      java: { ext: 'java', language: 'java' },
      json: { ext: 'json', language: 'json' },
      html: { ext: 'html', language: 'html' },
      css: { ext: 'css', language: 'css' },
      bash: { ext: 'sh', language: 'shell' },
      shell: { ext: 'sh', language: 'shell' },
      sql: { ext: 'sql', language: 'sql' },
      yaml: { ext: 'yml', language: 'yaml' },
      markdown: { ext: 'md', language: 'markdown' },
      ino: { ext: 'ino', language: 'cpp' },
    }
    const info = extMap[lang.toLowerCase()] ?? { ext: 'txt', language: 'plaintext' }
    const id = `ai-${Date.now()}.${info.ext}`
    setTabs((prev) => [...prev, { id, name: `ai-generated.${info.ext}`, language: info.language, content }])
    setActivePath(id)
    setOutputLog((prev) => prev + `\n✓ AI 代码已应用到新文件：ai-generated.${info.ext}\n`)
  }, [])

  // 新建工程
  const createProject = useCallback(async (type: string, name: string, scaffold?: Array<{ file: string; content: string }>) => {
    const res = await window.api.project.create({ type, name, parentPath: projectRoot ?? undefined, scaffold })
    if (!res.ok || !res.root) throw new Error(res.error ?? '创建失败')
    setProjectRoot(res.root)
    setTree(res.tree ?? null)
    setOutputLog((prev) => prev + `\n✓ 已创建工程：${res.root}\n`)
  }, [projectRoot])

  // 新建空白文件
  const newUntitledFile = useCallback(() => {
    const id = `untitled-${Date.now()}`
    setTabs((prev) => [...prev, { id, name: 'untitled', language: 'plaintext', content: '' }])
    setActivePath(id)
  }, [])

  // 保存当前文件
  const saveActive = useCallback(() => {
    void onSave(activePath)
  }, [activePath, onSave])

  // 底部折叠条上的一行状态：极简模式用它替代常驻的 6 个面板标签
  const dockStatusText =
    compileState === 'compiling' || compileState === 'uploading'
      ? `${compileState === 'compiling' ? '编译中' : '烧录中'} ${(buildElapsedMs / 1000).toFixed(1)}s`
      : compileState === 'success'
        ? `编译成功 ${(buildElapsedMs / 1000).toFixed(1)}s`
        : compileState === 'error'
          ? (busy ? '烧录中…' : '编译 / 烧录失败')
          : serialOpen ? '串口已连接' : ''

  return (
    <div className="ide">
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onExecute={(cmd) => void handleExecuteCommand(cmd)}
      />
      <TitleBar
        onNewProject={() => setShowNewProject(true)}
        onNewFile={newUntitledFile}
        onOpenProject={() => void openProject()}
        onSave={saveActive}
        onCloseProject={() => {
          void (async () => {
            // 关闭项目：清空所有标签页 + 项目状态（对齐 TrieCode"关闭项目 Ctrl+W"）。
            // 这里会一次性丢掉所有 tab，所以必须先过未保存闸门 —— 原来直接 setTabs([])，
            // 用户开了 5 个文件没保存，按一下 Ctrl+W 就全没了。
            const dirty = tabs.filter((t) => t.dirty)
            if (!(await guardUnsaved(dirty))) return
            setTabs([])
            setActivePath('')
            setProjectRoot(null)
            setTree(null)
            setOutputLog((prev) => prev + '\n📁 项目已关闭\n')
          })()
        }}
        onExit={() => window.api?.window?.close?.()}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => { setSettingsTab('general'); setShowSettings(true) }}
        onCompile={() => void runCompile()}
        onUpload={() => void runUpload()}
        onToggleTerminal={() => openPanel('output')}
        onToggleDebug={() => openPanel('debug')}
        debugVisible={bottomPanel === 'debug'}
        terminalVisible={bottomPanel === 'output'}
        onToggleTarget={() => openPanel('target')}
        targetVisible={bottomPanel === 'target'}
        onToggleGit={() => openPanel('git')}
        gitVisible={bottomPanel === 'git'}
        leftPanelVisible={leftPanelVisible}
        editorVisible={editorVisible}
        onToggleLeftPanel={toggleLeftPanel}
        onToggleEditor={toggleEditor}
        busy={busy}
        compileState={compileState}
        theme={theme}
        simple={simple}
        onToggleSimple={toggleSimple}
        onOpenSearch={() => setCommandPaletteOpen(true)}
      />
      {updater && (
        <div className={`updater-banner ${updater.state}${updater.force ? ' force' : ''}`}>
          {updater.state === 'checking' && <span className="updater-text">🔄 正在检查更新…</span>}
          {updater.state === 'downloading' && (
            <span className="updater-text">
              ⬇ 正在下载更新 v{updater.info?.version}
              {updater.progress != null ? `（${Math.round(updater.progress * 100)}%）` : ''}…
            </span>
          )}
          {updater.state === 'downloaded' && <span className="updater-text">✅ 下载完成，正在重启安装…</span>}
          {updater.state === 'available' && (
            <span className="updater-text">
              🆕 发现新版本 v{updater.info?.version}
              {updater.force ? '（强制更新）' : ''}
              {updater.info?.notes ? `：${updater.info.notes}` : ''}
            </span>
          )}
          {updater.state === 'up-to-date' && (
            <span className="updater-text">✓ {updater.message || '已是最新版本'}</span>
          )}
          {updater.state === 'disabled' && <span className="updater-text">⚙ {updater.message || '更新未启用'}</span>}
          {updater.state === 'error' && <span className="updater-text">⚠ {updater.message || '更新出错'}</span>}

          {updater.state === 'available' && !updater.force && (
            <button className="updater-btn" onClick={() => void window.api.updater.check({ interactive: true })}>
              立即更新
            </button>
          )}
          {updater.state === 'error' && (
            <button className="updater-btn" onClick={() => void window.api.updater.check({ interactive: true })}>
              重试
            </button>
          )}
          {(updater.state === 'available' || updater.state === 'up-to-date' || updater.state === 'disabled' || updater.state === 'error') && (
            <button className="updater-close" onClick={() => setUpdater(null)} aria-label="关闭">
              ×
            </button>
          )}
        </div>
      )}
      <div className="ide-body">
        {/* 图标带必须常驻：它是极简模式下唯一的左侧导航，
            之前把它和 sidebar 一起塞进 leftPanelVisible 里，收起左侧后连「文件」图标都没了 */
        }
        <ActivityBar active={activeSidebar} onChange={onActivityChange} aiActive={aiPanelVisible} simple={simple} />
        {leftPanelVisible && (
          <aside className="sidebar">
            {activeSidebar === 'files' && (
                <ProjectTree
                  root={projectRoot}
                  tree={tree}
                  activePath={activePath}
                  onOpenFile={(p, n) => void openFile(p, n)}
                  onOpenProject={() => void openProject()}
                />
              )}
              {activeSidebar === 'device' && (
                <ToolchainSidebar
                  projectRoot={projectRoot}
                  onOpenFile={(p, n) => void openFile(p, n || p.split(/[\\/]/).pop() || 'file')}
                  onBoardChange={(f, name) => {
                    setFqbn(f)
                    if (name) setBoardName(name)
                  }}
                  onPortChange={setSelectedPort}
                  serialSessionId={serialOpen && selectedPort ? `serial-${selectedPort}` : null}
                  onOpenSerialWindow={() => {
                    // 串口监视器统一走底部面板（不再弹浮窗，避免遮挡编辑器/仿真面板）。
                    // 之前这里只 setTerminalVisible(true) —— 那是个已被 PanelDock 取代的遗留 state
                    // （现在读的是 bottomPanel === 'output'），改它等于什么都没做：
                    // 面板折叠着或停在别的页签时，点了毫无反应。
                    ensureOutputVisible()
                    // 重建 OutputPanel → 页签回到 defaultTab「串口监视器」
                    setOutputKey((k) => k + 1)
                  }}
                  onGenerateWiring={() => void generateWiring()}
                />
              )}
          </aside>
        )}
        <div className="ide-center">
          {editorVisible && (tabs.length === 0 ? (
            <WelcomeView
              onOpenExample={(fileName) => {
                void openFile(ex(fileName), fileName)
              }}
              onOpenProject={() => void openProject()}
              onFlash={handleFlash}
              onAssist={() => focusAi('')}
              onSolve={() => focusAi('把这段编译 / 烧录 / 串口报错粘贴给我，我帮你定位原因并给出修复方案：\n')}
              simple={simple}
              onAsk={(text) => focusAi(text)}
            />
          ) : (
            <EditorArea
              tabs={tabs}
              activeId={activePath}
              onSelect={setActivePath}
              onClose={onClose}
              onChange={onChange}
              onSave={(id) => void onSave(id)}
              theme={theme}
            />
          ))}
          {/* 折叠条（showMinibar）不能只在极简模式给：专业模式下把面板收起后，
              PanelDock 会 return null，底部连一个"再展开"的入口都没有 ——
              用户只能靠菜单命令把它唤回来，等于功能被藏死了。 */}
          <PanelDock
            active={bottomPanel}
            onChange={(id) => {
              setBottomPanel(id)
              // 旧 state 与面板组保持一致，避免两套开关互相打架
              setTerminalVisible(id === 'output')
              setDebugVisible(id === 'debug')
              setPioVisible(id === 'platformio')
              setTargetVisible(id === 'target')
            }}
            height={panelHeight}
            onHeightChange={setPanelHeight}
            badges={{ output: buildError ? '!' : 0, git: gitBadge }}
            showMinibar
            statusText={dockStatusText}
            render={(id) => {
              if (id === 'output') {
                return (
                  <OutputPanel
                    key={outputKey}
                    outputLog={outputLog}
                    serialLog={serialLog}
                    cwd={cwd}
                    ports={ports}
                    selectedPort={selectedPort}
                    setSelectedPort={setSelectedPort}
                    baud={baud}
                    setBaud={setBaud}
                    serialOpen={serialOpen}
                    onToggleSerial={() => void toggleSerial()}
                    onRunCommand={(cmd) => void runCommand(cmd)}
                    terminalRef={terminalRef}
                    theme={theme}
                    shell={shell}
                    onClose={() => setBottomPanel(null)}
                    defaultTab="串口监视器"
                    buildError={buildError}
                    buildVisible={everBuilt}
                    buildActive={compileState === 'compiling' || compileState === 'uploading'}
                    buildStage={buildStage}
                    buildElapsedMs={buildElapsedMs}
                    buildCancellable={!!activeTaskId}
                    buildFailed={compileState === 'error'}
                    buildProgressPercent={compileProgress?.percent ?? null}
                    onCancelBuild={cancelBuild}
                    buildUsage={buildUsage}
                    onDiagnose={diagnoseBuildError}
                    onDebugFix={debugFixBuildError}
                  />
                )
              }
              if (id === 'debug') return <DebugPanel fqbn={fqbn} chipOverride={debugChip} onClose={() => setBottomPanel(null)} />
              if (id === 'platformio') return <PlatformIOPanel projectRoot={projectRoot} onClose={() => setBottomPanel(null)} />
              if (id === 'target') {
                return (
                  <TargetPanel
                    projectRoot={projectRoot}
                    fqbn={fqbn}
                    port={selectedPort}
              onApply={(t: BoardTargetInfo, o) => {
                if (o.port) setSelectedPort(o.port)
                if (o.buildPath === 'arduino-cli' && t.fqbn) {
                  setFqbn(t.fqbn)
                  setBoardName(t.name)
                }
                if (o.buildPath === 'platformio') setBottomPanel('platformio')
                setDebugChip(t.debug.chip)
                // 状态栏只读展示当前目标：谁被应用了，就显示谁
                setTargetLabel(`${t.chip} · ${o.buildPath === 'platformio' ? 'PlatformIO' : 'arduino-cli'}`)
              }}
                    onOpenDebug={(t: BoardTargetInfo) => {
                      setDebugChip(t.debug.chip)
                      setBottomPanel('debug')
                    }}
                    onClose={() => setBottomPanel(null)}
                  />
                )
              }
              if (id === 'agents') return <AgentBoard projectRoot={projectRoot} onClose={() => setBottomPanel(null)} />
              return <GitPanel projectRoot={projectRoot} onOpenFile={(p) => void openFile(p, p.split(/[\\/]/).pop() || 'file')} onClose={() => setBottomPanel(null)} />
            }}
          />
        </div>
        {aiPanelVisible && (
          <AiPanel tabs={tabs} activePath={activePath} projectRoot={projectRoot} onApplyCode={applyCodeToFile} onRunTerminal={(cmd) => void runCommand(cmd)} onOpenSettings={() => { setSettingsTab('models'); setShowSettings(true); }} prefill={aiPrefill} />
        )}
      </div>
      <StatusBar
        toolchain={toolchain}
        projectRoot={projectRoot}
        port={selectedPort}
        baud={baud}
        board={boardName}
        serialOpen={serialOpen}
        busy={busy}
        debugStatus={debugStatus}
        gitChanges={gitBadge}
        aiHealth={aiHealth}
        targetLabel={targetLabel}
      />
      {showNewProject && (
        <NewProjectDialog
          pluginTypes={pluginTypes}
          onClose={() => setShowNewProject(false)}
          onCreate={createProject}
        />
      )}
      {showSettings && (
        <SettingsModal
          theme={theme}
          onToggleTheme={toggleTheme}
          onClose={() => setShowSettings(false)}
          shell={shell}
          onShellChange={(s) => {
            setShell(s)
            localStorage.setItem('codelab-shell', s)
          }}
          language={language}
          onLanguageChange={(l) => {
            setLanguage(l)
            localStorage.setItem('codelab-lang', l)
          }}
          defaultTab={settingsTab}
        projectRoot={projectRoot}
        />
      )}
      {wiringSvg && (
        <div className="wiring-overlay" onClick={() => setWiringSvg(null)}>
          <div className="wiring-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wiring-modal-head">
              <span>📐 引脚接线图</span>
              <button className="wiring-close" onClick={() => setWiringSvg(null)} aria-label="关闭">✕</button>
            </div>
            <div className="wiring-modal-body" dangerouslySetInnerHTML={{ __html: wiringSvg }} />
          </div>
        </div>
      )}
    </div>
  )
}

export default App
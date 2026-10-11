import { useCallback, useEffect, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import ActivityBar from './components/ActivityBar'
import ProjectTree, { type TreeNode } from './components/ProjectTree'
import EditorArea, { type EditorTab } from './components/EditorArea'
import { decideOpen, classifyFile } from './components/editor/editorLogic'
import { loadEditorSettings, saveEditorSettings, type EditorSettings } from './components/editor/editorSettings'
import { type Groups, createGroup, openTab, closeTab, findTabLocation, flattenTabs, addGroup, moveTab } from './components/editor/editorGroups'
import OutputPanel from './components/OutputPanel'
import AiPanel from './components/AiPanel'
import NewProjectDialog, { type ProjectTypeItem } from './components/NewProjectDialog'
import OpenProjectDialog from './components/OpenProjectDialog'
import DebugPanel from './components/DebugPanel'
import PlatformIOPanel from './components/PlatformIOPanel'
import TargetPanel from './components/TargetPanel'
import GitPanel from './components/GitPanel'
import PanelDock, { type PanelId } from './components/PanelDock'
import SerialPlotter from './components/SerialPlotter'
import InstrumentsPanel from './components/InstrumentsPanel'
import AgentBoard from './components/AgentBoard'
import ErrorBoundary from './components/ErrorBoundary'
import type { BoardTargetInfo, BuildStageInfo, ChannelHealth, FlashStage, PrecheckSnapshot } from '../../preload'
import DevicePanel from './components/DevicePanel'
import ToolchainSidebar from './components/ToolchainSidebar'
import CommandPalette from './components/CommandPalette'
import WelcomeView from './components/WelcomeView'
import StatusBar from './components/StatusBar'
import SettingsModal from './components/SettingsModal'
import FeatureHintLayer from './components/FeatureHintLayer'
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

/**
 * 内容指纹（FNV-1a 32bit，纯函数无依赖）：层2 深度预检的缓存键。
 * 为什么不用 content.length：等长改写（改一个字符、换一行）会让缓存误命中，
 * 把上一次的「通过」当成这一次的结论——这正是保存即预检最忌讳的「误导性通过」
 * （假成功比报错更骗人）。改内容 → 指纹变 → 缓存失效重跑。
 */
function contentFingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0).toString(16)
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

/**
 * 输出面板 / 串口监视器两条流式日志的护栏（配套 App 内的 outLogRef / serLogRef）。
 * LOG_LIMIT：日志只增不截，编译一次几 MB、串口挂十分钟就是几百 MB —— 必须有上限。
 * LOG_FLUSH_MS：流式数据攒够一批再合并 setState，别让每个 chunk 都触发一次全树重算。
 */
const LOG_LIMIT = 200_000 // ≈20 万字符，够翻近期历史又不吃掉内存
const LOG_FLUSH_MS = 120
/** 追加一段并把总长度压回上限（超了丢最旧的，尾部留一段提示） */
const appendCapped = (cur: string, add: string): string => {
  const next = cur + add
  return next.length > LOG_LIMIT
    ? `…\n[日志过长，已只保留最近 ${Math.round(LOG_LIMIT / 1000)}k 字符]\n` + next.slice(-LOG_LIMIT)
    : next
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
  // 主题（默认浅色，与 TrieCode 一致：TrieCode 的浅色是默认态，深色通过 data-theme=dark 切换）
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
  // 分屏：groups 是标签页的唯一真相源（单一 group 时等价于旧 tabs）。activeGroupId 为当前聚焦组。
  const [groups, setGroups] = useState<Groups>(() => [createGroup('g1', DEFAULT_TABS)])
  const [activeGroupId, setActiveGroupId] = useState<string>('g1')
  const tabs = flattenTabs(groups) // 派生：供 resolveSketch / guardUnsaved / WelcomeView 等旧消费方
  const [activePath, setActivePath] = useState<string>(DEFAULT_TABS[0]?.id ?? '')
  const groupsRef = useRef(groups); groupsRef.current = groups
  const activeGroupIdRef = useRef(activeGroupId); activeGroupIdRef.current = activeGroupId
  // guardUnsaved 定义在下方（依赖 saveTab）。useCallback 依赖数组是立即求值的，
  // 上方的 closeGroup 直接引用它会报 TS2448/2454「used before declaration」——
  // 与 schedulePrecheckRef 同套路，用 ref 持有最新实现破除 TDZ。
  const guardUnsavedRef = useRef<(targets: EditorTab[]) => Promise<boolean>>(() => Promise.resolve(true))
  // 跨组按 id 打补丁（onChange / onSave / dirty 清除 / 外部刷新）。用 ref 供 [] deps 的 openFile 调用。
  const updateTabByIdRef = useRef<(id: string, patch: Partial<EditorTab>) => void>(() => {})
  updateTabByIdRef.current = (id, patch) => {
    setGroups((gs) => gs.map((g) => ({ ...g, tabs: g.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })))
  }

  // 往当前激活组追加新 tab（AI 生成 / 新建空白）
  const addTabToActiveRef = useRef<(tab: EditorTab) => void>(() => {})
  addTabToActiveRef.current = (tab) => {
    setGroups((gs) => gs.map((g) => (g.id === activeGroupIdRef.current ? { ...g, tabs: [...g.tabs, tab], activeId: tab.id } : g)))
  }

  // 标签聚焦（来自任意组的点击）：聚焦其所在组 + 全局 activePath
  const handleSelectTab = useCallback((groupId: string, tabId: string) => {
    setActiveGroupId(groupId)
    setActivePath(tabId)
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, activeId: tabId } : g)))
  }, [])

  // 分屏：在激活组右侧新增一个空组（用户再开另一个文件即并排对照）
  const splitEditor = useCallback(() => {
    const id = `group-${Date.now()}`
    const r = addGroup(groupsRef.current, id)
    setGroups(r.groups)
    setActiveGroupId(id)
  }, [])

  // 关闭整个组（先过未保存闸门）：逐 tab 走 closeTab，自然回收空组
  const closeGroup = useCallback(async (groupId: string) => {
    const g = groupsRef.current.find((x) => x.id === groupId)
    if (!g) return
    const dirty = g.tabs.filter((t) => t.dirty)
    if (dirty.length > 0 && !(await guardUnsavedRef.current(dirty))) return
    let next = groupsRef.current
    for (const t of g.tabs) {
      const r = closeTab(next, groupId, t.id)
      next = r.groups
    }
    setGroups(next)
    setActiveGroupId(next[0]?.id ?? groupId)
    if (activePath && !flattenTabs(next).some((t) => t.id === activePath)) {
      setActivePath(flattenTabs(next)[0]?.id ?? '')
    }
  }, [activePath])

  // 跨组移动 tab（#26 拖拽落点）：调用纯函数 moveTab，移动即激活目标组 + 全局焦点同步
  const moveTabToGroup = useCallback((tabId: string, toGroupId: string) => {
    setGroups((gs) => moveTab(gs, tabId, toGroupId))
    setActiveGroupId(toGroupId)
    setActivePath(tabId)
  }, [])

  // 工具链 / 串口
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null)
  // 当前打开项目对应的 active 工具链声明的 capability 键（标题栏编译/烧录/板卡按钮显隐，P0-2）
  const [toolchainCapabilities, setToolchainCapabilities] = useState<string[]>([])
  const [fqbn, setFqbn] = useState('esp32:esp32:esp32c3')
  // 板卡架构（由 fqbn 推导）：决定编辑器内置硬件片段与悬停文档的取向。
  // 纯字符串推导、开销可忽略，不必 useMemo。
  const boardArch: 'esp32' | 'stm32' | 'any' = (() => {
    const f = fqbn.toLowerCase()
    if (f.includes('esp32')) return 'esp32'
    if (f.includes('stm32')) return 'stm32'
    return 'any'
  })()
  const [boardName, setBoardName] = useState('')
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [baud, setBaud] = useState(115200)
  const [serialOpen, setSerialOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [compileState, setCompileState] = useState<'idle' | 'compiling' | 'uploading' | 'success' | 'error'>('idle')
  const [compileProgress, setCompileProgress] = useState<{ percent: number; message: string } | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  // 真机测试留痕：板卡 / 端口是编译烧录的唯一依据，改一次记一次
  useEffect(() => {
    window.api?.diag?.log('target:change', { fqbn, port: selectedPort, boardName })
  }, [fqbn, selectedPort, boardName])

  /** 当前 fqbn 的 ref 镜像：任务事件订阅是挂载时注册的（deps=[]），闭包里读不到最新 state */
  const fqbnRef = useRef(fqbn)
  useEffect(() => { fqbnRef.current = fqbn }, [fqbn])

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

  /** 编译/烧录的兜底超时定时器（编译 180s / 烧录 120s），取消时必须一起清掉 */
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelBuild = useCallback((): void => {
    if (!activeTaskId) return
    void window.api.cmd.kill(activeTaskId)
    // 兜底超时定时器不跟着取消，它到点还是会往日志里追加「超过 180s 无响应」：
    // 用户明明点的是「取消」，180 秒后凭空冒出一条假错误，看着像 IDE 自己抽风。
    if (guardTimerRef.current) {
      clearTimeout(guardTimerRef.current)
      guardTimerRef.current = null
    }
    pushOut((prev) => prev + '\n[取消] 已请求中断当前任务。\n')
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
  // 打开项目走应用内目录选择器（原生对话框 Shell 视图在本机不渲染）
  const [showOpenProject, setShowOpenProject] = useState(false)
  // P2-20：命令面板 open-view 请求切到某个插件视图（tab id）
  const [sidebarRequest, setSidebarRequest] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('general')
  const [language, setLanguage] = useState<'zh' | 'en'>(() => (localStorage.getItem('codelab-lang') as 'zh' | 'en') || 'zh')
  // 动效偏好：system = 尊重系统的「减少动效」设置；on / off = 用户强制覆盖。
  // 落到 <html data-motion>，由 main.css 统一收口，业务 CSS 不用各处判断。
  const [motion, setMotion] = useState<'system' | 'on' | 'off'>(() => {
    const v = localStorage.getItem('codelab-motion')
    return v === 'on' || v === 'off' ? v : 'system'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-motion', motion)
    localStorage.setItem('codelab-motion', motion)
  }, [motion])
  const [shell, setShell] = useState<ShellType>(() => (localStorage.getItem('codelab-shell') as ShellType) || 'powershell')
  // 编辑器偏好（字号/缩进/换行/minimap/字体）：单一 state，实时下发给 EditorArea + 设置面板
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(() => loadEditorSettings())
  const updateEditorSettings = useCallback((s: EditorSettings) => {
    setEditorSettings(s)
    saveEditorSettings(s)
  }, [])
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  /**
   * 极简 / 专业界面（对齐 TrieCode：默认专业模式，密度与 TrieCode v1.2.9 一致）。
   * 想要消费级极简可以在视图菜单切「切换到极简界面」。
   */
  const [simple, setSimple] = useState<boolean>(() => localStorage.getItem('codelab-simple') === '1')
  const toggleSimple = useCallback(() => {
    setSimple((v) => {
      const next = !v
      localStorage.setItem('codelab-simple', next ? '1' : '0')
      return next
    })
  }, [])
  const [pluginTypes, setPluginTypes] = useState<ProjectTypeItem[]>([])
  const [activeSidebar, setActiveSidebar] = useState('files')
  // 面板可见性只有 bottomPanel 一个真相源（TitleBar 的按钮高亮由它派生传入）。
  // 这里曾经并排维护 terminalVisible / debugVisible / pioVisible / targetVisible 四个平行 state，
  // 但它们的 setter 只在少数几条路径上被调用 —— 凡是从 ensureOutputVisible() 之类
  // 直接改 bottomPanel 进来的，标题栏按钮高亮就跟实际面板状态对不上。
  // 删掉平行 state，改成派生，这类不同步从此不可能再发生。
  /** 底部统一面板组：一次只显示一个（UI 重设计核心，见 PanelDock 注释） */
  // 专业模式（默认）：底部面板默认展开输出；极简模式才收起
  const [bottomPanel, setBottomPanel] = useState<PanelId | null>(simple ? null : 'output')
  /**
   * 输出 / 串口日志护栏。
   * 这两条是「只增不减」的流式日志：编译 gRPC 每几十毫秒吐一个 chunk，串口 115200 baud 更密。
   * 原来每个 chunk 都 setState —— App 顶层 state 一动，整棵子树（Monaco / xterm）都要重算，
   * OutputPanel 全量重渲染、SerialPlotter canvas 全量重画，长会话直接掉帧，跑久了还会 OOM。
   * 三道护栏：
   *   ① ref 是唯一事实源，state 只是展示副本，并且永远有长度上限（超了丢头部）；
   *   ② 输出面板没挂载时完全不碰 state —— 省下整树重算这一项最大开销；
   *   ③ 流式 chunk 走 120ms 节流合并，把每秒上百次 setState 压到个位数。
   */
  const outLogRef = useRef('')
  const serLogRef = useRef('')
  const bottomPanelRef = useRef(bottomPanel)
  bottomPanelRef.current = bottomPanel
  const logFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushOut = (updater: (prev: string) => string): void => {
    outLogRef.current = appendCapped(outLogRef.current, updater(''))
    setOutputLog((prev) => (prev === outLogRef.current ? prev : outLogRef.current))
  }
  const pushSer = (updater: (prev: string) => string): void => {
    serLogRef.current = appendCapped(serLogRef.current, updater(''))
    setSerialLog((prev) => (prev === serLogRef.current ? prev : serLogRef.current))
  }
  /** 流式堆进来的数据先攒着，面板可见时再合并（节流用） */
  const scheduleLogFlush = (): void => {
    if (logFlushRef.current) return
    logFlushRef.current = setTimeout(() => {
      logFlushRef.current = null
      if (bottomPanelRef.current !== 'output') return
      setOutputLog((prev) => (prev === outLogRef.current ? prev : outLogRef.current))
      setSerialLog((prev) => (prev === serLogRef.current ? prev : serLogRef.current))
    }, LOG_FLUSH_MS)
  }
  /** 手动清掉待合并的节流（组件卸载 / 面板切换时别留下悬挂定时器） */
  const cancelLogFlush = (): void => {
    if (logFlushRef.current) clearTimeout(logFlushRef.current)
    logFlushRef.current = null
  }
  const [panelHeight, setPanelHeight] = useState(280)
  /** Git 面板角标：变更文件数 */
  const [gitBadge, setGitBadge] = useState(0)
  /** 状态栏用：调试会话状态 + 当前目标摘要（只读，改动去硬件目标面板） */
  const [debugStatus, setDebugStatus] = useState<'idle' | 'starting' | 'running' | 'error'>('idle')
  const [aiHealth, setAiHealth] = useState<ChannelHealth | null>(null)
  const [targetLabel, setTargetLabel] = useState('')
  /**
   * 保存即预检（层1 即时静态校验）的 UI 状态。
   * 故意与 compileState 完全解耦：预检发现引脚冲突 / 板卡无效，绝不污染编译结果卡，
   * 否则「预检报了冲突、但编译其实是上一次的 success」会自相矛盾。
   */
  const [precheck, setPrecheck] = useState<PrecheckSnapshot>({ status: 'idle', boardValid: true, issues: [], summary: '', text: '' })
  /** 预检防抖的引用持有（onChange 早于 schedulePrecheck 定义，用 ref 破除 TDZ） */
  const schedulePrecheckRef = useRef<() => void>(() => {})

  // 层2 深度编译预检（实验性，默认关闭）：真实编译校验（依赖缺失/语法错/库找不到）。
  // 与层1 预检（纯静态）、手动编译（compileState）完全解耦：独立 IPC、独立状态、独立圆点。
  /** 层2 调度引用持有（save/onChange 早于 scheduleDeepCheck 定义，用 ref 破除 TDZ） */
  const scheduleDeepCheckRef = useRef<() => void>(() => {})
  const [deepPrecheckOn, setDeepPrecheckOn] = useState<boolean>(() => localStorage.getItem('codelab-deep-precheck') === '1')
  const [deepCheck, setDeepCheck] = useState<{ status: 'idle' | 'pending' | 'ok' | 'error'; summary: string; text: string }>({ status: 'idle', summary: '', text: '' })
  const deepRunningRef = useRef<boolean>(false)
  const deepSeqRef = useRef<number>(0)
  const deepCacheRef = useRef<{ key: string; status: 'ok' | 'error'; summary: string; text: string } | null>(null)
  const deepCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toggleDeepPrecheck = useCallback((): void => {
    setDeepPrecheckOn((v) => {
      const next = !v
      localStorage.setItem('codelab-deep-precheck', next ? '1' : '0')
      if (!next) {
        // 关掉就清掉状态圆点 + 缓存，并撤掉挂起的防抖任务：
        // 否则 2.5s 内关掉时，挂起定时器仍会触发旧闭包跑完编译、把圆点写回来（等于「关了还亮」）。
        if (deepCheckTimerRef.current) {
          clearTimeout(deepCheckTimerRef.current)
          deepCheckTimerRef.current = null
        }
        // 作废在飞结果：若真实编译已跑起来，此刻关掉也要让它的返回值落地时被判陈旧而丢弃，
        // 否则 30s 后圆点会自己亮回来。
        deepSeqRef.current += 1
        setDeepCheck({ status: 'idle', summary: '', text: '' })
        deepCacheRef.current = null
      } else {
        scheduleDeepCheckRef.current?.()
      }
      return next
    })
  }, [])

  // 悬停功能介绍：默认开（教学场景下没人会拒绝「这是什么」），熟了可以在设置里关掉。
  // 存 localStorage 而不是走设置持久化，是为了和 shell / 主题等开关保持同一种写法。
  const [featureHintsOn, setFeatureHintsOn] = useState<boolean>(() => localStorage.getItem('codelab-feature-hints') !== '0')
  const toggleFeatureHints = useCallback((): void => {
    setFeatureHintsOn((v) => {
      const next = !v
      localStorage.setItem('codelab-feature-hints', next ? '1' : '0')
      return next
    })
  }, [])

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
    setBottomPanel((cur) => (cur === id ? null : id))
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

  // 标题栏能力按钮：按当前打开项目的 active 工具链解析 capabilities，驱动编译/烧录/板卡按钮显隐（P0-2）
  useEffect(() => {
    if (!projectRoot) {
      setToolchainCapabilities([])
      return
    }
    let alive = true
    window.api.plugin
      .projectCapabilities(projectRoot)
      .then((caps) => { if (alive) setToolchainCapabilities(Array.isArray(caps) ? caps : []) })
      .catch(() => { if (alive) setToolchainCapabilities([]) })
    return () => { alive = false }
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
  /** 宿主真实版本（主进程 app.getVersion()）。设置页的「关于」不能写死版本号 */
  const [appVersion, setAppVersion] = useState('')

  const ex = useCallback((fileName: string) => {
    const base = examplesDir || `D:\\工作\\代码实验室\\codelab-desktop\\examples`
    return `${base}\\${fileName}`
  }, [examplesDir])

  const terminalRef = useRef<TerminalHandle>(null)
  const pendingTasksRef = useRef<Map<string, (code: number) => void>>(new Map())
  /** 最近一次成功编译的产物目录（task:exit 带回）。烧录必须带上同一 --build-path，见真机 bug #3。 */
  const lastCompileBuildPathRef = useRef('')
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
    pushOut((prev) => prev + '\n💡 请在左侧「设备」面板选择开发板和串口，然后点顶栏的「烧录」按钮一键烧录。\n')
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
        setWiringSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="40" style="fill:var(--error)" font-size="13">生成失败：${res?.error || '未知错误'}</text></svg>`)
      }
    } catch (e) {
      setWiringSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="40" style="fill:var(--error)" font-size="13">生成异常：${(e as Error).message}</text></svg>`)
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
        // 编译/烧录的流式输出：攒批再合并，不要每个 chunk 都 setState
        outLogRef.current = appendCapped(outLogRef.current, d.chunk)
        scheduleLogFlush()
      }
    })
    const offExit = window.api.onTaskExit((d) => {
      const line = d.id.startsWith('cmd-')
        ? `\x1b[90m[进程结束 code=${d.code}]\x1b[0m\r\n`
        : `\n[任务结束，退出码 ${d.code}]\n`
      if (d.id.startsWith('cmd-')) terminalRef.current?.append(line)
      else pushOut((prev) => prev + line)
      setBusy(false)
      // 编译 / 烧录任务：更新状态并捕获错误（供「一键 AI 诊断」）
      const isCompile = d.id.startsWith('cap-compile-') || d.id.startsWith('grpc-compile-')
      const isUpload = d.id.startsWith('cap-upload-') || d.id.startsWith('grpc-upload-')
      if (isCompile || isUpload) {
        setCompileState(d.code === 0 ? 'success' : 'error')
        setCompileProgress(null)
        // 编译成功后预热源码级调试符号索引（行断点/当前行高亮依赖它）。
        // 静默失败：编译已成功，符号只影响调试功能，不能因此干扰编译态。
        if (isCompile && d.code === 0) {
          // 记下最新编译产物目录：烧录必须带同一 --build-path（CLI 降级编译产物在自建目录
          // Temp\codelab-build\sketch-*，不带它 arduino-cli upload 去默认缓存找 → "Compiled sketch not found"）
          lastCompileBuildPathRef.current = (d as any).buildPath || ''
          if (lastCompileBuildPathRef.current) {
            void (window.api as any).debug?.symbols?.(lastCompileBuildPathRef.current)
          }
        }
        // 过程可见化：停表并冻结最终耗时（结果卡要显示真实耗时）
        const startedAt = buildStartedAtRef.current
        if (startedAt !== null) {
          const spent = Date.now() - startedAt
          setBuildElapsedMs(spent)
          buildStartedAtRef.current = null
          setBuildStartedAt(null)
          // 收尾结论直接写进输出流：用户不用去猜「刚才那几秒到底成没成」
          if (d.code === 0) {
            pushOut((prev) =>
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
    // 串口数据是最密的一条流（115200  baud 每秒上百 chunk），必须走节流合并
    const offSerial = window.api.onSerialData((d) => {
      serLogRef.current = appendCapped(serLogRef.current, d.data)
      scheduleLogFlush()
    })
    const offClose = window.api.onSerialClose((d) => {
      pushSer((prev) => prev + `\n${d.msg}\n`)
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
        pushOut(
          (prev) =>
            prev +
            `\n🔌 检测到开发板：${d.port}${d.fqbn ? ` · ${d.name || d.fqbn}` : '（未识别到板卡型号，仅选中端口）'}，已自动选中。\n`
        )
        // 认不出板卡时必须把「正在沿用哪块板」说出来：
        // ESP32-C3/S3/P4 原生 USB 共用 303a:1001，自动识别常失败；
        // 静默沿用旧板卡会让用户白等一次全量编译，最后才被 esptool 打回（真机已踩）。
        if (!d.fqbn) {
          pushOut(
            (prev) =>
              prev +
              `⚠ 没能认出这块板的具体型号（ESP32 的 C3/S3/P4 用的是同一个 USB ID，机器分不出来）。\n` +
              `   目标板卡仍是上次选的 ${boardName || fqbn}——如果和实物不符，请到「硬件目标」面板改对再烧录。\n`
          )
        }
      } else if (d.action === 'removed') {
        setSelectedPort((prev) => (d.removed?.includes(prev) ? '' : prev))
        pushOut((prev) => prev + `\n🔌 串口已拔出：${(d.removed || []).join('、')}\n`)
      }
    })
    // 烧录「芯片不匹配」：esptool 实测到的芯片和目标板卡不是一回事
    // （真机原文：This chip is ESP32-C3, not ESP32-S3 —— 编译全过了，最后一步被打回）。
    // esptool 是真读过 chip id 的，信它比信 VID:PID 启发式可靠（C3/S3/P4 共用 303a:1001），
    // 所以这里直接把板卡改成实测芯片并持久化，用户再点一次烧录即可。
    const offChip = window.api.device.onChipMismatch?.((d) => {
      window.api?.diag?.log('upload:chip-mismatch:ui', d)
      const target = d.suggestFqbn
      if (target && target !== fqbnRef.current) {
        setFqbn(target)
        if (d.suggestName) setBoardName(d.suggestName)
        // 写回设备上下文：否则下次启动又会恢复成错的那个（上次就是这么踩的）
        window.api.device.set({ board: target }).catch(() => undefined)
        pushOut((prev) => prev + `\n⚠ 板卡选错了：你选的是 ${d.expected.toUpperCase()}，esptool 实测这块芯片是 ${d.actual.toUpperCase()}。\n   已自动把目标板卡改为 ${d.suggestName || target}，请再点一次「烧录」（会按新板卡重新编译一次）。\n`)
      } else {
        pushOut((prev) => prev + `\n⚠ 芯片不匹配：目标板卡是 ${d.expected.toUpperCase()}，实测芯片是 ${d.actual.toUpperCase()}。请在「硬件目标」面板选对板卡后再烧录。\n`)
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
      offChip?.()
      // 订阅卸载时把待合并的节流定时器清掉，别留下悬挂定时器
      cancelLogFlush()
    }
  }, [])

  // 订阅主进程更新状态（检查中 / 可用 / 下载进度 / 已是最新 / 错误）
  useEffect(() => {
    const off = window.api.updater.onStatus(setUpdater)
    // 设置页底部要显示真实版本号，别让 UI 自己写一个数字
    window.api.app.version().then(setAppVersion).catch(() => setAppVersion(''))
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

  // 打开项目：拉起应用内目录选择器（原生 showOpenDialog 的 Shell 视图在本机不渲染）
  const openProject = useCallback(() => setShowOpenProject(true), [])

    // 选择器选定目录后真正打开工程
    const openProjectPath = useCallback(async (p: string) => {
      const res = await window.api.project.openPath(p)
      if (!res) { setShowOpenProject(false); return }
      setShowOpenProject(false)
      if ('error' in res) {
        pushOut((prev) => prev + `\n[打开项目失败] ${res.error}\n`)
        return
      }
      window.api?.diag?.log('project:open', { root: res.root, treeNodes: res.tree ? 1 : 0 })
      setProjectRoot(res.root)
      setTree(res.tree)
      setCwdHint(res.root)
    }, [pushOut])

  const setCwdHint = useCallback((_root: string) => {
    /* cwd 由 projectRoot 派生，无需额外状态 */
  }, [])

  // 打开文件（含大文件/二进制保护 + 外部改动刷新，判定逻辑见 editorLogic）
  const openFile = useCallback(async (path: string, name: string) => {
    setActivePath(path)

    let meta: { size: number; mtimeMs: number }
    try {
      meta = await window.api.fs.stat(path)
    } catch (e) {
      pushOut((p) => p + `\n[错误] 无法访问 ${path}：${(e as Error).message}\n`)
      return
    }

    let content = ''
    const cls = classifyFile(name, meta)
    if (!cls.readOnly) {
      try {
        content = await window.api.fs.read(path)
      } catch (e) {
        pushOut((p) => p + `\n[错误] 无法打开 ${path}：${(e as Error).message}\n`)
        return
      }
    }

    const ex = tabsRef.current.find((t) => t.id === path)
    const d = decideOpen(ex, name, meta, content)
    const loc = findTabLocation(groupsRef.current, path)

    if (loc) {
      // 已打开：原地更新字段并聚焦其所在组（不跨组挪动）
      const patch: Partial<EditorTab> = { mtimeMs: d.mtimeMs }
      if (d.kind === 'reload') { patch.content = d.content; patch.dirty = false }
      else if (d.kind === 'protect') { patch.readOnly = true; patch.notice = d.notice; patch.content = '' }
      else if (d.kind === 'keep-dirty') { pushOut((p) => p + '\n' + d.warn + '\n') }
      updateTabByIdRef.current(path, patch)
      setGroups((gs) => gs.map((g) => (g.id === loc.groupId ? { ...g, activeId: path } : g)))
      setActiveGroupId(loc.groupId)
    } else {
      // 新增到当前激活组
      let newTab: EditorTab
      if (d.kind === 'protect') {
        newTab = { id: path, name, language: langOf(name), content: '', readOnly: true, notice: d.notice, mtimeMs: d.mtimeMs }
      } else {
        newTab = { id: path, name, language: langOf(name), content, mtimeMs: d.mtimeMs }
      }
      const r = openTab(groupsRef.current, activeGroupIdRef.current, newTab)
      setGroups(r.groups)
      setActiveGroupId(r.activeGroupId)
      // 打开反馈：字节/行数直接来自磁盘读取结果。文件打开异常时，看这行就能
      // 一秒分清是「读到了 0 字节」还是「读到了但编辑器没渲染出来」。
      pushOut((p) => p + `\n✓ 已打开 ${name}（${meta.size} 字节 / ${content === '' ? 0 : content.split('\n').length} 行）${content === '' ? ' ⚠ 内容为空' : ''}`)
    }
    setActivePath(path)
  }, [])

  // 编辑器变更
  const onChange = useCallback((id: string, content: string) => {
    updateTabByIdRef.current(id, { content, dirty: true })
    // 停输 1s 防抖预check：用户改完代码静默 1s 后自动扫引脚冲突，不用手动点
    schedulePrecheckRef.current()
    // 层2 深度编译预检同样在停输后调度（2.5s 防抖，且默认关闭，内部会再判一次 deepPrecheckOn）
    scheduleDeepCheckRef.current()
  }, [])

  /**
   * 落盘一个 tab 的内容。
   * 刻意**不读 `tabs` 闭包**：批量保存时闭包里的 tabs 是旧的，靠外面把最新的 tab 对象
   * 传进来，才不会把过期内容写回磁盘（陈旧闭包这个坑在本文件里已经踩过两次）。
   */
  const saveTab = useCallback(async (tab: EditorTab): Promise<boolean> => {
    try {
      await window.api.fs.write(tab.id, tab.content)
      updateTabByIdRef.current(tab.id, { dirty: false })
      pushOut((prev) => prev + `\n✓ 已保存 ${tab.name}\n`)
      // 保存即预检：落盘后立刻用最新内容扫引脚冲突（保存是「检什么」的明确锚点）
      void runPrecheckRef.current()
      // 层2 深度编译预检：保存也是锚点，调度一次（默认关闭时内部直接 return）
      scheduleDeepCheckRef.current()
      return true
    } catch (e) {
      pushOut((prev) => prev + `\n[错误] 保存失败：${(e as Error).message}\n`)
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
  // 供上方 closeGroup 使用（破除 TDZ：上方依赖数组求值太早，拿不到这里的 guardUnsaved）
  guardUnsavedRef.current = guardUnsaved

  /** 关窗前的最新 tabs（用 ref 存，避免每次击键都重新注册监听器） */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  /**
   * 保存即预检（层1 即时静态校验）。
   * 触发来源有三：① 打开/切换项目（projectRoot 变化）② 选/换开发板（fqbn 变化）③ 停输 1s 防抖 / Ctrl+S。
   * 纯前端触发、主进程纯分析零 spawn；与 compileState 解耦，结果不污染编译卡。
   * 护栏：未打开项目 / 未选板卡 / 编译烧录进行中都不跑（避免抢资源、也避免对着临时工程误报）。
   */
  const runPrecheck = useCallback(async (): Promise<void> => {
    const root = projectRoot
    const fb = fqbn
    if (!root || !fb || busy) return
    // 只把「项目内、且当前打开」的源码文件作为覆盖层（未必落盘），其余走磁盘扫描
    const overlay: Record<string, string> = {}
    for (const t of tabsRef.current) {
      if (!isAbsPath(t.id)) continue
      if (!t.id.startsWith(root)) continue
      if (!/\.(ino|cpp|cc|c|h|hpp)$/i.test(t.id)) continue
      overlay[t.id] = t.content
    }
    setPrecheck((p) => ({ ...p, status: 'pending' }))
    try {
      const r = await window.api.sketch.precheck({ projectRoot: root, fqbn: fb, overlay })
      const errs = r.issues.filter((i) => i.level === 'error').length
      const warns = r.issues.filter((i) => i.level === 'warning').length
      setPrecheck({
        status: !r.boardValid ? 'conflict' : errs > 0 ? 'conflict' : warns > 0 ? 'conflict' : 'ok',
        boardValid: r.boardValid,
        issues: r.issues,
        summary: r.summary,
        text: r.text
      })
    } catch {
      // 预检失败不应打断用户：复位成 idle 静默重试，下次触发再来
      setPrecheck((p) => ({ ...p, status: 'idle' }))
    }
  }, [projectRoot, fqbn, busy])

  /** runPrecheck 用 ref 持有最新实现，让 saveTab 等在依赖不变时也能调到最新版 */
  const runPrecheckRef = useRef<() => Promise<void>>(() => Promise.resolve())
  runPrecheckRef.current = runPrecheck

  // 停输 1s 防抖：每次击键清掉上一个定时器，静默 1s 后才跑预检（避免每个字符都扫一遍）
  const precheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePrecheck = useCallback((): void => {
    if (precheckTimerRef.current) clearTimeout(precheckTimerRef.current)
    precheckTimerRef.current = setTimeout(() => {
      precheckTimerRef.current = null
      void runPrecheckRef.current()
    }, 1000)
  }, [])
  schedulePrecheckRef.current = schedulePrecheck

  // 层2 深度编译预检：复用 arduino-cli 真实编译，捕获依赖缺失/语法错/库找不到。
  // 与层1 预检（纯静态）、手动编译（compileState/busy）完全解耦：独立 IPC + 独立状态 + 独立圆点。
  const runDeepCheck = useCallback(async (): Promise<void> => {
    if (!deepPrecheckOn) return
    const root = projectRoot
    const fb = fqbn
    if (!root || !fb || busy || compileState === 'compiling' || compileState === 'uploading') return
    if (!toolchain?.available || !toolchain.path) return
    const resolved = resolveSketch(tabs, activePath, tree)
    if (!resolved) return
    // 落盘编辑器最新内容再编译（与手动编译同语义），但用 no-op 回调避免把标签页「未保存」点偷偷清掉
    const sketch = await prepareSketchForBuild(
      resolved,
      (s) => pushOut((p) => p + s),
      () => undefined
    )
    if (!sketch) return
    // 缓存：内容指纹+fqbn 没变就复用上次结论，不重复跑几十秒的真实编译。
    // 用内容指纹（不是 content.length）：等长改写也要让缓存失效，避免「误导性通过」。
    const key = `${fb}::${contentFingerprint(tabs.map((t) => `${t.id}\u0000${t.content}`).join('\u0001'))}`
    if (deepCacheRef.current && deepCacheRef.current.key === key) {
      setDeepCheck({ status: deepCacheRef.current.status, summary: deepCacheRef.current.summary, text: deepCacheRef.current.text })
      return
    }
    if (deepRunningRef.current) return // 串行，避免并发起多个 arduino-cli 编译
    const seq = ++deepSeqRef.current
    deepRunningRef.current = true
    setDeepCheck((d) => ({ ...d, status: 'pending' }))
    try {
      const r = await window.api.sketch.deepCompilePrecheck({ sketch, fqbn: fb })
      if (seq !== deepSeqRef.current) return // 已有更新的触发，丢弃陈旧结果
      const errText = r.ok ? '' : (extractBuildError(r.out) || r.out || '编译失败')
      const status: 'ok' | 'error' = r.ok ? 'ok' : 'error'
      const text = r.ok ? '真实编译校验通过：依赖、语法、库均正常。' : `── 深度编译预检报告 ──\n${errText}`
      const summary = r.ok ? '深度预检通过' : errText.split('\n')[0].slice(0, 80) || '编译失败'
      setDeepCheck({ status, summary, text })
      deepCacheRef.current = { key, status, summary, text }
    } catch {
      if (seq === deepSeqRef.current) setDeepCheck((d) => ({ ...d, status: 'idle' }))
    } finally {
      deepRunningRef.current = false
    }
  }, [deepPrecheckOn, projectRoot, fqbn, busy, compileState, toolchain, tabs, activePath, tree])

  // 层2 停输 2.5s 防抖：编译要几十秒，不能每次击键都跑（deepCheckTimerRef 已在状态块声明）
  const scheduleDeepCheck = useCallback((): void => {
    if (!deepPrecheckOn) return
    if (deepCheckTimerRef.current) clearTimeout(deepCheckTimerRef.current)
    deepCheckTimerRef.current = setTimeout(() => {
      deepCheckTimerRef.current = null
      void runDeepCheck()
    }, 2500)
  }, [deepPrecheckOn, runDeepCheck])
  scheduleDeepCheckRef.current = scheduleDeepCheck

  // 项目打开 / 切换、或换开发板后，立即重新预检（这两个动作改的是「检什么」，必须立刻反映）
  useEffect(() => {
    if (projectRoot && fqbn) void runPrecheck()
    // 层2 深度编译预检：换板/换项目让缓存失效并重检（默认关闭时内部直接 return，不浪费编译）
    if (projectRoot && fqbn && deepPrecheckOn) scheduleDeepCheck()
    // 只在这两个依赖上跑：保存/编辑走各自的显式触发，避免重复跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, fqbn])

  /**
   * 编译数据库（#30）：同样挂在这两个锚点上（开项目 / 换板）。
   * 没有 compile_commands.json，clangd 打开 .ino 就是满屏 Arduino.h not found，
   * 补全/跳转/悬停全废——这一步比任何补全优化都关键。
   * - force=true：换板后 variant 与 -D 宏都变了，复用旧文件会解析到上一个板子的头文件。
   * - 失败一律静默：clangd 没装 / core 没装只是少个补全，不该弹错误打扰用户。
   * - 1.2s 防抖：连续换板 / 快速切换项目时不反复生成（每次重建都会让 clangd 重新索引）。
   */
  const ensureDbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!projectRoot || !fqbn) return
    if (ensureDbTimerRef.current) clearTimeout(ensureDbTimerRef.current)
    ensureDbTimerRef.current = setTimeout(() => {
      ensureDbTimerRef.current = null
      void window.api.lsp.ensureDb({ projectRoot, fqbn, force: true }).catch(() => undefined)
    }, 1200)
    return () => {
      if (ensureDbTimerRef.current) clearTimeout(ensureDbTimerRef.current)
    }
  }, [projectRoot, fqbn])

  // 点击状态栏预检圆点：把完整报告打进输出面板并展开，方便用户逐条定位
  const onPrecheckClick = useCallback((): void => {
    if (!precheck.text) return
    ensureOutputVisible()
    pushOut((prev) => prev + `\n── 保存即预检报告 ──\n${precheck.text}\n`)
  }, [precheck, ensureOutputVisible])

  // 点击层2 深度预检圆点：把完整编译报告打进输出面板并展开
  const onDeepCheckClick = useCallback((): void => {
    if (!deepCheck.text) return
    ensureOutputVisible()
    pushOut((prev) => prev + `\n${deepCheck.text}\n`)
  }, [deepCheck, ensureOutputVisible])

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
      const loc = findTabLocation(groupsRef.current, id)
      if (!loc) return
      const r = closeTab(groupsRef.current, loc.groupId, id)
      setGroups(r.groups)
      setActiveGroupId(r.activeGroupId)
      // 若关掉的是全局聚焦 tab，焦点回退到该组剩余激活项（或全局首个）
      if (id === activePath) {
        const g = r.groups.find((x) => x.id === r.activeGroupId)
        setActivePath(g?.activeId ?? (flattenTabs(r.groups)[0]?.id ?? ''))
      }
    },
    [tabs, activePath, guardUnsaved]
  )

  // 编译 / 烧录（对齐 TrieCode：门控 + 保存检查 + 状态机 + 流式输出）
  // 内置示例 / 未保存的 .ino 会自动暂存到临时目录再编译烧录（Arduino IDE 同款做法），无需先建项目。
  const runCompile = useCallback(async () => {
    // 真机测试留痕：点编译时的现场（有没有工具链 / 哪个 sketch / 什么板卡）——
    // 「点了编译没反应」类问题，一眼就能看出是被哪个门控拦下的
    window.api?.diag?.log('ui:compile-click', {
      compileState, hasToolchain: !!toolchain?.available, fqbn,
      activePath, tabCount: tabs.length, hasTree: !!tree
    })
    // 门控最前：进行中再点击给明确反馈（而不是静默吞掉，避免"点了没反应像卡死"）
    if (compileState === 'compiling' || compileState === 'uploading') {
      pushOut((prev) => prev + '\n[提示] 已有编译/烧录任务在进行中，请等待完成或查看输出面板。\n')
      return
    }
    // P0-2 路由：ESP-IDF 工程走 idf.py build（此按钮此前只支持 arduino，硬编码 .ino + grpc.compile）。
    // 判据复用 P0-2 已解析出的 toolchainCapabilities：esp-idf 声明 board-select，arduino 是 board-search。
    if (projectRoot && toolchainCapabilities.includes('board-select')) {
      setCompileState('compiling')
      setBusy(true)
      ensureOutputVisible()
      buildStartedAtRef.current = Date.now()
      setBuildStartedAt(Date.now())
      setBuildElapsedMs(0)
      setBuildStage({ stage: 'prepare', label: '准备' })
      setCompileProgress(null)
      setEverBuilt(true)
      pushOut((prev) => prev + `\n▶ [编译] ESP-IDF idf.py build  (${projectRoot})\n`)
      const r = await window.api.espIdf.compile({ projectPath: projectRoot, port: selectedPort || undefined })
      const tid = r?.ok ? r.taskId : undefined
      if (tid) {
        setActiveTaskId(tid)
        pendingTasksRef.current.set(tid, () => undefined)
        // ESP-IDF 首次构建要装工具链 + 编译 bootloader，给足 15 分钟兜底
        guardTimerRef.current = setTimeout(() => {
          if (pendingTasksRef.current.has(tid)) {
            pendingTasksRef.current.delete(tid)
            const msg = 'ESP-IDF 编译超时（15 分钟无响应），已复位状态。请重试。'
            pushOut((prev) => prev + `\n[错误] ${msg}\n`)
            // 补 setBuildError：否则「一键 AI 诊断 / AI 自动修复」按钮不出现（P1-10 确定性闭环）
            setBuildError(msg)
            setCompileState('error')
            setBusy(false)
          }
        }, 900000)
      } else {
        const msg = `ESP-IDF 编译启动失败：${r?.error ?? '未知错误'}`
        pushOut((prev) => prev + `[错误] ${msg}\n`)
        setBuildError(msg)
        setCompileState('error')
        setBusy(false)
      }
      return
    }
    if (!toolchain?.available || !toolchain.path) {
      pushOut((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      return
    }
    // sketch 解析：优先识别你正在编辑的 .ino；其次项目树里的 .ino；再次任意已打开的 .ino
    const resolved = resolveSketch(tabs, activePath, tree)
    if (!resolved) {
      const msg = tree
        ? '\n[错误] 当前项目内未找到 .ino 工程文件。请在左侧「文件」面板点开项目里的 .ino 文件，或确认工程根目录/同名目录含 <工程名>.ino。\n'
        : '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再编译。\n'
      pushOut((prev) => prev + msg)
      setCompileState('error')
      return
    }
    if (!fqbn) {
      pushOut((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      // 早退路径必须复位 compileState：不改的话上一次的 'success' 会留着，
      // 状态栏继续显示「编译完成」+ 上一版的 Flash/RAM 用量卡，
      // 而这一趟其实一次都没跑 —— 比直接报错更容易骗到人。
      setCompileState('error')
      setBuildError(null)
      setBuildStartedAt(null)
      setBuildElapsedMs(0)
      return
    }

    // 落盘最新编辑内容 / 暂存虚拟文件，得到最终交给 arduino-cli 的 sketch 路径
    const sketch = await prepareSketchForBuild(
      resolved,
      (s) => pushOut((p) => p + s),
      (id) => updateTabByIdRef.current(id, { dirty: false })
    )
    if (!sketch) {
      setCompileState('error')
      return
    }

    pushOut((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    // 首次编译要现下板卡支持包（ESP32 core 几百 MB），那段时间 arduino-cli 几乎不打印东西，
    // 不提前说明就会以为卡死。已经在本会话编译过就不啰嗦了。
    if (!everBuilt) {
      pushOut((prev) => prev + '  首次编译需下载板卡支持包（ESP32 core 约 300MB），可能要 1–3 分钟才有新输出，属正常。\n')
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
        guardTimerRef.current = setTimeout(() => {
          if (pendingTasksRef.current.has(result.id)) {
            pendingTasksRef.current.delete(result.id)
            pushOut((prev) => prev + '\n[错误] 编译超过 180s 无响应，已复位状态。请重试；若反复出现请检查工具链。\n')
            setCompileState('error')
            setBusy(false)
          }
        }, 180000)
      } else {
        pushOut((prev) => prev + '[错误] 编译启动失败（gRPC）\n')
        setCompileState('error')
        setBusy(false)
      }
    } catch (e) {
      pushOut((prev) => prev + `[错误] 编译异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
    }
  }, [toolchain, tree, activePath, fqbn, compileState, tabs, everBuilt, projectRoot, toolchainCapabilities, selectedPort, ensureOutputVisible])

  const runUpload = useCallback(async () => {
    // 真机测试留痕：烧录最怕「端口 / 板卡 / 产物目录」三缺一，这里把三者都记下来
    window.api?.diag?.log('ui:upload-click', {
      compileState, hasToolchain: !!toolchain?.available, fqbn,
      port: selectedPort, lastBuildPath: lastCompileBuildPathRef.current,
      activePath, hasTree: !!tree
    })
    // 门控最前：进行中再点击给明确反馈（避免静默吞掉像"卡死"）
    if (compileState === 'compiling' || compileState === 'uploading') {
      pushOut((prev) => prev + '\n[提示] 已有编译/烧录任务在进行中，请等待完成或查看输出面板。\n')
      return
    }
    // P0-2 路由：ESP-IDF 工程烧录走 idf.py flash（绕开 arduino 的 .ino + grpc.upload 硬编码）。
    if (projectRoot && toolchainCapabilities.includes('board-select')) {
      if (!selectedPort) {
        pushOut((prev) => prev + '\n[错误] 请先在工具栏选择串口端口。\n')
        setCompileState('error')
        return
      }
      setCompileState('uploading')
      setBusy(true)
      ensureOutputVisible()
      buildStartedAtRef.current = Date.now()
      setBuildStartedAt(Date.now())
      setBuildElapsedMs(0)
      pushOut((prev) => prev + `\n▶ [烧录] ESP-IDF idf.py -p ${selectedPort} flash  (${projectRoot})\n`)
      const r = await window.api.espIdf.flash({ projectPath: projectRoot, port: selectedPort })
      const tid = r?.ok ? r.taskId : undefined
      if (tid) {
        setActiveTaskId(tid)
        pendingTasksRef.current.set(tid, () => undefined)
        guardTimerRef.current = setTimeout(() => {
          if (pendingTasksRef.current.has(tid)) {
            pendingTasksRef.current.delete(tid)
            const msg = 'ESP-IDF 烧录超时（15 分钟无响应），已复位状态。请重试。'
            pushOut((prev) => prev + `\n[错误] ${msg}\n`)
            setBuildError(msg)
            setCompileState('error')
            setBusy(false)
          }
        }, 900000)
      } else {
        const msg = `ESP-IDF 烧录启动失败：${r?.error ?? '未知错误'}`
        pushOut((prev) => prev + `[错误] ${msg}\n`)
        setBuildError(msg)
        setCompileState('error')
        setBusy(false)
      }
      return
    }
    if (!toolchain?.available || !toolchain.path) {
      pushOut((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      // 同上：早退也要把上一次的 success 结果卡清掉，别让用户以为烧录成功了
      setCompileState('error')
      setBuildError(null)
      setBuildStartedAt(null)
      setBuildElapsedMs(0)
      return
    }
    if (!selectedPort) {
      pushOut((prev) => prev + '\n[错误] 请先在工具栏选择串口端口。\n')
      setCompileState('error')
      setBuildError(null)
      setBuildStartedAt(null)
      setBuildElapsedMs(0)
      return
    }
    // sketch 解析：优先识别你正在编辑的 .ino；其次项目树里的 .ino；再次任意已打开的 .ino
    const resolved = resolveSketch(tabs, activePath, tree)
    if (!resolved) {
      const msg = tree
        ? '\n[错误] 当前项目内未找到 .ino 工程文件。请在左侧「文件」面板点开项目里的 .ino 文件，或确认工程根目录/同名目录含 <工程名>.ino。\n'
        : '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再烧录。\n'
      pushOut((prev) => prev + msg)
      setCompileState('error')
      return
    }
    if (!fqbn) {
      pushOut((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      // 早退路径必须复位 compileState：不改的话上一次的 'success' 会留着，
      // 状态栏继续显示「编译完成」+ 上一版的 Flash/RAM 用量卡，
      // 而这一趟其实一次都没跑 —— 比直接报错更容易骗到人。
      setCompileState('error')
      setBuildError(null)
      setBuildStartedAt(null)
      setBuildElapsedMs(0)
      return
    }

    // 落盘最新编辑内容 / 暂存虚拟文件，得到最终交给 arduino-cli 的 sketch 路径
    const sketch = await prepareSketchForBuild(
      resolved,
      (s) => pushOut((p) => p + s),
      (id) => updateTabByIdRef.current(id, { dirty: false })
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
    pushOut((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    if (!everBuilt) {
      pushOut((prev) => prev + '  首次编译需下载板卡支持包（ESP32 core 约 300MB），可能要 1–3 分钟才有新输出，属正常。\n')
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
        pushOut((prev) => prev + '[错误] 编译启动失败（gRPC）\n')
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
        pushOut((prev) => prev + `[错误] 编译失败（退出码 ${compileCode}），已中止烧录。\n`)
        setCompileState('error')
        setBusy(false)
        await restoreSerial()
        return
      }
    } catch (e) {
      pushOut((prev) => prev + `[错误] 编译异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
      await restoreSerial()
      return
    }

    // 编译成功，开始上传（grpc:upload；daemon 不可用时主进程自动降级 CLI，不会挂死）
    pushOut((prev) => prev + `\n▶ [烧录] arduino-cli upload --fqbn ${fqbn} --port ${selectedPort} ${sketch}\n`)
    pushOut((prev) => prev + `   正在写入 ${selectedPort}，期间请勿拔线…\n`)
    setCompileState('uploading')
    // 计时器保持连续（不重置），结束时冻结的是「编译 + 烧录」总耗时
    setBuildStage({ stage: 'flashing', label: `写入 ${selectedPort}` })
    ensureOutputVisible()
    try {
      const uploadResult = await window.api.grpc.upload({ sketch, fqbn, port: selectedPort, buildPath: lastCompileBuildPathRef.current })
      if (uploadResult.id) {
        setActiveTaskId(uploadResult.id)
        pendingTasksRef.current.set(uploadResult.id, async (code: number) => {
          setBusy(false)
          await restoreSerial()
          // P1：烧录成功后，若烧录前串口没开着 → 自动打开并切到串口监视器页签。
          // 失败路径不动：restoreSerial 只在烧录前就开着时才恢复，不会凭空开新串口占口。
          if (code === 0 && !wasSerialOpen && selectedPort) {
            try {
              await window.api.serial.open({ port: selectedPort, baud })
              setSerialOpen(true)
              ensureOutputVisible()
              setBottomPanel('serial')
              pushOut((prev) => prev + '\n[提示] 烧录成功，已自动打开串口监视器。\n')
            } catch {
              /* 开串口失败不阻断烧录成功结论 */
            }
          }
        })
        // 120s 兜底：烧录事件丢失时复位状态，避免"永久烧录中"假死
        guardTimerRef.current = setTimeout(() => {
          if (pendingTasksRef.current.has(uploadResult.id)) {
            pendingTasksRef.current.delete(uploadResult.id)
            pushOut((prev) => prev + '\n[错误] 烧录超过 120s 无响应，已复位状态。请检查端口是否被占用/板子是否进入下载模式，再重试。\n')
            setCompileState('error')
            setBusy(false)
            void restoreSerial()
          }
        }, 120000)
      } else {
        pushOut((prev) => prev + '[错误] 烧录启动失败\n')
        setCompileState('error')
        setBusy(false)
        await restoreSerial()
      }
    } catch (e) {
      pushOut((prev) => prev + `[错误] 烧录异常：${(e as Error).message}\n`)
      setCompileState('error')
      setBusy(false)
      await restoreSerial()
    }
  }, [toolchain, tree, activePath, fqbn, selectedPort, compileState, tabs, serialOpen, baud, everBuilt, projectRoot, toolchainCapabilities, ensureOutputVisible])

  // 串口开关
  const toggleSerial = useCallback(async () => {
    if (serialOpen) {
      await window.api.serial.close(`serial-${selectedPort}`)
      setSerialOpen(false)
      return
    }
    if (!selectedPort) return
    await window.api.serial.open({ port: selectedPort, baud })
    pushSer((prev) => prev + `\n—— 打开 ${selectedPort} @ ${baud} ——\n`)
    setSerialOpen(true)
  }, [serialOpen, selectedPort, baud])

  // 终端命令
  const runCommand = useCallback(async (cmd: string) => {
    await window.api.cmd.run({ cmd, cwd, shell })
  }, [cwd, shell])

  // 命令面板执行
  const handleExecuteCommand = useCallback(async (cmd: { id: string; title: string; kind: string; plugin: string; view?: string; transport?: string }) => {
    pushOut((prev) => prev + `\n[命令面板] 执行: ${cmd.title} (${cmd.id})\n`)
    if (cmd.kind === 'action') {
      // 尝试通过 capability 路由执行（命令 id 去掉插件前缀）
      const capId = cmd.id.replace(`${cmd.plugin}.`, '')
      try {
        const result = await window.api.capability.run(capId, {})
        if (!result.ok) {
          pushOut((prev) => prev + `[命令面板] ${result.error || '执行失败'}\n`)
        }
      } catch {
        pushOut((prev) => prev + `[命令面板] 命令 ${capId} 暂无绑定执行器\n`)
      }
    } else if (cmd.kind === 'open-view') {
      // P2-20：open-view 命令接到插件 views 登记表上。
      // 此前这里只打印「视图系统待实现」，是 views 字段零实现的最后一处占位。
      const viewId = cmd.view || cmd.id
      // ToolchainSidebar 只在 activeSidebar === 'device' 时挂载，先切过去再请求切 tab
      setActiveSidebar('device')
      setSidebarRequest(`plugin:${cmd.plugin}:${viewId}`)
      pushOut((prev) => prev + `[命令面板] 打开视图：${viewId}（插件 ${cmd.plugin}）\n`)
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
    addTabToActiveRef.current({ id, name: `ai-generated.${info.ext}`, language: info.language, content })
    setActivePath(id)
    pushOut((prev) => prev + `\n✓ AI 代码已应用到新文件：ai-generated.${info.ext}\n`)
  }, [])

  // 新建工程
  const createProject = useCallback(async (type: string, name: string, scaffold?: Array<{ file: string; content: string }>) => {
    const res = await window.api.project.create({ type, name, parentPath: projectRoot ?? undefined, scaffold })
    if (!res.ok || !res.root) throw new Error(res.error ?? '创建失败')
    setProjectRoot(res.root)
    setTree(res.tree ?? null)
    pushOut((prev) => prev + `\n✓ 已创建工程：${res.root}\n`)
  }, [projectRoot])

  // 新建空白文件
  const newUntitledFile = useCallback(() => {
    const id = `untitled-${Date.now()}`
    addTabToActiveRef.current({ id, name: 'untitled', language: 'plaintext', content: '' })
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
            setGroups([createGroup('g1')])
            setActiveGroupId('g1')
            setActivePath('')
            setProjectRoot(null)
            setTree(null)
            // 烧录上下文和串口状态必须一起收干净：
            // burnCtxRef 留着，下次烧录收尾会把上个项目的日志尾巴记到新项目上；
            // serialOpen 留 true，「烧完自动恢复串口」会对着一个已关掉的路径去 open。
            burnCtxRef.current = { projectRoot: '', fqbn: '', port: '' }
            setSerialOpen(false)
            pushOut((prev) => prev + '\n📁 项目已关闭\n')
          })()
        }}
        onExit={() => window.api?.window?.close?.()}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => { setSettingsTab('general'); setShowSettings(true) }}
        onCompile={() => void runCompile()}
        onUpload={() => void runUpload()}
        capabilities={toolchainCapabilities}
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
                  requestedTab={sidebarRequest}
                  onRequestedTabHandled={() => setSidebarRequest(null)}
                  onOpenFile={(p, n) => void openFile(p, n || p.split(/[\\/]/).pop() || 'file')}
                  onBoardChange={(f, name) => {
                    setFqbn(f)
                    if (name) setBoardName(name)
                  }}
                  onPortChange={setSelectedPort}
                  serialSessionId={serialOpen && selectedPort ? `serial-${selectedPort}` : null}
                  onOpenSerialWindow={() => {
                    // 串口监视器统一走底部面板（不再弹浮窗，避免遮挡编辑器/仿真面板）。
                    // 面板可见性读的是 bottomPanel，所以这里必须真的展开面板，
                    // 只翻一个孤立 state 的话，折叠着或停在别的页签时点了毫无反应。
                    ensureOutputVisible()
                    setBottomPanel('serial')
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
              groups={groups}
              activeGroupId={activeGroupId}
              onSelectTab={handleSelectTab}
              onCloseTab={onClose}
              onSplit={splitEditor}
              onCloseGroup={closeGroup}
              onMoveTab={moveTabToGroup}
              onChange={onChange}
              onSave={(id) => void onSave(id)}
              theme={theme}
              settings={editorSettings}
              arch={boardArch}
            />
          ))}
          {/* 折叠条（showMinibar）不能只在极简模式给：专业模式下把面板收起后，
              PanelDock 会 return null，底部连一个"再展开"的入口都没有 ——
              用户只能靠菜单命令把它唤回来，等于功能被藏死了。 */}
          <PanelDock
            active={bottomPanel}
            onChange={setBottomPanel}
            height={panelHeight}
            onHeightChange={setPanelHeight}
            badges={{ output: buildError ? '!' : 0, problems: buildError ? '!' : 0, git: gitBadge }}
            showMinibar
            statusText={dockStatusText}
            render={(id) => {
              if (id === 'output' || id === 'problems' || id === 'serial' || id === 'terminal') {
                const dockTab = id === 'problems' ? '问题' : id === 'serial' ? '串口监视器' : id === 'terminal' ? '终端' : '输出'
                return (
                  <ErrorBoundary name="输出 / 串口监视器" key={`out-${id}`}>
                  <OutputPanel
                    key={`${outputKey}-${id}`}
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
                    onClearSerial={() => setSerialLog('')}
                    onRunCommand={(cmd) => void runCommand(cmd)}
                    terminalRef={terminalRef}
                    theme={theme}
                    shell={shell}
                    onClose={() => setBottomPanel(null)}
                    defaultTab={dockTab}
                    hideHeader
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
                  </ErrorBoundary>
                )
              }
              if (id === 'plotter') return <ErrorBoundary name="绘图仪" key="plotter"><SerialPlotter serialLog={serialLog} serialOpen={serialOpen} theme={theme} /></ErrorBoundary>
              if (id === 'instruments') return <ErrorBoundary name="仪器" key="instruments"><InstrumentsPanel theme={theme} /></ErrorBoundary>
              if (id === 'debug') return <ErrorBoundary name="调试" key="debug"><DebugPanel fqbn={fqbn} chipOverride={debugChip} onClose={() => setBottomPanel(null)} /></ErrorBoundary>
              if (id === 'platformio') return <ErrorBoundary name="PlatformIO" key="platformio"><PlatformIOPanel projectRoot={projectRoot} onClose={() => setBottomPanel(null)} /></ErrorBoundary>
              if (id === 'target') {
                return (
                  <ErrorBoundary name="硬件目标" key="target">
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
                  </ErrorBoundary>
                )
              }
              if (id === 'agents') return <ErrorBoundary name="多智能体" key="agents"><AgentBoard projectRoot={projectRoot} onClose={() => setBottomPanel(null)} /></ErrorBoundary>
              return <ErrorBoundary name="Git" key="git"><GitPanel projectRoot={projectRoot} onOpenFile={(p) => void openFile(p, p.split(/[\\/]/).pop() || 'file')} onClose={() => setBottomPanel(null)} /></ErrorBoundary>
            }}
          />
        </div>
        {aiPanelVisible && (
          <ErrorBoundary name="AI 助手" key="ai">
            <AiPanel tabs={tabs} activePath={activePath} projectRoot={projectRoot} onApplyCode={applyCodeToFile} onRunTerminal={(cmd) => void runCommand(cmd)} onOpenSettings={() => { setSettingsTab('models'); setShowSettings(true); }} prefill={aiPrefill} />
          </ErrorBoundary>
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
        precheck={precheck}
        onPrecheckClick={onPrecheckClick}
        deepCheck={deepCheck}
        onDeepCheckClick={onDeepCheckClick}
        language={language}
        onToggleLanguage={() => setLanguage((l) => {
          const next = l === 'zh' ? 'en' : 'zh'
          localStorage.setItem('codelab-lang', next)
          return next
        })}
      />
      {showNewProject && (
        <NewProjectDialog
          pluginTypes={pluginTypes}
          onClose={() => setShowNewProject(false)}
          onCreate={createProject}
        />
      )}
      {showOpenProject && (
        <OpenProjectDialog
          initialPath={projectRoot}
          onClose={() => setShowOpenProject(false)}
          onPick={(p) => void openProjectPath(p)}
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
          motion={motion}
          onMotionChange={setMotion}
          defaultTab={settingsTab}
          projectRoot={projectRoot}
          version={appVersion}
          editorSettings={editorSettings}
          onEditorSettingsChange={updateEditorSettings}
          deepPrecheckOn={deepPrecheckOn}
          onDeepPrecheckChange={toggleDeepPrecheck}
          featureHintsOn={featureHintsOn}
          onFeatureHintsChange={toggleFeatureHints}
        />
      )}
      {/* 功能介绍浮层：全局单例，靠元素上的 data-hint-* 属性触发，挂一次即可 */}
      <FeatureHintLayer enabled={featureHintsOn} />
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
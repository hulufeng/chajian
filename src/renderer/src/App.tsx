import { useCallback, useEffect, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import ActivityBar from './components/ActivityBar'
import ProjectTree, { type TreeNode } from './components/ProjectTree'
import EditorArea, { type EditorTab } from './components/EditorArea'
import OutputPanel from './components/OutputPanel'
import AiPanel from './components/AiPanel'
import NewProjectDialog, { type ProjectTypeItem } from './components/NewProjectDialog'
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

  // 日志
  const [outputLog, setOutputLog] = useState('')
  const [serialLog, setSerialLog] = useState('')
  // 底部面板重挂载 key（用于从设备面板"串口监视器"按钮切到串口 Tab）
  const [outputKey, setOutputKey] = useState(0)
  const [showNewProject, setShowNewProject] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('general')
  const [language, setLanguage] = useState<'zh' | 'en'>(() => (localStorage.getItem('codelab-lang') as 'zh' | 'en') || 'zh')
  const [shell, setShell] = useState<ShellType>(() => (localStorage.getItem('codelab-shell') as ShellType) || 'powershell')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [pluginTypes, setPluginTypes] = useState<ProjectTypeItem[]>([])
  const [activeSidebar, setActiveSidebar] = useState('files')
  const [terminalVisible, setTerminalVisible] = useState(true)
  const [leftPanelVisible, setLeftPanelVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [aiPanelVisible, setAiPanelVisible] = useState(true)
  const [aiPrefill, setAiPrefill] = useState<{ text: string; nonce: number; autoSend?: boolean } | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const buildLogRef = useRef<string>('')
  const [examplesDir, setExamplesDir] = useState<string>('')

  // 更新（强制更新 / 自动更新）状态
  const [updater, setUpdater] = useState<UpdaterStatus | null>(null)

  const ex = useCallback((fileName: string) => {
    const base = examplesDir || `D:\\工作\\代码实验室\\codelab-desktop\\examples`
    return `${base}\\${fileName}`
  }, [examplesDir])

  const terminalRef = useRef<TerminalHandle>(null)
  const pendingTasksRef = useRef<Map<string, (code: number) => void>>(new Map())

  const toggleLeftPanel = useCallback(() => setLeftPanelVisible((v) => !v), [])
  const toggleEditor = useCallback(() => setEditorVisible((v) => !v), [])
  const onActivityChange = useCallback((id: string) => {
    if (id === 'ai') setAiPanelVisible((v) => !v)
    else setActiveSidebar(id)
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
        if (d.code !== 0) {
          setBuildError(extractBuildError(buildLogRef.current))
        } else {
          setBuildError(null)
          buildLogRef.current = ''
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

  // 关闭 tab
  const onClose = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      if (id === activePath && next.length > 0) {
        setActivePath(next[Math.min(idx, next.length - 1)].id)
      }
      return next
    })
  }, [activePath])

  // 保存
  const onSave = useCallback(async (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    try {
      await window.api.fs.write(tab.id, tab.content)
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dirty: false } : t)))
      setOutputLog((prev) => prev + `\n✓ 已保存 ${tab.name}\n`)
    } catch (e) {
      setOutputLog((prev) => prev + `\n[错误] 保存失败：${(e as Error).message}\n`)
    }
  }, [tabs])

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
    // sketch 解析：优先工程树中的 .ino；未打开项目时用当前打开的 .ino 标签页（内置示例）
    let sketch = findSketch(tree)
    let virtualTab = tabs.find((t) => t.id === sketch)
    if (!sketch) {
      virtualTab = tabs.find((t) => t.name.endsWith('.ino'))
      sketch = virtualTab?.id ?? null
    }
    if (!sketch) {
      setOutputLog(
        (prev) =>
          prev +
          '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再编译。\n'
      )
      setCompileState('error')
      return
    }
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }

    // 保存当前编辑的"真实文件"（虚拟文件的相对路径不落盘，避免写到进程 cwd）
    const activeTab = tabs.find((t) => t.id === activePath)
    if (activeTab && isAbsPath(activeTab.id)) {
      try {
        await window.api.fs.write(activeTab.id, activeTab.content)
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, dirty: false } : t)))
      } catch {
        setOutputLog((prev) => prev + '\n[错误] 保存失败，已中止编译：请检查磁盘空间或文件权限。\n')
        return
      }
    }

    // 内置示例 / 未保存的 .ino：暂存为真实临时工程再编译（每次覆盖，烧的是编辑器最新内容）
    if (!isAbsPath(sketch)) {
      try {
        const name = sketch.replace(/\.ino$/i, '').split('/').pop() || 'sketch'
        const staged = await window.api.fs.stageTemp(name, virtualTab?.content ?? '')
        setOutputLog((prev) => prev + `\nℹ 内置示例已暂存到临时目录编译（不影响原文件）：${staged}\n`)
        sketch = staged
      } catch (e) {
        setOutputLog((prev) => prev + `\n[错误] 示例暂存失败：${(e as Error).message}\n`)
        setCompileState('error')
        return
      }
    }

    setOutputLog((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    setCompileState('compiling')
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
  }, [toolchain, tree, activePath, fqbn, compileState, tabs])

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
    // sketch 解析：优先工程树中的 .ino；未打开项目时用当前打开的 .ino 标签页（内置示例）
    let sketch = findSketch(tree)
    let virtualTab = tabs.find((t) => t.id === sketch)
    if (!sketch) {
      virtualTab = tabs.find((t) => t.name.endsWith('.ino'))
      sketch = virtualTab?.id ?? null
    }
    if (!sketch) {
      setOutputLog(
        (prev) =>
          prev +
          '\n[错误] 未找到 .ino 工程文件。请打开一个项目，或在编辑器中打开/新建一个 .ino 文件后再烧录。\n'
      )
      setCompileState('error')
      return
    }
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }

    // 保存当前编辑的"真实文件"（虚拟文件不落盘，走下方临时暂存）
    const activeTab = tabs.find((t) => t.id === activePath)
    if (activeTab && isAbsPath(activeTab.id)) {
      try {
        await window.api.fs.write(activeTab.id, activeTab.content)
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, dirty: false } : t)))
      } catch {
        setOutputLog((prev) => prev + '\n[错误] 保存失败，已中止烧录。\n')
        return
      }
    }

    // 内置示例 / 未保存的 .ino：暂存为真实临时工程再烧录
    if (!isAbsPath(sketch)) {
      try {
        const name = sketch.replace(/\.ino$/i, '').split('/').pop() || 'sketch'
        const staged = await window.api.fs.stageTemp(name, virtualTab?.content ?? '')
        setOutputLog((prev) => prev + `\nℹ 内置示例已暂存到临时目录烧录（不影响原文件）：${staged}\n`)
        sketch = staged
      } catch (e) {
        setOutputLog((prev) => prev + `\n[错误] 示例暂存失败：${(e as Error).message}\n`)
        setCompileState('error')
        return
      }
    }

    // 烧录前暂停串口监视器
    const wasSerialOpen = serialOpen
    if (wasSerialOpen) {
      await window.api.serial.close(`serial-${selectedPort}`)
      setSerialOpen(false)
    }

    // 先编译
    setOutputLog((prev) => prev + `\n▶ [编译] arduino-cli compile --fqbn ${fqbn} ${sketch}\n`)
    setCompileState('compiling')
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
    setCompileState('uploading')
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
  }, [toolchain, tree, activePath, fqbn, selectedPort, compileState, tabs, serialOpen, baud])

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
          // 关闭项目：清空所有标签页 + 项目状态（对齐 TrieCode"关闭项目 Ctrl+W"）
          setTabs([])
          setActivePath('')
          setProjectRoot(null)
          setTree(null)
          setOutputLog((prev) => prev + '\n📁 项目已关闭\n')
        }}
        onExit={() => window.api?.window?.close?.()}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => { setSettingsTab('general'); setShowSettings(true) }}
        onCompile={() => void runCompile()}
        onUpload={() => void runUpload()}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
        leftPanelVisible={leftPanelVisible}
        editorVisible={editorVisible}
        onToggleLeftPanel={toggleLeftPanel}
        onToggleEditor={toggleEditor}
        busy={busy}
        compileState={compileState}
        theme={theme}
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
        {leftPanelVisible && (
          <>
            <ActivityBar active={activeSidebar} onChange={onActivityChange} aiActive={aiPanelVisible} />
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
                  onBoardChange={(f, name) => {
                    setFqbn(f)
                    if (name) setBoardName(name)
                  }}
                  onPortChange={setSelectedPort}
                  onOpenSerialWindow={() => {
                    // 串口监视器统一走底部面板（不再弹浮窗，避免遮挡编辑器/仿真面板）
                    setTerminalVisible(true)
                    setOutputKey((k) => k + 1)
                  }}
                />
              )}
            </aside>
          </>
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
          {terminalVisible && (
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
              onClose={() => setTerminalVisible(false)}
              defaultTab="串口监视器"
              buildError={buildError}
              onDiagnose={diagnoseBuildError}
            />
          )}
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
        />
      )}
    </div>
  )
}

export default App
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
import type { ToolchainStatus, SerialPortInfo } from '../../preload'

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
  const [examplesDir, setExamplesDir] = useState<string>('')

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
      // 根据 taskId 更新编译状态
      if (d.id.startsWith('cap-compile-') || d.id.startsWith('grpc-compile-') || d.id.startsWith('cap-upload-') || d.id.startsWith('grpc-upload-')) {
        setCompileState(d.code === 0 ? 'success' : 'error')
        setCompileProgress(null)
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
    return () => {
      offOutput()
      offExit()
      offProgress?.()
      offSerial()
      offClose()
    }
  }, [])

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
  const runCompile = useCallback(async () => {
    if (!toolchain?.available || !toolchain.path) {
      setOutputLog((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      return
    }
    const sketch = findSketch(tree) ?? activePath
    if (!sketch) {
      setOutputLog((prev) => prev + '\n[错误] 未找到 .ino 工程文件。\n')
      return
    }
    // 门控：需要开发板
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }
    // 防重复
    if (compileState === 'compiling' || compileState === 'uploading') return

    // 保存当前文件（虚拟文件也需落盘，否则 arduino-cli 找不到）
    const activeTab = tabs.find((t) => t.id === activePath)
    if (activeTab) {
      try {
        await window.api.fs.write(activeTab.id, activeTab.content)
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, dirty: false } : t)))
      } catch {
        setOutputLog((prev) => prev + '\n[错误] 保存失败，已中止编译：请检查磁盘空间或文件权限。\n')
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
    if (!toolchain?.available || !toolchain.path) {
      setOutputLog((prev) => prev + '\n[错误] 未检测到 arduino-cli 工具链。\n')
      return
    }
    if (!selectedPort) {
      setOutputLog((prev) => prev + '\n[错误] 请先在工具栏选择串口端口。\n')
      return
    }
    const sketch = findSketch(tree) ?? activePath
    if (!sketch) {
      setOutputLog((prev) => prev + '\n[错误] 未找到 .ino 工程文件。\n')
      return
    }
    if (!fqbn) {
      setOutputLog((prev) => prev + '\n[错误] 请先选择一个开发板。\n')
      return
    }
    if (compileState === 'compiling' || compileState === 'uploading') return

    // 保存当前文件（虚拟文件也需落盘）
    const activeTab = tabs.find((t) => t.id === activePath)
    if (activeTab) {
      try {
        await window.api.fs.write(activeTab.id, activeTab.content)
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, dirty: false } : t)))
      } catch {
        setOutputLog((prev) => prev + '\n[错误] 保存失败，已中止烧录。\n')
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
      // 等待编译完成
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

    // 编译成功，开始上传
    setOutputLog((prev) => prev + `\n▶ [烧录] arduino-cli upload --fqbn ${fqbn} --port ${selectedPort} ${sketch}\n`)
    setCompileState('uploading')
    try {
      const uploadResult = await window.api.capability.run('upload', { sketch, fqbn, bin: toolchain.path, port: selectedPort })
      if (uploadResult.ok && uploadResult.taskId) {
        setActiveTaskId(uploadResult.taskId)
        pendingTasksRef.current.set(uploadResult.taskId, async (code) => {
          setBusy(false)
          await restoreSerial()
        })
      } else if (!uploadResult.ok) {
        setOutputLog((prev) => prev + `[错误] 烧录失败：${uploadResult.error || '未知错误'}\n`)
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
        fqbn={fqbn}
        onBoardChange={(newFqbn) => {
          setFqbn(newFqbn)
          window.api.device.set({ board: newFqbn }).catch(() => undefined)
          setOutputLog((prev) => prev + `\n📌 开发板已切换：${newFqbn}\n`)
        }}
      />
      <div className="ide-body">
        {leftPanelVisible && (
          <>
            <ActivityBar active={activeSidebar} onChange={onActivityChange} />
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
            />
          )}
        </div>
        {aiPanelVisible && (
          <AiPanel tabs={tabs} activePath={activePath} projectRoot={projectRoot} onApplyCode={applyCodeToFile} onRunTerminal={(cmd) => void runCommand(cmd)} onOpenSettings={() => { setSettingsTab('models'); setShowSettings(true); }} />
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
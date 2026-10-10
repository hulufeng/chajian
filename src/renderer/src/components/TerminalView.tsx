import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalHandle {
  append: (text: string) => void
  clear: () => void
}

interface Props {
  cwd: string
  onCommand?: (cmd: string) => void
  theme: 'light' | 'dark'
  shell?: 'powershell' | 'cmd' | 'pwsh' | 'bash'
  args?: string[]
  env?: Record<string, string>
  /** T1-a：主命令（如 menuconfig）退出后自动执行此命令（如 idf.py reconfigure），其输出回显在同一终端 */
  postExit?: { args: string[]; cwd: string; env?: Record<string, string>; label?: string }
}

const SHELL_LABEL: Record<string, string> = {
  powershell: 'PowerShell',
  cmd: '命令提示符 (cmd)',
  pwsh: 'PowerShell 7 (pwsh)',
  bash: 'Bash (WSL / Git Bash)',
}

const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ cwd, theme, shell = 'powershell', args, env, postExit }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const ptyIdRef = useRef<string>('')
  const postExitRef = useRef(postExit)
  postExitRef.current = postExit

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const termTheme = theme === 'dark'
      ? { background: 'var(--terminal-bg)', foreground: 'var(--terminal-text)', cursor: 'var(--accent)' }
      : { background: 'var(--surface-1)', foreground: 'var(--terminal-bg)', cursor: 'var(--accent)' }

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: termTheme,
      scrollback: 5000,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try { fit.fit() } catch { /* 容器未就绪 */ }

    termRef.current = term

    let disposed = false
    const dims = { cols: term.cols || 80, rows: term.rows || 24 }

    // xterm 键盘输入 → 当前活动 PTY（主命令与 post-exit 命令共用）
    term.onData((data) => {
      if (ptyIdRef.current) {
        void window.api.pty.write({ id: ptyIdRef.current, data })
      }
    })

    const startOpts: {
      shell?: string
      cwd: string
      cols: number
      rows: number
      args?: string[]
      env?: Record<string, string>
    } = { cwd, cols: dims.cols, rows: dims.rows }
    if (args && args.length > 0) {
      startOpts.args = args
      if (env) startOpts.env = env
    } else {
      startOpts.shell = shell
    }

    const headerLabel = args && args.length > 0
      ? '\x1b[36mESP-IDF menuconfig 交互终端\x1b[0m'
      : `\x1b[36mLabCode 真终端（${SHELL_LABEL[shell] ?? shell}）\x1b[0m`

    // 启动一次 PTY 会话；isPost 标记是否为「主命令退出后的后续命令」，避免重复触发
    const launch = (opts: typeof startOpts, label: string, isPost: boolean): void => {
      window.api.pty.start(opts).then((res) => {
        if (disposed) return
        if (!res.id || res.error) {
          term.writeln(`\x1b[31m[终端启动失败] ${res.error || '未知错误'}\x1b[0m`)
          term.writeln('\x1b[90m回退到简易模式：输入命令后回车执行\x1b[0m')
          return
        }
        ptyIdRef.current = res.id
        const offData = window.api.pty.onData((d) => {
          if (d.id === res.id) term.write(d.data)
        })
        const offExit = window.api.pty.onExit((d) => {
          if (d.id !== res.id) return
          offData()
          offExit()
          term.writeln(`\r\n\x1b[90m[进程已退出，返回码 ${d.code ?? 0}]\x1b[0m`)
          ptyIdRef.current = ''
          // T1-a：主命令（如 menuconfig）退出后自动执行后续命令（如 idf.py reconfigure）
          if (!isPost && postExitRef.current) {
            const pe = postExitRef.current
            term.writeln(`\r\n\x1b[36m▶ ${pe.label || '执行后续命令…'}\x1b[0m`)
            launch({ cwd: pe.cwd, cols: term.cols || 80, rows: term.rows || 24, args: pe.args, env: pe.env }, pe.label || '', true)
          } else {
            term.writeln('\x1b[90m[会话结束]\x1b[0m')
          }
        })
        term.writeln(label)
        term.writeln(`\x1b[90m工作目录: ${opts.cwd}\x1b[0m`)
        term.writeln('')
      }).catch((e) => {
        term.writeln(`\x1b[31m[终端异常] ${(e as Error).message}\x1b[0m`)
      })
    }

    launch(startOpts, headerLabel, false)

    // 窗口大小变化 → 调整 PTY
    const onResize = (): void => {
      try {
        fit.fit()
        if (ptyIdRef.current) {
          void window.api.pty.resize({ id: ptyIdRef.current, cols: term.cols, rows: term.rows })
        }
      } catch { /* 忽略 */ }
    }
    window.addEventListener('resize', onResize)

    // 容器尺寸变化（ResizeObserver）
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (ptyIdRef.current) {
          void window.api.pty.resize({ id: ptyIdRef.current, cols: term.cols, rows: term.rows })
        }
      } catch { /* 忽略 */ }
    })
    ro.observe(host)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      if (ptyIdRef.current) {
        void window.api.pty.kill(ptyIdRef.current)
        ptyIdRef.current = ''
      }
      term.dispose()
      termRef.current = null
    }
  }, [cwd, shell, theme, args, env, postExit])

  useImperativeHandle(ref, () => ({
    append: (text: string): void => {
      termRef.current?.write(text)
    },
    clear: (): void => {
      termRef.current?.clear()
    }
  }))

  return <div className="terminal-host" ref={hostRef} />
})

export default TerminalView

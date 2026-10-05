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
}

const SHELL_LABEL: Record<string, string> = {
  powershell: 'PowerShell',
  cmd: '命令提示符 (cmd)',
  pwsh: 'PowerShell 7 (pwsh)',
  bash: 'Bash (WSL / Git Bash)',
}

const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ cwd, theme, shell = 'powershell' }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const ptyIdRef = useRef<string>('')
  const offDataRef = useRef<(() => void) | null>(null)
  const offExitRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const termTheme = theme === 'dark'
      ? { background: 'var(--terminal-bg)', foreground: 'var(--terminal-text)', cursor: 'var(--accent)' }
      : { background: 'var(--panel)', foreground: 'var(--terminal-bg)', cursor: 'var(--accent)' }

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

    // 启动 PTY 真终端
    let disposed = false
    const dims = { cols: term.cols || 80, rows: term.rows || 24 }

    window.api.pty.start({ shell, cwd, cols: dims.cols, rows: dims.rows }).then((res) => {
      if (disposed) return
      if (!res.id || res.error) {
        term.writeln(`\x1b[31m[终端启动失败] ${res.error || '未知错误'}\x1b[0m`)
        term.writeln('\x1b[90m回退到简易模式：输入命令后回车执行\x1b[0m')
        return
      }
      ptyIdRef.current = res.id

      // PTY 输出 → xterm
      offDataRef.current = window.api.pty.onData((d) => {
        if (d.id === res.id) term.write(d.data)
      })
      offExitRef.current = window.api.pty.onExit((d) => {
        if (d.id === res.id) {
          term.writeln('\r\n\x1b[90m[进程已退出]\x1b[0m')
          ptyIdRef.current = ''
        }
      })

      // xterm 输入 → PTY
      term.onData((data) => {
        if (ptyIdRef.current) {
          void window.api.pty.write({ id: ptyIdRef.current, data })
        }
      })

      term.writeln(`\x1b[36mLabCode 真终端（${SHELL_LABEL[shell] ?? shell}）\x1b[0m`)
      term.writeln(`\x1b[90m工作目录: ${cwd}\x1b[0m`)
      term.writeln('')
    }).catch((e) => {
      term.writeln(`\x1b[31m[终端异常] ${(e as Error).message}\x1b[0m`)
    })

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
      offDataRef.current?.()
      offExitRef.current?.()
      if (ptyIdRef.current) {
        void window.api.pty.kill(ptyIdRef.current)
        ptyIdRef.current = ''
      }
      term.dispose()
      termRef.current = null
    }
  }, [cwd, shell, theme])

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

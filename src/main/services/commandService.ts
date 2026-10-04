import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export type ShellType = 'powershell' | 'cmd' | 'pwsh' | 'bash'

export function runCommand(
  cmd: string,
  cwd: string,
  onData: (chunk: string) => void,
  onExit: (code: number) => void,
  shell: ShellType = 'powershell'
): ChildProcess {
  const win = process.platform === 'win32'
  let exe: string
  let args: string[]
  switch (shell) {
    case 'cmd':
      exe = 'cmd.exe'
      args = ['/d', '/s', '/c', cmd]
      break
    case 'pwsh':
      exe = 'pwsh.exe'
      args = ['-NoProfile', '-Command', cmd]
      break
    case 'bash':
      exe = win ? 'bash' : '/bin/bash'
      args = ['-c', cmd]
      break
    case 'powershell':
    default:
      exe = win ? 'powershell.exe' : '/bin/bash'
      args = win ? ['-NoProfile', '-Command', cmd] : ['-c', cmd]
      break
  }
  const cp = spawn(exe, args, { cwd })
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[命令错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

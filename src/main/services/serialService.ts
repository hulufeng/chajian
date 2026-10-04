import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// 优先使用 serialport；若原生模块不可用则回退到 Windows `mode` 命令枚举
let serialportModule: typeof import('serialport') | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  serialportModule = require('serialport')
} catch {
  serialportModule = null
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  friendlyName?: string
}

export async function listPorts(): Promise<SerialPortInfo[]> {
  if (serialportModule) {
    try {
      const ports = await serialportModule.SerialPort.list()
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        friendlyName: (p as { friendlyName?: string }).friendlyName
      }))
    } catch {
      /* 回退 mode */
    }
  }
  // Windows 兜底：用 PowerShell 调 .NET 的 SerialPort.GetPortNames() 枚举 COM 口。
  // 注意：不能用 `mode` 命令——它是 cmd.exe 内置命令、没有独立 exe，spawn 不经 shell 必然 ENOENT。
  if (process.platform === 'win32') {
    const portNames = listPortsViaPowershell()
    if (portNames.length > 0) return portNames
  }
  return []
}

/** 通过 PowerShell + .NET SerialPort.GetPortNames() 枚举串口（serialport 不可用时的兜底） */
function listPortsViaPowershell(): SerialPortInfo[] {
  try {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames()'],
      { encoding: 'utf-8', timeout: 10000, windowsHide: true }
    )
    const out = `${(r.stdout || '')}${(r.stderr || '')}`
    const ports: SerialPortInfo[] = []
    const seen = new Set<string>()
    const re = /COM\d+/gi
    let m
    while ((m = re.exec(out)) !== null) {
      const path = m[0].toUpperCase()
      if (!seen.has(path)) {
        seen.add(path)
        ports.push({ path })
      }
    }
    return ports
  } catch {
    return []
  }
}

export type SerialSink = (data: string) => void

// 活动串口注册表：id -> SerialPort 实例（支持发送）
const activeSerials = new Map<string, { port: { isOpen: boolean; close(): void; write(d: string | Uint8Array, cb?: (e: Error | null) => void): void } }>()

// 每个会话的设备输出缓冲（供 Agent 事后读回，对应 serial_read 工具）
const serialBuffers = new Map<string, string>()

/** 向已打开的串口写入数据（发送） */
export function writeSerial(id: string, data: string): { ok: boolean; error?: string } {
  const entry = activeSerials.get(id)
  if (!entry) return { ok: false, error: `串口 ${id} 未打开` }
  try {
    entry.port.write(data + '\n', (e) => {
      if (e) console.warn(`[serial] 写入失败 ${id}: ${e.message}`)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function openSerialMonitor(
  opts: { port: string; baud: number },
  onData: (chunk: string) => void,
  onClose: (msg: string) => void
): () => void {
  if (serialportModule) {
    try {
      const id = `serial-${opts.port}`
      const port = new serialportModule.SerialPort(
        { path: opts.port, baudRate: opts.baud },
        (err) => {
          if (err) onClose(`打开串口失败：${err.message}`)
          else onData(`[${opts.port}] 已连接 @ ${opts.baud}\n`)
        }
      )
      port.on('data', (d: Buffer) => {
        const s = d.toString()
        onData(s)
        const buf = serialBuffers.get(id)
        serialBuffers.set(id, (buf || '') + s)
      })
      port.on('error', (err: Error) => onClose(`串口错误：${err.message}`))
      port.on('close', () => {
        activeSerials.delete(id)
        serialBuffers.delete(id)
        onClose(`[${opts.port}] 已断开`)
      })
      activeSerials.set(id, { port: port as { isOpen: boolean; close(): void; write(d: string | Uint8Array, cb?: (e: Error | null) => void): void } })
      serialBuffers.set(id, '')
      return () => {
        activeSerials.delete(id)
        serialBuffers.delete(id)
        try {
          if (port.isOpen) port.close()
        } catch {
          /* 忽略 */
        }
      }
    } catch (e) {
      onClose(`打开串口异常：${(e as Error).message}`)
      return () => undefined
    }
  }
  // 无 serialport 时，尝试用 arduino-cli monitor 或提示
  onClose(`当前环境未加载 serialport 原生模块，串口监视暂不可用（请安装 serialport 并执行 electron-rebuild）。已枚举端口 ${opts.port}`)
  return () => undefined
}

export { serialportModule }

/** 关闭一个串口会话（清理注册表与缓冲）。id 形如 serial-COM3。 */
export function closeSerial(id: string): { ok: boolean; error?: string } {
  const entry = activeSerials.get(id)
  if (!entry) return { ok: false, error: `串口会话 ${id} 不存在（可能未打开或已关闭）` }
  try {
    if (entry.port.isOpen) entry.port.close()
  } catch {
    /* 忽略 */
  }
  activeSerials.delete(id)
  serialBuffers.delete(id)
  return { ok: true }
}

/** 读取会话截至目前的设备输出缓冲。reset=true 时读取后清空（消费式读回），
 * 适合 Agent 在发送指令后读取设备响应。 */
export function readSerialBuffer(id: string, reset = true): { ok: boolean; data?: string; error?: string } {
  if (!serialBuffers.has(id)) {
    return { ok: false, error: `串口会话 ${id} 不存在（先用 serial_monitor 打开或 serial_open 建立持久会话）` }
  }
  const data = serialBuffers.get(id) || ''
  if (reset) serialBuffers.set(id, '')
  return { ok: true, data }
}

/** 保留式读取会话累积日志全文（不清空），对齐 TrieCode serial_log 后台 buffer。 */
export function readSerialLog(id: string): { ok: boolean; data?: string; error?: string } {
  if (!serialBuffers.has(id)) {
    return { ok: false, error: `串口会话 ${id} 不存在（先用 serial_monitor continuous:true 打开或 serial_open 建立持久会话）` }
  }
  return { ok: true, data: serialBuffers.get(id) || '' }
}

/** 清空会话累积日志（保留会话本身）。 */
export function clearSerialLog(id: string): { ok: boolean; error?: string } {
  if (!serialBuffers.has(id)) {
    return { ok: false, error: `串口会话 ${id} 不存在` }
  }
  serialBuffers.set(id, '')
  return { ok: true }
}

/** 列出当前打开的串口会话。 */
export function listSerialSessions(): Array<{ id: string; open: boolean }> {
  return Array.from(activeSerials.keys()).map((id) => ({ id, open: activeSerials.get(id)?.port.isOpen ?? false }))
}

// ───────────────────────────────────────────────────────────
//  串口热插拔检测（USB 插拔无系统事件可用，采用轻量轮询）
//  listPorts() 基于 serialport，开销极小，2 秒轮询对 CPU 无影响。
//  端口集合发生变化（新增/移除）时回调，供主进程广播给渲染层。
// ───────────────────────────────────────────────────────────
export interface PortsChangePayload {
  ports: SerialPortInfo[]
  added: string[]
  removed: string[]
}

type PortsChangeHandler = (payload: PortsChangePayload) => void

let watchTimer: ReturnType<typeof setInterval> | null = null
let lastPortPaths: string[] = []

export function startPortWatcher(handler: PortsChangeHandler, intervalMs = 2000): void {
  if (watchTimer) return
  // 建立基线（不触发首次回调，避免启动时误报）
  void listPorts()
    .then((p) => {
      lastPortPaths = p.map((x) => x.path)
    })
    .catch(() => undefined)

  watchTimer = setInterval(() => {
    void listPorts()
      .then((ports) => {
        const cur = ports.map((p) => p.path)
        const added = cur.filter((x) => !lastPortPaths.includes(x))
        const removed = lastPortPaths.filter((x) => !cur.includes(x))
        lastPortPaths = cur
        if (added.length === 0 && removed.length === 0) return
        try {
          handler({ ports, added, removed })
        } catch {
          /* 回调异常不影响轮询 */
        }
      })
      .catch(() => undefined)
  }, intervalMs)
}

export function stopPortWatcher(): void {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
}

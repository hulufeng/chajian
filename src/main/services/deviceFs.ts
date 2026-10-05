// 设备端文件系统（对标 Pulsar 的「设备文件浏览 + 文件夹一键同步」）
//
// 链路：走已有串口会话（serial_monitor 打开的 sessionId），行协议：
//   FS LS <path>                        → `OK` + JSON 数组
//   FS CAT <path>                       → `OK` + base64
//   FS PUT <path> <total> <idx> <b64>   → `OK` / `ERR <msg>`（分片写，避免单行过长）
//   FS MKDIR <path>                     → `OK` / `ERR <msg>`
//   FS RM <path>                        → `OK` / `ERR <msg>`
//   FS STAT <path>                      → `OK` + JSON
// 设备端固件只要按这个协议回一行 OK/ERR 就能被本服务驱动；
// 协议本身与传输解耦（FsTransport 可注入），所以没有真机时也能用假 transport 跑通全流程。
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { writeSerial, readSerialLog, clearSerialLog } from './serialService'

/** 单次 PUT 的 base64 体积上限（约 24KB 原文），再大就多片 */
const MAX_CHUNK_B64 = 32000

export interface DeviceFsNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface DeviceFsStat {
  type: 'file' | 'dir'
  size: number
}

/** 与传输无关的抽象：发一条指令，拿回响应文本 */
export interface FsTransport {
  request(command: string, timeoutMs?: number): Promise<string>
}

export interface DeviceFs {
  list(path: string): Promise<DeviceFsNode[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<DeviceFsStat>
  /** 本地文件夹 → 设备目录，只传新增/变更的文件；返回本次改动摘要 */
  syncUp(localDir: string, deviceDir: string, onProgress?: (msg: string) => void): Promise<{ uploaded: string[]; skipped: string[] }>
}

/** 把响应文本切成行，去掉 \r */
function linesOf(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/\r/g, ''))
}

/** 从响应里取第一条以 OK/ERR 开头的行 */
function statusLine(text: string): { ok: boolean; line: string; rest: string[] } {
  const ls = linesOf(text)
  const idx = ls.findIndex((l) => /^(OK|ERR)\b/.test(l))
  if (idx < 0) return { ok: false, line: '', rest: ls }
  const line = ls[idx]
  return { ok: line === 'OK' || line.startsWith('OK '), line, rest: ls.slice(idx + 1) }
}

/** 取状态行之后的 JSON（可能带空行） */
function jsonAfter(text: string): unknown {
  const st = statusLine(text)
  if (!st.rest.length) return undefined
  const jsonLine = st.rest.find((l) => l.trim().startsWith('[') || l.trim().startsWith('{'))
  if (!jsonLine) return undefined
  try {
    return JSON.parse(jsonLine)
  } catch {
    return undefined
  }
}

/** 简单的 base64（不引依赖） */
export function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64')
}

export function fromBase64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf-8')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 基于已打开的串口会话构造 transport */
export function createSerialFsTransport(sessionId: string, opts: { timeoutMs?: number } = {}): FsTransport {
  const timeoutMs = opts.timeoutMs ?? 5000
  return {
    async request(command: string): Promise<string> {
      writeSerial(sessionId, command)
      const deadline = Date.now() + timeoutMs
      let text = ''
      for (;;) {
        const buf = readSerialLog(sessionId)
        if (!buf.ok) throw new Error(buf.error || `串口会话 ${sessionId} 不存在`)
        text = buf.data || ''
        // 只要出现以 OK/ERR 开头的行就认为响应完整
        if (linesOf(text).some((l) => /^(OK|ERR)\b/.test(l))) break
        if (Date.now() > deadline) break
        await sleep(50)
      }
      // 消费掉这段响应，避免污染下一条指令
      clearSerialLog(sessionId)
      return text
    }
  }
}

/** 基于内存 responder 的 transport（测试 / 离线演示用，不碰真实串口） */
export function createEchoFsTransport(get: (cmd: string) => string): FsTransport {
  return {
    async request(cmd: string): Promise<string> {
      await sleep(0)
      return get(cmd)
    }
  }
}

/**
 * 创建设备文件系统客户端。
 * transport 可注入：真机用 createSerialFsTransport，冒烟用 createEchoFsTransport。
 */
export function createDeviceFs(transport: FsTransport, opts: { timeoutMs?: number } = {}): DeviceFs {
  const timeoutMs = opts.timeoutMs ?? 5000

  async function call(cmd: string): Promise<void> {
    const res = await transport.request(cmd, timeoutMs)
    const st = statusLine(res)
    if (!st.line) throw new Error(`设备无响应（收到：${res.slice(0, 120).replace(/\n/g, ' ⏎ ')}）`)
    if (!st.ok) throw new Error(st.line.replace(/^ERR\s*/, '设备返回错误：') || '设备返回错误')
  }

  // 用局部函数而不是对象方法，避免 syncUp 里靠 this 互相调用（隐式 any 风险）
  async function list(path: string): Promise<DeviceFsNode[]> {
    const res = await transport.request(`FS LS ${path}`, timeoutMs)
    const st = statusLine(res)
    if (!st.line) throw new Error(`设备无响应（FS LS ${path}）`)
    if (!st.ok) throw new Error(st.line.replace(/^ERR\s*/, '列出目录失败：') || '列出目录失败')
    const data = jsonAfter(res)
    if (!Array.isArray(data)) return []
    return (data as Array<Record<string, unknown>>).map((n) => ({
      name: String(n.name ?? ''),
      path: String(n.path ?? ''),
      type: (n.type === 'dir' ? 'dir' : 'file') as 'file' | 'dir',
      size: typeof n.size === 'number' ? n.size : undefined
    }))
  }

  async function read(path: string): Promise<string> {
    const res = await transport.request(`FS CAT ${path}`, timeoutMs)
    const st = statusLine(res)
    if (!st.line) throw new Error(`设备无响应（FS CAT ${path}）`)
    if (!st.ok) throw new Error(st.line.replace(/^ERR\s*/, '读取失败：') || '读取失败')
    const b64 = st.rest.find((l) => l.trim())?.trim()
    return b64 ? fromBase64(b64) : ''
  }

  async function write(path: string, content: string): Promise<void> {
    const b64 = toBase64(content)
    const total = Math.max(1, Math.ceil(b64.length / MAX_CHUNK_B64))
    for (let i = 0; i < total; i++) {
      const part = b64.slice(i * MAX_CHUNK_B64, (i + 1) * MAX_CHUNK_B64)
      await call(`FS PUT ${path} ${total} ${i} ${part}`)
    }
  }

  async function mkdir(path: string): Promise<void> {
    await call(`FS MKDIR ${path}`)
  }

  async function remove(path: string): Promise<void> {
    await call(`FS RM ${path}`)
  }

  async function stat(path: string): Promise<DeviceFsStat> {
    const res = await transport.request(`FS STAT ${path}`, timeoutMs)
    const st = statusLine(res)
    if (!st.line) throw new Error(`设备无响应（FS STAT ${path}）`)
    if (!st.ok) throw new Error(st.line.replace(/^ERR\s*/, '查询失败：') || '查询失败')
    const data = jsonAfter(res) as DeviceFsStat | undefined
    if (!data) throw new Error('设备未返回 stat 信息')
    return data
  }

  async function syncUp(
    localDir: string,
    deviceDir: string,
    onProgress?: (msg: string) => void
  ): Promise<{ uploaded: string[]; skipped: string[] }> {
      const uploaded: string[] = []
      const skipped: string[] = []

      const walkLocal = (dir: string, rel: string): Array<{ rel: string; abs: string; size: number }> => {
        const out: Array<{ rel: string; abs: string; size: number }> = []
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch (e) {
          throw new Error(`读取本地目录失败 ${dir}：${(e as Error).message}`)
        }
        for (const name of entries) {
          if (name === '.' || name === '..') continue
          const abs = join(dir, name)
          const st = statSync(abs)
          const r = rel ? `${rel}/${name}` : name
          if (st.isDirectory()) out.push(...walkLocal(abs, r))
          else out.push({ rel: r, abs, size: st.size })
        }
        return out
      }

      const files = walkLocal(localDir, '')
      // 建立设备侧索引（目录名 → 已存在文件），避免每个文件都重新 LS
      const remoteByName = new Map<string, DeviceFsNode[]>()
      const ensureIndex = async (dirPath: string): Promise<Map<string, DeviceFsNode>> => {
        if (remoteByName.has(dirPath)) return new Map(remoteByName.get(dirPath)!.map((n) => [n.name, n]))
        const nodes = await list(dirPath)
        remoteByName.set(dirPath, nodes)
        return new Map(nodes.map((n) => [n.name, n]))
      }

      for (const f of files) {
        const devicePath = `${deviceDir.replace(/\/$/, '')}/${f.rel}`
        const dirPath = devicePath.slice(0, devicePath.lastIndexOf('/'))
        const fileName = devicePath.slice(devicePath.lastIndexOf('/') + 1)
        let idx = await ensureIndex(dirPath)
        const remote = idx.get(fileName)
        // 远端不存在或大小不一致 → 重传
        if (remote && remote.type === 'file' && remote.size === f.size) {
          skipped.push(f.rel)
          continue
        }
        try {
          await mkdir(dirPath)
        } catch {
          /* 目录已存在不算错 */
        }
        idx = await ensureIndex(dirPath)
        await write(devicePath, readFileSync(f.abs, 'utf-8'))
        uploaded.push(f.rel)
        onProgress?.(`已上传 ${f.rel}`)
      }
      return { uploaded, skipped }
  }

  return { list, read, write, mkdir, remove, stat, syncUp }
}

/**
 * diagLog.ts —— 真机测试信息收集（「自带测试」的底座）
 * --------------------------------------------------------------------------
 * 为什么需要它：
 *   我在沙箱里起不了 Electron GUI，也 spawn 不动 arduino-cli，
 *   真机上出了 bug 只能靠截图猜。有了它，用户在本机跑一遍，
 *   导出一个报告文件给我，我就能照着**真实数据**定位，而不是照着想象。
 *
 * 三条设计底线：
 *   1. **只写本机**：日志永远只落在用户自己的 userData 目录，不联网、不外发。
 *      要不要发出去，由用户在设置里手动点「导出」决定（导出的文件他看得到）。
 *   2. **只记排错必需的字段**：路径 / 命令 / 退出码 / 耗时 / 报错尾部。
 *      不记文件内容、不记 AI 对话正文、不记 Key。
 *   3. **绝不能因为记日志把主流程搞崩**：所有写入 try/catch 吞掉，
 *      超大小自动停写（不会把磁盘写满）。
 *
 * 落盘格式：JSONL（一行一个事件），既方便我 grep，也方便直接看。
 */

import { app } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 最多保留多少次会话的日志（超出删最旧的） */
const MAX_SESSIONS = 8
/** 单个会话日志的上限：超了就停写（避免长时间跑把磁盘写满） */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** 任务输出最多留多少字符（尾部）：报错都在最后，头部的编译噪声不重要 */
const TAIL_CHARS = 6000

export interface DiagEvent {
  ts: string
  /** 进程启动后的毫秒数：算耗时/看先后顺序比时间戳直观 */
  t: number
  event: string
  [k: string]: unknown
}

let dirPath = ''
let filePath = ''
let sessionId = ''
let startedAt = 0
/** 写满了 / 目录不可用 → 停写，但主流程不受影响 */
let disabled = false

function now(): number {
  return Date.now()
}

/**
 * 启动一次会话日志。必须在 app.whenReady 之后调（要取 userData 路径）。
 * 会顺手清理超过 MAX_SESSIONS 的旧日志。
 */
export function initDiag(): { dir: string; file: string; sessionId: string } {
  startedAt = now()
  // 精确到毫秒：同一秒内二次启动（崩溃后立刻重开很常见）不能互相覆盖同一个文件
  sessionId = new Date(startedAt).toISOString().replace(/[^0-9]/g, '').slice(0, 17)
  try {
    dirPath = join(app.getPath('userData'), 'diag')
    mkdirSync(dirPath, { recursive: true })
    filePath = join(dirPath, `session-${sessionId}.jsonl`)
    writeFileSync(filePath, '', 'utf-8')
    rotate()
  } catch {
    disabled = true
  }
  // 环境信息一律用可选调用取：诊断是「旁挂」能力，
  // 万一某个 Electron 版本没这个方法，也绝不能因为它把启动流程拖崩。
  diag('session:start', {
    appVersion: app.getVersion?.() ?? '',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    // 语言/时区会影响 arduino-cli 输出的解析（日期格式、编码），排错时有用
    locale: app.getLocale?.() ?? '',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd: process.cwd()
  })
  return { dir: dirPath, file: filePath, sessionId }
}

/** 删掉超出份数限制的旧会话日志（新的才有用，旧的只是占地方） */
function rotate(): void {
  try {
    const files = readdirSync(dirPath).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl')).sort()
    while (files.length > MAX_SESSIONS) {
      const oldest = files.shift()
      if (!oldest) break
      try { rmSync(join(dirPath, oldest), { force: true }) } catch { /* 删不掉就算了，不阻塞启动 */ }
    }
  } catch {
    /* 目录读不了就算了 */
  }
}

/** 记一条事件。主流程里到处埋，写入失败一律静默。 */
export function diag(event: string, data?: Record<string, unknown>): void {
  if (disabled || !filePath) return
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) {
      disabled = true
      return
    }
  } catch {
    // statSync 失败（文件被删等）：继续尝试写一次，写不进去自然被下面吞掉
  }
  try {
    const rec: DiagEvent = { ts: new Date().toISOString(), t: now() - startedAt, event, ...(data ?? {}) }
    appendFileSync(filePath, JSON.stringify(rec) + '\n', 'utf-8')
  } catch {
    /* 绝不因为日志拖垮功能 */
  }
}

export function diagInfo(): { dir: string; file: string; sessionId: string; disabled: boolean } {
  return { dir: dirPath, file: filePath, sessionId, disabled }
}

/**
 * 任务级记录器：编译 / 烧录这类长任务用。
 * 它会攒下输出（只留尾部 TAIL_CHARS），结束时连同退出码、耗时一起落盘 ——
 * 「编译失败但不知道为什么」的场景，有了 outTail 基本就能一眼定位。
 */
export function diagTask(id: string, kind: string, meta?: Record<string, unknown>): {
  push: (chunk: string) => void
  finish: (code: number, extra?: Record<string, unknown>) => void
} {
  const t0 = now()
  let buf = ''
  diag(`task:start`, { id, kind, ...(meta ?? {}) })
  return {
    push(chunk: string): void {
      buf += chunk ?? ''
      // 只保留尾部：buf 无限涨会拖慢长编译
      if (buf.length > TAIL_CHARS * 2) buf = buf.slice(-TAIL_CHARS)
    },
    finish(code: number, extra?: Record<string, unknown>): void {
      diag('task:exit', {
        id,
        kind,
        code,
        ms: now() - t0,
        outTail: buf.slice(-TAIL_CHARS),
        ...(extra ?? {})
      })
    }
  }
}

/**
 * 生成可发送的测试报告（纯文本，无需任何压缩依赖）。
 * 结构：头部环境信息 → 自检结论 → 全部事件（JSON 行，按时间顺序）。
 */
export function buildReport(selfTest?: Record<string, unknown>): { text: string; defaultName: string } {
  const head: string[] = []
  head.push('===== LabCode 真机测试报告 =====')
  head.push(`导出时间: ${new Date().toISOString()}`)
  head.push(`应用版本: ${app.getVersion?.() ?? ''}   Electron: ${process.versions.electron}   Node: ${process.versions.node}`)
  head.push(`平台: ${process.platform}-${process.arch}   已打包: ${app.isPackaged}`)
  head.push(`本次会话: ${sessionId}`)
  head.push('')
  head.push('【怎么读】下面每段以 --- session-xxx --- 开头，是一次启动；每行一个事件，')
  head.push('ts=时间，t=启动后毫秒，event=事件名；task:exit 的 outTail 是该任务的输出尾部。')
  head.push('【隐私】日志只写在你本机，含本机文件路径（排错必需）；是否外发由你决定。')
  if (selfTest) {
    head.push('')
    head.push('【自检结论】')
    head.push(JSON.stringify(selfTest, null, 2))
  }
  head.push('')
  head.push('===== 事件时间线 =====')

  const bodies: string[] = []
  try {
    const files = readdirSync(dirPath).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl')).sort()
    for (const f of files) {
      bodies.push(`--- ${f} ---`)
      try {
        bodies.push(readFileSync(join(dirPath, f), 'utf-8').trimEnd())
      } catch {
        bodies.push('(读取失败)')
      }
    }
  } catch {
    bodies.push('(日志目录为空或不可读)')
  }

  // 文件名只留数字（YYYYMMDDHHmmssSSS）：冒号在 Windows 上是非法文件名字符
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  return {
    text: head.join('\n') + '\n' + bodies.join('\n') + '\n',
    defaultName: `LabCode-测试报告-${stamp}.txt`
  }
}

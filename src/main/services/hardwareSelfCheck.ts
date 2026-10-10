// 一键硬件自检（让「插板就能跑」不依赖手工排查）
//
// 为什么要单独做：调试链路横跨 固件工具链 / 调试器 / USB 驱动 / 串口占用 四层，
// 任何一层没到位，报错都长成 openocd 的 `could not find or open device!`，
// 用户根本分不清是没插板、驱动没绑、还是工具没装。
//
// 设计要点：**必须区分「未安装」与「启动失败」**。
// 例如受限环境下 spawn 外部 exe 会返回 EBUSY/EPERM，这不是没装，
// 如果一律报「未安装」，用户会反复点安装却永远装不上。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getOpenocdInfo } from './debug/debugService'
import { locateToolchain } from './toolchain'
import { findPio } from './platformio'
import { listSerialSessions, listPorts } from './serialService'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export interface CheckItem {
  id: string
  name: string
  status: CheckStatus
  detail: string
  /** 可执行的修复动作（用户照做即可，不写「联系客服」这种废话） */
  fix?: string
}

export interface BoardSeen {
  path: string
  vid: number
  pid: number
  usbId: string
  kind: 'esp' | 'stlink' | 'ch340' | 'other'
  label: string
  /** serialport 能看到 = 驱动正常（系统已绑定） */
  viaSerial: boolean
}

export interface SelfCheckReport {
  ts: number
  items: CheckItem[]
  boards: BoardSeen[]
  /** 面向人的一句话结论 */
  summary: string
  /** 面向 Agent 的建议动作 */
  advice: string[]
}

/** 跑一个外部工具的版本查询，区分「没装」与「装了但起不来」 */
function probeTool(
  exe: string | null,
  args: string[]
): { status: CheckStatus; detail: string } {
  if (!exe) return { status: 'fail', detail: '未找到可执行文件' }
  if (!existsSync(exe)) return { status: 'fail', detail: `文件不存在：${exe}` }
  try {
    const r = spawnSync(exe, args, { encoding: 'utf-8', timeout: 20000, windowsHide: true })
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code || r.error.message
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return {
          status: 'warn',
          detail: `已安装但当前环境无法启动（${code}）。这是系统权限/沙箱限制，不是没装；换到普通终端或以管理员运行即可。`
        }
      }
      return { status: 'warn', detail: `启动失败：${code}` }
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
    if (r.status === 0) {
      const first = out.split('\n')[0] || 'ok'
      return { status: 'ok', detail: first.slice(0, 120) }
    }
    return { status: 'warn', detail: `退出码 ${r.status}：${out.split('\n')[0] || '(无输出)'}`.slice(0, 160) }
  } catch (e) {
    return { status: 'warn', detail: `探测异常：${(e as Error).message}` }
  }
}

function classify(vid: number, pid: number): { kind: BoardSeen['kind']; label: string } {
  if (vid === 0x303a) return { kind: 'esp', label: 'Espressif 原生 USB（ESP32 系列）' }
  if (vid === 0x0483) return { kind: 'stlink', label: 'STMicroelectronics（ST-Link / Nucleo 板载）' }
  if (vid === 0x1a86) return { kind: 'ch340', label: 'CH340 串口（USB-UART 转接）' }
  if (vid === 0x10c4) return { kind: 'other', label: 'Silicon Labs CP210x 串口' }
  if (vid === 0x0d28) return { kind: 'other', label: 'ARM CMSIS-DAP 调试器' }
  if (vid === 0x1366) return { kind: 'other', label: 'SEGGER J-Link' }
  if (pid === 0x1001) return { kind: 'esp', label: 'ESP32 USB JTAG/serial debug unit' }
  return { kind: 'other', label: `USB 设备 ${((vid << 16) | pid).toString(16).padStart(8, '0')}` }
}

export async function runSelfCheck(): Promise<SelfCheckReport> {
  const items: CheckItem[] = []
  const advice: string[] = []

  // ① 编译工具链
  const cli = probeTool(locateToolchain(), ['version'])
  items.push({
    id: 'arduino-cli',
    name: '编译工具链 arduino-cli',
    status: cli.status,
    detail: cli.detail,
    fix: cli.status === 'fail' ? '工具链面板点「安装 arduino-cli」' : undefined
  })

  // ② 调试器
  const ocd = getOpenocdInfo()
  if (!ocd.installed) {
    items.push({
      id: 'openocd',
      name: '调试器 openocd',
      status: 'fail',
      detail: '未安装',
      fix: '片上调试面板点「安装 openocd」，或设置环境变量 OPENOCD_PATH'
    })
  } else if (!existsSync(ocd.scripts)) {
    items.push({
      id: 'openocd',
      name: '调试器 openocd',
      status: 'fail',
      detail: `已找到 ${ocd.path}，但脚本目录缺失：${ocd.scripts}`,
      fix: '重装 openocd（安装不完整）'
    })
  } else {
    const v = probeTool(ocd.path, ['--version'])
    items.push({
      id: 'openocd',
      name: '调试器 openocd',
      status: v.status,
      detail: v.status === 'ok' ? `${v.detail} · scripts 完整` : v.detail
    })
  }

  // ③ PlatformIO（STM32 必需）
  const pio = findPio()
  if (!pio.installed) {
    items.push({
      id: 'platformio',
      name: '构建后端 PlatformIO',
      status: 'warn',
      detail: '未安装（ESP32 可用 arduino-cli 编译；STM32 必须装 pio）',
      fix: 'PlatformIO 面板点「安装 PlatformIO」'
    })
  } else {
    items.push({ id: 'platformio', name: '构建后端 PlatformIO', status: 'ok', detail: `${pio.version} · ${pio.command}` })
  }

  // ④ USB 设备枚举（板子是否插好、驱动是否绑定）
  const boards: BoardSeen[] = []
  try {
    const ports = await listPorts()
    for (const p of ports) {
      if (!p.vid || !p.pid) continue // 系统口（COM1 之类）不算板子
      const c = classify(p.vid, p.pid)
      boards.push({
        path: p.path,
        vid: p.vid,
        pid: p.pid,
        usbId: `0x${p.vid.toString(16)}:0x${p.pid.toString(16)}`,
        kind: c.kind,
        label: c.label,
        viaSerial: true
      })
    }
  } catch (e) {
    items.push({
      id: 'usb',
      name: 'USB 设备枚举',
      status: 'warn',
      detail: `枚举失败：${(e as Error).message}`,
      fix: '确认 serialport 原生模块已就绪（electron-rebuild）'
    })
  }

  const esp = boards.filter((b) => b.kind === 'esp')
  const stlink = boards.filter((b) => b.kind === 'stlink')
  if (boards.length === 0) {
    items.push({
      id: 'board',
      name: '已连接开发板',
      status: 'warn',
      detail: '没有检测到任何 USB 开发板',
      fix: 'ESP32-S3/C3 插「原生 USB 口」；Nucleo 插板载 ST-Link 的 USB 口；确认板子已上电'
    })
    advice.push('当前无板：插上板子后重跑自检，再点「连接调试器」。')
  } else {
    items.push({
      id: 'board',
      name: '已连接开发板',
      status: 'ok',
      detail: boards.map((b) => `${b.label} @ ${b.path}（${b.usbId}）`).join('；')
    })
  }

  if (esp.length > 0) {
    items.push({
      id: 'driver',
      name: '片上调试驱动（WinUSB）',
      status: 'warn',
      detail: '检测到 ESP 原生 USB。JTAG 功能需要「USB JTAG/serial debug unit」接口绑 WinUSB；未绑时 openocd 会报 could not find or open device',
      fix: '用 Zadig 选中该接口 → 选 WinUSB → 点 Replace Driver'
    })
    advice.push('ESP 已插入但若连接调试器失败，先确认 WinUSB 绑定（自检无法自动判定驱动类型）。')
  }
  if (stlink.length > 0) {
    items.push({ id: 'driver', name: 'ST-Link 驱动', status: 'ok', detail: 'ST-Link 枚举正常，openocd 的 stlink 驱动可直接使用' })
  }

  // ⑤ 串口占用（会顶掉调试/烧录）
  const sessions = listSerialSessions()
  if (sessions.length > 0) {
    items.push({
      id: 'serial-lock',
      name: '串口占用',
      status: 'warn',
      detail: `有 ${sessions.length} 个串口会话开着：${sessions.map((s) => s.id).join(', ')}`,
      fix: '烧录前会自动释放调试会话；串口监视器与烧录不能同时占用同一端口'
    })
  } else {
    items.push({ id: 'serial-lock', name: '串口占用', status: 'ok', detail: '没有打开的串口会话' })
  }

  const fail = items.filter((i) => i.status === 'fail').length
  const warn = items.filter((i) => i.status === 'warn').length
  const summary =
    fail > 0
      ? `${fail} 项失败、${warn} 项提醒 —— 先修失败项`
      : warn > 0
        ? `环境可用（有 ${warn} 项提醒）`
        : '全部就绪，可以直接连板调试'

  return { ts: Date.now(), items, boards, summary, advice }
}

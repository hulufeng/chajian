// 硬件目标注册表（第四批②「扩硬件」的数据源）
//
// 为什么单独建一个注册表：以前板卡信息散落在三处——arduino-cli 的 FQBN 字符串、
// openocd 的 board cfg、PlatformIO 的 board id。扩到 STM32 后这三套命名完全不同
// （esp32:esp32:esp32s3 / board/esp32s3-builtin.cfg / esp32-s3-devkitc-1），
// 再散着写就一定会配错。这里做成一份数据，UI、Agent、代码生成都从这里读。
//
// 收录标准（不收录跑不通的板）：
//  ① arduino-cli 或 PlatformIO 至少有一条能编译的构建路径；
//  ② openocd 有对应的配置（板载 USB-JTAG / 板载 ST-Link / 外接 ST-Link 三种链路之一）；
//  ③ USB VID/PID 用真实值，能靠端口自动认出来。

export type BoardFamily = 'esp32' | 'stm32'
export type BuildPath = 'arduino-cli' | 'platformio' | 'esp-idf' | 'stm32cube'
/** 烧录通道 */
export type UploadKind = 'serial' | 'usb-jtag' | 'stlink' | 'dfu'
/** 调试器链路 */
export type DebugLink = 'builtin-usb-jtag' | 'onboard-stlink' | 'external-stlink' | 'cmsis-dap'

export interface BoardTarget {
  id: string
  name: string
  family: BoardFamily
  /** 芯片标识（与 debugService 的 chipOf 对应） */
  chip: string
  mcu: string
  flash: string
  /** 构建路径（按可用性排序，第一项是推荐） */
  build: Array<{ path: BuildPath; detail: string }>
  /** arduino-cli FQBN（path=arduino-cli 时有效） */
  fqbn?: string
  /** PlatformIO board id（path=platformio 时有效） */
  pioBoard?: string
  /** PlatformIO platform 名 */
  pioPlatform?: string
  upload: { kind: UploadKind; baud: number; note: string }
  debug: { link: DebugLink; cfg: string[]; chip: string; note: string }
  /** SVD 芯片名（espressif/svd 官方源）；STM32 为 null，需导入本地 SVD */
  svdChip?: string | null
  /** 认板用的 USB VID:PID（十进制或 0x 前缀字符串），用于自动匹配端口 */
  usbIds?: string[]
  /** 排查/上手提示 */
  notes: string
}

export const BOARD_TARGETS: BoardTarget[] = [
  {
    id: 'esp32-s3-devkitc-1',
    name: 'ESP32-S3-DevKitC-1',
    family: 'esp32',
    chip: 'esp32s3',
    mcu: 'Xtensa LX7 双核 240MHz',
    flash: '16MB',
    build: [
      { path: 'arduino-cli', detail: 'esp32:esp32:esp32s3（官方 core，最省事）' },
      { path: 'platformio', detail: 'espressif32 / esp32-s3-devkitc-1' }
    ],
    fqbn: 'esp32:esp32:esp32s3',
    pioBoard: 'esp32-s3-devkitc-1',
    pioPlatform: 'espressif32',
    upload: { kind: 'usb-jtag', baud: 4000000, note: '原生 USB 口直连 esptool，无需外置串口' },
    debug: {
      link: 'builtin-usb-jtag',
      cfg: ['board/esp32s3-builtin.cfg'],
      chip: 'esp32s3',
      note: '板载 USB-JTAG，WinUSB 驱动；面板寄存器/内存/断点直读'
    },
    svdChip: 'esp32s3',
    usbIds: ['0x303a:0x1001'],
    notes: '本项目主战场：USB 串口与 JTAG 是同一个 USB 口，插原生 USB 口即可。'
  },
  {
    id: 'esp32-c3-supermini',
    name: 'ESP32-C3 SuperMini',
    family: 'esp32',
    chip: 'esp32c3',
    mcu: 'RISC-V 160MHz',
    flash: '4MB',
    build: [
      { path: 'arduino-cli', detail: 'esp32:esp32:esp32c3' },
      { path: 'platformio', detail: 'espressif32 / esp32-c3-devkitm-1' }
    ],
    fqbn: 'esp32:esp32:esp32c3',
    pioBoard: 'esp32-c3-devkitm-1',
    pioPlatform: 'espressif32',
    upload: { kind: 'usb-jtag', baud: 460800, note: 'SuperMini 用 USB CDC 串口' },
    debug: {
      link: 'builtin-usb-jtag',
      cfg: ['board/esp32c3-builtin.cfg'],
      chip: 'esp32c3',
      note: 'RISC-V，openocd 支持；调试同样走 telnet，不用 gdb'
    },
    svdChip: 'esp32c3',
    usbIds: ['0x303a:0x1001'],
    notes: '串口与 JTAG 共用同一个 USB 设备口。'
  },
  {
    id: 'esp32-s2-saola-1',
    name: 'ESP32-S2-Saola-1',
    family: 'esp32',
    chip: 'esp32s2',
    mcu: 'Xtensa LX7 单核 240MHz',
    flash: '4MB',
    build: [
      { path: 'arduino-cli', detail: 'esp32:esp32:esp32s2' },
      { path: 'platformio', detail: 'espressif32 / esp32-s2-saola-1' }
    ],
    fqbn: 'esp32:esp32:esp32s2',
    pioBoard: 'esp32-s2-saola-1',
    pioPlatform: 'espressif32',
    upload: { kind: 'serial', baud: 460800, note: 'S2 没有原生 USB-JTAG，走 UART 口' },
    debug: {
      link: 'external-stlink',
      cfg: ['interface/stlink.cfg', 'target/esp32s2.cfg'],
      chip: 'esp32s2',
      note: '需外接 ST-Link（板子只有 UART 调试口）'
    },
    svdChip: 'esp32s2',
    usbIds: ['0x303a:0x0002'],
    notes: '注意：S2 无片上 USB-JTAG，调试要外接探针。'
  },
  {
    id: 'esp32-p4-function-ev',
    name: 'ESP32-P4 Function EV',
    family: 'esp32',
    chip: 'esp32p4',
    mcu: 'RISC-V 双核 400MHz',
    flash: '16MB',
    build: [{ path: 'platformio', detail: 'espressif32 / esp32-p4-function-ev-board' }],
    pioBoard: 'esp32-p4-function-ev-board',
    pioPlatform: 'espressif32',
    upload: { kind: 'usb-jtag', baud: 460800, note: '走板载 USB' },
    debug: {
      link: 'builtin-usb-jtag',
      cfg: ['board/esp32p4-builtin.cfg'],
      chip: 'esp32p4',
      note: 'P4 芯片较新，openocd 支持内置 USB-JTAG'
    },
    svdChip: null,
    usbIds: ['0x303a:0x1001'],
    notes: 'P4 无 arduino-cli 官方 core，请用 PlatformIO 路径。'
  },
  {
    id: 'esp32-devkitc-v4',
    name: 'ESP32-DevKitC-V4',
    family: 'esp32',
    chip: 'esp32',
    mcu: 'Xtensa LX6 双核 240MHz',
    flash: '4MB',
    build: [
      { path: 'arduino-cli', detail: 'esp32:esp32:esp32' },
      { path: 'platformio', detail: 'espressif32 / esp32-devkitc-v4' }
    ],
    fqbn: 'esp32:esp32:esp32',
    pioBoard: 'esp32-devkitc-v4',
    pioPlatform: 'espressif32',
    upload: { kind: 'serial', baud: 460800, note: '经典 CP2102/CH340 串口' },
    debug: {
      link: 'external-stlink',
      cfg: ['board/esp32-wrover-kit-3.3v.cfg'],
      chip: 'esp32',
      note: '需外接 JTAG 探针（ESP32 经典款无片上 USB-JTAG）'
    },
    svdChip: 'esp32',
    usbIds: ['0x1a86:0x7523', '0x10c4:0xea60'],
    notes: '最经典的 ESP32 教学板，调试必须外接探针。'
  },
  {
    id: 'stm32-nucleo-f767zi',
    name: 'NUCLEO-F767ZI',
    family: 'stm32',
    chip: 'stm32f7',
    mcu: 'Cortex-M7 216MHz',
    flash: '2MB',
    build: [
      { path: 'platformio', detail: 'ststm32 / nucleo_f767zi / stm32cube' },
      { path: 'stm32cube', detail: 'STM32CubeIDE（外部工具，本项目只做配置与调试）' }
    ],
    pioBoard: 'nucleo_f767zi',
    pioPlatform: 'ststm32',
    upload: { kind: 'stlink', baud: 0, note: '板载 ST-Link（V2-1），接跳线即可烧' },
    debug: {
      link: 'onboard-stlink',
      cfg: ['board/st_nucleo_f7.cfg'],
      chip: 'stm32f7',
      note: 'openocd + telnet：断点/寄存器/单步全支持，不用 gdb'
    },
    svdChip: null,
    usbIds: ['0x0483:0x374b', '0x0483:0x3748', '0x0483:0x374f'],
    notes: '本项目 STM32 的首选验证板：板载 ST-Link，openocd 直接认。'
  },
  {
    id: 'stm32-nucleo-f103rb',
    name: 'NUCLEO-F103RB',
    family: 'stm32',
    chip: 'stm32f103rb',
    mcu: 'Cortex-M3 72MHz',
    flash: '128KB',
    build: [{ path: 'platformio', detail: 'ststm32 / nucleo_f103rb / stm32cube' }],
    pioBoard: 'nucleo_f103rb',
    pioPlatform: 'ststm32',
    upload: { kind: 'stlink', baud: 0, note: '板载 ST-Link' },
    debug: {
      link: 'onboard-stlink',
      cfg: ['board/st_nucleo_f103rb.cfg'],
      chip: 'stm32f103rb',
      note: 'F1 系列，openocd cfg 一条搞定'
    },
    svdChip: null,
    usbIds: ['0x0483:0x374b', '0x0483:0x3748'],
    notes: '入门性价比最高的 STM32 板。'
  },
  {
    id: 'stm32-nucleo-h743zi2',
    name: 'NUCLEO-H743ZI2',
    family: 'stm32',
    chip: 'stm32h7',
    mcu: 'Cortex-M7 480MHz',
    flash: '2MB',
    build: [{ path: 'platformio', detail: 'ststm32 / nucleo_h743zi2 / stm32cube' }],
    pioBoard: 'nucleo_h743zi2',
    pioPlatform: 'ststm32',
    upload: { kind: 'stlink', baud: 0, note: '板载 ST-Link' },
    debug: {
      link: 'onboard-stlink',
      cfg: ['board/st_nucleo_h743zi.cfg'],
      chip: 'stm32h7',
      note: 'H7 双核场景注意 openocd 的 dual bank 变体配置'
    },
    svdChip: null,
    usbIds: ['0x0483:0x374b', '0x0483:0x374f'],
    notes: 'openocd 有 h743zi 与 h7x_dual_bank 两套 cfg，按实际工程选。'
  },
  {
    id: 'stm32-nucleo-g474re',
    name: 'NUCLEO-G474RE',
    family: 'stm32',
    chip: 'stm32g4',
    mcu: 'Cortex-M4 170MHz',
    flash: '512KB',
    build: [{ path: 'platformio', detail: 'ststm32 / nucleo_g474re / stm32cube' }],
    pioBoard: 'nucleo_g474re',
    pioPlatform: 'ststm32',
    upload: { kind: 'stlink', baud: 0, note: '板载 ST-Link' },
    debug: {
      link: 'onboard-stlink',
      cfg: ['board/st_nucleo_g4.cfg'],
      chip: 'stm32g4',
      note: 'G4 带 HRTIM/ADC 新外设，调试走 openocd 常规流程'
    },
    svdChip: null,
    usbIds: ['0x0483:0x374b'],
    notes: '电机/电源控制方向常用。'
  },
  {
    id: 'stm32-bluepill-f103c8',
    name: 'Blue Pill F103C8T6',
    family: 'stm32',
    chip: 'stm32f103rb',
    mcu: 'Cortex-M3 72MHz',
    flash: '64KB',
    build: [{ path: 'platformio', detail: 'ststm32 / bluepill_f103c8 / stm32cube' }],
    pioBoard: 'bluepill_f103c8',
    pioPlatform: 'ststm32',
    upload: { kind: 'serial', baud: 115200, note: 'CH340 串口 + 手动进 bootloader（BOOT0 拉高复位）' },
    debug: {
      link: 'external-stlink',
      cfg: ['interface/stlink.cfg', 'target/stm32f1x.cfg'],
      chip: 'stm32f103rb',
      note: '没有板载探针，必须外接 ST-Link；本项目用两条 -f 组合配置'
    },
    svdChip: null,
    usbIds: ['0x1a86:0x7523'],
    notes: '板子便宜但没有板载调试器，是「外接探针链路」的标准验证对象。'
  }
]

export function listTargets(family?: BoardFamily): BoardTarget[] {
  return family ? BOARD_TARGETS.filter((t) => t.family === family) : BOARD_TARGETS
}

export function findTarget(id: string): BoardTarget | undefined {
  const s = String(id || '').trim().toLowerCase()
  return BOARD_TARGETS.find((t) => t.id === s || t.name.toLowerCase() === s)
}

/** 从 arduino-cli FQBN 反查板卡 */
export function targetForFqbn(fqbn?: string): BoardTarget | undefined {
  const s = String(fqbn || '').trim().toLowerCase()
  if (!s) return undefined
  return BOARD_TARGETS.find((t) => t.fqbn?.toLowerCase() === s)
}

/** 从 PlatformIO board id 反查板卡 */
export function targetForPioBoard(boardId?: string): BoardTarget | undefined {
  const s = String(boardId || '').trim().toLowerCase()
  if (!s) return undefined
  return BOARD_TARGETS.find((t) => t.pioBoard?.toLowerCase() === s)
}

/** 按 USB VID:PID 反查板卡（serialport 枚举到的端口信息里带 vid/pid 时用） */
export function targetForUsbId(usbId?: string): BoardTarget | undefined {
  const s = String(usbId || '').trim().toLowerCase()
  if (!s) return undefined
  return BOARD_TARGETS.find((t) => t.usbIds?.some((u) => u.toLowerCase() === s))
}

/** 该板当前推荐的第一条构建路径 */
export function primaryBuild(t: BoardTarget): { path: BuildPath; detail: string } {
  return t.build[0]
}

/**
 * 生成 platformio.ini 片段（PlatformIO 路径用）。
 * 只写必要项，缺省参数一律注释掉，避免生成一堆用户没要求的配置。
 */
export function buildPlatformioIni(t: BoardTarget, opts: { env?: string; monitorSpeed?: number } = {}): string {
  const env = opts.env || t.id.replace(/-/g, '_')
  const monitor = opts.monitorSpeed ?? (t.family === 'esp32' ? 115200 : 115200)
  const upload = t.upload.kind === 'serial' ? `\nupload_port = /dev/ttyUSB0` : ''
  return `; 由 CodeLab「硬件目标」面板生成（${t.name}）
[env:${env}]
platform = ${t.pioPlatform || 'espressif32'}
board = ${t.pioBoard || t.id}
framework = ${t.family === 'esp32' ? 'arduino' : 'stm32cube'}
monitor_speed = ${monitor}${upload}
; upload_port 需要按实际端口改（面板可自动探测后回填）
`
}

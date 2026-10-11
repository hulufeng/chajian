// 编译/烧录错误结构化分类（P1-8）
// 把 arduino-cli / gcc / esptool / idf.py(CMake+ninja) 的原始输出解析成
//「分类 + 文件 + 行号 + 可执行修复建议」，
// 供 ①Agent 的 compile/upload 工具返回结构化结果 ②UI「一键 AI 诊断」捕获更精准的上下文。
// 纯本地解析，不联网，无第三方依赖。
//
// P1-10：已覆盖 ESP-IDF 路径。ESP-IDF 规则必须排在 arduino 规则之前——两者报错文本
//（undefined reference / fatal error）大量重叠，但修复动作不同（装 IDF 组件 vs 装 arduino 库）。

export type DiagnosticCategory =
  | 'missing_include' // 头文件不存在 → 多半缺库或 FQBN 选错
  | 'undefined_reference' // 链接期符号未定义 → 缺库/函数未实现
  | 'undeclared_symbol' // 标识符未声明 → 拼错/作用域/缺宏
  | 'type_error' // 类型/转换/重载匹配失败
  | 'syntax_error' // 语法错误
  | 'multiple_definition' // 重复定义
  | 'board_platform' // 板卡/平台未安装或 FQBN 非法
  | 'sketch_invalid' // sketch 结构不合法（缺主文件等）
  | 'port_error' // 串口打不开/被占用
  | 'flash_error' // esptool/烧录握手失败
  | 'toolchain_missing' // 工具链缺失
  | 'permission' // 权限/只读/占用
  | 'warning' // 警告（deprecated / unused 等）
  | 'missing_library' // 链接器找不到 -lXXX（库未安装/未参与链接）
  | 'size_overflow' // 固件超出芯片容量（分区/PSRAM/裁剪）
  | 'other'

export interface BuildDiagnostic {
  category: DiagnosticCategory
  severity: 'error' | 'warning'
  /** 分类中文名，便于人读 */
  label: string
  /** 去掉文件行号前缀后的消息正文 */
  message: string
  file?: string
  line?: number
  column?: number
  /** 针对本条错误的具体修复建议 */
  hint: string
  /** 原始行（已去首尾空白） */
  raw: string
}

export interface BuildReport {
  ok: boolean
  errorCount: number
  warningCount: number
  errors: BuildDiagnostic[]
  warnings: BuildDiagnostic[]
  /** 编译器的提示级输出（note / #pragma message / 上下文行）——不是错误，但会让人误判 */
  noteCount: number
  /** 已知无害的平台提示（命中已知库），UI 可折叠 */
  knownNotes: BuildNote[]
  /** 去重后的可执行修复动作（如 arduino-cli lib install "xxx"） */
  suggestions: string[]
  summary: string
}

export interface BuildNote {
  file?: string
  line?: number
  text: string
  /** 命中已知提示库 → UI 标「已知平台提示，可忽略」 */
  known: boolean
  label?: string
}

// ============================================================
//  编译阶段 / 资源用量（让「编译过程」可见）
// ============================================================

/**
 * 构建阶段。刻意**不给百分比**：arduino-cli / esptool 都不输出可靠的百分比，
 * 拿「已用时 + 阶段序号」表达进度比编造一个 0-100 更诚实。
 */
export type BuildStage = 'prepare' | 'sketch' | 'libs' | 'link' | 'image' | 'done' | 'flashing' | 'flashed'

export const STAGE_LABEL: Record<BuildStage, string> = {
  prepare: '准备',
  sketch: '编译草图',
  libs: '编译库',
  link: '链接',
  image: '生成二进制',
  done: '完成',
  flashing: '烧录中',
  flashed: '烧录完成'
}

/** 阶段推进顺序（用于阶段条渲染；flashing 之后不再顺序推进） */
export const STAGE_ORDER: BuildStage[] = ['prepare', 'sketch', 'libs', 'link', 'image', 'done']

// ============================================================
//  烧录阶段进度（让「写入过程」可见）
// ============================================================

export interface FlashProgress {
  /** 短阶段名：连接 / 擦除 / 写入 / 校验 / 复位 */
  stage: 'connect' | 'erase' | 'write' | 'verify' | 'reset' | 'done'
  /** 给用户看的阶段文案（含端口等上下文） */
  label: string
  /**
   * esptool 自己打印的写入百分比（0-100）。
   * 与编译阶段不同：烧录这里 **工具真的给了数字**（Writing at 0x... (62 %)），
   * 直接用它，既不编造也不假装没有。没给就是 null。
   */
  percent: number | null
}

const FLASH_STAGE_TEXT: Record<FlashProgress['stage'], string> = {
  connect: '连接芯片',
  erase: '擦除 Flash',
  write: '写入固件',
  verify: '校验',
  reset: '复位运行',
  done: '烧录完成'
}

/**
 * 从 esptool 流式输出里解析出「正在干什么 + 写到百分之几」。
 *
 * 只对 esptool 的真实输出做匹配（Connecting… / Chip erase / Writing at 0x.. (nn %) /
 * Hash of data verified / Hard resetting via RTS pin），命中不到就返回 null，
 * 由调用方保持上一帧的阶段，不做猜测推进。
 */
export function parseFlashProgress(text: string, port?: string): FlashProgress | null {
  const t = text || ''
  if (!t.trim()) return null
  const tail = port ? ` · ${port}` : ''

  // 百分比：Writing at 0x0000e000... (62 %)
  // label 里**不拼百分比**：界面上有专门的进度条 + 数字在显示它，
  // 拼进来就是同一个数字在屏幕上出现两遍（"写入固件 62% · COM7" + "62%"），看着像渲染错乱。
  const writeMatch = t.match(/Writing at\s+0x[0-9a-f]+[^\n]*?\((\d+)\s*%\)/i)
  if (writeMatch) {
    const percent = Math.max(0, Math.min(100, Number(writeMatch[1])))
    return {
      stage: 'write',
      label: `${FLASH_STAGE_TEXT.write}${tail}`,
      percent
    }
  }
  if (/Wrote\s+\d+\s+bytes/i.test(t)) {
    return { stage: 'write', label: `${FLASH_STAGE_TEXT.write}${tail}`, percent: 100 }
  }
  // 真实输出首行在不同版本里长得不一样（esptool.py v4.x / esptool v5.x / Serial port COM1），
  // 都归到"连接芯片"，让界面从第一帧就有反馈
  if (/(^|\s)esptool(\.py)?\s+v?\d|connecting|Serial port/i.test(t) && !/Hard resetting/i.test(t)) {
    return { stage: 'connect', label: `${FLASH_STAGE_TEXT.connect}${tail}`, percent: null }
  }
  if (/Chip erase|Erasing flash|erase/i.test(t)) {
    return { stage: 'erase', label: `${FLASH_STAGE_TEXT.erase}${tail}`, percent: null }
  }
  if (/Hash of data verified|Verifying/i.test(t)) {
    return { stage: 'verify', label: `${FLASH_STAGE_TEXT.verify}${tail}`, percent: null }
  }
  if (/Hard resetting via RTS pin|Leaving\.\.\.|Staying in bootloader/i.test(t)) {
    return { stage: 'reset', label: `${FLASH_STAGE_TEXT.reset}${tail}`, percent: null }
  }
  return null
}

/**
 * 从输出文本推断当前阶段（取最后命中的那一条）。
 * 只认 arduino-cli / esptool 的真实输出，不做猜测式推进。
 */
export function parseBuildStage(text: string): BuildStage {
  const t = text || ''
  let stage: BuildStage = 'prepare'
  const has = (re: RegExp): boolean => re.test(t)
  // 分支顺序 = 时间倒序（越靠后发生的阶段判得越优先）。
  // 因为吃的是**累积日志**，日志里会同时含前后两个阶段的行，只能靠优先级取最晚那个。
  // 顺序必须对着 arduino-cli 的真实输出排：编译草图 → 编译库 → 链接 → 生成二进制 → 用量行。
  // （原来把 link 排在 image 前面，导致「生成二进制」这一格永远跳不过去——日志一旦出现
  //   Linking 就一直命中 link，image 分支成了死代码。）
  if (has(/Sketch uses \d+ bytes|Global variables use|项目使用|编译完成/i)) stage = 'done'
  else if (has(/Generating binary image|Creating BIN|\.bin.*file|Generating .*\.elf/i)) stage = 'image'
  else if (has(/Linking everything together/i)) stage = 'link'
  else if (has(/Compiling librar|Compiling dependenc/i)) stage = 'libs'
  else if (has(/Compiling sketch|\.ino\.cpp|Compiling .*\.cpp/i)) stage = 'sketch'
  // 烧录阶段（esptool）优先级最高：它发生在编译之后
  if (has(/esptool|Writing at|Hash of data verified|Hard resetting via RTS pin/i)) {
    return has(/Hard resetting via RTS pin|Hash of data verified/i) ? 'flashed' : 'flashing'
  }
  return stage
}

export interface UsageSummary {
  flashBytes: number
  flashPercent: number
  ramBytes: number
  ramPercent: number
  /** 完整原始两行，便于 hover 查看 */
  rawFlash: string
  rawRam: string
}

const FLASH_RE = /Sketch uses (\d+) bytes \(([\d.]+)%\) of program storage space/i
const FLASH_RE_ALT = /项目使用的.*?(\d+) bytes.*?\(([\d.]+)%\)/i
const RAM_RE = /Global variables use (\d+) bytes \(([\d.]+)%\) of dynamic memory/i

/**
 * 解析编译产物资源占用。arduino-cli 的成功输出固定给这两行，
 * 解析出来做成摘要卡，比让用户自己在日志里找要省事。
 */
export function parseUsageSummary(text: string): UsageSummary | null {
  const t = text || ''
  const mf = t.match(FLASH_RE) || t.match(FLASH_RE_ALT)
  const mr = t.match(RAM_RE)
  if (!mf && !mr) return null
  return {
    flashBytes: mf ? Number(mf[1]) : 0,
    flashPercent: mf ? Number(mf[2]) : 0,
    ramBytes: mr ? Number(mr[1]) : 0,
    ramPercent: mr ? Number(mr[2]) : 0,
    rawFlash: mf ? mf[0] : '',
    rawRam: mr ? mr[0] : ''
  }
}

/** 字节数 → 人类可读（KB/MB） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 单行输出分类：给 UI 着色用。error 才是真正需要处理的问题。 */
export type OutputLineKind = 'error' | 'warning' | 'note' | 'context' | 'success' | 'plain'

/**
 * 给原始输出行分类，供输出窗口逐行着色。
 * 为什么需要：编译器把「错误」「警告」「提示」「上下文」全打在同一个纯文本框里，
 * 用户看到一堆 `In file included from ...` 会以为编译失败（实际只是提示）。
 */
export function classifyOutputLine(raw: string): OutputLineKind {
  const s = (raw || '').trim()
  if (!s) return 'plain'
  if (/:\s*(fatal error|error)\s*:/i.test(s) || /^error(\s|:)/i.test(s) || /^Error during build/i.test(s)) {
    return 'error'
  }
  if (/:\s*warning\s*:/i.test(s) || /^warning(\s|:)/i.test(s)) return 'warning'
  // gcc 代码框里的纯光标行（`      |          ^~~~~~`）不含数字行前缀，
  // 前面那条规则吃不到 → 会落成 plain（默认色）。它属于错误上下文，应该跟提示一样灰着。
  // 放在 error/warning/note 判定之后，不可能抢走真正的诊断行。
  if (/^[\s|~^.:+\-*]*\^[\s^~.:+\-*|]*$/.test(s)) return 'context'
  if (/^In file included from\b/i.test(s) || /^\s*(from|.*\d+\s*\|)/.test(s) && /\^/.test(s)) return 'context'
  if (/:\s*note\s*:/i.test(s) || /#pragma\s+message/i.test(s) || /^note\s*:/i.test(s)) return 'note'
  if (/^(✓|✔|Success|成功)/i.test(s)) return 'success'
  return 'plain'
}

/** 已知无害的平台提示（用户常来问「这是不是错误」） */
const KNOWN_NOTES: Array<{ re: RegExp; label: string }> = [
  { re: /BT: forcing BR\/EDR max sync conn eff to 1/i, label: 'ESP32 经典蓝牙栈提示' },
  { re: /#pragma message\(".*Skipping.*"\)/i, label: 'ESP32 平台提示' },
  { re: /this use of \w+ is deprecated/i, label: 'API 弃用提示（仍可编译）' },
  { re: /multiple definition of .*select\(\)/i, label: '新 IDF 头文件与旧宏重复（无害）' },
  { re: /Multiple libraries were found for/i, label: '多个库冲突（编译器自动选一个，如需指定优先库可在库管理卸载冲突库）' }
]

const CATEGORY_LABEL: Record<DiagnosticCategory, string> = {
  missing_include: '缺少头文件',
  undefined_reference: '链接错误（符号未定义）',
  undeclared_symbol: '标识符未声明',
  type_error: '类型错误',
  syntax_error: '语法错误',
  multiple_definition: '重复定义',
  board_platform: '板卡/平台问题',
  sketch_invalid: '工程结构不合法',
  port_error: '串口打开失败',
  flash_error: '烧录失败',
  toolchain_missing: '工具链缺失',
  permission: '权限/占用',
  warning: '警告',
  missing_library: '链接库缺失（-l 未找到）',
  size_overflow: '固件超出容量',
  other: '其他错误'
}

/** 常见头文件 → 库名 / 归属提示。用于「缺少头文件」时给出可执行的安装命令。 */
interface HeaderHint {
  re: RegExp
  /** 需要 arduino-cli 安装的库名；为空表示平台内置 */
  lib?: string
  /** 额外说明（内置库时提示检查 FQBN） */
  note?: string
}
const HEADER_HINTS: HeaderHint[] = [
  { re: /^WiFi(Client|Server|UDP|Multi)?\.h$/i, note: 'ESP32 / ESP8266 平台内置，一般不是缺库——请确认 FQBN 选对了芯片平台（如 esp32:esp32:esp32s3），且平台已安装。' },
  { re: /^(BLEDevice|BLEServer|BLEUtils|BLE2902)\.h$/i, note: 'ESP32 平台内置 BLE 库，请确认 FQBN 为 ESP32 且已安装 esp32:esp32 平台。' },
  { re: /^(HTTPClient|WebServer|Preferences|ESP32Servo|ESPmDNS|Update|esp_now|esp_wifi)\.h$/i, note: 'ESP32 平台内置，请确认 FQBN 与平台安装状态。' },
  { re: /^(Wire|SPI|EEPROM|Servo|SD|FS|LittleFS)\.h$/i, note: 'Arduino 内置库，若缺失多为平台未安装或 FQBN 错误。' },
  { re: /^(ESPAsyncWebServer|AsyncTCP|AsyncUDP)\.h$/i, lib: 'ESPAsyncWebServer', note: '异步服务器需同时装 ESPAsyncWebServer 与 AsyncTCP（ESP32）。' },
  { re: /^ArduinoJson\.h$/i, lib: 'ArduinoJson' },
  { re: /^DHT(_U)?\.h$/i, lib: 'DHT sensor library', note: '若用 DHT_U 还需装 Adafruit Unified Sensor。' },
  { re: /^Adafruit_SSD1306\.h$/i, lib: 'Adafruit SSD1306', note: '依赖 Adafruit GFX Library，通常会自动带装。' },
  { re: /^Adafruit_GFX\.h$/i, lib: 'Adafruit GFX Library' },
  { re: /^Adafruit_NeoPixel\.h$/i, lib: 'Adafruit NeoPixel' },
  { re: /^(Adafruit_Sensor|Adafruit_Unified_Sensor)\.h$/i, lib: 'Adafruit Unified Sensor' },
  { re: /^U8g2lib\.h$/i, lib: 'U8g2' },
  { re: /^U8x8lib\.h$/i, lib: 'U8g2' },
  { re: /^LiquidCrystal_I2C\.h$/i, lib: 'LiquidCrystal I2C' },
  { re: /^PubSubClient\.h$/i, lib: 'PubSubClient' },
  { re: /^OneWire\.h$/i, lib: 'OneWire' },
  { re: /^DallasTemperature\.h$/i, lib: 'DallasTemperature', note: '依赖 OneWire。' },
  { re: /^TFT_eSPI\.h$/i, lib: 'TFT_eSPI', note: '需在库的 User_Setup.h 里配置屏幕驱动与引脚。' },
  { re: /^LoRa\.h$/i, lib: 'LoRa' },
  { re: /^RCSwitch\.h$/i, lib: 'rc-switch' },
  { re: /^MFRC522\.h$/i, lib: 'MFRC522' },
  { re: /^TinyGPS(Plus)?(\+\+)?\.h$/i, lib: 'TinyGPSPlus' },
  { re: /^FastLED\.h$/i, lib: 'FastLED' },
  { re: /^NTPClient\.h$/i, lib: 'NTPClient' },
  { re: /^ESP32Encoder\.h$/i, lib: 'ESP32Encoder' },
  { re: /^NewPing\.h$/i, lib: 'NewPing' },
  { re: /^IRremote\.h$/i, lib: 'IRremote' },
  { re: /^AccelStepper\.h$/i, lib: 'AccelStepper' },
  { re: /^(lvgl|lv_conf)\.h$/i, lib: 'lvgl' }
]

const ESP_IDF_HEADERS = /^(esp_|driver\/|freertos\/|nvs_|soc\/|hal\/|lwip\/|mbedtls\/|esp_event|esp_log|esp_timer|esp_netif|esp_pm|esp_sleep)/i

function headerHint(name: string): { lib?: string; note?: string } {
  const base = name.replace(/^.*[\\/]/, '')
  for (const h of HEADER_HINTS) {
    if (h.re.test(base)) return { lib: h.lib, note: h.note }
  }
  if (ESP_IDF_HEADERS.test(name)) {
    return { note: '这是 ESP-IDF 头文件。Arduino 工程里不应直接包含——请改用 Arduino API，或把工程切到 ESP-IDF 框架。' }
  }
  return {}
}

interface Rule {
  re: RegExp
  category: DiagnosticCategory
  hint: string | ((m: RegExpMatchArray) => string)
}

// 顺序敏感：越具体的规则越靠前
const RULES: Rule[] = [
  // ══════════════ ESP-IDF（idf.py / CMake / ninja）══════════════
  // 必须排在 arduino 规则之前：IDF 的报错文本与 gcc 通用错误大量重叠
  // （如 undefined reference / fatal error），但修复动作完全不同
  // （装 ESP-IDF 组件 vs 装 arduino 库）。排在后面会被 arduino 规则抢走，
  // 给出「装 arduino-cli」的误导建议。
  {
    re: /CMAKE_(?:ASM|C|CXX)_COMPILER:\s*(\S+)\s*is not a full path and was not found in the PATH/i,
    category: 'toolchain_missing',
    hint: (m) =>
      `ESP-IDF 交叉编译器 ${m[1] || ''} 不在 PATH 中 —— 这不是代码问题，是 ESP-IDF 的 tools 目录没被注入子进程环境。` +
      '修复方向：让 toolsPath 指向真实工具根（如 C:\\Espressif\\tools，注意它本身就是工具根、下面直接是 cmake/ninja/xtensa-*，别再拼一层 tools），' +
      '必要时在 ESP-IDF 官方终端里跑 idf.py --version 确认环境本身正常。'
  },
  {
    re: /(Failed to resolve component|Could not find component|component\s+['"][^'"]+['"]\s+(?:not\s+found|does\s+not\s+exist))/i,
    category: 'board_platform',
    hint: (m) =>
      `ESP-IDF 组件解析失败：${m[0]}。通常是 CMakeLists.txt 里 set(EXTRA_COMPONENT_DIRS ...) 或 idf_component_register 引用的组件名/目录不存在。检查：①路径拼写 ②该组件目录是否真的存在 ③ESP-IDF 版本是否包含该组件。`
  },
  {
    re: /(IDF_TARGET is not set|Could not detect the target|target\s+['"][^'"]+['"]\s+is\s+not\s+supported)/i,
    category: 'board_platform',
    hint: 'ESP-IDF 没确定目标芯片：在「硬件目标」面板用「应用目标芯片」显式设置 target（会写入 sdkconfig 的 CONFIG_IDF_TARGET），或在 sdkconfig.defaults 里加 CONFIG_IDF_TARGET="esp32s3"。'
  },
  {
    re: /(was generated for target\s+'[^']*'\s*,?\s*but CMakeCache\.txt contains|run 'idf\.py fullclean')/i,
    category: 'other',
    hint: 'sdkconfig 与 CMake 缓存里的目标芯片不一致（改了 target / 改了分区表 / 用 Kconfig 编辑器改过 sdkconfig 后常见）。修复动作：idf.py fullclean 后重新构建——它会重建 CMakeCache.txt。这是状态不同步，不是代码错误。'
  },
  {
    re: /(ninja:\s*build stopped|CMake Error at|Failed executing|command terminated with non-zero|Error:\s+Python script.*failed)/i,
    category: 'other',
    hint: 'ESP-IDF 构建在 CMake / Ninja 阶段中止，真正的错误在它上面的若干行。往上翻找第一条 error: 或 CMake Error；若上方是「编译器不在 PATH」，按工具链那条处理。也可能是上一次的 CMake 缓存脏了，用 idf.py fullclean 后重来。'
  },
  {
    re: /(Project configuration error|Failed to load SDK config|sdkconfig[^:\n]{0,40}(?:error|invalid|missing))/i,
    category: 'other',
    hint: 'sdkconfig 有问题：通常被手工改坏或与当前 idf.py 版本不匹配。建议 idf.py fullclean 后重新 configure，或用「Kconfig 编辑器 / menuconfig 终端」改回合法值。'
  },
  {
    re: /(Failed to open\s+COM\d+|could not open port|Access is denied[^.\n]*COM\d+|cannot open[^.\n]*COM\d+|Permission denied[^.\n]*tty|Serial port busy)/i,
    category: 'port_error',
    hint: '串口打不开。依次检查：①串口是否被串口监视器/其他程序占用（先关掉占用它的面板）②驱动是否安装（CH340/CP210x/CP2104）③端口号是否还是当前那个——设备重插后端口号常变，用「自动探测」重新选。'
  },
  {
    re: /(Failed to connect to ESP\d+|No serial data received|invalid head of packet|Wrong boot mode|Failed to write target memory|EsptoolFailedToWrite|Target is not responding)/i,
    category: 'flash_error',
    hint: '烧录失败（握手/下载模式问题）。①CH340 板子要走 UART0(TX/RX)，不是原生 USB 口 ②按住 BOOT 键上电再松开，或在板子上电瞬间点烧录 ③复位板子后重试 ④确认固件没超过 flash 容量（Flash Size 设小了也会失败）。'
  },
  // ── 缺失头文件 ──
  {
    re: /fatal error:\s*([^:]+):\s*No such file or directory/i,
    category: 'missing_include',
    hint: (m) => {
      const header = (m[1] || '').trim().replace(/[<>"]/g, '')
      const { lib, note } = headerHint(header)
      if (lib) return `缺少库：安装命令 arduino-cli lib install "${lib}"（也可在左侧「库管理」面板搜索安装）。${note ? ' ' + note : ''}`
      return `找不到头文件 ${header}。${note || '请确认：①库是否已安装 ②#include 拼写与大小写 ③FQBN 是否选对平台（不同芯片的库不通用）。'}`
    }
  },
  // ── 板卡 / 平台 ──
  {
    re: /(Board\s+[^\s]+\s+not found|platform\s+[^\s]+\s+is\s+not\s+installed|Error:\s*Unknown FQBN|Invalid FQBN|no matching board|Platform .* not installed)/i,
    category: 'board_platform',
    hint: 'FQBN 无效或对应平台未安装。安装命令：arduino-cli core install esp32:esp32（ESP32）/ arduino-cli core install arduino:avr（UNO）。装完后用 board listall 复核 FQBN。'
  },
  // ── 工程结构 ──
  {
    re: /(main file missing|Can't find the sketch|Invalid sketch|no sketch file found|sketch .* not found)/i,
    category: 'sketch_invalid',
    hint: 'Arduino 要求 sketch 目录名与主文件同名（如 Blink/Blink.ino）。请把 .ino 放进同名目录，或在项目根创建 <工程名>/<工程名>.ino。'
  },
  // ── 链接错误 ──
  {
    re: /undefined reference to\s*[`']?([^`'\s]+)/i,
    category: 'undefined_reference',
    hint: (m) =>
      `链接期找不到符号 ${m[1] || ''}。常见原因：①声明了函数/变量但没实现 ②用了库的函数但库未安装或未参与编译 ③C/C++ 混编缺少 extern "C"。先确认该符号来自哪个库并安装它，或补上实现。`
  },
  {
    re: /multiple definition of\s*[`']?([^`'\s]+)/i,
    category: 'multiple_definition',
    hint: '同一符号被定义了多次：检查是否把变量/函数定义写进了 .h 头文件（应改为 extern 声明 + 单点定义），或是否重复包含了源文件。'
  },
  // ── 语法 ──
  {
    re: /expected\s+(['"`]?[^'`"]+['"`]?)\s+(before|after|at end of input)/i,
    category: 'syntax_error',
    hint: '语法错误：多半是括号/花括号/分号不匹配，或上一行漏了分号。定位报错行并向上检查最近的括号对。'
  },
  {
    re: /(stray\s+'[^']*'\s+in program|unqualified-id|expected declaration)/i,
    category: 'syntax_error',
    hint: '语法错误：常见为中文标点混入代码（如中文引号、中文分号）、宏定义末尾多余分号、或关键字拼写错误。'
  },
  // ── 类型 ──
  {
    re: /(cannot convert|invalid conversion|no matching function for call to|invalid initialization of|no match for)/i,
    category: 'type_error',
    hint: '类型不匹配：核对函数签名与实参类型（String vs char*、int vs uint8_t 等），必要时显式转换或改用正确重载。'
  },
  {
    re: /(was not declared in this scope|has not been declared|is not a member of|no member named)/i,
    category: 'undeclared_symbol',
    hint: '标识符未声明：检查拼写与大小写、变量作用域、头文件是否已包含、以及该类/结构体是否真有这个成员（不同版本库 API 会变）。'
  },
  // ── 烧录 / 端口 ──
  {
    re: /(Permission denied|Access is denied|resource busy|device is busy)/i,
    category: 'permission',
    hint: '权限/占用：端口或文件被占用。关闭占用进程（串口助手、PlatformIO 监视器、arduino 串口监视器），或以管理员权限重试。'
  },
  {
    re: /(can't open device|could not open port|cannot open port|Failed to open|No such file or directory:\s*['"]?(COM|\/dev\/))/i,
    category: 'port_error',
    hint: '串口打不开：端口被串口监视器/其他程序占用、板子未连接或驱动未装。先关闭串口监视器与占用程序，重新插拔确认端口号，再烧录。'
  },
  {
    re: /(collect2[^:]*:\s*error:\s*ld returned|ld returned \d+ exit status)/i,
    category: 'undefined_reference',
    hint: '链接阶段失败：编译通过但链接器无法拼出可执行文件。向上看同一段输出里的 "undefined reference to xxx"，那才是缺失的符号——通常是库没装或函数只声明未实现。'
  },
  {
    // "Failed to connect" 留成可选项：esptool 的规范行是 `Failed to connect to ESP32: Timed…`，
    // 但不同版本/波特率失败时也会只打 `Failed to connect` 直接收尾。
    re: /(Failed to connect(?: to [^:]+)?|Wrong boot mode detected|Timed out waiting for packet (header|content)|Invalid head of packet|A fatal error occurred|Failed to enter.*download mode)/i,
    category: 'flash_error',
    hint: '烧录握手失败（esptool）：①确认选对端口 ②下载模式下需按住 BOOT 键再点烧录，或手动进入下载模式 ③降低波特率（--upload-speed 115200）④检查 USB 线是否只充电不传数据 ⑤串口监视器占着端口会挡住烧录。'
  },
  // ── 工具链 ──
  {
    // 注意 `:` 与空白都得可选：真实输出是 `xtensa-esp32-elf-gcc: command not found`
    // （sh 那条链上还会先出来 `sh: 1: xtensa-esp32-elf-gcc: not found`）。
    // 原来写成 `[^:\n]*(not found…)`，跨不过工具名后的那个冒号 → 这条规则永远匹配不到。
    re: /(arduino-cli|avr-gcc|xtensa-esp[0-9a-z-]*-elf-gcc)\b\s*:?\s*(not found|is not recognized|command not found)/i,
    category: 'toolchain_missing',
    hint: '工具链缺失：在「设置 → 工具链」点一键安装 arduino-cli，或手动安装后配置路径。'
  },
  // ── 链接库缺失（ld 找不到 -lXXX） ──
  {
    re: /(ld: )?cannot find -l(\S+)/i,
    category: 'missing_library',
    hint: (m) =>
      `链接器找不到库 -l${m[2] || ''}：该库未安装或未参与链接。Arduino 第三方库若含 .c/.cpp 会被自动链；` +
      '若用平台/外部库请确认：①库已安装 ②FQBN/平台正确 ③PlatformIO/IDF 的 lib_deps 已声明。可试 arduino-cli lib install 安装对应库。'
  },
  // ── 固件超出芯片容量 ──
  {
    re: /(region\s+'[^']+'\s+overflowed by|section\s+'[^']+'\s+will not fit|Sketch too big|'\S+'\s+segment data does not fit|available space is not enough|DRAM segment data does not fit)/i,
    category: 'size_overflow',
    hint: '固件超出芯片容量：①用分区表编辑器扩大 app 分区（如 default_8MB / 自定义分区）②删减不用的库与功能 ③降低日志/缓冲区 ④ESP32 可改 Flash 大小或开启 PSRAM。'
  }
]

// 单行匹配：`file:line:col: error: msg` / `file:line: error: msg`
// 兼容 Windows 绝对路径（C:\xxx\main.ino:5:10: error: …）
const LOC_RE = /^(.*?):(\d+):(?:\s*(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/
// 宽松版：连 note / info 行一起匹配（只用于给提示定位，不参与 error/warning 判定）
const LOC_ANY_RE = /^(.*?):(\d+):(?:\s*(\d+):)?\s*(fatal error|error|warning|note|info):\s*(.+)$/i

function classifyLine(raw: string): { file?: string; line?: number; column?: number; severity: 'error' | 'warning' | null; body: string } {
  const m = raw.match(LOC_RE)
  if (m) {
    const sev = /^fatal/i.test(m[4]) || m[4] === 'error' ? 'error' : 'warning'
    return {
      file: m[1].trim(),
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : undefined,
      severity: sev,
      body: m[5].trim()
    }
  }
  return { severity: null, body: raw }
}

function matchRule(body: string): { category: DiagnosticCategory; hint: string } | null {
  for (const r of RULES) {
    const m = body.match(r.re)
    if (m) {
      return { category: r.category, hint: typeof r.hint === 'function' ? r.hint(m) : r.hint }
    }
  }
  return null
}

/** 无行号前缀的兜底规则（arduino-cli / esptool 自己打的整行错误） */
function matchRawLine(raw: string): { category: DiagnosticCategory; hint: string } | null {
  for (const r of RULES) {
    const m = raw.match(r.re)
    if (m) return { category: r.category, hint: typeof r.hint === 'function' ? r.hint(m) : r.hint }
  }
  return null
}

const NOISE_RE = /^(Error:\s*exit status|exit status \d+|compilation terminated\.|Error during build|\[错误\] 工程文件不存在)/i

/** 解析编译/烧录原始输出，产出结构化报告。 */
export function parseBuildOutput(text: string): BuildReport {
  const errors: BuildDiagnostic[] = []
  const warnings: BuildDiagnostic[] = []
  const notes: BuildNote[] = []
  const lines = (text || '').split(/\r?\n/)

  for (const raw0 of lines) {
    const raw = raw0.trim()
    if (!raw) continue
    if (NOISE_RE.test(raw)) continue

    const { file, line, column, severity, body } = classifyLine(raw)
    const hit = matchRule(body) || matchRawLine(raw)

    // 仅 error 行 / 命中规则的原始行才进入诊断；普通输出行忽略
    if (severity === 'error') {
      const cat = hit?.category ?? 'other'
      errors.push({
        category: cat,
        severity: 'error',
        label: CATEGORY_LABEL[cat],
        message: body.length > 300 ? body.slice(0, 300) + '…' : body,
        file,
        line,
        column,
        hint: hit?.hint ?? '未匹配到已知错误模式。请把该行连同上下文一起排查，或直接把完整输出交给 AI 诊断。',
        raw
      })
      continue
    }
    if (severity === 'warning') {
      const cat = hit?.category ?? 'warning'
      warnings.push({
        category: cat,
        severity: 'warning',
        label: CATEGORY_LABEL[cat],
        message: body.length > 200 ? body.slice(0, 200) + '…' : body,
        file,
        line,
        column,
        hint: hit?.hint ?? '警告不阻断编译，但可能预示运行时问题（类型截断、弃用 API、未使用变量）。',
        raw
      })
      continue
    }
    // 无位置信息，但命中了明确的错误签名（如 esptool / arduino-cli / 链接器 的整行报错）。
    // undefined_reference / multiple_definition 是强签名，无需再要求行内含 "error" 字样。
    // #8 收尾：缺库链接（ld: cannot find -lX）与固件超容量（region ... overflow / Sketch too big）
    // 同样没有 error 关键字，但确属编译失败，一并列为强签名。
    const strongSignature =
      hit?.category === 'undefined_reference' ||
      hit?.category === 'multiple_definition' ||
      hit?.category === 'missing_library' ||
      hit?.category === 'size_overflow'
    if (hit && (strongSignature || /error|fatal|failed|not found|denied|Timed out/i.test(raw))) {
      errors.push({
        category: hit.category,
        severity: 'error',
        label: CATEGORY_LABEL[hit.category],
        message: raw.length > 300 ? raw.slice(0, 300) + '…' : raw,
        hint: hit.hint,
        raw
      })
      continue
    }

    // 已知无害提示（ESP32 蓝牙栈那类）通常没有 `file:line: note:` 前缀，
    // classifyOutputLine 会判成 plain —— 不在这里接住就直接丢了，KNOWN_NOTES 永远匹配不到，
    // 「已知平台提示，可忽略」这个特性等于没做。命中就按提示收集（UI 可折叠）。
    const knownOnly = KNOWN_NOTES.find((k) => k.re.test(raw))
    if (knownOnly) {
      notes.push({
        text: raw.length > 240 ? raw.slice(0, 240) + '…' : raw,
        known: true,
        label: knownOnly.label
      })
      continue
    }

    // 到这里说明这行不是错误。提示级输出（note / #pragma message / 编译上下文）
    // 单独收集：它们不会阻断编译，但混在纯文本输出里最容易被误判成「编译失败」。
    const kind = classifyOutputLine(raw)
    if (kind === 'note' || kind === 'context') {
      const known = KNOWN_NOTES.find((k) => k.re.test(raw))
      const m2 = raw.match(LOC_ANY_RE)
      notes.push({
        file: m2?.[1]?.trim(),
        line: m2?.[2] ? Number(m2[2]) : undefined,
        text: raw.length > 240 ? raw.slice(0, 240) + '…' : raw,
        known: !!known,
        label: known?.label
      })
    }
  }

  // 同类错误去重（同 category + 同 message 只保留一条）
  const dedupe = (list: BuildDiagnostic[]): BuildDiagnostic[] => {
    const seen = new Set<string>()
    const out: BuildDiagnostic[] = []
    for (const d of list) {
      const key = `${d.category}|${d.file || ''}|${d.line || ''}|${d.message.slice(0, 120)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(d)
    }
    return out
  }
  // 链接器收尾行（collect2 … ld returned 1）在有具体 undefined reference 时是冗余的，去掉避免干扰
  const hasRealLinkError = errors.some(
    (d) => d.category === 'undefined_reference' && !/(collect2|ld returned)/i.test(d.raw)
  )
  const errs = dedupe(hasRealLinkError ? errors.filter((d) => !/(collect2|ld returned)/i.test(d.raw)) : errors)
  const warns = dedupe(warnings)

  const suggestions: string[] = []
  const seenSug = new Set<string>()
  const addSug = (s: string): void => {
    if (!s || seenSug.has(s)) return
    seenSug.add(s)
    suggestions.push(s)
  }
  for (const e of errs) {
    // 提取可执行的修复命令片段：
    //   ① arduino-cli lib/core install "xxx"
    //   ② idf.py <子命令>（fullclean / reconfigure / set-target / --version …）
    // 引号形式整体取；否则只取 ASCII 标识符部分，避免把中文说明截进命令
    const cmd =
      e.hint.match(/(arduino-cli\s+(?:lib|core)\s+install\s+(?:"[^"]+"|[A-Za-z0-9_:.\-]+))/i) ??
      e.hint.match(/(idf\.py\s+(?:fullclean|reconfigure|set-target|build|flash|menuconfig|--version)\b)/i)
    if (cmd) addSug(cmd[1])
  }

  const summary = errs.length === 0
    ? warns.length === 0
      ? notes.length
        ? `无错误与警告（${notes.length} 条平台提示可忽略）`
        : '无错误与警告'
      : `无错误，${warns.length} 条警告`
    : `${errs.length} 条错误${warns.length ? `，${warns.length} 条警告` : ''}`

  return {
    ok: errs.length === 0,
    errorCount: errs.length,
    warningCount: warns.length,
    errors: errs,
    warnings: warns,
    noteCount: notes.length,
    knownNotes: notes.filter((n) => n.known),
    suggestions,
    summary
  }
}

/** 格式化为给 UI / AI 看的可读文本。 */
export function formatBuildReport(report: BuildReport, opts?: { maxErrors?: number }): string {
  const max = opts?.maxErrors ?? 8
  if (report.errorCount === 0 && report.warningCount === 0) return ''
  const out: string[] = ['── 构建诊断 ──', `${report.errorCount > 0 ? '✗' : '✓'} ${report.summary}`]
  const render = (d: BuildDiagnostic, i: number): void => {
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}` : '(无位置信息)'
    out.push(`${i + 1}) [${d.category}] ${d.label} @ ${loc}`)
    out.push(`   ${d.message}`)
    out.push(`   建议: ${d.hint}`)
  }
  const shown = report.errors.slice(0, max)
  shown.forEach(render)
  if (report.errors.length > max) out.push(`… 另有 ${report.errors.length - max} 条同类/其他错误未展开`)
  // 无错误只有警告时，也把警告列出来（构建是成功的，但值得关注）
  if (report.errorCount === 0 && report.warnings.length > 0) {
    out.push('警告明细:')
    report.warnings.slice(0, 5).forEach((d, i) => {
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(无位置信息)'
      out.push(`- [${d.category}] ${loc} ${d.message}`)
    })
    if (report.warnings.length > 5) out.push(`… 另有 ${report.warnings.length - 5} 条警告`)
  }
  if (report.suggestions.length > 0) {
    out.push('修复动作:')
    for (const s of report.suggestions) out.push(`- ${s}`)
  }
  return out.join('\n')
}

/**
 * 芯片不匹配：esptool 连上芯片后，发现「你让我烧的是 X，实际插的是 Y」。
 *
 * 为什么单列一个函数：这是真机最高频、也最让人懵的一类失败 ——
 * 编译一路通过（142s 都编完了），却在最后一步被 esptool 一句
 * `This chip is ESP32-C3, not ESP32-S3` 打回。用户看到的是「烧录失败」，
 * 真正的原因是**板卡选错了**，而 C3/S3/P4 还共用同一个 USB VID:PID，
 * 自动识别又常常认不出来，于是这个坑会反复踩。
 *
 * 认出来之后上层就能自动把板卡改成实际芯片（比让用户自己猜可靠得多）：
 * esptool 是真的连上芯片读过 chip id 的，它的结论比任何启发式都准。
 *
 * 只认 esptool 明确的措辞；认不出就返回 null，绝不猜（误改用户板卡比漏报更糟）。
 */
export interface ChipMismatch {
  /** esptool 实测到的芯片（归一化：小写、去连字符，如 esp32c3） */
  actual: string
  /** 当前目标板卡的芯片（如 esp32s3） */
  expected: string
}

export function parseChipMismatch(text: string): ChipMismatch | null {
  const t = text || ''
  // 真机原文：`A fatal error occurred: This chip is ESP32-C3, not ESP32-S3. Wrong chip argument?`
  const m = t.match(/This chip is ([A-Za-z0-9_-]+), not ([A-Za-z0-9_-]+)/i)
  if (!m) return null
  const norm = (s: string): string => s.toLowerCase().replace(/-/g, '')
  const actual = norm(m[1])
  const expected = norm(m[2])
  // 只认 ESP 系列芯片名（esptool 的措辞在这里始终是 ESP32-xx 之类）
  if (!actual.startsWith('esp') || !expected.startsWith('esp')) return null
  if (actual === expected) return null
  return { actual, expected }
}

/** 给 Agent 系统/工具结果用的紧凑结构化摘要（JSON 文本）。 */
export function diagnosticsForAgent(report: BuildReport): string {
  if (report.errorCount === 0 && report.warningCount === 0) return ''
  const slim = report.errors.slice(0, 6).map((d) => ({
    category: d.category,
    label: d.label,
    file: d.file,
    line: d.line,
    message: d.message,
    hint: d.hint.slice(0, 260)
  }))
  return JSON.stringify({ summary: report.summary, errors: slim, suggestions: report.suggestions }, null, 2)
}

/**
 * 崩溃签名分析（宿主后端能力，原创实现）。
 *
 * 为什么需要：串口日志里的崩溃信息对新手是一堵墙——「Guru Meditation Error: Core 1 panic'ed
 * (LoadProhibited)」看不懂，而同一份固件每次崩在同一处时会刷出成百上千条几乎一样的日志。
 * 这里做两件事：
 *   1. 把常见崩溃（panic / abort / assert / 栈溢出 / 看门狗 / 掉电 / 内存不足）解析成结构化字段；
 *   2. 生成「稳定签名」——剔除每次会变的栈地址，只留异常类型 + PC + 调用栈前几帧，
 *      于是「同一处崩溃」签名相同（可去重/计数/比对），「不同处崩溃」签名不同。
 *
 * 解析规则依据 ESP-IDF / Arduino-ESP32 实际打印文本（公开事实），算法与建议文案为自研。
 */

export type CrashKind =
  | 'panic'
  | 'abort'
  | 'assert'
  | 'stack-overflow'
  | 'watchdog'
  | 'brownout'
  | 'heap'
  | 'unknown'

export interface CrashSignature {
  /** 是否从文本里识别出崩溃 */
  crashed: boolean
  kind: CrashKind
  /** 异常类型（LoadProhibited / StoreProhibited / IllegalInstruction ...） */
  exception?: string
  /** 崩溃所在核（0/1） */
  core?: number
  /** 程序计数器：崩溃瞬间执行到哪条指令 */
  pc?: string
  /** 触发异常的访问地址（空指针多为 0x00000000） */
  excvaddr?: string
  /** 调用栈帧（"PC:SP" 形式，已按出现顺序） */
  backtrace: string[]
  /** 稳定签名：同固件同位置崩溃 → 相同字符串 */
  signature: string
  /** 一句话结论（给小白看） */
  summary: string
  /** 可执行的排查建议 */
  advice: string[]
}

const EMPTY: CrashSignature = {
  crashed: false,
  kind: 'unknown',
  backtrace: [],
  signature: '',
  summary: '未在这段日志里识别出崩溃信息',
  advice: ['确认日志来自设备崩溃后的完整输出（有些板子复位很快，可加大串口缓冲或降低波特率重试）']
}

/** backtrace 帧：0x400d1a2b:0x3ffb1e40 */
const FRAME_RE = /0x[0-9a-fA-F]+:0x[0-9a-fA-F]+/g
/** 纯地址 */
const ADDR_RE = /0x[0-9a-fA-F]+/

/**
 * 稳定签名：只取调用栈前 N 帧的「PC 部分」。
 * 冒号后的栈指针（SP）每次运行都可能变，若纳入签名会让同一处崩溃算出不同签名，
 * 去重与计数就失效了——所以这里显式丢弃 SP。
 */
function buildSignature(kind: CrashKind, exception: string | undefined, pc: string | undefined, frames: string[]): string {
  const pcs = frames.slice(0, 3).map((f) => (f.split(':')[0] || '').toLowerCase())
  return [kind, exception || '-', (pc || '-').toLowerCase(), ...pcs].join('|')
}

function firstMatch(text: string, res: RegExp[]): RegExpMatchArray | null {
  for (const re of res) {
    const m = text.match(re)
    if (m) return m
  }
  return null
}

/** 按 kind + exception 给出排查建议（中文、可执行） */
function buildAdvice(kind: CrashKind, exception: string | undefined, excvaddr: string | undefined): string[] {
  const ex = (exception || '').toLowerCase()
  const advice: string[] = []

  if (kind === 'panic') {
    if (ex.includes('loadprohibited')) {
      advice.push('这是「读非法地址」：最常见是空指针解引用——指针还没赋值/初始化就去读它的成员。')
      advice.push(`检查 EXCVADDR${excvaddr ? '=' + excvaddr : ''}：若是 0x00000000 基本就是空指针；若是乱值，多半是对象已释放或数组越界读。`)
      advice.push('排查顺序：先给所有指针加判空；再确认回调注册的对象生命周期长于回调触发时机。')
    } else if (ex.includes('storeprohibited')) {
      advice.push('这是「写非法地址」：往空指针、越界位置，或只读区域（flash/const/字符串常量）写数据。')
      advice.push('常见于：数组/缓冲区越界写、sprintf 目标缓冲区太小、把 const 数据当可写内存改。')
      advice.push('把写操作目标地址和缓冲区长度打日志，越界写通常一验就现形。')
    } else if (ex.includes('illegalinstruction')) {
      advice.push('这是「执行了非法指令」：函数指针跑飞、栈被踩坏，或 flash 内容损坏。')
      advice.push('若用了函数指针/回调表，确认赋值前已初始化；中断服务函数记得加 IRAM_ATTR。')
    } else if (ex.includes('instrfetchprohibited')) {
      advice.push('这是「取指失败」：CPU 跳到了不允许执行的地址，通常是未初始化的函数指针或虚表被破坏。')
    } else if (ex.includes('integerdividebyzero')) {
      advice.push('这是「整数除零」：检查除数来自传感器读数、计数器或配置的表达式，加判零保护。')
    } else if (ex.includes('unaligned')) {
      advice.push('这是「非对齐访问」：常见于结构体 packed 后强转指针，或直接对奇数地址做 32 位读写。')
      advice.push('把按字节拷贝（memcpy）替代直接指针强转，可规避对齐问题。')
    } else {
      advice.push(`异常类型 ${exception || '未知'}：先按「非法内存访问」排查指针与数组边界。`)
    }
  } else if (kind === 'abort') {
    advice.push('abort() 是程序主动中止：常见触发点是断言失败、ESP_ERROR_CHECK 检查失败、或 C++ 抛异常未捕获。')
    advice.push('往上翻日志，abort 之前一行通常就是失败原因（打印的 error 或 assert 信息）。')
  } else if (kind === 'assert') {
    advice.push('断言失败：日志里 assert failed: 后面会带文件名和行号，直接定位到那一行看条件为什么不满足。')
    advice.push('多半是参数越界、初始化顺序不对（外设还没 init 就被使用）。')
  } else if (kind === 'stack-overflow') {
    advice.push('栈溢出：任务栈不够用了。常见原因是函数里开了大数组（如 uint8_t buf[4096]）或递归太深。')
    advice.push('把大数组改成 static/堆分配（malloc 或 std::vector）；创建任务时把栈深调大（xTaskCreate 的 usStackDepth）。')
  } else if (kind === 'watchdog') {
    advice.push('看门狗触发：某个任务长时间没让出 CPU（死循环、阻塞等待、耗时计算）。')
    advice.push('在循环里加 vTaskDelay(1) 或 delay(1) 让出 CPU；长时间操作拆成小步，别在中断/回调里干重活。')
  } else if (kind === 'brownout') {
    advice.push('掉电/电压跌落：供电带不动（USB 线太长太细、电源功率不够、电机/继电器等大电流外设启动时拉垮电压）。')
    advice.push('换短而粗的 USB 线或独立 5V 电源；大电流外设单独供电并共地；必要时在电源端加电容。')
  } else if (kind === 'heap') {
    advice.push('内存不足：malloc/堆分配失败。检查是否有内存泄漏（反复 malloc 不 free），或一次性申请过大缓冲区。')
    advice.push('用 ESP.getFreeHeap() 打点观察堆是否持续下降；下降即泄漏。')
  }

  advice.push('定位源码行：用 addr2line 把 PC 地址翻译到代码位置，例如：')
  advice.push('  xtensa-esp32-elf-addr2line -pfiaC -e <firmware.elf> <PC地址>')
  return advice
}

function buildSummary(kind: CrashKind, exception: string | undefined, core: number | undefined, pc: string | undefined): string {
  const where = pc ? `，崩溃位置 PC=${pc}` : ''
  const onCore = core !== undefined ? `（Core ${core}）` : ''
  const head = `设备崩溃${onCore}${where}`
  switch (kind) {
    case 'panic':
      return `${head}：触发了 ${exception || '未知异常'}（CPU 访问了不该访问的内存/指令）。`
    case 'abort':
      return `${head}：程序调用 abort() 主动中止，通常是断言或错误检查失败。`
    case 'assert':
      return `${head}：断言失败，日志中会带文件名与行号。`
    case 'stack-overflow':
      return `${head}：任务栈溢出（栈被写穿，触发栈保护）。`
    case 'watchdog':
      return `${head}：看门狗超时，任务长时间没让出 CPU。`
    case 'brownout':
      return `${head}：电压跌落（供电不足），不是代码逻辑问题。`
    case 'heap':
      return `${head}：内存分配失败（堆空间不足或泄漏）。`
    default:
      return '未识别出明确的崩溃类型。'
  }
}

/** 主入口：给一段串口日志，返回结构化崩溃签名 */
export function analyzeCrashLog(text: string): CrashSignature {
  if (!text || typeof text !== 'string' || !text.trim()) return { ...EMPTY }

  // ── 1. 判定崩溃种类（按明确程度排优先级，避免一条日志被多个规则重复命中） ──
  let kind: CrashKind = 'unknown'
  let exception: string | undefined
  let core: number | undefined

  const panicM =
    firstMatch(text, [
      /Guru Meditation Error:\s*Core\s+(\d+)\s+panic'ed\s*\(([^)]+)\)/i,
      /Core\s+(\d+)\s+panic'ed\s*\(([^)]+)\)/i,
      /panic'ed\s*\(([^)]+)\)/i
    ]) || null

  if (panicM) {
    kind = 'panic'
    // 第一个捕获组可能是 core，也可能是 exception（取决于命中哪条规则）
    const g1 = panicM[1]
    const g2 = panicM[2]
    if (g2 !== undefined) {
      core = Number(g1)
      exception = g2.trim()
    } else {
      exception = (g1 || '').trim()
    }
  } else if (/Stack canary watchpoint triggered|stack overflow|Stack overflow/i.test(text)) {
    kind = 'stack-overflow'
  } else if (/abort\(\)\s*was called/i.test(text)) {
    kind = 'abort'
  } else if (/assert failed:/i.test(text)) {
    kind = 'assert'
  } else if (/Brownout detector was triggered/i.test(text)) {
    kind = 'brownout'
  } else if (/watchdog/i.test(text)) {
    kind = 'watchdog'
  } else if (/Failed to allocate|out of memory|heap_caps_malloc failed/i.test(text)) {
    kind = 'heap'
  }

  if (kind === 'unknown') return { ...EMPTY, crashed: false, kind: 'unknown' }

  // ── 2. 提取关键寄存器与调用栈 ──
  const pcM = firstMatch(text, [/^\s*PC\s*:\s*(0x[0-9a-fA-F]+)/im, /PC\s*[:=]\s*(0x[0-9a-fA-F]+)/i])
  const pc = pcM ? pcM[1] : undefined

  const excM = firstMatch(text, [/EXCVADDR\s*:\s*(0x[0-9a-fA-F]+)/i])
  const excvaddr = excM ? excM[1] : undefined

  const btM = text.match(/Backtrace:[^\n]*((?:\n[^\n]*)*?)(?=\n\s*\n|\n[0-9a-fA-F]{8}|\nELF|\nRebooting|$)/i)
  const frames: string[] = []
  if (btM) {
    for (const f of btM[0].match(FRAME_RE) || []) frames.push(f)
  }
  // 兜底：即使没有 Backtrace: 标题，也尝试从整段里抓 "PC:SP" 形式的帧
  if (frames.length === 0) {
    const all = text.match(FRAME_RE) || []
    for (const f of all.slice(0, 8)) frames.push(f)
  }

  return {
    crashed: true,
    kind,
    exception,
    core: core !== undefined && !Number.isNaN(core) ? core : undefined,
    pc,
    excvaddr,
    backtrace: frames,
    signature: buildSignature(kind, exception, pc, frames),
    summary: buildSummary(kind, exception, core, pc),
    advice: buildAdvice(kind, exception, excvaddr)
  }
}

/** 生成给终端/面板展示的可读报告 */
export function formatCrashReport(sig: CrashSignature): string {
  if (!sig.crashed) return `${sig.summary}\n${sig.advice.map((a) => '  - ' + a).join('\n')}`
  const lines: string[] = []
  lines.push(sig.summary)
  if (sig.exception) lines.push(`  异常类型: ${sig.exception}`)
  if (sig.excvaddr) lines.push(`  访问地址: ${sig.excvaddr}`)
  if (sig.backtrace.length > 0) lines.push(`  调用栈: ${sig.backtrace.slice(0, 6).join(' ')}`)
  lines.push(`  崩溃签名: ${sig.signature}`)
  lines.push('  排查建议:')
  for (const a of sig.advice) lines.push(`    - ${a}`)
  return lines.join('\n')
}

/** 供自检：判断某段文本里是否含地址（避免把日志正文误当地址） */
export function extractAddresses(text: string): string[] {
  return (text.match(/0x[0-9a-fA-F]+/g) || []).filter((a) => ADDR_RE.test(a))
}

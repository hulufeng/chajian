/**
 * 引脚冲突检测（差异化功能 #1）
 *
 * 干的事：真实扫描工程源码，把每条「引脚使用」抽出来，按芯片引脚模型判定冲突。
 * 原则：
 *  - 不猜、不编造引脚编号。识别不了名字（如 LED_BUILTIN 在不同板卡上不同）就如实标「未解析」并提示。
 *  - 只基于 Espressif 官方引脚约束（strapping / JTAG / flash / GPIO 范围），给出可执行结论。
 *
 * 识别能力：
 *  - `#define LED_PIN 2` 宏常量、嵌套 `GPIO_NUM_2`、数值字面量、括号与空格容错。
 *  - Arduino API：pinMode / digitalWrite / digitalRead / analogRead / analogWrite / ledcAttach / ledcAttachPin / tone / attachInterrupt。
 *  - 总线调用：Wire.begin(sda, scl)、SPI.begin(sck, miso, mosi, ss)、Serial.begin(baud)。
 */
import fs from 'node:fs'
import path from 'node:path'

export type ChipModel = 'esp32' | 'esp32s3' | 'esp32c3'
export type PinKind = 'mode' | 'out' | 'in' | 'adc' | 'pwm' | 'int' | 'sda' | 'scl' | 'sck' | 'miso' | 'mosi' | 'ss'

export interface PinUse {
  pin: number
  /** 芯片引脚模型中的性质（可为复合，如 'strapping+adc'） */
  kind: PinKind
  api: string
  file: string
  line: number
  /** 该 API 在第几个参数上取到的引脚 */
  arg: number
}

export interface PinIssue {
  level: 'error' | 'warning' | 'info'
  pin: number
  title: string
  detail: string
  /** 相关代码位置（file:line），供 UI 点击跳转 */
  refs: Array<{ file: string; line: number; api: string }>
}

/** 解析不出具体 GPIO 号但明显是引脚名字的调用（如实提示，不猜编号）。 */
export interface UnresolvedPin {
  token: string
  api: string
  file: string
  line: number
  note: string
}

export interface PinReport {
  chip: ChipModel
  scannedFiles: number
  uses: PinUse[]
  issues: PinIssue[]
  unresolved: UnresolvedPin[]
  summary: string
}

interface ChipPinModel {
  /** GPIO 编号上界（含），超出即非法 */
  maxGpio: number
  /** 启动 strapping 脚（上/下拉决定启动模式，普通驱动易导致无法启动） */
  strapping: number[]
  /** 默认被 USB-JTAG / JTAG 占用的脚 */
  jtag: number[]
  /** flash / PSRAM 专用或保留脚 */
  reserved: number[]
  /** ESP-IDF ADC1 可用脚 */
  adc1: number[]
  /** 板载 LED 常见 GPIO（仅提示用，不参与判定） */
  onboardLed?: number
}

/** 引脚模型来源：Espressif 各芯片技术参考手册「GPIO  Faults / Strapping / JTAG 引脚」章节。 */
const CHIP_MODELS: Record<ChipModel, ChipPinModel> = {
  esp32: {
    maxGpio: 39,
    strapping: [0, 2, 15],
    jtag: [9, 10, 11, 12],
    reserved: [6, 7, 8, 9, 10, 11], // 内部 flash 占用
    adc1: [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39],
    onboardLed: 2
  },
  esp32s3: {
    maxGpio: 48,
    strapping: [0, 3, 45, 46],
    jtag: [0, 3, 45, 46], // 内置 USB-JTAG
    reserved: [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37], // 内部 flash/PSRAM
    adc1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
    onboardLed: 48
  },
  esp32c3: {
    maxGpio: 21,
    strapping: [0, 3, 9],
    jtag: [0, 2, 3, 9], // 内置 JTAG（部分封装）
    reserved: [],
    adc1: [0, 1, 2, 3, 4, 5, 18, 19, 20, 21],
    onboardLed: 8
  }
}

const SOURCE_EXT = ['.ino', '.cpp', '.cc', '.c', '.h', '.hpp']
const SKIP_DIRS = new Set(['build', 'node_modules', '.git', '.labcode', 'dist', 'out', 'sketchbook'])
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 300

/** 由 FQBN / 芯片名推断引脚模型。 */
export function detectChipModel(fqbn?: string): ChipModel {
  const s = String(fqbn || '').toLowerCase()
  if (s.includes('esp32s3') || s.includes('esp32-s3')) return 'esp32s3'
  if (s.includes('esp32c3') || s.includes('esp32-c3')) return 'esp32c3'
  return 'esp32'
}

// ── 源码扫描 ────────────────────────────────────────────────
interface ParsedFile {
  rel: string
  lines: string[]
}

function walkSources(root: string): ParsedFile[] {
  const out: ParsedFile[] = []
  const stack: string[] = ['']
  let count = 0
  while (stack.length > 0) {
    const rel = stack.pop() || ''
    const abs = rel ? path.join(root, rel) : root
    let entries: string[] = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      if (count >= MAX_FILES) return out
      const relPath = rel ? rel + '/' + name : name
      const absPath = path.join(root, relPath)
      let st: fs.Stats
      try {
        st = fs.statSync(absPath)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        stack.push(relPath)
        continue
      }
      if (!SOURCE_EXT.includes(path.extname(name).toLowerCase()) || st.size > MAX_FILE_BYTES) continue
      try {
        const text = fs.readFileSync(absPath, 'utf-8')
        out.push({ rel: relPath, lines: text.split(/\r?\n/) })
        count++
      } catch {
        /* 跳过无法读取的文件 */
      }
    }
  }
  return out
}

/** 解析 `#define NAME <value>`，只收简单值（数字 / GPIO_NUM_x），跳过表达式。 */
function collectMacros(files: ParsedFile[]): Map<string, number> {
  const macros = new Map<string, number>()
  for (const f of files) {
    f.lines.forEach((raw, i) => {
      const m = /^\s*#\s*define\s+([A-Za-z_][\w]*)\s+(.+?)\s*$/.exec(raw)
      if (!m) return
      const rawName = m[1]
      const rawVal = m[2]
      if (/\d\s*[*+\-/%]|[*+\-/%]|<<|>>|\?/.test(rawVal)) return // 表达式不做求值，避免误判
      const v = resolvePinToken(rawVal.trim(), macros)
      if (v !== null) macros.set(rawName, v)
      void i
    })
  }
  return macros
}

/** 把 token 解析为 GPIO 号；解析不了返回 null（宁可不报，也不编造）。 */
function resolvePinToken(token: string, macros: Map<string, number>): number | null {
  let t = String(token || '').trim().replace(/^\(/, '').replace(/\)$/, '').replace(/\s+/g, '')
  if (!t) return null
  if (/^-?\d+$/.test(t)) {
    const n = Number(t)
    return n >= 0 && n <= 99 ? n : null
  }
  const gpio = /^GPIO_NUM_(?:GPIO)?(\d+)$/i.exec(t)
  if (gpio) return Number(gpio[1])
  const bare = /^GPIO(\d+)$/i.exec(t)
  if (bare) return Number(bare[1])
  const mm = /^([A-Za-z_][\w]*)$/.exec(t)
  if (mm && macros.has(mm[1])) return macros.get(mm[1])!
  return null
}

interface FnRule {
  api: string
  arg: number
  kind: PinKind
  re: RegExp
}

const FN_RULE_DEFS: Array<{ api: string; arg: number; kind: PinKind }> = [
  { api: 'pinMode', arg: 0, kind: 'mode' },
  { api: 'digitalWrite', arg: 0, kind: 'out' },
  { api: 'digitalWriteFast', arg: 0, kind: 'out' },
  { api: 'digitalRead', arg: 0, kind: 'in' },
  { api: 'digitalReadFast', arg: 0, kind: 'in' },
  { api: 'analogRead', arg: 0, kind: 'adc' },
  { api: 'analogWrite', arg: 0, kind: 'pwm' },
  { api: 'ledcAttach', arg: 0, kind: 'pwm' },
  { api: 'ledcAttachPin', arg: 0, kind: 'pwm' },
  { api: 'tone', arg: 0, kind: 'out' },
  { api: 'attachInterrupt', arg: 0, kind: 'int' },
  { api: 'attachInterruptArg', arg: 0, kind: 'int' },
  { api: 'pinMatrixInAttach', arg: 0, kind: 'out' },
  { api: 'pinMatrixOutAttach', arg: 0, kind: 'out' },
  { api: 'adcAttachPin', arg: 0, kind: 'adc' },
  { api: 'ledcWrite', arg: 0, kind: 'pwm' },
  { api: 'ledcRead', arg: 0, kind: 'adc' }
]

const FN_PATTERNS: FnRule[] = FN_RULE_DEFS.map((r) => ({
  ...r,
  re: new RegExp(`\\b${r.api}\\s*\\(`, 'g')
}))

// ── 主检查 ──────────────────────────────────────────────────
export function checkPinConflicts(root: string, opts: { fqbn?: string } = {}): PinReport {
  const chip = detectChipModel(opts.fqbn)
  const model = CHIP_MODELS[chip]
  const files = walkSources(root)
  const macros = collectMacros(files)
  const uses: PinUse[] = []
  const unresolved: UnresolvedPin[] = []

  for (const f of files) {
    const rel = f.rel
    f.lines.forEach((line, idx) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return // 纯注释行不参与匹配
      for (const rule of FN_PATTERNS) {
        rule.re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = rule.re.exec(line)) !== null) {
          // 取调用段的顶层参数（先定位到实打实的 '('，再括号配对后按逗号切分）
          const openParen = line.indexOf('(', m.index)
          if (openParen < 0) continue
          let body = line.slice(openParen + 1)
          let depth = 1
          for (let i = 0; i < body.length; i++) {
            if (body[i] === '(') depth++
            else if (body[i] === ')') {
              depth--
              if (depth === 0) {
                body = body.slice(0, i)
                break
              }
            }
          }
          const args = splitTopLevel(body)
          const pinToken = args[rule.arg]
          if (pinToken == null) continue
          const pin = resolvePinToken(pinToken, macros)
          if (pin === null) {
            // 只登记「像引脚名但解析不到」的 token，避免把变量名/枚举误当引脚报出来
            if (/^[A-Za-z_][\w.]*$/.test(pinToken) && !/^(true|false|NULL|nullptr)$/.test(pinToken)) {
              unresolved.push({
                token: pinToken,
                api: rule.api,
                file: rel,
                line: idx + 1,
                note: `「${pinToken}」解析不到具体 GPIO 号（不同板卡 variant 的引脚定义不同），未参与冲突判定。`
              })
            }
            continue
          }
          uses.push({ pin, kind: rule.kind, api: rule.api, file: rel, line: idx + 1, arg: rule.arg })
        }
      }
      // 总线调用：Wire.begin(sda, scl) / SPI.begin(sck, miso, mosi, ss)
      const wire = /\bWire\s*\.\s*begin\s*\(([^)]*)\)/.exec(line)
      if (wire) {
        const a = splitTopLevel(wire[1])
        const push = (tok: string | undefined, kind: PinKind, api: string): void => {
          const p = tok == null ? null : resolvePinToken(tok, macros)
          if (p === null) return
          uses.push({ pin: p, kind, api, file: rel, line: idx + 1, arg: 0 })
        }
        push(a[0], 'sda', 'Wire.begin(sda)')
        push(a[1], 'scl', 'Wire.begin(scl)')
      }
      const spi = /\bSPI\s*\.\s*begin\s*\(([^)]*)\)/.exec(line)
      if (spi) {
        const a = splitTopLevel(spi[1])
        const names: Array<[PinKind, string]> = [
          ['sck', 'SPI.begin(sck)'],
          ['miso', 'SPI.begin(miso)'],
          ['mosi', 'SPI.begin(mosi)'],
          ['ss', 'SPI.begin(ss)']
        ]
        a.forEach((tok, i) => {
          if (!tok) return
          const p = resolvePinToken(tok, macros)
          if (p === null) return
          uses.push({ pin: p, kind: names[i][0], api: names[i][1], file: rel, line: idx + 1, arg: i })
        })
      }
    })
  }

  // 若无工程源码（空工程）→ 明确说明，不粉饰
  if (files.length === 0) {
    return {
      chip,
      scannedFiles: 0,
      uses: [],
      issues: [],
      unresolved: [],
      summary: `未在项目 ${path.basename(root)} 下找到可扫描的源码文件（.ino/.cpp/.h 等），无法做引脚冲突检测。`
    }
  }

  // 未解析引脚名 → 只提示不判定（同一个 token 去重）
  const seenTokens = new Set<string>()
  const unresolvedIssues: PinIssue[] = []
  for (const u of unresolved) {
    if (seenTokens.has(u.token)) continue
    seenTokens.add(u.token)
    unresolvedIssues.push({
      level: 'info',
      pin: -1,
      title: `引脚名「${u.token}」未能解析为 GPIO 号`,
      detail: `${u.note} 若它确实是引脚，请用数字或 #define 指到一个确定的脚，便于检测冲突。`,
      refs: [{ file: u.file, line: u.line, api: u.api }]
    })
  }
  const issues = [...analyze(uses, model, chip), ...unresolvedIssues]
  const byPin = new Map<number, PinUse[]>()
  for (const u of uses) {
    const list = byPin.get(u.pin) || []
    list.push(u)
    byPin.set(u.pin, list)
  }
  const errs = issues.filter((i) => i.level === 'error').length
  const warns = issues.filter((i) => i.level === 'warning').length
  const summary =
    `芯片模型 ${chip}（GPIO 0-${model.maxGpio}）· 扫描 ${files.length} 个源文件 · 识别 ${uses.length} 处引脚调用\n` +
    (issues.length === 0
      ? '未发现引脚冲突。'
      : `发现 ${issues.length} 条提示（错误 ${errs} / 警告 ${warns} / 提示 ${issues.length - errs - warns}）。`) +
    `涉及引脚：${[...byPin.keys()].sort((a, b) => a - b).join(', ') || '—'}`

  return { chip, scannedFiles: files.length, uses, issues, unresolved, summary }
}

/** 按逗号切分，忽略括号内的逗号。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 冲突判定。 */
function analyze(uses: PinUse[], model: ChipPinModel, chip: ChipModel): PinIssue[] {
  const issues: PinIssue[] = []
  const byPin = new Map<number, PinUse[]>()
  for (const u of uses) {
    const l = byPin.get(u.pin) || []
    l.push(u)
    byPin.set(u.pin, l)
  }

  const dirOf = (k: PinKind): 'out' | 'in' | null => {
    if (k === 'out' || k === 'pwm') return 'out'
    if (k === 'in' || k === 'adc') return 'in'
    return null
  }

  for (const [pin, list] of [...byPin.entries()].sort((a, b) => a[0] - b[0])) {
    const refs = list.map((u) => ({ file: u.file, line: u.line, api: u.api }))
    const kinds = list.map((u) => u.kind)
    const has = (k: PinKind): boolean => kinds.includes(k)

    if (pin > model.maxGpio) {
      issues.push({
        level: 'error',
        pin,
        title: `GPIO ${pin} 在 ${chip} 上不存在`,
        detail: `${chip.toUpperCase()} 的 GPIO 范围是 0-${model.maxGpio}，使用 ${pin} 会导致编译失败或运行异常。`,
        refs
      })
      continue
    }
    if (model.reserved.includes(pin)) {
      issues.push({
        level: 'warning',
        pin,
        title: `GPIO ${pin} 是内部 flash/PSRAM 保留脚`,
        detail: '该脚被芯片内部 flash/PSRAM 占用，普通 IO 驱动不稳定，建议换脚。',
        refs
      })
    }
    if (model.strapping.includes(pin)) {
      issues.push({
        level: 'warning',
        pin,
        title: `GPIO ${pin} 是启动 strapping 脚`,
        detail:
          '该脚在复位/启动瞬间被采样决定启动模式（部分封装还带 boot 键功能），普通驱动可能导致下载模式异常或反复重启。' +
          (kinds.includes('out') ? ' 当前代码对它做了输出驱动。' : ''),
        refs
      })
    }
    if (model.jtag.includes(pin) && !model.jtag.every((p) => !byPin.has(p))) {
      issues.push({
        level: 'info',
        pin,
        title: `GPIO ${pin} 被 USB-JTAG 占用`,
        detail: '启用 USB-JTAG 调试时这些脚由调试器使用；若改用普通 IO，需在板卡配置里关闭 USB-JTAG（或换调试接口）。',
        refs
      })
    }
    if (has('mode') && has('in') && has('out')) {
      issues.push({
        level: 'error',
        pin,
        title: `GPIO ${pin} 同一引脚既读又写`,
        detail: '代码里既做了输入（digitalRead/analogRead）又做输出（digitalWrite/ledc），方向互相冲突。',
        refs
      })
    }
    if (has('adc') && has('pwm')) {
      issues.push({
        level: 'error',
        pin,
        title: `GPIO ${pin} 同时被用于 ADC 与 PWM`,
        detail: 'ADC 与 PWM 输出共用同一脚会互相干扰（部分芯片 ADC 与输出模式复用），建议拆分。',
        refs
      })
    }
    if (has('adc') && (has('out') || has('mode'))) {
      issues.push({
        level: 'warning',
        pin,
        title: `GPIO ${pin} 是 ADC 脚但被当普通输出用`,
        detail: '对 ADC 脚做数字输出会让该脚退出 ADC 采样，采样值固定且失去意义。',
        refs
      })
    }
    if (has('int') && has('adc')) {
      issues.push({
        level: 'info',
        pin,
        title: `GPIO ${pin} 同时用于外部中断与 ADC`,
        detail: '可以工作，但中断期间 ADC 采样会受影响（ADC 在数字输入路径上）。',
        refs
      })
    }
    const outs = list.filter((u) => dirOf(u.kind) === 'out')
    if (outs.length > 1) {
      issues.push({
        level: 'info',
        pin,
        title: `GPIO ${pin} 被多处输出`,
        detail: `共 ${outs.length} 处写入（${outs.map((u) => u.api).join('、')}），请确认不会互相拉扯。`,
        refs
      })
    }
  }
  return issues
}

/** 生成 Markdown 版报告（给 Agent / 输出面板用）。 */
export function formatPinReport(report: PinReport): string {
  const lines: string[] = []
  lines.push(`引脚冲突检测（${report.chip}）`)
  lines.push(report.summary)
  if (report.issues.length === 0) return lines.join('\n')
  lines.push('')
  for (const it of report.issues) {
    lines.push(`[${it.level.toUpperCase()}] GPIO ${it.pin} · ${it.title}`)
    lines.push(`  ${it.detail}`)
    for (const r of it.refs.slice(0, 6)) lines.push(`    - ${r.file}:${r.line}  ${r.api}`)
  }
  return lines.join('\n')
}

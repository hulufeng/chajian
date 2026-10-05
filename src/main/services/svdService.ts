/**
 * CMSIS-SVD 寄存器/位域精确查询（P1-7）
 *
 * 数据来源：Espressif 官方 SVD 仓库（github.com/espressif/svd，Apache-2.0）。
 * 约束（遵循项目既定红线）：
 *  - SVD 文件**不进安装包、不进服务器**：运行时按需下载，缓存到用户目录 %APPDATA%/codelab-desktop/svd。
 *  - 未安装对应芯片 SVD 时**明确报错并给出安装方法**，绝不凭记忆编造寄存器/位域值（对齐「降幻觉」原则）。
 *  - 纯本地解析（零第三方依赖），解析结果内存缓存。
 *
 * 查询到的寄存器地址/位域与官方 SVD 逐字一致（同源同文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** 官方 SVD 仓库路径（raw）。gh-proxy 优先，直连兜底。 */
const SVD_UPSTREAM = 'https://raw.githubusercontent.com/espressif/svd/main/svd'
const SVD_MIRROR_PREFIXES = ['https://gh-proxy.com/', '']

/** 已确认存在的芯片（其余名称按 <chip>.svd 规则尝试）。 */
export const KNOWN_SVD_CHIPS = [
  'esp32', 'esp32s2', 'esp32s3', 'esp32c2', 'esp32c3', 'esp32c6', 'esp32h2', 'esp32p4', 'esp32s3-ulp'
] as const

export interface SvdField {
  name: string
  description: string
  bitOffset: number
  bitWidth: number
  access?: string
}

export interface SvdRegister {
  name: string
  description: string
  addressOffset: number
  /** 绝对地址 = 外设基址 + addressOffset（数组寄存器取第 0 项） */
  address: number
  size: number
  /** 数组寄存器维度（如 GPIO_OUT 无，KEY[%s] 为 8） */
  dim?: number
  dimIncrement?: number
  fields: SvdField[]
}

export interface SvdPeripheral {
  name: string
  description: string
  baseAddress: number
  derivedFrom?: string
  registers: SvdRegister[]
}

export interface ParsedSvd {
  deviceName: string
  vendor: string
  version: string
  peripherals: SvdPeripheral[]
  /** 全局寄存器索引：REGISTER_NAME(大写) → 命中列表 */
  index: Map<string, Array<{ peripheral: string; register: SvdRegister }>>
}

// ── 目录 ────────────────────────────────────────────────────
export function getSvdDir(): string {
  return path.join(app.getPath('appData'), 'codelab-desktop', 'svd')
}

function svdFilePath(chip: string): string {
  return path.join(getSvdDir(), `${normalizeChip(chip)}.svd`)
}

export function normalizeChip(chip: string): string {
  return String(chip || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
}

/** 已安装（本地已有 .svd）的芯片清单。 */
export function listInstalledChips(): Array<{ chip: string; bytes: number; mtime: number }> {
  const dir = getSvdDir()
  if (!fs.existsSync(dir)) return []
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.svd'))
      .map((f) => {
        const p = path.join(dir, f)
        const st = fs.statSync(p)
        return { chip: f.replace(/\.svd$/i, ''), bytes: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => a.chip.localeCompare(b.chip))
  } catch {
    return []
  }
}

export function isChipInstalled(chip: string): boolean {
  return fs.existsSync(svdFilePath(chip))
}

// ── 下载安装 ────────────────────────────────────────────────
export interface SvdInstallResult {
  chip: string
  path: string
  bytes: number
  url: string
}

/**
 * 下载并缓存某芯片的官方 SVD。已在本地时（且 force=false）直接返回。
 * 网络不可达 / 该芯片不存在 → 抛错，由调用方转成可操作提示。
 */
export async function installSvd(chip: string, opts: { force?: boolean } = {}): Promise<SvdInstallResult> {
  const name = normalizeChip(chip)
  if (!name) throw new Error('芯片名不能为空（如 esp32s3）')
  const dir = getSvdDir()
  fs.mkdirSync(dir, { recursive: true })
  const dest = svdFilePath(name)
  if (!opts.force && fs.existsSync(dest)) {
    return { chip: name, path: dest, bytes: fs.statSync(dest).size, url: '(本地缓存)' }
  }

  const rel = `${SVD_UPSTREAM}/${name}.svd`
  let lastErr = ''
  for (const prefix of SVD_MIRROR_PREFIXES) {
    const url = prefix + rel
    try {
      const xml = await fetchText(url, 180_000)
      if (!/<\s*device[\s>]/.test(xml)) {
        lastErr = `返回内容不是 SVD（可能是 404 页面）`
        continue
      }
      const tmp = dest + '.part'
      fs.writeFileSync(tmp, xml, 'utf-8')
      fs.renameSync(tmp, dest)
      clearSvdCache(name)
      return { chip: name, path: dest, bytes: fs.statSync(dest).size, url }
    } catch (e) {
      lastErr = (e as Error).message
    }
  }
  throw new Error(
    `下载 ${name}.svd 失败：${lastErr || '网络不可达'}。\n` +
      `可确认芯片名是否正确（官方仓库支持：${KNOWN_SVD_CHIPS.join(', ')}），或稍后重试（需可访问 GitHub）。`
  )
}

/** 允许用户直接放置本地 SVD 文件（离线/内网场景）。 */
export function importLocalSvd(chip: string, filePath: string): SvdInstallResult {
  const name = normalizeChip(chip)
  if (!name) throw new Error('芯片名不能为空')
  const src = path.resolve(filePath)
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`)
  const text = fs.readFileSync(src, 'utf-8')
  if (!/<\s*device[\s>]/.test(text)) throw new Error('该文件不是 CMSIS-SVD（缺少 <device> 根节点）')
  const dir = getSvdDir()
  fs.mkdirSync(dir, { recursive: true })
  const dest = svdFilePath(name)
  fs.writeFileSync(dest, text, 'utf-8')
  clearSvdCache(name)
  return { chip: name, path: dest, bytes: Buffer.byteLength(text), url: src }
}

export function removeSvd(chip: string): boolean {
  const p = svdFilePath(chip)
  if (!fs.existsSync(p)) return false
  fs.rmSync(p, { force: true })
  clearSvdCache(normalizeChip(chip))
  return true
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LabCode/1.1 (+svd-fetch)' } })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

// ── 解析 ────────────────────────────────────────────────────
const svdCache = new Map<string, ParsedSvd>()

function clearSvdCache(chip: string): void {
  svdCache.delete(normalizeChip(chip))
}

/** 取内层第一个同名标签的文本。 */
function firstTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\s*>(.*?)</${tag}>`, 's').exec(block)
  return m ? m[1].trim() : undefined
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function num(s: string | undefined, fallback = 0): number {
  if (s == null) return fallback
  const t = s.trim()
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16)
    const n = Number(t)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

/** 取所有 <tag ...>...</tag> 块（含开标签属性）。SVD 中 register/field/peripheral 不自我嵌套，非贪婪匹配安全。 */
function tagBlocksEx(block: string, tag: string): Array<{ attrs: string; body: string }> {
  const out: Array<{ attrs: string; body: string }> = []
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) out.push({ attrs: m[1] || '', body: m[2] })
  return out
}

function tagBlocks(block: string, tag: string): string[] {
  return tagBlocksEx(block, tag).map((x) => x.body)
}

function parseFields(regBlock: string): SvdField[] {
  const fieldsBlock = firstTag(regBlock, 'fields')
  if (!fieldsBlock) return []
  return tagBlocks(fieldsBlock, 'field').map((fb) => ({
    name: stripTags(firstTag(fb, 'name')) || '(未命名)',
    description: stripTags(firstTag(fb, 'description')),
    bitOffset: num(firstTag(fb, 'bitOffset'), 0),
    bitWidth: num(firstTag(fb, 'bitWidth'), 1),
    access: firstTag(fb, 'access')
  }))
}

function parseRegisters(periphBlock: string, baseAddress: number): SvdRegister[] {
  const regsBlock = firstTag(periphBlock, 'registers')
  if (!regsBlock) return []
  return tagBlocks(regsBlock, 'register').map((rb) => {
    const offset = num(firstTag(rb, 'addressOffset'), 0)
    const dim = firstTag(rb, 'dim')
    return {
      name: stripTags(firstTag(rb, 'name')) || '(未命名)',
      description: stripTags(firstTag(rb, 'description')),
      addressOffset: offset,
      address: baseAddress + offset,
      size: num(firstTag(rb, 'size'), 32),
      dim: dim ? num(dim) : undefined,
      dimIncrement: firstTag(rb, 'dimIncrement') ? num(firstTag(rb, 'dimIncrement')) : undefined,
      fields: parseFields(rb)
    }
  })
}

/** 解析 SVD 文本。导出以便单测。 */
export function parseSvd(xml: string): ParsedSvd {
  const deviceName = stripTags(firstTag(xml, 'name')) || 'unknown'
  const vendor = stripTags(firstTag(xml, 'vendor'))
  const version = stripTags(firstTag(xml, 'version'))
  const peripheralsBlock = firstTag(xml, 'peripherals') || xml

  const raw = tagBlocksEx(peripheralsBlock, 'peripheral').map(({ attrs, body: pb }) => {
    const baseAddress = num(firstTag(pb, 'baseAddress'), 0)
    const derivedFrom = /\bderivedFrom\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
    return {
      name: stripTags(firstTag(pb, 'name')) || '(未命名)',
      description: stripTags(firstTag(pb, 'description')),
      baseAddress,
      derivedFrom,
      registers: parseRegisters(pb, baseAddress)
    } as SvdPeripheral
  })

  // 解析 derivedFrom：派生外设（如 I2C1 derivedFrom I2C0）自身无寄存器，复制父外设寄存器并按其基址重算地址
  const byName = new Map(raw.map((p) => [p.name, p]))
  for (const p of raw) {
    if (p.registers.length === 0 && p.derivedFrom) {
      const parent = byName.get(p.derivedFrom)
      if (parent && parent.registers.length > 0) {
        p.registers = parent.registers.map((r) => ({ ...r, address: p.baseAddress + r.addressOffset }))
      }
    }
  }

  const index = new Map<string, Array<{ peripheral: string; register: SvdRegister }>>()
  for (const p of raw) {
    for (const r of p.registers) {
      const key = r.name.replace(/\[%s\]/g, '').toUpperCase()
      const list = index.get(key) || []
      list.push({ peripheral: p.name, register: r })
      index.set(key, list)
    }
  }

  return { deviceName, vendor, version, peripherals: raw, index }
}

/** 载入并解析某芯片 SVD（内存缓存）。未安装则抛错。 */
export function loadSvd(chip: string): ParsedSvd {
  const name = normalizeChip(chip)
  const hit = svdCache.get(name)
  if (hit) return hit
  const p = svdFilePath(name)
  if (!fs.existsSync(p)) {
    throw new Error(
      `未安装 ${name} 的 SVD 数据文件（寄存器查询依赖它，不会凭空编造）。\n` +
        `安装方式二选一：\n` +
        `  ① 让 AI 执行：svd_query({action:"install", chip:"${name}"})（从乐鑫官方仓库 espressif/svd 下载，需可访问 GitHub）；\n` +
        `  ② 手动把官方 ${name}.svd 放到：${p}\n` +
        `已安装芯片可用 svd_query({action:"list"}) 查看。`
    )
  }
  const parsed = parseSvd(fs.readFileSync(p, 'utf-8'))
  svdCache.set(name, parsed)
  return parsed
}

// ── 查询 ────────────────────────────────────────────────────
export interface RegisterHit {
  peripheral: string
  baseAddress: number
  register: SvdRegister
}

/**
 * 前缀式寄存器名解析：官方 SVD 用**短名**（GPIO 下是 OUT/ENABLE，UART0 下是 CLKDIV），
 * 而 ESP-IDF/数据手册习惯写 `GPIO_OUT_REG`、`UART_CLKDIV`、`I2C0_CTR`。
 * 这里把「外设名_寄存器名」拆开，在对应外设内查短名（并兼容尾部 _REG 后缀）。
 * 外设名按长度倒序优先，避免 GPIO 抢先匹配 GPIO_SD_* 这类更具体的前缀。
 */
function resolvePrefixed(svd: ParsedSvd, key: string, want: string): RegisterHit[] {
  const hits: RegisterHit[] = []
  const peripherals = [...svd.peripherals].sort((a, b) => b.name.length - a.name.length)
  for (const p of peripherals) {
    const pn = p.name.toUpperCase()
    if (want && pn !== want) continue
    // 支持两种前缀：完整外设名（UART0_）与去掉末尾实例号的家族名（UART_）
    const prefixes = new Set<string>([pn + '_'])
    const family = pn.replace(/\d+$/, '')
    if (family && family !== pn) prefixes.add(family + '_')
    let rest: string | null = null
    for (const pre of prefixes) {
      if (key.startsWith(pre)) {
        rest = key.slice(pre.length)
        break
      }
    }
    if (rest == null || rest.length === 0) continue
    const cands = new Set([rest, rest.replace(/_REG$/, ''), rest.replace(/^REG_/, ''), rest.replace(/^R_/, '')])
    for (const r of p.registers) {
      const rn = r.name.replace(/\[%s\]/g, '').toUpperCase()
      if (cands.has(rn)) hits.push({ peripheral: p.name, baseAddress: p.baseAddress, register: r })
    }
  }
  return hits
}

/** 按寄存器名查（大小写不敏感；先直查，未命中再按「外设_寄存器」前缀拆解）。 */
export function findRegister(chip: string, name: string, opts: { peripheral?: string; exact?: boolean } = {}): RegisterHit[] {
  const svd = loadSvd(chip)
  const key = String(name || '').trim().toUpperCase()
  if (!key) return []
  const want = opts.peripheral ? opts.peripheral.trim().toUpperCase() : ''
  const hits: RegisterHit[] = []

  const push = (peripheral: string, baseAddress: number, register: SvdRegister): void => {
    if (want && peripheral.toUpperCase() !== want) return
    hits.push({ peripheral, baseAddress, register })
  }

  if (opts.exact) {
    for (const e of svd.index.get(key) || []) {
      push(e.peripheral, svd.peripherals.find((p) => p.name === e.peripheral)?.baseAddress || 0, e.register)
    }
  } else {
    for (const p of svd.peripherals) {
      if (want && p.name.toUpperCase() !== want) continue
      for (const r of p.registers) {
        const rn = r.name.replace(/\[%s\]/g, '').toUpperCase()
        if (rn === key || rn.includes(key)) push(p.name, p.baseAddress, r)
      }
    }
  }
  // 直查无果 → 前缀拆解（GPIO_OUT_REG → GPIO.OUT）
  if (hits.length === 0) {
    for (const h of resolvePrefixed(svd, key, want)) push(h.peripheral, h.baseAddress, h.register)
  }
  return hits.slice(0, 30)
}

/** 按外设列出寄存器。 */
export function listPeripheral(chip: string, peripheral: string, opts: { max?: number } = {}): { peripheral: SvdPeripheral; total: number } | null {
  const svd = loadSvd(chip)
  const want = String(peripheral || '').trim().toUpperCase()
  const p = svd.peripherals.find((x) => x.name.toUpperCase() === want)
  if (!p) return null
  return { peripheral: p, total: p.registers.length }
}

export function listPeripherals(chip: string): SvdPeripheral[] {
  return loadSvd(chip).peripherals
}

// ── 格式化（给 Agent 看） ───────────────────────────────────
export function hex(n: number, width = 8): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0')
}

export function formatRegister(hit: RegisterHit): string {
  const r = hit.register
  const lines: string[] = []
  lines.push(`外设 ${hit.peripheral} (基址 ${hex(hit.baseAddress)})  寄存器 ${r.name}`)
  lines.push(`  绝对地址: ${hex(r.address)}   偏移: ${hex(r.addressOffset, 4)}   位宽: ${r.size}`)
  if (r.description) lines.push(`  说明: ${r.description}`)
  if (r.dim && r.dimIncrement) lines.push(`  数组: ${r.dim} 个，步长 ${hex(r.dimIncrement, 4)}（第 n 项地址 = 基址 + ${hex(r.addressOffset, 4)} + n*${hex(r.dimIncrement, 4)}）`)
  if (r.fields.length === 0) {
    lines.push('  位域: 该 SVD 未定义位域（仅寄存器整体）')
  } else {
    lines.push(`  位域（${r.fields.length}）:`)
    for (const f of r.fields) {
      const hi = f.bitOffset + f.bitWidth - 1
      const range = f.bitWidth === 1 ? `bit${f.bitOffset}` : `bit${hi}:${f.bitOffset}`
      lines.push(`    - ${f.name} [${range}]${f.access ? ` (${f.access})` : ''}${f.description ? '：' + f.description : ''}`)
    }
  }
  lines.push(`  来源: Espressif 官方 SVD（espressif/svd）`)
  return lines.join('\n')
}

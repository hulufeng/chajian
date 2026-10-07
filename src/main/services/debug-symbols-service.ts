/**
 * 源码级调试的符号服务（主进程侧）。
 *
 * 职责：
 *   1) 在编译产物目录（buildPath）里定位 .elf，构建并缓存 DebugIndex；
 *   2) 对外提供「地址 ↔ 源码」查询（供当前行高亮 / 断点 / 变量用）；
 *   3) 把「某文件某行的断点」翻译成 openocd 硬件断点（经 debugService.setBreakpoint）。
 *
 * 与 debugService 的关系：debugService 只懂「按地址操作 openocd」，本服务负责
 * 「把地址翻译成人类可读的源码位置」并管理 .elf 索引，二者解耦。
 *
 * 与纯函数模块 debug-symbols 的关系：解析逻辑全在 debug-symbols（纯、可测），
 * 本文件只做「读文件 + 缓存 + 接 openocd」的胶水，不重复实现解析。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDebugIndex,
  getSection,
  parseElf,
  addrToSource as indexAddrToSource,
  lineToAddr as indexLineToAddr,
  findFunction as indexFindFunction,
  type DebugIndex,
  type SourceLoc,
  type ElfSymbol,
  type ElfFile
} from './debug-symbols'
import { parseInfo, extractVariables, type DwarfVar } from './debug-dwarf-info'
import { setBreakpoint, removeBreakpoint, isDebugActive, readRegisters, readRawBytes } from './debugService'
import { resolveRegRoles, walkCallStack, type StackWalkResult } from './debug-callstack'
import { listGlobals as vListGlobals, readGlobalVar as vReadGlobalVar, interpretBytes, type GlobalVar, type VarValue } from './debug-variables'

/** 已加载的索引（按 buildPath 缓存，编译产物不变就不重解析） */
let cache: { buildPath: string; index: DebugIndex; elfPath: string; typedGlobals: DwarfVar[]; typedLocals: DwarfVar[] } | null = null

/** 从 ELF 缓冲里取某节字节（不存在返回 null）。传 ElfFile 以拿到节表。 */
function sectionBytes(elfBuf: Buffer, elf: ElfFile, name: string): Buffer | null {
  const sec = getSection(elf, name)
  if (!sec || sec.size <= 0) return null
  if (sec.offset + sec.size > elfBuf.length) return null
  return elfBuf.subarray(sec.offset, sec.offset + sec.size)
}

/** 在 buildPath 里递归找 .elf（arduino: <sketch>.ino.elf；PlatformIO: firmware.elf） */
function findElf(dir: string, depth = 0): string | null {
  if (depth > 3) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  // 优先非 debug 版（避免 build/ 下多个 elf 时误选带 debug 的）
  const elfs = entries.filter((f) => f.toLowerCase().endsWith('.elf'))
  const preferred = elfs.find((f) => !f.includes('debug')) ?? elfs[0]
  if (preferred) {
    const p = join(dir, preferred)
    try {
      if (statSync(p).isFile()) return p
    } catch { /* 忽略 */ }
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'libdeps') continue
    const p = join(dir, e)
    try {
      if (statSync(p).isDirectory()) {
        const found = findElf(p, depth + 1)
        if (found) return found
      }
    } catch { /* 忽略 */ }
  }
  return null
}

export interface SymbolLoadResult {
  ok: boolean
  /** 是否含行号信息（需编译带 -g）。false 时只能做函数级跳转/断点（按地址） */
  hasLineInfo: boolean
  elfPath: string
  fileCount: number
  functionCount: number
  /** 无法定位 .elf / 解析失败的原因（如实上报） */
  error?: string
  /** DWARF ≥5 未支持行号解析 */
  dwarfUnsupported?: boolean
  parseError?: string
}

/**
 * 加载（或复用）buildPath 下固件的调试符号。
 * 编译产物已带 buildPath，切换板卡/重新编译后 buildPath 变化会自动重建索引。
 */
export function loadDebugSymbols(buildPath: string): SymbolLoadResult {
  if (!buildPath) {
    cache = null
    return { ok: false, hasLineInfo: false, elfPath: '', fileCount: 0, functionCount: 0, error: '缺少 buildPath（需先成功编译一次）' }
  }
  if (cache && cache.buildPath === buildPath) {
    return {
      ok: true,
      hasLineInfo: cache.index.hasLineInfo,
      elfPath: cache.elfPath,
      fileCount: cache.index.files.length - 1,
      functionCount: cache.index.functions.length,
      dwarfUnsupported: cache.index.dwarfUnsupported,
      parseError: cache.index.parseError
    }
  }
  const elfPath = findElf(buildPath)
  if (!elfPath) {
    cache = null
    return { ok: false, hasLineInfo: false, elfPath: '', fileCount: 0, functionCount: 0, error: `在 ${buildPath} 下未找到 .elf（编译产物里应有）` }
  }
  try {
    const elfBuf = readFileSync(elfPath)
    const elf = parseElf(elfBuf)
    const index = buildDebugIndex(elfBuf)
    // 解析 .debug_info 拿变量精确类型 + 局部变量（DWARF v2-4；不支持则静默降级为无类型）
    let typedGlobals: DwarfVar[] = []
    let typedLocals: DwarfVar[] = []
    const infoSec = sectionBytes(elfBuf, elf, '.debug_info')
    const abbrevSec = sectionBytes(elfBuf, elf, '.debug_abbrev')
    if (infoSec && abbrevSec) {
      const strSec = sectionBytes(elfBuf, elf, '.debug_str')
      const parsed = parseInfo(infoSec, abbrevSec, strSec, elf.endian === 'little')
      const vars = extractVariables(parsed.cus)
      typedGlobals = vars.globals
      typedLocals = vars.locals
    }
    cache = { buildPath, index, elfPath, typedGlobals, typedLocals }
    return {
      ok: true,
      hasLineInfo: index.hasLineInfo,
      elfPath,
      fileCount: index.files.length - 1,
      functionCount: index.functions.length,
      dwarfUnsupported: index.dwarfUnsupported,
      parseError: index.parseError
    }
  } catch (err) {
    cache = null
    return { ok: false, hasLineInfo: false, elfPath, fileCount: 0, functionCount: 0, error: (err as Error).message }
  }
}

function requireIndex(): DebugIndex | null {
  return cache?.index ?? null
}

/** 地址 → 源码位置（当前行高亮 / 变量定位）。无索引或无行号表返回 null */
export function addrToSource(addr: number): SourceLoc | null {
  const idx = requireIndex()
  if (!idx) return null
  return indexAddrToSource(idx, addr)
}

/** (文件, 行) → 断点地址。找不到返回 null（不编造） */
export function lineToAddr(file: string, line: number): number | null {
  const idx = requireIndex()
  if (!idx) return null
  return indexLineToAddr(idx, file, line)
}

/** 地址 → 所在函数符号 */
export function functionAt(addr: number): ElfSymbol | null {
  const idx = requireIndex()
  if (!idx) return null
  return indexFindFunction(idx, addr)
}

export interface BreakpointSyncResult {
  ok: boolean
  /** 实际下发的硬件断点地址（可能被 line2addr 挪到最近可执行行） */
  addr?: number
  error?: string
}

/**
 * 切换某文件某行的断点（下发到 openocd）。
 * - 需已有活跃调试会话与已加载符号；
 * - 行 → 地址经 lineToAddr（空行会落到下一条可执行语句，调试器惯例）。
 */
export async function toggleSourceBreakpoint(file: string, line: number, enable: boolean): Promise<BreakpointSyncResult> {
  if (!isDebugActive()) {
    return { ok: false, error: '调试会话未运行，请先连接调试器' }
  }
  const idx = requireIndex()
  if (!idx) {
    return { ok: false, error: '调试符号未加载，请先成功编译一次' }
  }
  const addr = indexLineToAddr(idx, file, line)
  if (addr === null) {
    return { ok: false, error: `无法把 ${file}:${line} 映射到地址（该文件可能没有调试信息）` }
  }
  return enable
    ? applyBreakpoint(addr)
    : clearBreakpoint(addr)
}

async function applyBreakpoint(addr: number): Promise<BreakpointSyncResult> {
  try {
    await setBreakpoint(addr)
    return { ok: true, addr }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function clearBreakpoint(addr: number): Promise<BreakpointSyncResult> {
  try {
    await removeBreakpoint(addr)
    return { ok: true, addr }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 停住后一次性取「当前行 + 所在函数」，供 UI 渲染（避免多次 IPC 往返） */
export function currentLocation(pc: number): { source: SourceLoc | null; fn: ElfSymbol | null } {
  return { source: addrToSource(pc), fn: functionAt(pc) }
}

/**
 * 回溯调用栈（帧指针法，需固件启用 -fno-omit-frame-pointer）。
 * 读寄存器拿 SP/FP，再读一段栈内存交给纯逻辑 walkCallStack 逐帧解析。
 * 做不了时如实返回 none + 原因，不硬凑。
 */
export async function callStack(maxFrames = 32): Promise<StackWalkResult> {
  const idx = requireIndex()
  if (!idx) return { frames: [], method: 'none', note: '调试符号未加载，请先成功编译一次' }
  try {
    const regs = await readRegisters()
    const roles = resolveRegRoles(regs)
    if (roles.sp === undefined) return { frames: [], method: 'none', note: '读不到栈指针(SP)' }
    const mem = await readRawBytes(roles.sp, 512) // 512B 足够回溯较深的调用
    return walkCallStack(roles, mem, roles.sp, idx, maxFrames)
  } catch (err) {
    return { frames: [], method: 'none', note: `读寄存器/栈失败：${(err as Error).message}` }
  }
}

/** 列出全局变量（Watch 候选）。若 .debug_info 可用则带精确类型。 */
export function globals(): GlobalVar[] {
  const idx = requireIndex()
  if (!idx) return []
  const base = vListGlobals(idx)
  const typed = cache?.typedGlobals ?? []
  // 用 DWARF 类型覆盖/补齐（DWARF 的 DW_OP_addr 更精确）
  const typeByName = new Map(typed.map((v) => [v.name, v.typeName]))
  return base.map((g) => ({ ...g, typeName: typeByName.get(g.name) }))
}

/** 读某个全局变量的当前值（走 openocd 读内存 + 按类型解释） */
export async function watchGlobal(name: string): Promise<VarValue> {
  const idx = requireIndex()
  if (!idx) throw new Error('调试符号未加载，请先成功编译一次')
  const val = await vReadGlobalVar(idx, name)
  const typed = (cache?.typedGlobals ?? []).find((v) => v.name === name)
  return { ...val, typeName: typed?.typeName }
}

export interface LocalVarInfo {
  name: string
  typeName: string
  /** 栈上地址 = 帧基址(FP) + DW_OP_fbreg 偏移 */
  addr: number
  offset: number
  funcName?: string
}

/**
 * 列出「当前 PC 所在函数」的局部变量及其栈地址。
 * 需要帧指针(FP)作为帧基址——与调用栈同一前提（固件启用 -fno-omit-frame-pointer）。
 */
export async function locals(): Promise<LocalVarInfo[]> {
  const idx = requireIndex()
  if (!idx || !cache) return []
  const typedLocals = cache.typedLocals
  if (typedLocals.length === 0) return []
  const regs = await readRegisters()
  const roles = resolveRegRoles(regs)
  if (roles.pc === undefined || roles.fp === undefined) return []
  const pc = roles.pc
  const fp = roles.fp
  // 选出 low_pc <= pc 且最接近 pc 的那个函数（帧基址取该函数 FP）
  let best: DwarfVar | null = null
  for (const v of typedLocals) {
    if (v.funcLowPc === undefined) continue
    if (v.funcLowPc <= pc && (!best || (best.funcLowPc ?? 0) < v.funcLowPc!)) best = v
  }
  if (!best) return []
  return typedLocals
    .filter((v) => v.funcLowPc === best!.funcLowPc)
    .map((v) => ({
      name: v.name,
      typeName: v.typeName,
      addr: fp + (v.fbreg ?? 0),
      offset: v.fbreg ?? 0,
      funcName: v.funcName
    }))
}

/** 读某个局部变量的当前值（按类型解释） */
export async function readLocalVarByName(name: string): Promise<VarValue> {
  const list = await locals()
  const v = list.find((x) => x.name === name)
  if (!v) throw new Error(`未找到局部变量 ${name}（可能已出作用域 / 未启用帧指针）`)
  // 按类型决定读多少字节
  const bytes = typeSizeGuess(v.typeName)
  const mem = await readRawBytes(v.addr, bytes)
  const interp = interpretBytes(mem)
  return { name: v.name, address: v.addr, size: bytes, typeName: v.typeName, ...interp }
}

/** 粗略按类型名猜字节数（够读值即可，精确大小需完整类型推导） */
function typeSizeGuess(t: string): number {
  const s = t.toLowerCase()
  if (s.includes('double') || s.includes('long long')) return 8
  if (s.includes('float')) return 4
  if (s.includes('char *') || s.includes('*')) return 4
  if (s.includes('long')) return 4
  if (s.includes('short')) return 2
  if (s.includes('bool')) return 1
  if (s.includes('char')) return 1
  return 4
}
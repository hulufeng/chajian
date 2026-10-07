/**
 * 变量 / Watch（主进程侧）—— 全局变量走 ELF 符号表，局部变量留待 .debug_info。
 *
 * 诚实边界（对齐项目「不编造、误报比漏报更烦人」）：
 *   - 全局变量：STT_OBJECT 符号直接给出 名字/地址/大小，**无需 .debug_info**，故本模块可靠。
 *   - 变量**类型**需解析 DWARF .debug_info（尚未接）。因此读回的值按**字节宽度**给出多种解释
 *     （hex / 有符号整数 / 浮点），并明确标注「类型未知」——**不假装知道它是 int 还是 float**。
 *   - 局部变量：需按作用域找 DIE + 栈偏移，尚未实现；接口预留但会如实返回「暂不支持」。
 */
import { type DebugIndex, type ElfSymbol } from './debug-symbols'
import { readRawBytes } from './debugService'

/** 读回字节 → 多种解释（纯函数，可单测）。不编造类型，只按宽度罗列。 */
export function interpretBytes(bytes: Buffer): {
  hex: string
  asInt: number | null
  asFloat: number | null
  /** 字节宽度对应的一句话提示 */
  hint: string
} {
  const hex = bytes.toString('hex')
  let asInt: number | null = null
  let asFloat: number | null = null
  let hint = ''
  const n = bytes.length
  try {
    if (n === 1) { asInt = bytes.readInt8(0); hint = 'int8' }
    else if (n === 2) { asInt = bytes.readInt16LE(0); hint = 'int16' }
    else if (n === 4) { asInt = bytes.readInt32LE(0); asFloat = bytes.readFloatLE(0); hint = 'int32 或 float32（类型未知，两种都列出）' }
    else if (n === 8) {
      const v = bytes.readBigInt64LE(0)
      asInt = Number(v) // 53 位精度内
      asFloat = bytes.readDoubleLE(0)
      hint = 'int64 / double / 指针（类型未知）'
    } else {
      asInt = null
      hint = `${n} 字节（结构体/数组等，仅显示原始字节）`
    }
  } catch {
    asInt = null
    hint = '解析失败，仅显示原始字节'
  }
  return { hex, asInt, asFloat, hint }
}

export interface GlobalVar {
  name: string
  address: number
  size: number
  /** DWARF 精确类型（如 int/float/char*）；.debug_info 不可用时为 undefined */
  typeName?: string
}

export interface VarValue extends GlobalVar {
  hex: string
  asInt: number | null
  asFloat: number | null
  hint: string
}

/** 列出可观察的全局变量（按地址升序）。objects 已由 buildDebugIndex 提好，直接用。 */
export function listGlobals(index: DebugIndex, limit = 500): GlobalVar[] {
  return (index.objects || [])
    .filter((s) => s.size > 0)
    .slice(0, limit)
    .map((s) => ({ name: s.name, address: s.value, size: s.size }))
    .sort((a, b) => a.address - b.address)
}

function findGlobal(index: DebugIndex, name: string): ElfSymbol | null {
  const target = String(name || '').trim()
  return (index.objects || []).find((s) => s.name === target && s.size > 0) ?? null
}

/** 按名字读一个全局变量的当前值（走 openocd 读内存） */
export async function readGlobalVar(index: DebugIndex, name: string): Promise<VarValue> {
  const sym = findGlobal(index, name)
  if (!sym) throw new Error(`未找到全局变量 ${name}（可能未编译进固件或被优化掉）`)
  const count = Math.min(Math.max(sym.size, 1), 64) // 防超大符号，一次最多读 64B
  const bytes = await readRawBytes(sym.value, count)
  const v = interpretBytes(bytes)
  return { name: sym.name, address: sym.value, size: sym.size, ...v }
}

/** 局部变量：需 .debug_info 作用域解析，尚未实现——如实说明，不糊弄 */
export async function readLocalVar(_index: DebugIndex, _func: string, _name: string): Promise<never> {
  throw new Error('局部变量查看暂不支持：需解析 DWARF .debug_info 的作用域与栈偏移（尚未实现）。全局变量可用。')
}

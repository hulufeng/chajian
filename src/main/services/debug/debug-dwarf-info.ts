/**
 * DWARF .debug_info / .debug_abbrev 解析（纯函数）——拿变量精确类型 + 局部变量位置。
 *
 * 只覆盖工具链最常见的 DWARF v2-4（32/64 位都能走）。目标是回答两个问题：
 *   1) 变量是什么类型（int / float / char* / 数组…）→ 读回值才能正确解释；
 *   2) 局部变量在栈上的位置（DW_OP_fbreg 偏移）→ 结合帧指针读出实时值。
 *
 * 诚实边界：遇到不认识的 form/tag 就**停止该 CU 解析并如实标记**，不硬猜。
 * 只做「够用」的解析：够取变量名/类型/位置，不做完整类型系统推导。
 */

// ── 读取游标 ──────────────────────────────────────────────────────────
class R {
  pos = 0
  constructor(public buf: Buffer) {}
  get eof(): boolean { return this.pos >= this.buf.length }
  u8(): number { return this.buf[this.pos++] }
  u16(little: boolean): number { const v = little ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos); this.pos += 2; return v }
  u32(little: boolean): number { const v = little ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos); this.pos += 4; return v }
  u64(little: boolean): number { const v = little ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos); this.pos += 8; return Number(v) }
  uleb(): number { let r = 0, s = 0; for (;;) { const b = this.u8(); r += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; if (s > 63) break } return r }
  sleb(): number { let r = 0, s = 0, b = 0; do { b = this.u8(); r += (b & 0x7f) * Math.pow(2, s); s += 7; if (s > 63) break } while (b & 0x80); if (s < 64 && (b & 0x40)) r -= Math.pow(2, s); return r }
  str(): string { const st = this.pos; while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++; const s = this.buf.toString('utf-8', st, this.pos); this.pos++; return s }
  skip(n: number): void { this.pos += n }
}

// ── 标签 / 属性 / 形式 常量 ──────────────────────────────────────────
const TAG_array_type = 0x01
const TAG_pointer_type = 0x0f
const TAG_compile_unit = 0x11
const TAG_structure_type = 0x13
const TAG_subroutine_type = 0x15
const TAG_typedef = 0x16
const TAG_union_type = 0x17
const TAG_base_type = 0x24
const TAG_const_type = 0x26
const TAG_subrange_type = 0x21
const TAG_enumeration_type = 0x04
const TAG_volatile_type = 0x35
const TAG_variable = 0x34
const TAG_formal_parameter = 0x05
const TAG_lexical_block = 0x0b
const TAG_subprogram = 0x2e

const AT_name = 0x03
const AT_byte_size = 0x0b
const AT_stmt_list = 0x10
const AT_low_pc = 0x11
const AT_high_pc = 0x12
const AT_encoding = 0x3e
const AT_external = 0x3f
const AT_location = 0x02
const AT_const_value = 0x1c
const AT_type = 0x49
const AT_declaration = 0x3c
const AT_prototyped = 0x27
const AT_upper_bound = 0x2f

// form
const FORM_addr = 0x01, FORM_block2 = 0x03, FORM_block4 = 0x04, FORM_data2 = 0x05
const FORM_data4 = 0x06, FORM_data8 = 0x07, FORM_string = 0x08, FORM_block = 0x09
const FORM_block1 = 0x0a, FORM_data1 = 0x0b, FORM_sdata = 0x0d, FORM_strp = 0x0e
const FORM_udata = 0x0f, FORM_ref_addr = 0x10, FORM_ref1 = 0x11, FORM_ref2 = 0x12
const FORM_ref4 = 0x13, FORM_ref8 = 0x14, FORM_indirect = 0x16, FORM_sec_offset = 0x17
const FORM_exprloc = 0x18, FORM_flag_present = 0x19, FORM_strx = 0x1a, FORM_data16 = 0x1e
const FORM_strx1 = 0x25, FORM_strx2 = 0x26, FORM_strx3 = 0x27, FORM_strx4 = 0x28
const FORM_ref_sup4 = 0x1c, FORM_strp_sup = 0x1d, FORM_addrx = 0x29
const FORM_ref_sup8 = 0x24, FORM_strx_addr = 0x2a

interface AbbrevAttr { attr: number; form: number; implicit?: number }
interface Abbrev { tag: number; hasChildren: boolean; attrs: AbbrevAttr[] }

/** 解析 .debug_abbrev → { abbrevCode → Abbrev }。返回的 Map 以 CU 的 abbrev_offset 为键。 */
export function parseAbbrev(buf: Buffer, little = true): Map<number, Abbrev> {
  const map = new Map<number, Abbrev>()
  const r = new R(buf)
  while (!r.eof) {
    const code = r.uleb()
    if (code === 0) break // 结束当前缩写表
    const tag = r.uleb()
    const hasChildren = r.u8() !== 0
    const attrs: AbbrevAttr[] = []
    for (;;) {
      const attr = r.uleb()
      const form = r.uleb()
      if (attr === 0 && form === 0) break
      if (attr !== 0) attrs.push({ attr, form })
    }
    map.set(code, { tag, hasChildren, attrs })
  }
  return map
}

export interface Die {
  offset: number
  tag: number
  /** 属性号 → 值（字符串/数字/字节数组/引用 offset） */
  attrs: Record<number, number | string | number[]>
  children: Die[]
}

export interface CUInfo {
  offset: number
  version: number
  abbrevOffset: number
  addressSize: number
  root: Die
  /** 该 CU 覆盖的机器码区间 [low, high)（high 可能为偏移，需加 low） */
  lowPc?: number
  highPc?: number
}

/** 读一个属性值（按 form）。无法处理的 form 抛错（调用方据此停止该 CU，如实标记）。 */
function readForm(r: R, form: number, little: boolean, addressSize: number, strBase: Buffer | null, implicitConst?: number): number | string | number[] {
  switch (form) {
    case FORM_addr: return addressSize === 8 ? r.u64(little) : r.u32(little)
    case FORM_data1: return r.u8()
    case FORM_data2: return r.u16(little)
    case FORM_data4: return r.u32(little)
    case FORM_data8: return r.u64(little)
    case FORM_sdata: return r.sleb()
    case FORM_udata: return r.uleb()
    case FORM_string: return r.str()
    case FORM_strp: {
      const off = r.u32(little)
      if (!strBase) throw new Error('DW_FORM_strp 需要 .debug_str')
      const rr = new R(strBase); rr.pos = off; return rr.str()
    }
    case FORM_exprloc: { const n = r.uleb(); const b: number[] = []; for (let i = 0; i < n; i++) b.push(r.u8()); return b }
    case FORM_block1: { const n = r.u8(); const b: number[] = []; for (let i = 0; i < n; i++) b.push(r.u8()); return b }
    case FORM_block2: { const n = r.u16(little); const b: number[] = []; for (let i = 0; i < n; i++) b.push(r.u8()); return b }
    case FORM_block4: { const n = r.u32(little); const b: number[] = []; for (let i = 0; i < n; i++) b.push(r.u8()); return b }
    case FORM_block: { const n = r.uleb(); const b: number[] = []; for (let i = 0; i < n; i++) b.push(r.u8()); return b }
    case FORM_flag_present: return 1
    case FORM_ref1: return r.u8()
    case FORM_ref2: return r.u16(little)
    case FORM_ref4: return r.u32(little)
    case FORM_ref8: return r.u64(little)
    case FORM_ref_addr: return addressSize === 8 ? r.u64(little) : r.u32(little)
    case FORM_sec_offset: return r.u32(little)
    case FORM_indirect: { const f2 = r.uleb(); return readForm(r, f2, little, addressSize, strBase) }
    case FORM_data16: { const b: number[] = []; for (let i = 0; i < 16; i++) b.push(r.u8()); return b }
    // DWARF5 索引形式：本模块不解析索引表（.debug_str_offsets），给出占位并跳过
    case FORM_strx: case FORM_strx1: case FORM_strx2: case FORM_strx3: case FORM_strx4:
    case FORM_addrx: case FORM_strx_addr:
      if (form === FORM_strx) r.uleb(); else if (form === FORM_strx1) r.u8(); else if (form === FORM_strx2) r.u16(little); else if (form === FORM_strx3) { r.u8(); r.u8(); r.u8() } else if (form === FORM_strx4) r.u32(little); else r.uleb()
      return `DW_FORM#${form}` // 不编造字符串
    case FORM_ref_sup4: r.u32(little); return 0
    case FORM_strp_sup: r.u32(little); return ''
    case FORM_ref_sup8: r.u64(little); return 0
    default:
      if (implicitConst !== undefined) return implicitConst
      throw new Error(`未支持的 DWARF form 0x${form.toString(16)}`)
  }
}

/** 解析 .debug_info 的单个 CU（含 DIE 树）。abbrevs 为该 CU 用的缩写表。 */
function parseCU(infoBuf: Buffer, base: number, little: boolean, abbrevs: Map<number, Abbrev>, strBase: Buffer | null): CUInfo | null {
  const r = new R(infoBuf)
  r.pos = base
  let unitLength = r.u32(little)
  let is64 = false
  if (unitLength === 0xffffffff) { unitLength = Number(r.u64(little)); is64 = true }
  const cuStart = r.pos
  const version = r.u16(little)
  if (version >= 5) return null // v5 头部/索引不同，暂不支持（诚实跳过）
  const abbrevOffset = is64 ? r.u64(little) : r.u32(little)
  const addressSize = r.u8()

  const cu: CUInfo = { offset: base, version, abbrevOffset, addressSize, root: { offset: base, tag: 0, attrs: {}, children: [] } }
  // 解析一棵 DIE 子树；返回 [子树, 结束位置]
  const parseDie = (): Die | null => {
    const off = r.pos
    const code = r.uleb()
    if (code === 0) return null // 结束子节点
    const ab = abbrevs.get(code)
    if (!ab) throw new Error(`未知缩写码 ${code}`)
    const die: Die = { offset: off, tag: ab.tag, attrs: {}, children: [] }
    for (const a of ab.attrs) {
      const v = readForm(r, a.form, little, addressSize, strBase, a.implicit)
      die.attrs[a.attr] = v as any
    }
    if (ab.hasChildren) {
      for (;;) {
        const child = parseDie()
        if (!child) break
        die.children.push(child)
      }
    }
    return die
  }
  const root = parseDie()
  if (!root) return null
  cu.root = root
  const low = root.attrs[AT_low_pc]
  if (typeof low === 'number') {
    cu.lowPc = low
    const high = root.attrs[AT_high_pc]
    if (typeof high === 'number') cu.highPc = high // v4: high_pc 可能是偏移
  }
  return cu
}

/** 解析整个 .debug_info，返回所有 CU。遇到不支持的 CU/版本就跳过（不编造）。 */
export function parseInfo(info: Buffer, abbrev: Buffer, str: Buffer | null, little = true): { cus: CUInfo[]; skipped: number; parseError?: string } {
  const abbrevMaps = new Map<number, Map<number, Abbrev>>()
  const cus: CUInfo[] = []
  let skipped = 0
  let parseError: string | undefined
  let pos = 0
  while (pos + 11 < info.length) {
    // 先预读 CU 头以确定 abbrev 偏移与下一个 CU 的起点（unit_length 精确推进）
    const head = new R(info); head.pos = pos
    let ul = head.u32(little)
    let is64 = false
    if (ul === 0xffffffff) { is64 = true; ul = Number(head.u64(little)) }
    const nextCu = is64 ? pos + 12 + ul : pos + 4 + ul
    const version = head.u16(little)
    if (version >= 5) { skipped++; break }
    const abbrevOffset = is64 ? head.u64(little) : head.u32(little)

    if (!abbrevMaps.has(abbrevOffset)) {
      const sub = new R(abbrev); sub.pos = abbrevOffset
      const m = new Map<number, Abbrev>()
      for (;;) {
        const code = sub.uleb()
        if (code === 0) break
        const tag = sub.uleb()
        const hasChildren = sub.u8() !== 0
        const attrs: AbbrevAttr[] = []
        for (;;) {
          const attr = sub.uleb()
          const form = sub.uleb()
          if (attr === 0 && form === 0) break
          if (attr !== 0) attrs.push({ attr, form })
        }
        m.set(code, { tag, hasChildren, attrs })
      }
      abbrevMaps.set(abbrevOffset, m)
    }
    try {
      const cu = parseCU(info, pos, little, abbrevMaps.get(abbrevOffset)!, str)
      if (!cu) { skipped++; break }
      cus.push(cu)
    } catch (err) {
      skipped++
      parseError = (err as Error).message
      break
    }
    if (nextCu <= pos) break // 防死循环
    pos = nextCu
  }
  return { cus, skipped, parseError }
}

// ── 类型解析 ──────────────────────────────────────────────────────────
const BASE_ENC: Record<number, string> = {
  0x02: 'bool', 0x04: 'float', 0x05: 'complex float', 0x08: 'string',
  0x01: 'addr', 0x03: 'double'
}

/** 由类型 DIE 的引用 offset 解析出类型名。offset 是全局 .debug_info 偏移，需配合 allDies。 */
export function resolveTypeName(typeOff: number | undefined, dies: Map<number, Die>, depth = 0): string {
  if (typeOff === undefined || depth > 8) return 'void'
  const d = dies.get(typeOff)
  if (!d) return 'void'
  switch (d.tag) {
    case TAG_base_type: {
      const n = typeof d.attrs[AT_name] === 'string' ? (d.attrs[AT_name] as string) : ''
      return n || BASE_ENC[d.attrs[AT_encoding] as number] || 'int'
    }
    case TAG_typedef: {
      const n = typeof d.attrs[AT_name] === 'string' ? (d.attrs[AT_name] as string) : ''
      return n || resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1)
    }
    case TAG_pointer_type:
      return resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1) + ' *'
    case TAG_const_type:
      return 'const ' + resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1)
    case TAG_volatile_type:
      return 'volatile ' + resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1)
    case TAG_structure_type: {
      const n = typeof d.attrs[AT_name] === 'string' ? (d.attrs[AT_name] as string) : ''
      return n ? `struct ${n}` : 'struct'
    }
    case TAG_union_type: {
      const n = typeof d.attrs[AT_name] === 'string' ? (d.attrs[AT_name] as string) : ''
      return n ? `union ${n}` : 'union'
    }
    case TAG_enumeration_type: {
      const n = typeof d.attrs[AT_name] === 'string' ? (d.attrs[AT_name] as string) : ''
      return n ? `enum ${n}` : 'enum'
    }
    case TAG_subroutine_type:
      return resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1) + ' (*)()'
    case TAG_array_type: {
      // 取第一个 subrange 的上界做长度
      let count = ''
      const sub = d.children.find((c) => c.tag === TAG_subrange_type)
      if (sub) {
        const ub = sub.attrs[AT_upper_bound]
        if (typeof ub === 'number') count = String(ub + 1)
      }
      return `${resolveTypeName(d.attrs[AT_type] as number, dies, depth + 1)}[${count}]`
    }
    default:
      return 'void'
  }
}

// ── 变量提取 ──────────────────────────────────────────────────────────
export interface DwarfVar {
  name: string
  typeName: string
  /** 全局：绝对地址；局部：DW_OP_fbreg 偏移（相对帧基址） */
  addr?: number
  fbreg?: number
  /** 字节大小（类型 DIE 推不出时为 undefined） */
  size?: number
  external: boolean
  /** 局部变量所属函数的 low_pc（用于按当前 PC 过滤只显示所在函数的局部变量） */
  funcLowPc?: number
  /** 局部变量所属函数名 */
  funcName?: string
}

function collectVars(die: Die, dies: Map<number, Die>, out: DwarfVar[], fnCtx: { lowPc?: number; name?: string } | null, depth = 0): void {
  if (depth > 24) return
  for (const c of die.children) {
    if (c.tag === TAG_variable) {
      const name = typeof c.attrs[AT_name] === 'string' ? (c.attrs[AT_name] as string) : ''
      if (name) {
        const typeName = resolveTypeName(c.attrs[AT_type] as number, dies)
        const loc = c.attrs[AT_location] as number[] | undefined
        const v: DwarfVar = { name, typeName, external: !!c.attrs[AT_external] }
        if (loc && loc.length > 0) {
          const op = loc[0]
          if (op === 0x03) v.addr = decodeULEB(loc, 1) // DW_OP_addr
          else if (op === 0x91) v.fbreg = decodeSLEB(loc, 1) // DW_OP_fbreg
        }
        if (v.fbreg !== undefined && fnCtx) {
          v.funcLowPc = fnCtx.lowPc
          v.funcName = fnCtx.name
        }
        out.push(v)
      }
    } else if (c.tag === TAG_subprogram) {
      // 进入函数：记录其 low_pc / 名字，供局部变量按 PC 过滤
      const sub = c.tag === TAG_subprogram
        ? { lowPc: c.attrs[AT_low_pc] as number | undefined, name: typeof c.attrs[AT_name] === 'string' ? (c.attrs[AT_name] as string) : undefined }
        : fnCtx
      collectVars(c, dies, out, sub, depth + 1)
    } else if (c.tag === TAG_lexical_block || c.tag === TAG_formal_parameter) {
      collectVars(c, dies, out, fnCtx, depth + 1)
    }
  }
}

function decodeULEB(b: number[], start: number): number {
  let r = 0, s = 0, i = start
  for (; i < b.length; i++) { const x = b[i]; r += (x & 0x7f) * Math.pow(2, s); if (!(x & 0x80)) break; s += 7 }
  return r
}
function decodeSLEB(b: number[], start: number): number {
  let r = 0, s = 0, x = 0, i = start
  for (; i < b.length; i++) { x = b[i]; r += (x & 0x7f) * Math.pow(2, s); s += 7; if (!(x & 0x80)) break }
  if (s < 64 && (x & 0x40)) r -= Math.pow(2, s)
  return r
}

/** 从所有 CU 提取变量（全局 DW_OP_addr + 局部 DW_OP_fbreg）。 */
export function extractVariables(cus: CUInfo[]): { globals: DwarfVar[]; locals: DwarfVar[] } {
  const dies = new Map<number, Die>()
  for (const cu of cus) {
    // 收集所有 DIE（含嵌套）到全局 map，便于按 offset 查类型
    const walk = (d: Die) => { dies.set(d.offset, d); for (const c of d.children) walk(c) }
    walk(cu.root)
  }
  const all: DwarfVar[] = []
  for (const cu of cus) collectVars(cu.root, dies, all, null)
  return {
    globals: all.filter((v) => v.addr !== undefined),
    locals: all.filter((v) => v.fbreg !== undefined)
  }
}

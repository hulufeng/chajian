/**
 * 源码级调试符号解析（纯函数，零依赖，不碰 electron / 不 spawn）。
 *
 * 目的：把「编辑器里的行号」和「芯片里的运行时地址」打通，是源码级断点、
 * 当前行高亮、调用栈、变量视图的共同地基。
 *
 * 两层信息：
 *   1) ELF 符号表（.symtab/.dynsym）→ 函数/变量 名 ↔ 地址（任何固件都有）
 *   2) DWARF 行号表（.debug_line）→ 地址 ↔ 源码 文件:行（需编译带 -g）
 *
 * 重要原则（对齐项目约定「误报比漏报更烦人」「不编造」）：
 *   - 缺 .debug_line（没带 -g）→ 行号映射返回 null，只保留函数级映射，**绝不臆造行号**；
 *   - DWARF v5 行号表头部与 v2-4 不同，本模块只解 v2-4，遇到 v5 明确标记 unsupported，不猜。
 */

// ── ELF 常量 ──────────────────────────────────────────────────────────
const ET_EXEC = 2
const SHT_SYMTAB = 2
const SHT_STRTAB = 3
const SHT_DYNSYM = 11
const STT_OBJECT = 1
const STT_FUNC = 2
const STB_LOCAL = 0
const SHN_UNDEF = 0

export interface ElfSection {
  name: string
  type: number
  flags: number
  addr: number
  offset: number
  size: number
  link: number
  entsize: number
}

export interface ElfSymbol {
  name: string
  value: number
  size: number
  type: number
  bind: number
  shndx: number
}

export interface ElfFile {
  elfClass: 32 | 64
  endian: 'little' | 'big'
  machine: number
  type: number
  entry: number
  sections: ElfSection[]
  symbols: ElfSymbol[]
}

/** 从 ELF 节名表（.shstrtab）按偏移读 NUL 结尾字符串 */
function readCStr(buf: Buffer, base: number, off: number, little: boolean): string {
  if (base < 0 || base >= buf.length) return ''
  let i = base + off
  const end = buf.length
  while (i < end && buf[i] !== 0) i++
  return buf.toString('utf-8', base + off, i)
}

function u16(buf: Buffer, off: number, little: boolean): number {
  return little ? buf.readUInt16LE(off) : buf.readUInt16BE(off)
}
function u32(buf: Buffer, off: number, little: boolean): number {
  return little ? buf.readUInt32LE(off) : buf.readUInt32BE(off)
}
function u64(buf: Buffer, off: number, little: boolean): number {
  // ELF64 字段用 JS number（53 位）承载地址足够（固件地址远小于 2^53）
  const v = little ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off)
  return Number(v)
}

/**
 * 解析 ELF：头 + 节表 + 符号表（.symtab 优先，退 .dynsym）。
 * buf 必须是完整 ELF 文件字节。
 */
export function parseElf(buf: Buffer): ElfFile {
  // e_ident 校验
  if (buf.length < 16 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('不是 ELF 文件（魔数不对）')
  }
  const clsByte = buf[4]
  const dataByte = buf[5]
  const elfClass: 32 | 64 = clsByte === 2 ? 64 : 32
  const little = dataByte !== 2 // EI_DATA=2 是大端；1/0 为小端
  const machine = u16(buf, 18, little)

  let shoff: number
  let shentsize: number
  let shnum: number
  let shstrndx: number
  let entry: number
  let eType: number
  if (elfClass === 64) {
    eType = u16(buf, 16, little)
    entry = u64(buf, 24, little)
    shoff = u64(buf, 40, little)
    shentsize = u16(buf, 58, little)
    shnum = u16(buf, 60, little)
    shstrndx = u16(buf, 62, little)
  } else {
    eType = u16(buf, 16, little)
    entry = u32(buf, 24, little)
    shoff = u32(buf, 32, little)
    shentsize = u16(buf, 46, little)
    shnum = u16(buf, 48, little)
    shstrndx = u16(buf, 50, little)
  }

  // 先读节表（还没有名字，靠索引定位 .shstrtab 再回填 name）
  const rawSections: Array<Omit<ElfSection, 'name'>> = []
  for (let i = 0; i < shnum; i++) {
    const off = shoff + i * shentsize
    if (off < 0 || off + shentsize > buf.length) break
    let s: Omit<ElfSection, 'name'>
    if (elfClass === 64) {
      s = {
        type: u32(buf, off + 4, little),
        flags: u64(buf, off + 8, little),
        addr: u64(buf, off + 16, little),
        offset: u64(buf, off + 24, little),
        size: u64(buf, off + 32, little),
        link: u32(buf, off + 40, little),
        entsize: u64(buf, off + 56, little)
      }
    } else {
      s = {
        type: u32(buf, off + 4, little),
        flags: u32(buf, off + 8, little),
        addr: u32(buf, off + 12, little),
        offset: u32(buf, off + 16, little),
        size: u32(buf, off + 20, little),
        link: u32(buf, off + 24, little),
        entsize: u32(buf, off + 36, little)
      }
    }
    rawSections.push(s)
  }

  // 节名表
  let shstrBase = -1
  let shstrSize = 0
  if (shstrndx >= 0 && shstrndx < rawSections.length) {
    shstrBase = rawSections[shstrndx].offset
    shstrSize = rawSections[shstrndx].size
  }
  const sections: ElfSection[] = rawSections.map((s, i) => {
    let name = ''
    if (shstrBase >= 0) {
      // sh_name 在节头首 4 字节（32/64 都是 u32）
      const sh_name = u32(buf, shoff + i * shentsize, little)
      if (sh_name < shstrSize) name = readCStr(buf, shstrBase, sh_name, little)
    }
    return { ...s, name }
  })

  // 符号表：优先 .symtab(type 2)，否则 .dynsym(type 11)
  let symTabIdx = sections.findIndex((s) => s.type === SHT_SYMTAB)
  if (symTabIdx < 0) symTabIdx = sections.findIndex((s) => s.type === SHT_DYNSYM)

  const symbols: ElfSymbol[] = []
  if (symTabIdx >= 0) {
    const sym = sections[symTabIdx]
    const strSec = sym.link >= 0 && sym.link < sections.length ? sections[sym.link] : null
    const strBase = strSec ? strSec.offset : -1
    const entsize = sym.entsize || (elfClass === 64 ? 24 : 16)
    const count = entsize > 0 ? Math.floor(sym.size / entsize) : 0
    for (let i = 0; i < count; i++) {
      const off = sym.offset + i * entsize
      if (off < 0 || off + entsize > buf.length) break
      let st_name: number, st_value: number, st_size: number, st_info: number, shndx: number
      if (elfClass === 64) {
        st_name = u32(buf, off, little)
        st_info = buf[off + 4]
        shndx = u16(buf, off + 6, little)
        st_value = u64(buf, off + 8, little)
        st_size = u64(buf, off + 16, little)
      } else {
        st_name = u32(buf, off, little)
        st_value = u32(buf, off + 4, little)
        st_size = u32(buf, off + 8, little)
        st_info = buf[off + 12]
        shndx = u16(buf, off + 14, little)
      }
      const name = strBase >= 0 ? readCStr(buf, strBase, st_name, little) : ''
      symbols.push({
        name,
        value: st_value,
        size: st_size,
        type: st_info & 0xf,
        bind: (st_info >> 4) & 0xf,
        shndx
      })
    }
  }

  return { elfClass, endian: little ? 'little' : 'big', machine, type: eType, entry, sections, symbols }
}

export function getSection(elf: ElfFile, name: string): ElfSection | undefined {
  return elf.sections.find((s) => s.name === name)
}

/** 只取有意义的函数符号（STT_FUNC、有地址、非 UNDEF、名字合法），按地址升序 */
export function functionSymbols(elf: ElfFile): ElfSymbol[] {
  return elf.symbols
    .filter(
      (s) =>
        s.type === STT_FUNC &&
        s.shndx !== SHN_UNDEF &&
        s.value !== 0 &&
        s.name.length > 0 &&
        // 跳过汇编内部标签（下划线/点开头）与编译器合成名
        !/^[._]/.test(s.name)
    )
    .sort((a, b) => a.value - b.value)
}

/** 全局/静态数据符号（STT_OBJECT），变量视图用 */
export function objectSymbols(elf: ElfFile): ElfSymbol[] {
  return elf.symbols.filter(
    (s) => s.type === STT_OBJECT && s.shndx !== SHN_UNDEF && s.value !== 0 && s.name.length > 0 && !/^[._]/.test(s.name)
  )
}

// ── DWARF .debug_line 行号程序（v2-4） ────────────────────────────────

export interface LineRow {
  address: number
  /** 文件编号（DWARF file index，1-based） */
  file: number
  line: number
  column: number
  isStmt: boolean
  endSequence: boolean
}

interface Cursor {
  buf: Buffer
  pos: number
  little: boolean
  addrSize: number
  /** 当前 section 末尾（行号程序循环边界） */
  unitEnd: number
}

function readU8(c: Cursor): number {
  return c.buf[c.pos++]
}
function readU16(c: Cursor): number {
  const v = c.little ? c.buf.readUInt16LE(c.pos) : c.buf.readUInt16BE(c.pos)
  c.pos += 2
  return v
}
function readU32(c: Cursor): number {
  const v = c.little ? c.buf.readUInt32LE(c.pos) : c.buf.readUInt32BE(c.pos)
  c.pos += 4
  return v
}
function readU64(c: Cursor): number {
  const v = c.little ? c.buf.readBigUInt64LE(c.pos) : c.buf.readBigUInt64BE(c.pos)
  c.pos += 8
  return Number(v)
}
function readULEB(c: Cursor): number {
  let result = 0
  let shift = 0
  for (;;) {
    const b = readU8(c)
    result += (b & 0x7f) * Math.pow(2, shift)
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 63) break // 防畸形文件死循环
  }
  return result
}
function readSLEB(c: Cursor): number {
  let result = 0
  let shift = 0
  let byte = 0
  do {
    byte = readU8(c)
    result += (byte & 0x7f) * Math.pow(2, shift)
    shift += 7
    if (shift > 63) break
  } while (byte & 0x80)
  // 符号扩展
  if (shift < 64 && byte & 0x40) {
    result -= Math.pow(2, shift)
  }
  return result
}
/** 读 NUL 结尾字符串 */
function readStr(c: Cursor): string {
  const start = c.pos
  while (c.pos < c.buf.length && c.buf[c.pos] !== 0) c.pos++
  const s = c.buf.toString('utf-8', start, c.pos)
  c.pos++ // 跳过 NUL
  return s
}

/** 解析一个 .debug_line 编译单元，返回行表（只支持 version 2-4；v5 返回 unsupported 标记） */
function parseLineUnit(c: Cursor): { rows: LineRow[]; files: string[]; unsupported?: 'v5' } {
  const rows: LineRow[] = []
  const files: string[] = [''] // file 编号 1-based，索引 0 占位

  const unit_length = readU32(c)
  if (unit_length === 0xffffffff) {
    // DWARF64：长度是 8 字节 we've already consumed 4 for 0xffffffff; 读掉真正长度
    const len64 = readU64(c)
    void len64 // 后续字段按 64 位地址解析即可
  }
  const version = readU16(c)
  if (version >= 5) {
    // v5 头部格式不同（目录/文件用格式串描述），本模块不解；标记由调用方处理
    return { rows, files, unsupported: 'v5' }
  }

  const header_length = readU32(c)
  const program_start = c.pos + header_length

  const min_inst_len = readU8(c)
  let max_ops = 1
  if (version >= 4) {
    max_ops = readU8(c) || 1
  }
  void max_ops // VLIW 暂不支持特殊寻址，按 1 处理
  const default_is_stmt = readU8(c) !== 0
  const line_base = (readU8(c) << 24) >> 24 // sbyte
  const line_range = readU8(c)
  const opcode_base = readU8(c)
  const std_lengths: number[] = []
  for (let i = 1; i < opcode_base; i++) std_lengths.push(readU8(c))

  // include_directories：NUL 结尾字符串序列，空串结束
  const dirs: string[] = []
  for (;;) {
    const d = readStr(c)
    if (d === '') break
    dirs.push(d)
  }

  // file_names（v2-4）：{name, dir_index(ULEB), mtime(ULEB), length(ULEB)}，空名结束
  for (;;) {
    if (c.pos >= c.buf.length) break
    const name = readStr(c)
    if (name === '') break
    readULEB(c) // dir index
    readULEB(c) // mtime
    readULEB(c) // length
    files.push(name)
  }

  // 跳到行号程序
  c.pos = program_start

  // 状态机寄存器
  let address = 0
  let file = 1
  let line = 1
  let column = 0
  let is_stmt = default_is_stmt

  const emit = (endSequence: boolean): void => {
    rows.push({ address, file, line, column, isStmt: is_stmt, endSequence })
  }
  const resetState = (): void => {
    address = 0
    file = 1
    line = 1
    column = 0
    is_stmt = default_is_stmt
  }

  const unitEnd = c.unitEnd
  let unitDone = false
  while (c.pos < unitEnd && !unitDone) {
    const opcode = readU8(c)
    if (opcode >= opcode_base) {
      // 特殊操作码
      const adjusted = opcode - opcode_base
      address += min_inst_len * Math.floor(adjusted / line_range)
      line += line_base + (adjusted % line_range)
      emit(false)
    } else if (opcode === 0) {
      // 扩展操作码
      const len = readULEB(c)
      const end = c.pos + len
      const sub = readU8(c)
      if (sub === 1) {
        // DW_LNE_end_sequence：一个单元程序的结束标志，emit 后必须跳出，
        // 否则会把「下一个编译单元」的头（unit_length 等）当成操作码继续解析。
        emit(true)
        resetState()
        unitDone = true
      } else if (sub === 2) {
        // DW_LNE_set_address
        if (c.addrSize === 8) address = readU64(c)
        else address = readU32(c)
      } else if (sub === 3) {
        // DW_LNE_define_file
        const name = readStr(c)
        readULEB(c)
        readULEB(c)
        readULEB(c)
        files.push(name)
      }
      // DW_LNE_set_discriminator(4) 等忽略；无论如何对齐到 end
      c.pos = end
    } else {
      switch (opcode) {
        case 1: // DW_LNS_copy
          emit(false)
          break
        case 2: // DW_LNS_advance_pc
          address += min_inst_len * readULEB(c)
          break
        case 3: // DW_LNS_advance_line
          line += readSLEB(c)
          break
        case 4: // DW_LNS_set_file
          file = readULEB(c)
          break
        case 5: // DW_LNS_set_column
          column = readULEB(c)
          break
        case 6: // DW_LNS_negate_stmt
          is_stmt = !is_stmt
          break
        case 7: // DW_LNS_set_basic_block
          break
        case 8: // DW_LNS_const_add_pc
          address += min_inst_len * Math.floor((255 - opcode_base) / line_range)
          break
        case 9: // DW_LNS_fixed_advance_pc
          address += readU16(c)
          break
        case 10: // DW_LNS_set_prologue_end
        case 11: // DW_LNS_set_epilogue_begin
          break
        case 12: // DW_LNS_set_isa
          readULEB(c)
          break
        default: {
          // 未知标准操作码：按 std_opcode_lengths 跳过其 ULEB 操作数
          const n = std_lengths[opcode - 1] ?? 0
          for (let k = 0; k < n; k++) readULEB(c)
          break
        }
      }
    }
  }
  return { rows, files }
}

// ── 调试索引 ──────────────────────────────────────────────────────────

export interface SourceLoc {
  file: string
  line: number
  column?: number
}

export interface DebugIndex {
  elfClass: 32 | 64
  machine: number
  entry: number
  /** 行号表（按 address 升序） */
  rows: LineRow[]
  /** file 编号 → 文件名 */
  files: string[]
  /** 函数符号（按地址升序） */
  functions: ElfSymbol[]
  /** 数据符号 */
  objects: ElfSymbol[]
  /** 是否含行号表（需 -g） */
  hasLineInfo: boolean
  /** DWARF 版本 ≥5（未支持行号解析） */
  dwarfUnsupported: boolean
  /** 行号表解析失败的原因（供 UI 如实告知，不静默） */
  parseError?: string
}

function sortRows(rows: LineRow[]): LineRow[] {
  return rows.slice().sort((a, b) => a.address - b.address)
}

/**
 * 从 ELF 字节构建调试索引。缺 .debug_line 时仍返回函数级索引（hasLineInfo=false）。
 */
export function buildDebugIndex(elfBuf: Buffer): DebugIndex {
  const elf = parseElf(elfBuf)
  const functions = functionSymbols(elf)
  const objects = objectSymbols(elf)

  let rows: LineRow[] = []
  let files: string[] = ['']
  let dwarfUnsupported = false
  let parseError: string | undefined

  const lineSec = getSection(elf, '.debug_line')
  if (lineSec && lineSec.size > 0 && lineSec.offset + lineSec.size <= elfBuf.length) {
    const secBuf = elfBuf.subarray(lineSec.offset, lineSec.offset + lineSec.size)
    const c: Cursor & { unitEnd: number } = {
      buf: secBuf,
      pos: 0,
      little: elf.endian === 'little',
      addrSize: elf.elfClass === 64 ? 8 : 4,
      unitEnd: secBuf.length
    }
    // 多个编译单元连续排布，逐个解析直到段尾
    while (c.pos < secBuf.length - 4) {
      const before = c.pos
      try {
        const unit = parseLineUnit(c)
        if (unit.unsupported === 'v5') {
          dwarfUnsupported = true
          break
        }
        // 合并多单元：文件编号整体平移
        const fileBase = files.length - 1 // 当前单元 files[0] 是占位，偏移 = 已有真实文件数
        for (const r of unit.rows) {
          rows.push({ ...r, file: r.file + fileBase })
        }
        for (let i = 1; i < unit.files.length; i++) files.push(unit.files[i])
      } catch (err) {
        // 畸形数据：停止解析，保留已解出的部分（宁可漏不乱报），但如实记录原因
        parseError = (err as Error).message
        break
      }
      if (c.pos <= before) break // 无进展，防死循环
    }
  } else if (lineSec) {
    parseError = `.debug_line 越界（offset=${lineSec.offset}, size=${lineSec.size}）`
  }

  return {
    elfClass: elf.elfClass,
    machine: elf.machine,
    entry: elf.entry,
    rows: sortRows(rows),
    files,
    functions,
    objects,
    hasLineInfo: rows.length > 0,
    dwarfUnsupported,
    parseError
  }
}

/** 取包含地址 addr 的函数符号（地址落在 [value, value+size)） */
export function findFunction(index: DebugIndex, addr: number): ElfSymbol | null {
  const fns = index.functions
  // 二分找最后一个 value <= addr
  let lo = 0
  let hi = fns.length - 1
  let cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (fns[mid].value <= addr) {
      cand = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (cand < 0) return null
  const f = fns[cand]
  if (f.size > 0 && addr >= f.value + f.size) {
    // 落在函数之外（可能 gap / 下一个函数前的对齐）→ 仍返回最近的函数名但不可信
    return f
  }
  return f
}

/**
 * 地址 → 源码位置。二分找最后一个 address <= addr 的非 end_sequence 行。
 * 落在 end_sequence 之后（序列间隙）返回 null。
 */
export function addrToSource(index: DebugIndex, addr: number): SourceLoc | null {
  if (!index.hasLineInfo) return null
  const rows = index.rows
  let lo = 0
  let hi = rows.length - 1
  let cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].address <= addr) {
      cand = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (cand < 0) return null
  const row = rows[cand]
  if (row.endSequence) return null // 两个序列之间的间隙，无源码映射
  const file = index.files[row.file] || ''
  if (!file) return null
  return { file, line: row.line, column: row.column }
}

/**
 * (文件, 行) → 断点地址。精确命中优先；否则取该文件里「≥ 目标行的最近可执行行」
 * （编辑器在空行/注释上点断点时落到下一条真实语句，符合调试器惯例）。
 * 无行号表或找不到 → null（不编造）。
 */
export function lineToAddr(index: DebugIndex, file: string, line: number): number | null {
  if (!index.hasLineInfo) return null
  // 文件名匹配：精确 → 规范化（斜杠/反斜杠、去掉 ./ 前缀）→ 结尾匹配
  const target = normalizePath(file)
  const matchIdx = new Set<number>()
  for (let i = 1; i < index.files.length; i++) {
    const fn = normalizePath(index.files[i])
    if (!fn) continue
    if (fn === target || fn.endsWith('/' + target) || target.endsWith('/' + fn)) matchIdx.add(i)
  }
  if (matchIdx.size === 0) return null

  // 收集该文件所有非 end 行，按 (line, address) 升序
  const cands: Array<{ line: number; address: number }> = []
  for (const r of index.rows) {
    if (r.endSequence || !matchIdx.has(r.file)) continue
    cands.push({ line: r.line, address: r.address })
  }
  if (cands.length === 0) return null
  cands.sort((a, b) => (a.line - b.line) || (a.address - b.address))

  // 精确行
  for (const c of cands) if (c.line === line) return c.address
  // 否则：第一个 line > 目标 的地址（下一条语句）
  for (const c of cands) if (c.line > line) return c.address
  // 都小于目标（点在函数末尾）→ 取该文件最大地址
  return cands[cands.length - 1].address
}

function normalizePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}
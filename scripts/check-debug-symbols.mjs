/**
 * 源码级调试符号解析自检（合成 ELF/DWARF 夹具 + 真函数，不依赖 Electron）。
 *
 * 盯的是 Phase 1 地基的正确性：
 *   - parseElf：ELF32 头 / 节表 / 符号表（.symtab + 链接的 .strtab）解析；
 *   - buildDebugIndex：DWARF v4 .debug_line 行号程序状态机（set_address/advance_line/copy/end_sequence）；
 *   - addrToSource：地址 → 文件:行，含「end_sequence 之后为间隙→null」；
 *   - lineToAddr：文件:行 → 地址，精确命中 + 空行落到下一条语句（调试器惯例）；
 *   - findFunction：地址落在 [value, value+size) → 函数符号；
 *   - 边界：无 .debug_line（没 -g）→ hasLineInfo=false 且不编造行号；DWARF v5 → 明确标记 unsupported。
 *
 * 用法：node scripts/check-debug-symbols.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/debugSymbols.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/debug/debug-symbols.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + outfile.replace(/\\/g, '/'))
const { parseElf, buildDebugIndex, addrToSource, lineToAddr, findFunction, getSection, functionSymbols, objectSymbols } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 合成 ELF32 (LE, EM_XTENSA=94) 夹具 ────────────────────────────────
function buildStrtab(strings) {
  const parts = [Buffer.from([0])]
  const offsets = { '': 0 }
  let off = 1
  for (const s of strings) {
    offsets[s] = off
    const b = Buffer.from(s + '\0', 'utf-8')
    parts.push(b)
    off += b.length
  }
  return { buf: Buffer.concat(parts), offsets }
}

function sym32(nameOff, value, size, info, shndx) {
  const b = Buffer.alloc(16)
  b.writeUInt32LE(nameOff, 0)
  b.writeUInt32LE(value >>> 0, 4)
  b.writeUInt32LE(size >>> 0, 8)
  b[12] = info
  b[13] = 0
  b.writeUInt16LE(shndx, 14)
  return b
}

// DWARF v4 行号表：把 (addr→file:line) 编码成真实字节
function buildDebugLine(fileName, rows) {
  // 头部字段（min_inst_len 之后到 file_names 结束）
  const fileTable = Buffer.concat([
    Buffer.from(fileName + '\0', 'utf-8'),
    Buffer.from([0x00, 0x00, 0x00]), // dir_index/mtime/length = 0
    Buffer.from([0x00]) // file_names 结束
  ])
  const headerTail = Buffer.concat([
    Buffer.from([1]),        // min_inst_len
    Buffer.from([1]),        // max_ops_per_inst (v4)
    Buffer.from([1]),        // default_is_stmt
    Buffer.from([0xfb]),     // line_base = -5
    Buffer.from([14]),       // line_range
    Buffer.from([13]),       // opcode_base
    Buffer.from([0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1]), // std_opcode_lengths
    Buffer.from([0x00]),     // include_directories 结束
    fileTable
  ])
  // 行号程序：每行 set_address + advance_line + copy，最后 end_sequence
  const prog = []
  let curLine = 1
  for (const [addr, line] of rows) {
    prog.push(0x00, 0x05, 0x02, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >>> 24) & 0xff)
    let delta = line - curLine
    // SLEB128(小正数直接单字节；本夹具 delta 都小)
    prog.push(0x03, delta & 0x7f)
    prog.push(0x01) // DW_LNS_copy
    curLine = line
  }
  prog.push(0x00, 0x01, 0x01) // DW_LNE_end_sequence
  const program = Buffer.from(prog)
  const headerLength = headerTail.length
  const afterLen = 2 /*version*/ + 4 /*header_length*/ + headerLength + program.length
  const head = Buffer.alloc(10)
  head.writeUInt32LE(afterLen, 0) // unit_length
  head.writeUInt16LE(4, 4)        // version 4
  head.writeUInt32LE(headerLength, 6)
  return Buffer.concat([head, headerTail, program])
}

function buildElf({ symbols, debugLine, machine = 94 }) {
  const strtab = buildStrtab(symbols.map((s) => s.name).filter(Boolean))
  // 节名表
  const secNames = ['', '.text', '.data', '.symtab', '.strtab', '.shstrtab', '.debug_line']
  const shstrtab = buildStrtab(secNames.filter(Boolean))
  // sh_name 偏移（指向 shstrtab）
  const shNameOff = {}
  for (const n of secNames) if (n) shNameOff[n] = shstrtab.offsets[n]

  // 符号表
  const symBufs = [sym32(0, 0, 0, 0, 0)] // null symbol
  for (const s of symbols) {
    const type = s.kind === 'object' ? 1 : 2
    const info = (1 << 4) | type // STB_GLOBAL
    symBufs.push(sym32(strtab.offsets[s.name], s.value, s.size, info, s.kind === 'object' ? 2 : 1))
  }
  const symtab = Buffer.concat(symBufs)

  const sections = [
    { name: '', type: 0, offset: 0, size: 0 },
    { name: '.text', type: 1, offset: 0, size: 16 },
    { name: '.data', type: 1, offset: 0, size: 4 },
    { name: '.symtab', type: 2, offset: 0, size: symtab.length, link: 4, entsize: 16, info: 1 },
    { name: '.strtab', type: 3, offset: 0, size: strtab.buf.length },
    { name: '.shstrtab', type: 3, offset: 0, size: shstrtab.buf.length },
    ...(debugLine ? [{ name: '.debug_line', type: 1, offset: 0, size: debugLine.length }] : [])
  ]

  const ehsize = 52
  const shentsize = 40
  // 布局：ehdr | 各节数据 | shdr
  let cursor = ehsize
  const dataBufs = []
  for (const s of sections) {
    if (s.name === '.symtab') { s.offset = cursor; const b = symtab; dataBufs.push(b); cursor += b.length }
    else if (s.name === '.strtab') { s.offset = cursor; dataBufs.push(strtab.buf); cursor += strtab.buf.length }
    else if (s.name === '.shstrtab') { s.offset = cursor; dataBufs.push(shstrtab.buf); cursor += shstrtab.buf.length }
    else if (s.name === '.debug_line') { s.offset = cursor; dataBufs.push(debugLine); cursor += debugLine.length }
  }
  const shoff = cursor

  const eh = Buffer.alloc(ehsize)
  eh.writeUInt8(0x7f, 0); eh.write('ELF', 1, 'latin1')
  eh[4] = 1 // ELFCLASS32
  eh[5] = 1 // ELFDATA2LSB
  eh[6] = 1 // EV_CURRENT
  eh.writeUInt16LE(2, 16)  // e_type = ET_EXEC
  eh.writeUInt16LE(machine, 18)
  eh.writeUInt32LE(1, 20)  // e_version
  eh.writeUInt32LE(0x400d0000, 24) // e_entry
  eh.writeUInt32LE(0, 28)  // e_phoff
  eh.writeUInt32LE(shoff, 32)
  eh.writeUInt32LE(0, 36)  // e_flags
  eh.writeUInt16LE(ehsize, 40)
  eh.writeUInt16LE(0, 42)
  eh.writeUInt16LE(0, 44)
  eh.writeUInt16LE(shentsize, 46)
  eh.writeUInt16LE(sections.length, 48)
  eh.writeUInt16LE(5, 50) // e_shstrndx = .shstrtab

  const shBufs = sections.map((s) => {
    const b = Buffer.alloc(shentsize)
    b.writeUInt32LE(s.name ? shNameOff[s.name] : 0, 0)
    b.writeUInt32LE(s.type, 4)
    b.writeUInt32LE(0, 8)
    b.writeUInt32LE(0, 12)
    b.writeUInt32LE(s.offset, 16)
    b.writeUInt32LE(s.size, 20)
    b.writeUInt32LE(s.link ?? 0, 24)
    b.writeUInt32LE(s.info ?? 0, 28)
    b.writeUInt32LE(4, 32)
    b.writeUInt32LE(s.entsize ?? 0, 36)
    return b
  })

  return Buffer.concat([eh, ...dataBufs, ...shBufs])
}

const SYMBOLS = [
  { name: 'setup', value: 0x400d0000, size: 0x40, kind: 'func' },
  { name: 'loop', value: 0x400d0040, size: 0x30, kind: 'func' },
  { name: 'g_counter', value: 0x3fcb0000, size: 4, kind: 'object' }
]
const LINE_ROWS = [
  [0x400d0000, 10],
  [0x400d0010, 11],
  [0x400d0020, 12],
  [0x400d0040, 20],
  [0x400d0050, 21]
]
const debugLine = buildDebugLine('main.cpp', LINE_ROWS)
const elfBuf = buildElf({ symbols: SYMBOLS, debugLine })

// ── ① parseElf ────────────────────────────────────────────────────────
{
  const elf = parseElf(elfBuf)
  check('① ELF32 小端 / machine=94(XTENSA)', elf.elfClass === 32 && elf.endian === 'little' && elf.machine === 94,
    `${elf.elfClass}/${elf.endian}/${elf.machine}`)
  check('  ↳ e_entry 解析正确 (0x400d0000)', elf.entry === 0x400d0000, elf.entry.toString(16))
  check('  ↳ 节名表解析（.debug_line 存在）', !!getSection(elf, '.debug_line') && !!getSection(elf, '.symtab'))
  const fns = functionSymbols(elf)
  check('  ↳ 函数符号 2 个且按地址升序', fns.length === 2 && fns[0].name === 'setup' && fns[1].name === 'loop',
    fns.map((f) => f.name).join(','))
  const objs = objectSymbols(elf)
  check('  ↳ 数据符号 g_counter 解析', objs.length === 1 && objs[0].name === 'g_counter' && objs[0].value === 0x3fcb0000,
    JSON.stringify(objs[0]))
}

// ── ② buildDebugIndex：行号表解析 ──────────────────────────────────────
let idx = null
{
  idx = buildDebugIndex(elfBuf)
  check('② hasLineInfo=true 且未标 unsupported', idx.hasLineInfo === true && idx.dwarfUnsupported === false,
    `hasLineInfo=${idx.hasLineInfo} unsupported=${idx.dwarfUnsupported} parseError=${idx.parseError}`)
  check('  ↳ 解析出 5 条有效行（+1 end_sequence）', idx.rows.filter((r) => !r.endSequence).length === 5,
    `rows=${idx.rows.length} parseError=${idx.parseError}`)
  check('  ↳ 文件表含 main.cpp', idx.files.includes('main.cpp'), idx.files.join(','))
}

// ── ③ addrToSource：地址 → 文件:行 ────────────────────────────────────
{
  const a = addrToSource(idx, 0x400d0010)
  check('③ 精确地址 0x...10 → main.cpp:11', a && a.file === 'main.cpp' && a.line === 11, JSON.stringify(a))
  const b = addrToSource(idx, 0x400d0018) // 落在 0x10 与 0x20 之间 → 归属 0x10 那行
  check('  ↳ 区间内地址归属上一条语句行(11)', b && b.line === 11, JSON.stringify(b))
  const c = addrToSource(idx, 0x400d0048) // 落在 setup 尾部之后的 loop 区间
  check('  ↳ 0x...48 → main.cpp:20', c && c.line === 20, JSON.stringify(c))
  // end_sequence(0x400d0050) 之后的地址属于序列间隙 → null（不编造）
  const d = addrToSource(idx, 0x400d0200)
  check('  ↳ end_sequence 之后为间隙 → null', d === null, JSON.stringify(d))
}

// ── ④ lineToAddr：文件:行 → 地址 ──────────────────────────────────────
{
  check('④ main.cpp:11 → 0x400d0010', lineToAddr(idx, 'main.cpp', 11) === 0x400d0010, String(lineToAddr(idx, 'main.cpp', 11)))
  check('  ↳ main.cpp:20 → 0x400d0040', lineToAddr(idx, 'main.cpp', 20) === 0x400d0040, String(lineToAddr(idx, 'main.cpp', 20)))
  // 空行/注释行 13 不存在 → 落到下一条可执行语句(20)
  check('  ↳ 空行 13 落到下一条语句(20→0x400d0040)', lineToAddr(idx, 'main.cpp', 13) === 0x400d0040,
    String(lineToAddr(idx, 'main.cpp', 13)))
  check('  ↳ 路径分隔符无关（反斜杠也能匹配）', lineToAddr(idx, 'src\\main.cpp', 11) === 0x400d0010,
    String(lineToAddr(idx, 'src\\main.cpp', 11)))
  check('  ↳ 不存在的文件 → null', lineToAddr(idx, 'other.cpp', 11) === null)
}

// ── ⑤ findFunction：地址 → 函数 ───────────────────────────────────────
{
  check('⑤ 0x...10 → setup', findFunction(idx, 0x400d0010)?.name === 'setup', findFunction(idx, 0x400d0010)?.name)
  check('  ↳ 0x...50 → loop', findFunction(idx, 0x400d0050)?.name === 'loop', findFunction(idx, 0x400d0050)?.name)
}

// ── ⑥ 边界：无 .debug_line（没 -g）→ 不编造行号 ────────────────────────
{
  const noLine = buildElf({ symbols: SYMBOLS, debugLine: null })
  const ni = buildDebugIndex(noLine)
  check('⑥ 无 .debug_line → hasLineInfo=false', ni.hasLineInfo === false)
  check('  ↳ addrToSource 返回 null（不臆造）', addrToSource(ni, 0x400d0010) === null)
  check('  ↳ lineToAddr 返回 null', lineToAddr(ni, 'main.cpp', 11) === null)
  check('  ↳ 但函数级映射仍在（findFunction 可用）', findFunction(ni, 0x400d0010)?.name === 'setup')
}

// ── ⑦ 边界：DWARF v5 → 明确 unsupported，不猜 ───────────────────────
{
  // 造一个 version=5 的行号表头（只到能判定版本即可）
  const v5 = Buffer.concat([Buffer.alloc(4), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(5, 0); return b })(), Buffer.alloc(8)])
  const elf5 = buildElf({ symbols: SYMBOLS, debugLine: v5 })
  const i5 = buildDebugIndex(elf5)
  check('⑦ DWARF v5 → dwarfUnsupported=true', i5.dwarfUnsupported === true, JSON.stringify({ u: i5.dwarfUnsupported }))
  check('  ↳ v5 不产出行（不猜）', i5.hasLineInfo === false)
}

// ── ⑧ 断点状态模型（渲染层纯逻辑） ─────────────────────────────────────
{
  const bpOut = 'scripts/.tmp/debugBreakpoints.bundle.mjs'
  buildSync({
    entryPoints: ['src/renderer/src/components/editor/debugBreakpoints.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bpOut
  })
  const bp = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + bpOut.replace(/\\/g, '/'))
  let list = []
  list = bp.toggleBreakpoint(list, 'main.cpp', 10)
  check('⑧ 点一下加断点', list.length === 1 && bp.hasBreakpoint(list, 'main.cpp', 10))
  list = bp.toggleBreakpoint(list, 'main.cpp', 10)
  check('  ↳ 再点取消', list.length === 0 && !bp.hasBreakpoint(list, 'main.cpp', 10))
  list = bp.toggleBreakpoint(list, 'main.cpp', 12)
  list = bp.toggleBreakpoint(list, 'main.cpp', 10)
  check('  ↳ 多行断点按行升序', JSON.stringify(bp.breakpointsForFile(list, 'main.cpp')) === '[10,12]',
    JSON.stringify(bp.breakpointsForFile(list, 'main.cpp')))
  check('  ↳ 路径归一：.\\main.cpp 与 ./main.cpp 命中同一文件', bp.hasBreakpoint(list, '.\\main.cpp', 10) && bp.hasBreakpoint(list, './main.cpp', 10))
  check('  ↳ 真正不同的文件(src/main.cpp)不算同一文件', !bp.hasBreakpoint(list, 'src/main.cpp', 10))
  list = bp.toggleBreakpoint(list, 'other.cpp', 5)
  check('  ↳ 跨文件隔离', bp.breakpointsForFile(list, 'main.cpp').length === 2 && bp.breakpointsForFile(list, 'other.cpp').length === 1)
  const cleared = bp.removeBreakpointsForFile(list, 'main.cpp')
  check('  ↳ 清某文件断点', cleared.length === 1 && bp.hasBreakpoint(cleared, 'other.cpp', 5))
  check('  ↳ 非法行号被忽略', bp.toggleBreakpoint(list, 'main.cpp', 0).length === list.length)
}

// ── ⑨ 调用栈帧指针回溯（纯逻辑，合成栈内存） ──────────────────────────
{
  const csOut = 'scripts/.tmp/debugCallstack.bundle.mjs'
  buildSync({ entryPoints: ['src/main/services/debug/debug-callstack.ts'], bundle: true, format: 'esm', platform: 'node', outfile: csOut })
  const cs = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + csOut.replace(/\\/g, '/'))

  // 寄存器角色解析：ARM(Cortex-M) / RISC-V / 无帧指针
  const arm = cs.resolveRegRoles([{ name: 'pc', num: 1 }, { name: 'sp', num: 2 }, { name: 'r7', num: 3 }, { name: 'lr', num: 4 }])
  check('⑨ ARM: fp 命中 r7', arm.fp === 3 && arm.lr === 4, JSON.stringify(arm.names))
  const rv = cs.resolveRegRoles([{ name: 'pc', num: 1 }, { name: 'sp', num: 2 }, { name: 's0', num: 5 }, { name: 'ra', num: 6 }])
  check('  ↳ RISC-V: fp 命中 s0、链接寄存器 ra', rv.fp === 5 && rv.lr === 6, JSON.stringify(rv.names))

  // 合成栈：memBase=0x1000，帧链 loop→setup→setup
  const mem = Buffer.alloc(64, 0)
  mem.writeUInt32LE(0x1020, 0x10)      // [0x1010]=前一帧FP
  mem.writeUInt32LE(0x400d0020, 0x14)  // [0x1014]=返回地址(setup 内)
  mem.writeUInt32LE(0, 0x20)            // [0x1020]=前一帧FP=0(链尾)
  mem.writeUInt32LE(0x400d0010, 0x24)  // [0x1024]=返回地址(setup 内)
  const roles = { pc: 0x400d0048, sp: 0x1000, fp: 0x1010 }
  const r = cs.walkCallStack(roles, mem, 0x1000, idx)
  check('  ↳ 帧指针回溯出 3 帧且 method=frame-pointer', r.frames.length === 3 && r.method === 'frame-pointer',
    `frames=${r.frames.length} method=${r.method}`)
  check('  ↳ frame0 是当前 PC 且定位到 loop', r.frames[0].fn === 'loop' && r.frames[0].address === 0x400d0048,
    JSON.stringify(r.frames[0]))
  check('  ↳ frame1/2 映射回 setup 且带源码行', r.frames[1].fn === 'setup' && r.frames[1].file === 'main.cpp' && r.frames[1].line === 12,
    JSON.stringify(r.frames[1]))

  // 诚实失败：没有帧指针 → 不硬凑，如实返回 none
  const noFp = cs.walkCallStack({ pc: 0x400d0048, sp: 0x1000 }, mem, 0x1000, idx)
  check('  ↳ 无帧指针 → method=none 且如实说明', noFp.method === 'none' && /帧指针/.test(noFp.note), noFp.note)
  // 帧指针越界 → none
  const badFp = cs.walkCallStack({ pc: 0x400d0048, sp: 0x1000, fp: 0x9999 }, mem, 0x1000, idx)
  check('  ↳ 帧指针越界 → none', badFp.method === 'none', badFp.method)
}

// ── ⑩ 变量 Watch：数值解释（纯函数） + 全局变量列举 ─────────────────
{
  const vOut = 'scripts/.tmp/debugVariables.bundle.mjs'
  buildSync({ entryPoints: ['src/main/services/debug/debug-variables.ts'], bundle: true, format: 'esm', platform: 'node', outfile: vOut })
  const dv = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + vOut.replace(/\\/g, '/'))

  // 4 字节：既可能是 int32 也可能是 float32，两个解释都要给出
  const i4 = dv.interpretBytes(Buffer.from([0x78, 0x56, 0x34, 0x12]))
  check('⑩ 4 字节 hex 正确', i4.hex === '78563412', i4.hex)
  check('  ↳ 4 字节 int32 = 0x12345678', i4.asInt === 0x12345678, String(i4.asInt))
  check('  ↳ 4 字节也给出 float 解释且注明类型未知', i4.asFloat !== null && /类型未知/.test(i4.hint), i4.hint)
  // 8 字节
  const i8 = dv.interpretBytes(Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]))
  check('  ↳ 8 字节 int64=1', i8.asInt === 1, String(i8.asInt))
  // 1 字节
  check('  ↳ 1 字节 int8 负数正确', dv.interpretBytes(Buffer.from([0xff])).asInt === -1)
  // 非标长度 → 只给 hex
  const st = dv.interpretBytes(Buffer.alloc(12, 0xab))
  check('  ↳ 12 字节结构体只给 hex、asInt=null', st.asInt === null && st.hex.length === 24, `${st.asInt}/${st.hex}`)

  // 全局变量列举：合成 ELF 里有 g_counter（STT_OBJECT, size4）
  const g = dv.listGlobals(idx)
  check('  ↳ listGlobals 含 g_counter 且地址/大小正确', g.length >= 1 && g[0].name === 'g_counter' && g[0].address === 0x3fcb0000 && g[0].size === 4,
    JSON.stringify(g))
}

console.log(`[debug-symbols] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[debug-symbols] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('            -', f))
  process.exit(1)
}
console.log('[debug-symbols] ✓ 全部通过')
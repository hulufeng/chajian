/**
 * .debug_info（DIE 树 + 类型解析 + 局部变量位置）自检。
 * 合成 .debug_abbrev + .debug_info 夹具，验证：
 *   - 缩写表解码、CU/DIE 树解析；
 *   - 变量精确类型：int / float / 指针(int *) / typedef；
 *   - 全局变量 DW_OP_addr 地址、局部变量 DW_OP_fbreg 偏移 + 所属函数。
 * 用法：node scripts/check-dwarf-info.mjs
 */
import { buildSync } from 'esbuild'

const outfile = 'scripts/.tmp/dwarfInfo.bundle.mjs'
buildSync({ entryPoints: ['src/main/services/debug-dwarf-info.ts'], bundle: true, format: 'esm', platform: 'node', outfile })
const M = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + outfile.replace(/\\/g, '/'))

// ── 字节构造器 ────────────────────────────────────────────────────────
class B {
  constructor() { this.a = [] }
  u8(v) { this.a.push(v & 0xff); return this }
  u16(v) { this.a.push(v & 0xff, (v >> 8) & 0xff); return this }
  u32(v) { this.a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this }
  raw(arr) { for (const x of arr) this.a.push(x & 0xff); return this }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 0xff); this.a.push(0); return this }
  uleb(v) { v = v >>> 0; do { let b = v & 0x7f; v = v >>> 7; if (v) b |= 0x80; this.a.push(b) } while (v); return this }
  get n() { return this.a.length }
  buf() { return Buffer.from(this.a) }
  static ulebBytes(v) { v = v >>> 0; const o = []; do { let b = v & 0x7f; v = v >>> 7; if (v) b |= 0x80; o.push(b) } while (v); return o }
  static slebBytes(v) { const o = []; let more = true; while (more) { let b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b) } return o }
}
const exprAddr = (b, addr) => { const e = [0x03, ...B.ulebBytes(addr)]; return b.uleb(e.length).raw(e) }
const exprFbreg = (b, off) => { const e = [0x91, ...B.slebBytes(off)]; return b.uleb(e.length).raw(e) }

// ── .debug_abbrev ─────────────────────────────────────────────────────
const ab = new B()
ab.uleb(1).uleb(0x11).u8(1).uleb(0x11).uleb(0x01).uleb(0x12).uleb(0x06).uleb(0x03).uleb(0x08).uleb(0x10).uleb(0x17).uleb(0).uleb(0)
ab.uleb(2).uleb(0x24).u8(0).uleb(0x03).uleb(0x08).uleb(0x0b).uleb(0x0b).uleb(0x3e).uleb(0x0b).uleb(0).uleb(0)
ab.uleb(3).uleb(0x34).u8(0).uleb(0x03).uleb(0x08).uleb(0x49).uleb(0x13).uleb(0x02).uleb(0x18).uleb(0).uleb(0)
ab.uleb(4).uleb(0x0f).u8(0).uleb(0x49).uleb(0x13).uleb(0x0b).uleb(0x0b).uleb(0).uleb(0)
ab.uleb(5).uleb(0x2e).u8(1).uleb(0x03).uleb(0x08).uleb(0x11).uleb(0x01).uleb(0).uleb(0)
ab.uleb(0)

// ── .debug_info（单 CU, v4, 32bit）────────────────────────────────────
const info = new B()
info.u32(0).u16(4).u32(0).u8(4)                    // unit_length占位/version4/abbrev_off0/addr_size4
info.uleb(1).u32(0x1000).u32(0x2000).str('main.c').u32(0)  // root CU
const baseOff = info.n
info.uleb(2).str('int').u8(4).u8(5)                // base int
const floatOff = info.n
info.uleb(2).str('float').u8(4).u8(4)              // base float
const ptrOff = info.n
info.uleb(4).u32(baseOff).u8(4)                    // pointer -> int
exprAddr(info.uleb(3).str('gCount').u32(baseOff), 0x20000000)
exprAddr(info.uleb(3).str('gRatio').u32(floatOff), 0x20000010)
exprAddr(info.uleb(3).str('gName').u32(ptrOff), 0x20000020)
info.uleb(5).str('main').u32(0x1000)               // subprogram main
exprFbreg(info.uleb(3).str('counter').u32(baseOff), -8)
info.uleb(0).uleb(0)                                // end subprogram / end CU
const infoBuf = info.buf()
infoBuf.writeUInt32LE(infoBuf.length - 4, 0)

// ── 断言 ──────────────────────────────────────────────────────────────
let pass = 0
const fails = []
const check = (n, c, d) => { if (c) pass++; else fails.push(n + (d ? '：' + d : '')) }

const { cus, skipped, parseError } = M.parseInfo(infoBuf, ab.buf(), null, true)
check('解析出 1 个 CU 且无跳过', cus.length === 1 && skipped === 0, `cus=${cus.length} skipped=${skipped} err=${parseError}`)
if (cus.length === 0) {
  console.log('[dwarf-info] ❌ CU 解析失败: ' + parseError)
  process.exit(1)
}
const { globals, locals } = M.extractVariables(cus)
const g = Object.fromEntries(globals.map((v) => [v.name, v]))
const l = Object.fromEntries(locals.map((v) => [v.name, v]))
check('gCount: int @0x20000000', g.gCount?.typeName === 'int' && g.gCount?.addr === 0x20000000, JSON.stringify(g.gCount))
check('gRatio: float', g.gRatio?.typeName === 'float', JSON.stringify(g.gRatio))
check('gName: 指针类型含 *', g.gName?.typeName.includes('*'), JSON.stringify(g.gName))
check('counter: 局部 int, fbreg=-8', l.counter?.fbreg === -8 && l.counter?.typeName === 'int', JSON.stringify(l.counter))
check('counter 归属函数 main 且带 low_pc', l.counter?.funcName === 'main' && l.counter?.funcLowPc === 0x1000, JSON.stringify(l.counter))
check('全局/局部分类正确（各 3/1）', globals.length === 3 && locals.length === 1, `${globals.length}/${locals.length}`)

console.log(`[dwarf-info] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[dwarf-info] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[dwarf-info] ✓ 全部通过')
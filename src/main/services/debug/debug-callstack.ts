/**
 * 调用栈回溯（帧指针法）—— 纯逻辑，不 spawn、不碰 electron。
 *
 * 诚实声明（重要，别误读成 GDB 级调用栈）：
 *   真正的调用栈需要 DWARF `.eh_frame` CFI + unwinder（那是 GDB 的活），本项目刻意不用 GDB。
 *   裸机 openocd 没有可靠 `bt`，因此这里只实现**帧指针回溯**：读帧指针(FP)链，
 *   每一帧 = { 前一个 FP, 返回地址 }。它**仅在固件启用了帧指针时成立**
 *   （编译加 -fno-omit-frame-pointer）。若固件省略了帧指针，本模块会**如实返回 none + 说明**，
 *   **绝不用「扫栈猜返回地址」硬凑一个像模像样的假栈**（对齐项目「不编造、误报比漏报更烦人」）。
 *
 * 寄存器角色按架构解析（openocd `reg` 的寄存器名因芯片而异）：
 *   PC  : pc / PC / rip …
 *   SP  : sp / SP / esp …
 *   FP  : fp / s0 / r7 / x8 / ebp …
 *   LR/RA: lr / ra / ra(xtensa a0?) …
 */
import { addrToSource, findFunction, type DebugIndex } from './debug-symbols'

export interface RegisterLike {
  name: string
  num?: number
}

export interface RegRoles {
  pc?: number
  sp?: number
  fp?: number
  lr?: number
  /** 命中的寄存器名（排障/展示用） */
  names?: { pc?: string; sp?: string; fp?: string; lr?: string }
}

/** 按寄存器名（大小写不敏感）匹配角色。返回第一个命中的值。 */
export function resolveRegRoles(regs: RegisterLike[]): RegRoles {
  const get = (names: string[]): { name: string; num: number } | null => {
    for (const r of regs) {
      if (r.num === undefined) continue
      const n = r.name.toLowerCase()
      if (names.includes(n)) return { name: r.name, num: r.num }
    }
    return null
  }
  const pc = get(['pc'])
  const sp = get(['sp', 'esp'])
  const fp = get(['fp', 's0', 'x8', 'r7', 'ebp', 'y29'])
  const lr = get(['lr', 'ra', 'x1', 'r14'])
  return {
    pc: pc?.num,
    sp: sp?.num,
    fp: fp?.num,
    lr: lr?.num,
    names: { pc: pc?.name, sp: sp?.name, fp: fp?.name, lr: lr?.name }
  }
}

export interface CallFrame {
  /** 0 = 当前帧 */
  index: number
  /** 返回地址（frame 0 为当前 PC） */
  address: number
  fn: string | null
  file: string | null
  line: number | null
  via: 'pc' | 'frame-pointer' | 'lr'
}

export type WalkMethod = 'frame-pointer' | 'lr-only' | 'none'

export interface StackWalkResult {
  frames: CallFrame[]
  method: WalkMethod
  /** 诚实说明：为什么是这个 method / 为什么没有帧 */
  note: string
}

/**
 * 帧指针回溯。
 * @param roles 寄存器角色（需含 fp；sp 用于校验链是否落在栈范围内）
 * @param mem   栈内存缓冲（从 sp 读出的一段）
 * @param memBase mem[0] 对应的真实地址（通常是 sp）
 * @param index 调试索引（用于把地址映射成函数/源码行）
 */
export function walkCallStack(
  roles: RegRoles,
  mem: Buffer,
  memBase: number,
  index: DebugIndex,
  maxFrames = 32
): StackWalkResult {
  const frames: CallFrame[] = []
  const pc = roles.pc
  if (pc === undefined) {
    return { frames, method: 'none', note: '读不到 PC，无法回溯' }
  }

  // frame 0：当前 PC
  frames.push(makeFrame(0, pc, index, 'pc'))

  const fp = roles.fp
  const sp = roles.sp ?? memBase
  const memEnd = memBase + mem.length

  if (fp === undefined) {
    // 没有帧指针寄存器 → 无法可靠回溯，如实说明（可退到只看 LR，但不冒充调用栈）
    const note = roles.lr !== undefined
      ? '固件/架构未提供帧指针(FP)寄存器，无法逐帧回溯；仅能给出当前 PC。启用 -fno-omit-frame-pointer 编译才有完整调用栈。'
      : '读不到帧指针(FP)与链接寄存器(LR)，无法回溯调用栈。'
    return { frames, method: 'none', note }
  }

  // 帧指针必须落在栈缓冲范围内，否则认为不可信
  const inMem = (a: number): boolean => a >= memBase && a + 8 <= memEnd
  if (!inMem(fp)) {
    return {
      frames,
      method: 'none',
      note: `帧指针 0x${fp.toString(16)} 不在已读取的栈范围（0x${memBase.toString(16)}~0x${memEnd.toString(16)}）内，无法逐帧回溯。`
    }
  }

  // 逐帧：标准 ARM EABI 帧布局 [fp] = 前一帧指针, [fp+4] = 返回地址
  let cur = fp
  const seen = new Set<number>([pc])
  for (let i = 1; i < maxFrames; i++) {
    if (!inMem(cur)) break
    const off = cur - memBase
    const prevFp = mem.readUInt32LE(off)
    const retAddr = mem.readUInt32LE(off + 4)
    // 返回地址必须像代码地址（能在已知函数范围里找到），否则链断了
    if (retAddr === 0 || seen.has(retAddr)) break
    if (!findFunction(index, retAddr)) break
    frames.push(makeFrame(i, retAddr, index, 'frame-pointer'))
    seen.add(retAddr)
    // 栈向低地址增长：上一帧 FP 应大于当前 FP（更靠近栈顶）；非递增视为链断
    if (prevFp <= cur || prevFp >= memEnd) break
    cur = prevFp
  }

  if (frames.length <= 1) {
    return {
      frames,
      method: 'none',
      note: '帧指针链只有当前帧（固件很可能省略了帧指针 / 首帧返回地址不在已知符号内）。'
    }
  }
  return {
    frames,
    method: 'frame-pointer',
    note: `帧指针回溯 ${frames.length} 帧（需固件启用 -fno-omit-frame-pointer）。`
  }
}

function makeFrame(index: number, address: number, index2: DebugIndex, via: CallFrame['via']): CallFrame {
  const src = addrToSource(index2, address)
  const fn = findFunction(index2, address)
  return { index, address, fn: fn?.name ?? null, file: src?.file ?? null, line: src?.line ?? null, via }
}
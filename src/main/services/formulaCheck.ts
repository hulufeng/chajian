/**
 * 嵌入式时序公式校验（NeuralInverse #10 对标：波特率/定时器/PLL/PWM）。
 *
 * 给定输入时钟与目标频率，判定分频是否可达，并返回实际值、误差(Hz/ppm) 与建议寄存器值。
 * 纯数学、不依赖任何厂商数据，可独立单测 —— 写裸寄存器/配时钟前先跑它，避免凭记忆算错分频。
 *
 * 注：PLL 仅做整数 N/D 搜索给出近似值，真实 PLL 还有小数分频/扩频/锁定范围，最终须对照数据手册。
 */
export interface FormulaCheckResult {
  kind: 'baud' | 'timer' | 'pll' | 'pwm'
  targetHz: number
  clockHz: number
  achievable: boolean
  actualHz: number
  errorHz: number
  errorPpm: number
  tolerancePpm: number
  withinTolerance: boolean
  detail: string
  registers?: Record<string, number>
}

interface Opts {
  mode?: 'standard' | 'double'
  tolerancePpm?: number
  fracBits?: number
  maxPrescaler?: number
  maxReload?: number
}

export function checkFormula(kind: string, target: number, clock: number, opts: Opts = {}): FormulaCheckResult {
  switch (kind) {
    case 'baud':
      return checkBaud(target, clock, opts)
    case 'timer':
      return checkTimer(target, clock, opts)
    case 'pll':
      return checkPll(target, clock, opts)
    case 'pwm': {
      const r = checkTimer(target, clock, opts)
      return { ...r, kind: 'pwm' }
    }
    default:
      throw new Error(`未知 kind: ${kind}（支持 baud/timer/pll/pwm）`)
  }
}

/** UART 波特率：分频系数 = clock / (oversample × baud)，支持 3 位小数分频（如 ESP32 UART_CLKDIV） */
function checkBaud(targetBaud: number, clockHz: number, opts: Opts): FormulaCheckResult {
  const tol = opts.tolerancePpm ?? 2000
  const ovs = opts.mode === 'double' ? 8 : 16
  const fracBits = opts.fracBits ?? 3
  const step = 1 / (1 << fracBits)
  const ideal = clockHz / (ovs * targetBaud)
  const div = Math.max(step, Math.round(ideal / step) * step)
  const actualBaud = clockHz / (ovs * div)
  const errorHz = actualBaud - targetBaud
  const errorPpm = (errorHz / targetBaud) * 1e6
  const intPart = Math.floor(div)
  const fracPart = Math.round((div - intPart) * (1 << fracBits)) / (1 << fracBits)
  return {
    kind: 'baud',
    targetHz: targetBaud,
    clockHz,
    achievable: true,
    actualHz: actualBaud,
    errorHz,
    errorPpm,
    tolerancePpm: tol,
    withinTolerance: Math.abs(errorPpm) <= tol,
    detail: `采样率 ${ovs}x，分频系数 ${div.toFixed(fracBits)}（整 ${intPart} + 小数 ${fracPart}），实际波特率 ${actualBaud.toFixed(1)} baud，误差 ${errorPpm.toFixed(0)} ppm`,
    registers: { UART_CLKDIV: Math.round(div * (1 << fracBits)) },
  }
}

/** 定时器/PWM 频率：clock / (prescaler × autoreload)，选 prescaler ≈ √(clock/target) 使两者都在范围内且误差最小 */
function checkTimer(targetHz: number, clockHz: number, opts: Opts): FormulaCheckResult {
  const tol = opts.tolerancePpm ?? 2000
  const maxP = opts.maxPrescaler ?? 65536
  const maxR = opts.maxReload ?? 65536
  const ideal = clockHz / targetHz
  const p0 = Math.min(maxP, Math.max(1, Math.floor(Math.sqrt(ideal))))
  let bestP = 0
  let bestR = 0
  let bestErr = Infinity
  for (let p = Math.max(1, p0 - 4); p <= Math.min(maxP, p0 + 4); p++) {
    const r = Math.min(maxR, Math.max(1, Math.round(ideal / p)))
    const actual = clockHz / (p * r)
    const err = Math.abs(actual - targetHz)
    if (err < bestErr) {
      bestErr = err
      bestP = p
      bestR = r
    }
  }
  const achievable = bestP > 0 && bestR > 0 && bestP <= maxP && bestR <= maxR
  const actualHz = achievable ? clockHz / (bestP * bestR) : 0
  const errorHz = achievable ? actualHz - targetHz : -targetHz
  const errorPpm = achievable ? (errorHz / targetHz) * 1e6 : -1e9
  return {
    kind: 'timer',
    targetHz,
    clockHz,
    achievable,
    actualHz,
    errorHz,
    errorPpm,
    tolerancePpm: tol,
    withinTolerance: achievable && Math.abs(errorPpm) <= tol,
    detail: `预分频 ${bestP}，自动重装 ${bestR}，实际 ${actualHz.toFixed(2)} Hz，误差 ${errorPpm.toFixed(0)} ppm`,
    registers: achievable ? { prescaler: bestP, autoreload: bestR } : undefined,
  }
}

/** PLL 整数倍率/分频搜索（仅近似，真实 PLL 见数据手册） */
function checkPll(targetHz: number, clockHz: number, opts: Opts): FormulaCheckResult {
  const tol = opts.tolerancePpm ?? 2000
  const maxM = 64
  const maxD = 64
  let bestM = 1
  let bestD = 1
  let bestErr = Infinity
  for (let d = 1; d <= maxD; d++) {
    for (let m = 1; m <= maxM; m++) {
      const actual = (clockHz * m) / d
      const err = Math.abs(actual - targetHz)
      if (err < bestErr) {
        bestErr = err
        bestM = m
        bestD = d
      }
    }
  }
  const actualHz = (clockHz * bestM) / bestD
  const errorHz = actualHz - targetHz
  const errorPpm = (errorHz / targetHz) * 1e6
  return {
    kind: 'pll',
    targetHz,
    clockHz,
    achievable: true,
    actualHz,
    errorHz,
    errorPpm,
    tolerancePpm: tol,
    withinTolerance: Math.abs(errorPpm) <= tol,
    detail: `PLL 整数倍率 N=${bestM}, 分频 D=${bestD}, 实际 ${actualHz.toFixed(0)} Hz, 误差 ${errorPpm.toFixed(0)} ppm（仅整数 N/D 搜索，实数 PLL 含小数/扩频，须对照手册）`,
    registers: { PLL_N: bestM, PLL_DIV: bestD },
  }
}

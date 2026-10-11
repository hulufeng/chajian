/**
 * AI 完成提示音 —— WebAudio 现场合成，不带任何音频资源文件。
 *
 * 为什么不用 mp3/wav：出包要额外带一个二进制、还要处理 asar 解包路径；
 * 而这里只需要「叮」一声，两个正弦音 + 指数衰减包络就够了，零资源、零依赖。
 *
 * 两条硬约束：
 *  1. **绝不抛错**：AudioContext 可能因为「用户还没交互过」被浏览器挂起，
 *     也可能在某些 Electron 版本里压根不可用 —— 播不出声就算了，不能让 AI 面板崩。
 *  2. **不持有长连接**：播完立刻 close()，避免残留 AudioContext 占着音频设备。
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    // webkitAudioContext 只为兼容很老的壳；本项目是 Electron 44，实际走标准分支
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
    if (!Ctor) return null
    if (!ctx || ctx.state === 'closed') ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

/**
 * 播一声「叮」（两个上方泛音，收尾干净不刺耳）。
 * @param freq 基频，默认 988Hz（B5，清脆但不尖锐）
 */
export function playChime(freq = 988): void {
  const ac = getCtx()
  if (!ac) return
  try {
    // 自动播放策略：挂起状态要 resume，否则第一声永远不出
    if (ac.state === 'suspended') void ac.resume()
    const now = ac.currentTime
    const master = ac.createGain()
    master.gain.value = 0.18 // 音量压低，别盖过系统其它声音
    master.connect(ac.destination)
    ;[1, 1.5].forEach((mul, i) => {
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq * mul
      const t0 = now + i * 0.06
      const dur = 0.22
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(i === 0 ? 1 : 0.5, t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(g)
      g.connect(master)
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    })
    // 播完释放：留着 AudioContext 会一直占着音频设备句柄
    setTimeout(() => {
      try {
        if (ctx && ctx.state !== 'closed') void ctx.close()
      } catch { /* 关不掉就算了 */ }
      ctx = null
    }, 800)
  } catch {
    /* 出声失败不影响任何功能 */
  }
}

const KEY = 'codelab-chime'

/** 提示音开关（默认开，与 TrieCode 一致） */
export function isChimeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setChimeEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch { /* 隐私模式下写不了，忽略 */ }
}

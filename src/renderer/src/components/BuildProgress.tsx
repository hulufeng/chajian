import type { BuildStageInfo, FlashStage, UsageSummary } from '../../../preload'

interface Props {
  /** 当前阶段（由主进程从真实输出解析而来） */
  stage: BuildStageInfo
  /** 是否正在编译/烧录（决定显示阶段条还是结果卡） */
  active: boolean
  /** 已用时（毫秒） */
  elapsedMs: number
  /** 能否取消（有活动任务时） */
  cancellable: boolean
  onCancel: () => void
  /** 编译产物用量（编译完成后才有） */
  usage: UsageSummary | null
  /** 阶段条与结果卡都隐藏（例如从未编译过） */
  visible: boolean
  /** 本次编译/烧录是失败收尾（失败时不能还打 ✓ 显示"完成"） */
  failed?: boolean
  /**
   * 真实写入百分比（0-100），只来自 esptool 自己打印的 Writing at ... (nn %)。
   * 编译场景工具不给百分比，传 null，这里就不画进度条——不编数字。
   */
  progressPercent?: number | null
  /** 当前烧录端口。烧录阶段条代替了原来那行带端口的文案，端口得单独显示。 */
  port?: string
}

const ORDER: BuildStageInfo['stage'][] = ['prepare', 'sketch', 'libs', 'link', 'image', 'done']

const STAGE_TEXT: Record<string, string> = {
  prepare: '准备',
  sketch: '编译草图',
  libs: '编译库',
  link: '链接',
  image: '生成二进制',
  done: '完成'
}

/** 烧录用另一套阶段：编译是「怎么把代码变成 bin」，烧录是「怎么把 bin 送进芯片」。 */
const FLASH_ORDER: FlashStage[] = ['connect', 'erase', 'write', 'verify', 'reset']

const FLASH_TEXT: Record<FlashStage, string> = {
  connect: '连接',
  erase: '擦除',
  write: '写入',
  verify: '校验',
  reset: '复位'
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s'
  if (ms < 1000) return (ms / 1000).toFixed(1) + 's'
  return (ms / 1000).toFixed(1) + 's'
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * 编译过程条 / 结果摘要卡。
 * 刻意不显示百分比进度条 —— arduino-cli 与 esptool 都不给可靠百分比，
 * 拿「阶段 + 真实已用时」表达进度，比编造一个数字更可信。
 */
export default function BuildProgress({
  stage,
  active,
  elapsedMs,
  cancellable,
  onCancel,
  usage,
  visible,
  failed = false,
  progressPercent = null,
  port
}: Props): React.JSX.Element | null {
  if (!visible) return null

  const isFlashing = stage.stage === 'flashing' || stage.stage === 'flashed'
  // 烧录用另一套阶段条（连接→擦除→写入→校验→复位）。
  // 之前烧录时整排阶段条被换成一行文字，用户点烧录后会看到阶段条凭空消失、像是过程退化了。
  const steps: string[] = isFlashing ? FLASH_ORDER : ORDER
  const stepText = (s: string): string => (isFlashing ? FLASH_TEXT[s as FlashStage] : STAGE_TEXT[s])
  // 走完全部步骤（烧录成功）时下标推到末尾，让所有点都点亮，与编译成功「全绿」的表现一致
  const flashedAll = isFlashing && stage.stage === 'flashed' && !failed
  const curIdx = isFlashing
    ? flashedAll
      ? FLASH_ORDER.length
      : Math.max(0, FLASH_ORDER.indexOf(stage.flashStage ?? 'connect'))
    : ORDER.indexOf(stage.stage)
  // 失败时不展示 Flash/RAM 用量：没链接成功就没有用量，显示 0 B 只会误导
  const showUsage = !active && !failed && !!usage
  // 只在「正在写入」这一步画条：esptool 只有 Writing at ... (nn %) 给得出数字，
  // 其余步骤工具没给数字就不画（不编造进度）。
  const showPercent =
    !!isFlashing &&
    active &&
    !failed &&
    stage.flashStage === 'write' &&
    typeof progressPercent === 'number' &&
    Number.isFinite(progressPercent) &&
    progressPercent > 0

  return (
    <div className={failed ? 'bprog is-failed' : active ? 'bprog is-active' : 'bprog is-done'}>
      <div className="bprog-bar">
        <span className="bprog-state">
          {failed ? (
            <>
              <span className="bprog-fail">✘</span>
              {isFlashing ? '烧录失败' : '编译失败'}
            </>
          ) : active ? (
            <>
              <span className="bprog-spin" />
              {/* 状态区只说"在干什么 + 对谁做"，具体走到哪一步交给右边的阶段条 ——
                  之前这里也用 stage.label，结果烧录时同一句话（如"写入固件 62% · COM7"）
                  在状态区和阶段区各出现一遍，看着像渲染错乱。 */}
              {isFlashing ? (port ? `烧录中 · ${port}` : '烧录中') : '编译中'}
            </>
          ) : (
            <>
              <span className="bprog-ok">✓</span>
              {isFlashing ? '烧录完成' : '编译完成'}
            </>
          )}
        </span>

        <span className="bprog-stages" title={stage.label}>
          {steps.map((s, i) => (
            <span key={s} className="bprog-stage">
              <span className={'bprog-dot' + (i < curIdx ? ' done' : '') + (i === curIdx ? ' now' : '')} />
              <span className={'bprog-stage-label' + (i === curIdx ? ' on' : '')}>{stepText(s)}</span>
              {i < steps.length - 1 && <span className={'bprog-link' + (i < curIdx ? ' done' : '')} />}
            </span>
          ))}
        </span>

        {showPercent && (
          <span className="bprog-pct" title="esptool 打印的写入百分比">
            <span className="bprog-pct-bar">
              <span className="bprog-pct-fill" style={{ width: `${Math.round(progressPercent * 10) / 10}%` }} />
            </span>
            <span className="bprog-pct-num mono">{Math.round(progressPercent)}%</span>
          </span>
        )}

        <span className="bprog-time mono">{fmtMs(elapsedMs)}</span>
        {active && cancellable && (
          <button className="bprog-cancel" onClick={onCancel} title="中断当前编译/烧录">
            取消
          </button>
        )}
      </div>

      {showUsage && usage && (
        <div className="bprog-usage">
          <div className="bprog-usage-cell" title={usage.rawFlash}>
            <span className="bprog-usage-k">程序存储（Flash）</span>
            <span className="bprog-usage-v mono">
              {fmtBytes(usage.flashBytes)}
              <em> · {usage.flashPercent}%</em>
            </span>
          </div>
          <div className="bprog-usage-cell" title={usage.rawRam}>
            <span className="bprog-usage-k">动态内存（RAM）</span>
            <span className="bprog-usage-v mono">
              {fmtBytes(usage.ramBytes)}
              <em> · {usage.ramPercent}%</em>
            </span>
          </div>
          <div className="bprog-usage-cell">
            <span className="bprog-usage-k">耗时</span>
            <span className="bprog-usage-v mono">{fmtMs(elapsedMs)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

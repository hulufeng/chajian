import type { BuildStageInfo, UsageSummary } from '../../../preload'

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
  visible
}: Props): React.JSX.Element | null {
  if (!visible) return null

  const isFlashing = stage.stage === 'flashing' || stage.stage === 'flashed'
  const activeIdx = ORDER.indexOf(stage.stage)

  return (
    <div className={active ? 'bprog is-active' : 'bprog is-done'}>
      <div className="bprog-bar">
        <span className="bprog-state">
          {active ? (
            <>
              <span className="bprog-spin" />
              {isFlashing ? '烧录中' : '编译中'}
            </>
          ) : (
            <>
              <span className="bprog-ok">✓</span>
              {isFlashing ? '烧录完成' : '编译完成'}
            </>
          )}
        </span>

        {isFlashing ? (
          <span className="bprog-stage-label">esptool 写入固件</span>
        ) : (
          <span className="bprog-stages">
            {ORDER.map((s, i) => (
              <span key={s} className="bprog-stage">
                <span className={'bprog-dot' + (i < activeIdx ? ' done' : '') + (i === activeIdx ? ' now' : '')} />
                <span className={'bprog-stage-label' + (i === activeIdx ? ' on' : '')}>{STAGE_TEXT[s]}</span>
                {i < ORDER.length - 1 && <span className={'bprog-link' + (i < activeIdx ? ' done' : '')} />}
              </span>
            ))}
          </span>
        )}

        <span className="bprog-time mono">{fmtMs(elapsedMs)}</span>
        {active && cancellable && (
          <button className="bprog-cancel" onClick={onCancel} title="中断当前编译/烧录">
            取消
          </button>
        )}
      </div>

      {!active && usage && (
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

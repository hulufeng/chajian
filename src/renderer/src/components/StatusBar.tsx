import type { ToolchainStatus, PrecheckSnapshot } from '../../../preload'

interface Props {
  toolchain: ToolchainStatus | null
  projectRoot: string | null
  port: string
  baud: number
  board: string
  /** 串口会话是否已打开 */
  serialOpen?: boolean
  /** 编译/烧录进行中 */
  busy?: boolean
  /** 片上调试会话状态 */
  debugStatus?: 'idle' | 'starting' | 'running' | 'error'
  /** Git 变更文件数（0 = 干净） */
  gitChanges?: number
  /** 当前硬件目标摘要（只读展示，改动去硬件目标面板） */
  targetLabel?: string
  /** AI 通道健康：本地就绪 / 已登录 / 未登录，直接显示在状态栏 */
  aiHealth?: {
    loggedIn: boolean
    localReady: boolean
    localModel: string | null
    byokActive: string | null
    modelListOk: boolean | null
    /** 本地引擎状态：idle = 已装且下载了模型但没启动（状态栏可直接提示一键启动） */
    engineHint?: 'running' | 'idle' | 'not-installed' | 'no-models'
    localModelCount?: number
  } | null
  /** 保存即预检（层1 即时静态校验）的快照；未跑过则为 undefined */
  precheck?: PrecheckSnapshot
  /** 点击预检圆点：展开完整报告（App 负责打进输出面板） */
  onPrecheckClick?: () => void
  /** 保存即预检（层2 深度编译，实验性）快照；未开启/未跑过则 undefined */
  deepCheck?: { status: 'idle' | 'pending' | 'ok' | 'error'; summary: string; text: string }
  /** 点击层2 圆点：展开完整编译报告（App 负责打进输出面板） */
  onDeepCheckClick?: () => void
}

type Dot = { color: string; text: string; title: string; onClick?: () => void }

function dot(d: Dot | null): React.JSX.Element | null {
  if (!d) return null
  return (
    <span
      className="sb-item"
      title={d.title}
      onClick={d.onClick}
      style={d.onClick ? { cursor: 'pointer' } : undefined}
    >
      <span className="sb-dot" style={{ background: d.color }} />
      {d.text}
    </span>
  )
}

/**
 * 状态栏：左边是「环境事实」（工具链/项目），右边是「现在在跑什么」。
 * 加右侧的原因是：串口、调试、编译这些状态原来只能在面板里看到，
 * 用户为了确认「刚才那下到底成没成」要来回切面板。
 */
function StatusBar({
  toolchain,
  projectRoot,
  port,
  baud,
  board,
  serialOpen,
  busy,
  debugStatus,
  gitChanges,
  targetLabel,
  aiHealth,
  precheck,
  onPrecheckClick,
  deepCheck,
  onDeepCheckClick
}: Props): React.JSX.Element {
  const ready = toolchain?.available ? '1/1 后端就绪' : '0/1 后端就绪'

  // 保存即预检圆点：把「板卡合法 + 引脚冲突」这件事直接晒在状态栏，不必等编译才报错。
  // 错误级冲突=红、仅有警告=黄、通过=绿；板卡无效单独提示（不参与引脚校验）。
  const precheckDot: Dot | null = !precheck || precheck.status === 'idle'
    ? null
    : precheck.status === 'pending'
      ? { color: 'var(--accent)', text: '预检中', title: '正在静态校验引脚冲突…', onClick: onPrecheckClick }
      : !precheck.boardValid
        ? {
            color: 'var(--warning)',
            text: '未选有效板',
            title: '当前开发板不在硬件目标注册表中，无法校验引脚冲突。请到硬件目标面板选一个已收录的板。',
            onClick: onPrecheckClick
          }
        : (() => {
            const errs = precheck.issues.filter((i) => i.level === 'error').length
            const warns = precheck.issues.filter((i) => i.level === 'warning').length
            if (errs > 0) {
              return {
                color: 'var(--danger)',
                text: `引脚冲突×${errs}`,
                title: `检测到 ${errs} 处引脚冲突（错误级）。点击查看详情。`,
                onClick: onPrecheckClick
              }
            }
            if (warns > 0) {
              return {
                color: 'var(--warning)',
                text: `引脚警告×${warns}`,
                title: `检测到 ${warns} 处引脚警告。点击查看详情。`,
                onClick: onPrecheckClick
              }
            }
            return {
              color: 'var(--success)',
              text: '预检通过',
              title: `板卡合法，未发现引脚冲突。`,
              onClick: onPrecheckClick
            }
          })()

  // 层2 深度编译预检圆点：与层1 完全分开（颜色用 violet 区分），避免两件事的结论混成一个语义。
  const deepCheckDot: Dot | null = !deepCheck || deepCheck.status === 'idle'
    ? null
    : deepCheck.status === 'pending'
      ? { color: 'var(--violet)', text: '深度编译中', title: '正在真实编译校验（依赖/语法/库）…', onClick: onDeepCheckClick }
      : deepCheck.status === 'ok'
        ? { color: 'var(--success)', text: '深度通过', title: '真实编译校验通过：依赖、语法、库均正常。', onClick: onDeepCheckClick }
        : { color: 'var(--danger)', text: '深度编译失败', title: deepCheck.summary || '真实编译校验失败，点击查看报告。', onClick: onDeepCheckClick }

  const serial: Dot | null = serialOpen
    ? { color: 'var(--success)', text: `串口 ${port || '已打开'}`, title: `串口已打开 ${port} @ ${baud}` }
    : port
      ? { color: 'var(--text-muted)', text: `串口 ${port}`, title: '串口已识别但未打开' }
      : null

  const debug: Dot | null =
    debugStatus === 'running'
      ? { color: 'var(--success)', text: '调试已连接', title: 'openocd 会话运行中（telnet）' }
      : debugStatus === 'starting'
        ? { color: 'var(--warning)', text: '调试连接中', title: '正在连接 openocd' }
        : debugStatus === 'error'
          ? { color: 'var(--danger)', text: '调试失败', title: '上次连接调试器失败' }
          : null

  const running: Dot | null = busy
    ? { color: 'var(--accent)', text: '编译/烧录中', title: '正在执行编译或烧录' }
    : null

  // AI 通道：能不能用，在状态栏就能看到，不必等发消息才报 401
  const ai: Dot | null = !aiHealth
    ? null
    : aiHealth.localReady
      ? { color: 'var(--success)', text: `本地模型 ${aiHealth.localModel || '就绪'}`, title: '本地引擎就绪，不消耗云端积分' }
      : aiHealth.byokActive
        ? { color: 'var(--success)', text: `自定义模型 ${aiHealth.byokActive}`, title: '正在使用自带 Key 的自定义模型通道' }
        : aiHealth.loggedIn && aiHealth.modelListOk !== false
          ? { color: 'var(--success)', text: '内置模型已登录', title: '云端通道可用' }
          : aiHealth.engineHint === 'idle'
            ? { color: 'var(--warning)', text: `本地引擎未启动（${aiHealth.localModelCount ?? 0} 个模型）`, title: '本地引擎已就绪但没启动，AI 面板里点「一键启动」即可离线使用，不耗积分' }
            : aiHealth.engineHint === 'no-models'
              ? { color: 'var(--warning)', text: '本地引擎无模型', title: '引擎已装但没下载 gguf 模型，到「设置 → 本地引擎」下载一个' }
              : aiHealth.engineHint === 'not-installed'
                ? { color: 'var(--warning)', text: '本地引擎未安装', title: 'llama.cpp 引擎缺失，到「设置 → 本地引擎」重新安装' }
                : { color: 'var(--warning)', text: 'AI 通道不可用', title: aiHealth.loggedIn ? '登录可能已过期，请重新登录' : '未登录，且没有本地/自定义模型可用' }

  return (
    <footer className="statusbar">
      <span>{toolchain?.available ? `工具链 ${toolchain.version.split('\n')[0] || 'arduino-cli'}` : '工具链未安装'}</span>
      <span className="sep">|</span>
      <span>{projectRoot ? `项目 ${projectRoot.split(/[\\/]/).pop()}` : '未打开项目'}</span>
      <span className="sep">|</span>
      <span className={toolchain?.available ? 'ok' : 'warn'}>{ready}</span>

      <span className="spacer" />

      {running ? dot(running) : null}
      {ai ? dot(ai) : null}
      {precheckDot ? dot(precheckDot) : null}
      {deepCheckDot ? dot(deepCheckDot) : null}
      {serial ? dot(serial) : null}
      {debug ? dot(debug) : null}
      {gitChanges !== undefined && (
        <span className={`sb-item ${gitChanges > 0 ? 'warn' : ''}`} title="Git 变更文件数（点击打开 Git 面板）">
          Git {gitChanges}
        </span>
      )}
      <span className="sep">|</span>
      <span className="mono" title="当前硬件目标（改动请到硬件目标面板）">
        {targetLabel || (board ? board : '未选目标')}
      </span>
      <span className="sep">|</span>
      <span>UTF-8</span>
    </footer>
  )
}

export default StatusBar

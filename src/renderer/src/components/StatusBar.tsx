import type { ToolchainStatus } from '../../../preload'

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
  } | null
}

type Dot = { color: string; text: string; title: string }

function dot(d: Dot | null): React.JSX.Element | null {
  if (!d) return null
  return (
    <span className="sb-item" title={d.title}>
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
  aiHealth
}: Props): React.JSX.Element {
  const ready = toolchain?.available ? '1/1 后端就绪' : '0/1 后端就绪'

  const serial: Dot | null = serialOpen
    ? { color: '#4ade80', text: `串口 ${port || '已打开'}`, title: `串口已打开 ${port} @ ${baud}` }
    : port
      ? { color: '#888780', text: `串口 ${port}`, title: '串口已识别但未打开' }
      : null

  const debug: Dot | null =
    debugStatus === 'running'
      ? { color: '#4ade80', text: '调试已连接', title: 'openocd 会话运行中（telnet）' }
      : debugStatus === 'starting'
        ? { color: '#ef9f27', text: '调试连接中', title: '正在连接 openocd' }
        : debugStatus === 'error'
          ? { color: '#e24b4a', text: '调试失败', title: '上次连接调试器失败' }
          : null

  const running: Dot | null = busy
    ? { color: '#2f7cf6', text: '编译/烧录中', title: '正在执行编译或烧录' }
    : null

  // AI 通道：能不能用，在状态栏就能看到，不必等发消息才报 401
  const ai: Dot | null = !aiHealth
    ? null
    : aiHealth.localReady
      ? { color: '#4ade80', text: `本地模型 ${aiHealth.localModel || '就绪'}`, title: '本地引擎就绪，不消耗云端积分' }
      : aiHealth.byokActive
        ? { color: '#4ade80', text: `自定义模型 ${aiHealth.byokActive}`, title: '正在使用自带 Key 的自定义模型通道' }
        : aiHealth.loggedIn && aiHealth.modelListOk !== false
          ? { color: '#4ade80', text: '内置模型已登录', title: '云端通道可用' }
          : { color: '#ef9f27', text: 'AI 通道不可用', title: aiHealth.loggedIn ? '登录可能已过期，请重新登录' : '未登录，且没有本地/自定义模型可用' }

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

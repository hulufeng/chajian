import type { ToolchainStatus } from '../../../preload'

interface Props {
  toolchain: ToolchainStatus | null
  projectRoot: string | null
  port: string
  baud: number
  board: string
}

function StatusBar({
  toolchain,
  projectRoot,
  port,
  baud,
  board
}: Props): React.JSX.Element {
  const ready = toolchain?.available ? '1/1 后端就绪' : '0/1 后端就绪'
  return (
    <footer className="statusbar">
      <span>{toolchain?.available ? `工具链 ${toolchain.version.split('\n')[0] || 'arduino-cli'}` : '工具链未安装'}</span>
      <span className="sep">|</span>
      <span>{projectRoot ? `项目 ${projectRoot.split(/[\\/]/).pop()}` : '未打开项目'}</span>
      <span className="sep">|</span>
      <span className={toolchain?.available ? 'ok' : 'warn'}>{ready}</span>
      <span className="spacer" />
      <span className="sep">|</span>
      <span>UTF-8</span>
      <span className="sep">|</span>
      <span>{board ? `${board}${port ? ` - ${port}` : ''}` : (port ? `${port} · ${baud}` : '未连接串口')}</span>
    </footer>
  )
}

export default StatusBar

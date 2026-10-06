import React from 'react'

interface Props {
  /** 面板/区域名，用于报错信息定位 */
  name?: string
  /** 自定义「恢复」动作；不传则仅重置本边界内部状态 */
  onReload?: () => void
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染期崩溃隔离边界。
 * 桌面 IDE 组件多，任意一个面板（串口监视器 / 调试 / Git 等）在渲染时抛错，
 * 若没有边界会一路冒泡到根，整棵 IDE 白屏。这里把崩溃就地兜住：
 *  - 只影响当前边界包裹的区域，其余功能照常；
 *  - 给出可读的错误信息与「重试」入口，避免静默白屏。
 * 注：class 组件才能捕获渲染期错误，hooks 做不到。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 打到控制台，保留组件栈便于真机排查（沙箱起不了 Electron，只能本机验）
    console.error(`[ErrorBoundary${this.props.name ? ' · ' + this.props.name : ''}]`, error, info)
  }

  private handleReload = (): void => {
    if (this.props.onReload) this.props.onReload()
    else this.setState({ error: null })
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div className="err-boundary">
          <div className="err-boundary-title">⚠️ {this.props.name ?? '区域'}渲染异常</div>
          <div className="err-boundary-msg">{error.message || String(error)}</div>
          <button className="btn" onClick={this.handleReload}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

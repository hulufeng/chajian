/**
 * <webview> 是 Electron 注入的内置标签，不是标准 HTML 元素，
 * React 的 JSX.IntrinsicElements 里没有它的类型，这里补上。
 * 需要主进程 webPreferences.webviewTag = true（已开启）。
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        /** Electron <webview> 的 preload 是独立属性，必须单独传，不能塞进 webpreferences 字符串 */
        preload?: string
        webpreferences?: string
        allowpopups?: boolean
        partition?: string
      }
    }
  }
}

export {}
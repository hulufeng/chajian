/// <reference types="vite/client" />
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './assets/main.css'

// 全局兜底：任何未捕获的 Promise rejection 都打到控制台并带上来源，
// 避免裸 window.api.*() fire-and-forget 在 reject 时让整页静默崩（详见 scripts/scan-unhandled-rejection.mjs）。
// 渲染层是浏览器上下文，用 window 事件而非 process.on。
window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  const reason = ev.reason instanceof Error ? `${ev.reason.message}\n${ev.reason.stack ?? ''}` : String(ev.reason)
  console.error('[unhandledrejection]', reason)
})

// 让 Monaco 使用本地打包的 worker（桌面端离线可用，不走 CDN）
;(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker(): Worker {
    return new Worker(
      new URL('../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    )
  }
}
loader.config({ monaco })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary name="应用" onReload={() => window.location.reload()}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)

/// <reference types="vite/client" />
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './assets/main.css'

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

import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 测试桩：把 electron 的 app/shell/BrowserWindow 顶成本地临时目录实现，
// 供 shareCard / burnHistory / browser-automation 在 node 真跑。
export const app = {
  getPath: (name) => {
    if (name === 'appData') return process.env.TEST_APPDATA || join(tmpdir(), 'codelab-test-appdata')
    return join(tmpdir(), 'codelab-test', name)
  },
  // 版本号：诊断日志 / 分享卡片会读它。桩给固定值，断言才有确定性
  getVersion: () => '0.0.0-test',
  getLocale: () => 'zh-CN',
  getAppPath: () => process.cwd(),
  isPackaged: false,
  commandLine: {
    // BrowserWindow 的 webPreferences 里会带这些开关，测试桩只做记录不生效
    switches: new Map(),
    appendSwitch(k, v) { this.switches.set(k, v) }
  }
}
export const shell = {
  openPath: async () => ''
}

// BrowserWindow 桩：只提供「不抛异常」的最小表面。
// browser-automation 的窗口是懒加载的（ensureSession 里才建），
// 所以自检脚本只要能打包通过、不在 import 阶段炸掉即可——
// 真跑浏览器需要 Electron 运行时，不在 node 自检范围内。
class StubWebContents {
  constructor() {
    this.debugger = {
      isAttached: () => false,
      attach: () => {},
      detach: () => {},
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {}
    }
    this.session = { on: () => {} }
  }
  async loadURL() {}
  async capturePage() { return { toPNG: () => Buffer.alloc(0) } }
  isDestroyed() { return false }
  on() {}
  removeListener() {}
}
export class BrowserWindow {
  constructor() {
    this.webContents = new StubWebContents()
  }
  isDestroyed() { return false }
  destroy() {}
  loadURL() { return Promise.resolve() }
  static getAllWindows() { return [] }
}
export const ipcMain = { handle: () => {}, on: () => {} }
export const ipcRenderer = { invoke: async () => ({}), on: () => {} }
export const contextBridge = { exposeInMainWorld: () => {} }
export const dialog = { showOpenDialog: async () => ({ canceled: true }) }
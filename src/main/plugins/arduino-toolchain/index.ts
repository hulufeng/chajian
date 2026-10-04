import {
  detectToolchain,
  compileSketch,
  uploadSketch,
  findToolchain,
  searchBoards,
  listConnectedBoards,
  searchLibraries,
  listInstalledLibraries,
  listPlatforms,
  runArduinoCliCommand
} from '../../services/toolchain'
import { listPorts, openSerialMonitor } from '../../services/serialService'
import type { PluginContext, StreamTask } from '../pluginManager'
import manifest from './manifest.json'

export { manifest }

/**
 * Arduino CLI 工具链官方插件
 * 能力覆盖：
 * - 编译 / 烧录 / 板卡搜索 / 已连接板卡 / 库搜索 / 库安装 / 库列表 / 平台列表 / 平台安装 / 串口日志
 * - backend: 流式编译/烧录/安装 + 同步查询
 * - internal: 工具链检测
 * - devicePanel: 开发板搜索 + 端口选择 + 串口监视器
 */
export function load(ctx: PluginContext): void {
  // ========== backend：同步查询 ==========
  ctx.registerBackend('toolchain.detect', () => detectToolchain())

  // 板卡搜索（board.search）→ arduino-cli board listall，支持 keyword 过滤
  ctx.registerBackend('toolchain.boardSearch', (args) => {
    const { keyword, bin } = (args ?? {}) as { keyword?: string; bin?: string }
    return searchBoards(keyword || '', bin || findToolchain() || undefined)
  })

  // 已连接板卡（board.list）
  ctx.registerBackend('toolchain.boardList', (args) => {
    const { bin } = (args ?? {}) as { bin?: string }
    return listConnectedBoards(bin || findToolchain() || undefined)
  })

  // 库搜索（library.search）
  ctx.registerBackend('toolchain.librarySearch', (args) => {
    const { keyword, bin } = (args ?? {}) as { keyword?: string; bin?: string }
    return searchLibraries(keyword || '', bin || findToolchain() || undefined)
  })

  // 已安装库列表（library.list）
  ctx.registerBackend('toolchain.libraryList', (args) => {
    const { bin } = (args ?? {}) as { bin?: string }
    return listInstalledLibraries(bin || findToolchain() || undefined)
  })

  // 平台列表（core.list）
  ctx.registerBackend('toolchain.platformList', (args) => {
    const { bin } = (args ?? {}) as { bin?: string }
    return listPlatforms(bin || findToolchain() || undefined)
  })

  // ========== backend：流式执行 ==========
  const toolBinOf = (bin?: string): string => bin || findToolchain() || 'arduino-cli'

  ctx.registerBackend('toolchain.compile', (args) => {
    const { sketch, fqbn, bin } = (args ?? {}) as { sketch: string; fqbn: string; bin?: string }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = compileSketch({ sketch, fqbn, bin: toolBinOf(bin) }, push, done)
        return () => {
          try {
            cp.kill()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return task
  })

  ctx.registerBackend('toolchain.upload', (args) => {
    const { sketch, fqbn, bin, port } = (args ?? {}) as { sketch: string; fqbn: string; bin?: string; port: string }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = uploadSketch({ sketch, fqbn, bin: toolBinOf(bin), port }, push, done)
        return () => {
          try {
            cp.kill()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return task
  })

  // 库安装（library.install）→ arduino-cli lib install <name>
  ctx.registerBackend('toolchain.libraryInstall', (args) => {
    const { name, bin } = (args ?? {}) as { name: string; bin?: string }
    const task: StreamTask = {
      start: (push, done) => {
        push(`\n▶ arduino-cli lib install ${name}\n`)
        const cp = runArduinoCliCommand(['lib', 'install', name], { bin: toolBinOf(bin) }, push, done)
        return () => {
          try {
            cp.kill()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return task
  })

  // 平台安装（platform.install / core.install）→ arduino-cli core install <pkg>
  ctx.registerBackend('toolchain.platformInstall', (args) => {
    const { pkg, bin } = (args ?? {}) as { pkg: string; bin?: string }
    const task: StreamTask = {
      start: (push, done) => {
        push(`\n▶ arduino-cli core install ${pkg}\n`)
        const cp = runArduinoCliCommand(['core', 'install', pkg], { bin: toolBinOf(bin) }, push, done)
        return () => {
          try {
            cp.kill()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return task
  })

  // 平台卸载（platform.uninstall）→ arduino-cli core uninstall <pkg>
  ctx.registerBackend('toolchain.platformUninstall', (args) => {
    const { pkg, bin } = (args ?? {}) as { pkg: string; bin?: string }
    const task: StreamTask = {
      start: (push, done) => {
        push(`\n▶ arduino-cli core uninstall ${pkg}\n`)
        const cp = runArduinoCliCommand(['core', 'uninstall', pkg], { bin: toolBinOf(bin) }, push, done)
        return () => {
          try {
            cp.kill()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return task
  })

  ctx.registerBackend('serial.list', () => listPorts())

  ctx.registerBackend('serial.open', (args) => {
    const { port, baud } = (args ?? {}) as { port: string; baud: number }
    const task: StreamTask = {
      start: (push, done) => {
        const cleanup = openSerialMonitor(
          { port, baud: Number(baud) || 115200 },
          (data) => push(data),
          () => done(0)
        )
        return cleanup
      }
    }
    return task
  })

  // ========== internal ==========
  ctx.registerInternal('arduino.version', () => {
    const bin = findToolchain()
    return { installed: !!bin, path: bin }
  })

  ctx.registerInternal('arduino.detect', () => detectToolchain())
}

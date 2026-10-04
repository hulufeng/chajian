import { detectStm32, stm32Flash, stm32Build } from '../../services/stm32Service'
import type { PluginContext, StreamTask } from '../pluginManager'
import manifest from './manifest.json'

export { manifest }

/**
 * STM32Cube 工具链官方插件
 * - backend: stm32.detect / stm32.build / stm32.flash
 * - internal: stm32.version
 */
export function load(ctx: PluginContext): void {
  // ---------- backend ----------
  ctx.registerBackend('stm32.detect', () => detectStm32())

  ctx.registerBackend('stm32.build', (args) => {
    const { project, buildDir } = (args ?? {}) as { project: string; buildDir?: string }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = stm32Build({ project, buildDir }, push, done)
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

  ctx.registerBackend('stm32.flash', (args) => {
    const { programmer, binary, device } = (args ?? {}) as { programmer: string; binary: string; device?: string }
    if (!programmer) {
      return { error: '未检测到 STM32CubeProgrammer（STM32_Programmer_CLI），请先安装 STM32CubeCLT' }
    }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = stm32Flash({ programmer, binary, device }, push, done)
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

  // ---------- internal ----------
  ctx.registerInternal('stm32.version', async () => {
    const status = await detectStm32()
    return { installed: status.available, programmer: status.programmer, armGcc: status.armGcc }
  })
}

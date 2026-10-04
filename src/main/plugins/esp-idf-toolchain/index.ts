import { detectEspIdf, espIdfBuild, espIdfFlash, findIdfPy } from '../../services/espIdfService'
import type { PluginContext, StreamTask } from '../pluginManager'
import manifest from './manifest.json'

export { manifest }

/**
 * ESP-IDF 工具链官方插件
 * - backend: espidf.detect / espidf.build / espidf.flash / espidf.setTarget
 * - internal: espidf.version
 */
export function load(ctx: PluginContext): void {
  // ---------- backend ----------
  ctx.registerBackend('espidf.detect', () => detectEspIdf())

  ctx.registerBackend('espidf.build', (args) => {
    const { project, bin, target } = (args ?? {}) as { project: string; bin?: string; target?: string }
    const toolBin = bin || findIdfPy()
    if (!toolBin) {
      return { error: '未检测到 ESP-IDF 工具链（idf.py），请先安装并设置 IDF_PATH' }
    }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = espIdfBuild({ project, bin: toolBin, target }, push, done)
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

  ctx.registerBackend('espidf.flash', (args) => {
    const { project, bin, target, port } = (args ?? {}) as { project: string; bin?: string; target?: string; port: string }
    const toolBin = bin || findIdfPy()
    if (!toolBin) {
      return { error: '未检测到 ESP-IDF 工具链（idf.py），请先安装并设置 IDF_PATH' }
    }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = espIdfFlash({ project, bin: toolBin, target, port }, push, done)
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

  ctx.registerBackend('espidf.setTarget', (args) => {
    const { project, target } = (args ?? {}) as { project: string; target: string }
    const toolBin = findIdfPy()
    if (!toolBin) return { error: '未检测到 ESP-IDF 工具链（idf.py）' }
    const task: StreamTask = {
      start: (push, done) => {
        const cp = espIdfBuild({ project, bin: toolBin, target }, push, done)
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
  ctx.registerInternal('espidf.version', () => {
    const bin = findIdfPy()
    return { installed: !!bin, path: bin, idfPath: process.env.IDF_PATH || null }
  })
}

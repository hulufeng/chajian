import { listPorts, listSerialSessions, readSerialLog } from '../services/serialService'
import type { PluginContext, PluginManifest } from './pluginManager'

/**
 * 宿主能力插件（内置，不可卸载）。
 *
 * 作用：把宿主侧的串口会话能力暴露成 backend 命令，第三方插件通过
 * ctx.invoke('backend', 'serial.peek', …) 调用即可读设备输出，
 * 插件自身不 require 宿主模块（打包后路径会变），耦合只靠命令名。
 */

export const hostManifest: PluginManifest = {
  name: 'codelab-host',
  displayName: '宿主能力',
  version: '1.0.0',
  description: '把串口会话能力暴露成命令，供已安装插件调用',
  entry: 'host-adapter/index.js',
  // channels 是全量七通道表（内部通道校验按这个形状走），这里只对外声明下面三条
  channels: {
    internal: [],
    backend: ['serial.list', 'serial.sessions', 'serial.peek'],
    cli: [],
    http: [],
    grpc: [],
    mcp: [],
    mqtt: []
  }
}

/** 取最后 n 行（设备输出一般是持续打印，只有尾部才是有用的那几帧） */
function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

export function load(ctx: PluginContext): void {
  ctx.registerBackend('serial.list', async () => ({
    ports: (await listPorts()).map((p) => ({
      path: p.path,
      label: p.friendlyName || p.manufacturer || p.path,
      description: p.manufacturer || p.friendlyName || ''
    }))
  }))

  ctx.registerBackend('serial.sessions', () => ({ sessions: listSerialSessions() }))

  ctx.registerBackend('serial.peek', (args) => {
    const opts = (args || {}) as { id?: string; maxLines?: number }
    const sessions = listSerialSessions()
    if (sessions.length === 0) {
      return { ok: false, error: '没有打开的串口会话（先用串口监视器打开设备）' }
    }
    const id = opts.id || (sessions.find((s) => s.open) || sessions[0]).id
    const read = readSerialLog(id)
    if (!read.ok) return { ok: false, error: read.error }
    const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : 40
    return { ok: true, id, data: tailLines(read.data || '', maxLines) }
  })
}

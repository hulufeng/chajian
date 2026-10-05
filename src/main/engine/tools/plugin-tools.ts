// 插件工具集（Agent 侧按需安装 / 调用）
//
// 与设置页共用同一套主进程安装器，行为完全一致：
//   - install 未信任时返回 needConfirm，Agent 必须先用 ask_user（type=yesno）问过用户，
//     用户同意后带 trust=true 重调才算装；装完自动重扫，命令/工具当场可用。
//   - invoke 让 Agent 直接用已装插件声明的能力（如 sensor.sample），不必绕回渲染层。
//   - 失败原因原样回传（校验和不符 / manifest 非法 / 下载失败），不做静默降级。
import {
  installPlugin,
  uninstallPlugin,
  installedPlugins,
  listPlugins,
  scanInstalledPlugins
} from '../../plugins/pluginInstaller'
import { pluginManager } from '../../plugins/pluginManager'
import type { ToolDefinition, ToolResult } from '../types'

function formatInstalled(): string {
  const list = installedPlugins()
  if (list.length === 0) return '（本机还没有已安装插件）'
  return list
    .map((p) => `- ${p.id} v${p.version}${p.valid ? '' : '（manifest 校验未通过，不会生效）'}`)
    .join('\n')
}

const pluginTool: ToolDefinition = {
  name: 'plugin',
  description:
    '本机插件的清单与调用。action="catalog" 列出可安装的插件（含来源/版本/是否已装），' +
    'action="install" 安装指定 id（首次安装会先问用户“是否允许执行这个插件的代码”，' +
    '用户同意后才装；装完自动接入命令与工具），action="uninstall" 卸载，action="list" 看已装插件，' +
    'action="invoke" 直接调用已装插件的命令（channel + command）。' +
    '典型用法：需要某个外部能力（如传感器读数）而当前工具集没有时，先 catalog 找 id，' +
    '再 install，然后 invoke 用它。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['catalog', 'install', 'uninstall', 'list', 'invoke'],
        description: '操作类型'
      },
      id: { type: 'string', description: '插件 id（catalog/install/uninstall 用）' },
      channel: {
        type: 'string',
        enum: ['internal', 'backend', 'cli'],
        description: 'invoke 时的通道'
      },
      command: { type: 'string', description: 'invoke 时的插件命令名（如 sensor.sample）' },
      args: { type: 'string', description: 'invoke 时的参数 JSON 字符串，无参可省略' }
    },
    required: ['action']
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const action = String(args.action || '')
    const id = typeof args.id === 'string' ? args.id.trim() : ''

    if (action === 'catalog') {
      const list = await listPlugins()
      if (list.length === 0) return { ok: true, content: '（清单里没有可用插件）' }
      const lines = list.map((e) => {
        const flag = e.installed ? '已装' : '未装'
        const expose = Array.isArray(e.exposes) && e.exposes.length > 0 ? ` 能力:${e.exposes.join(',')}` : ''
        return `- ${e.id} v${e.version} [${flag}] 来源:${e.source}${expose}\n  ${e.description}`
      })
      return { ok: true, content: `可用插件（${list.length}）：\n${lines.join('\n')}` }
    }

    if (action === 'list') {
      return { ok: true, content: `已安装插件：\n${formatInstalled()}` }
    }

    if (action === 'install') {
      if (!id) return { ok: false, content: '', error: 'install 需要 id' }
      const res = await installPlugin(id)
      if (res.needConfirm) {
        // 没被信任过：把「会执行什么」讲清楚，交给 Agent 用 ask_user 征询用户
        const e = res.entry
        return {
          ok: false,
          content: '',
          error:
            `插件 ${id} 尚未被信任，不能直接安装。` +
            (e
              ? `它会做的事：${e.description}\n来源：${e.source}\n版本：v${e.version}` +
                (Array.isArray(e.exposes) && e.exposes.length > 0 ? `\n会接入的能力：${e.exposes.join(', ')}` : '')
              : '') +
            `\n请先用 ask_user（type=yesno）问用户“是否允许安装并运行这个插件”，用户明确同意后带着 trust=true 重调 install。`
        }
      }
      if (!res.ok) {
        return { ok: false, content: '', error: res.error || '安装失败' }
      }
      scanInstalledPlugins()
      const s = res.summary
      return {
        ok: true,
        content: `已安装并接入 ${s?.displayName || id} v${s?.version || ''}。它注册的命令现在可以直接用 invoke 调用。`,
        data: { id, version: s?.version }
      }
    }

    if (action === 'uninstall') {
      if (!id) return { ok: false, content: '', error: 'uninstall 需要 id' }
      const res = uninstallPlugin(id)
      if (!res.ok) return { ok: false, content: '', error: res.error || '卸载失败' }
      scanInstalledPlugins()
      return { ok: true, content: `已卸载 ${id}。` }
    }

    if (action === 'invoke') {
      const channel = String(args.channel || 'backend') as 'internal' | 'backend' | 'cli'
      const command = String(args.command || '')
      if (!command) return { ok: false, content: '', error: 'invoke 需要 command' }
      let parsed: unknown = undefined
      if (typeof args.args === 'string' && args.args.trim().length > 0) {
        try {
          parsed = JSON.parse(args.args)
        } catch {
          return { ok: false, content: '', error: `args 不是合法 JSON：${args.args}` }
        }
      }
      try {
        const out = pluginManager.invoke(channel, command, parsed ?? {})
        return { ok: true, content: typeof out === 'string' ? out : JSON.stringify(out, null, 2), data: out }
      } catch (e) {
        return { ok: false, content: '', error: `调用插件命令失败：${(e as Error).message}` }
      }
    }

    return { ok: false, content: '', error: `未知 action: ${action}` }
  }
}

export const pluginTools: ToolDefinition[] = [pluginTool]

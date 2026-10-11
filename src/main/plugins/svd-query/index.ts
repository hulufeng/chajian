// SVD 寄存器查询插件（NeuralInverse #7：做成插件，数据 GitHub 托管 espressif/svd）。
//
// 设计（B1，零回归）：
//   - Agent 主路径仍走内置工具 svd_query（engine/tools/svd-tools.ts，同步返回 ToolResult），
//     因此不改动 Agent 工具面、不触碰系统提示。
//   - 本插件经 pluginManager.registerBuiltin 注册为内置插件：manifest 声明能力/工具，
//     load() 把 svd.query 注册成 backend 命令，复用同一个 svdQuery.execute（单一真相源）。
//   - 这样 SVD 能力被 pluginManager「发现」、可在设置页/plugin 工具里看到，
//     数据来源（GitHub: espressif/svd）写进 manifest 描述，符合「插件 + GitHub 托管」的意图。
import type { PluginContext } from '../pluginManager'
import { svdQuery } from '../../engine/tools/svd-tools'
import manifest from './manifest.json'

export { manifest }

export function load(ctx: PluginContext): void {
  // 命令名 svd.query（与 manifest 的 channels.backend 一致）。
  // 注意：pluginManager.invoke 不 await 异步 handler，所以 plugin invoke backend svd.query
  // 的顶层序列化对 install 这类异步 action 不完美；但 Agent 主路径走内置工具，不受影响。
  ctx.registerBackend('svd.query', (args) =>
    svdQuery.execute((args ?? {}) as Record<string, unknown>, { projectRoot: null, cwd: process.cwd() })
  )
}

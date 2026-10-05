// PlatformIO 工具（补齐竞品的 pio 链路，让 Agent 能直接驱动 pio 构建/烧录）
//
// 为什么要单独一套：现有 compile/upload 工具走 arduino-cli；
// 工程里如果存在 platformio.ini，用 pio 才是官方路径（多 env、lib_deps、分区表都在 ini 里）。
// 所以这里按「有没有 platformio.ini」自动分流，而不是让用户自己记命令。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ToolDefinition, ToolResult } from '../types'
import { findPio, detectPioProject, buildPio, uploadPio } from '../../services/platformio'

/** 输出太长时只保留尾部（pio 的错误信息都在尾部） */
function tail(text: string, n = 4000): string {
  return text.length > n ? `...(已省略前 ${text.length - n} 字符)\n${text.slice(-n)}` : text
}

function envSummary(root: string): string {
  const proj = detectPioProject(resolve(root))
  if (!proj.found) return `未找到 platformio.ini（当前工程不是 PlatformIO 工程）`
  const lines = proj.envs.map(
    (e) =>
      `  - ${e.name}  board=${e.board ?? '?'}  platform=${e.platform ?? '?'}  framework=${e.framework ?? '-'}` +
      `${e.monitorSpeed ? `  monitor_speed=${e.monitorSpeed}` : ''}`
  )
  return `PlatformIO 工程：${proj.root}\n环境（默认 ${proj.defaultEnv ?? '无'}）：\n${lines.join('\n') || '  （platformio.ini 里没有 [env:*]）'}`
}

const platformioBuild: ToolDefinition = {
  name: 'platformio_build',
  description:
    '用 PlatformIO Core（pio run）构建当前工程。**工程里存在 platformio.ini 时优先用本工具**，' +
    '因为多环境、库依赖、分区表都定义在 ini 里，arduino-cli 路径看不到这些配置。' +
    '工具会自动探测 pio 是否安装、列出 platformio.ini 里的所有 env。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程根目录，默认当前工作区根目录' },
      env: { type: 'string', description: '要构建的 env 名（platformio.ini 里的 [env:xxx]）；不填用默认 env' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const root = resolve(String(args.project || ''))
    if (!existsSync(join(root, 'platformio.ini'))) {
      return {
        ok: false,
        content: `${root} 下没有 platformio.ini。\n${envSummary(root)}\n提示：Arduino 工程请改用 compile 工具（arduino-cli）。`
      }
    }
    const pio = findPio(root)
    if (!pio.installed) {
      return { ok: false, content: `${pio.hint}\n\n${envSummary(root)}` }
    }
    const proj = detectPioProject(root)
    const env = String(args.env || proj.defaultEnv || '')
    const r = await buildPio(root, env || undefined)
    return {
      ok: r.ok,
      content:
        `PlatformIO Core ${pio.version}（${pio.command}）\n` +
        `${envSummary(root)}\n` +
        `执行：pio run${env ? ` -e ${env}` : ''}\n\n` +
        tail(r.output || '（无输出）')
    }
  }
}

const platformioUpload: ToolDefinition = {
  name: 'platformio_upload',
  description:
    '用 PlatformIO Core 烧录当前工程（pio run -t upload）。与 platformio_build 同套环境选择逻辑；' +
    'port 省略时用 platformio.ini 里的 upload_port 或让 pio 自己探测。烧录前会自动释放调试会话。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程根目录，默认当前工作区根目录' },
      env: { type: 'string', description: '要烧录的 env 名；不填用默认 env' },
      port: { type: 'string', description: '串口，如 COM3；不填用 ini 里的 upload_port' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const root = resolve(String(args.project || ''))
    if (!existsSync(join(root, 'platformio.ini'))) {
      return { ok: false, content: `${root} 下没有 platformio.ini。Arduino 工程请改用 upload 工具（arduino-cli）。` }
    }
    const pio = findPio(root)
    if (!pio.installed) return { ok: false, content: pio.hint }
    const proj = detectPioProject(root)
    const env = String(args.env || proj.defaultEnv || '')
    const port = String(args.port || '')
    const r = await uploadPio(root, { env: env || undefined, port: port || undefined })
    return {
      ok: r.ok,
      content:
        `执行：pio run -t upload${env ? ` -e ${env}` : ''}${port ? ` --upload-port ${port}` : ''}\n\n` +
        tail(r.output || '（无输出）')
    }
  }
}

const platformioInfo: ToolDefinition = {
  name: 'platformio_info',
  description:
    '查看 PlatformIO Core 安装状态与当前工程的 env 列表（board/platform/framework/monitor_speed/upload_port）。' +
    '在决定用 compile 还是 platformio_build 之前先查一次。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程根目录，默认当前工作区根目录' }
    },
    required: []
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const root = resolve(String(args.project || ''))
    const pio = findPio(root)
    return {
      ok: true,
      content:
        `PlatformIO Core：${pio.installed ? `已安装 ${pio.version}（${pio.command}，来源 ${pio.source}）` : '未安装'}\n` +
        (pio.installed ? '' : `${pio.hint}\n`) +
        `${envSummary(root)}`
    }
  }
}

export const platformioTools: ToolDefinition[] = [platformioBuild, platformioUpload, platformioInfo]

// 板卡 / 平台管理工具：查看已连接板子、已装平台、安装平台、探测烧录目标
// 全部复用 services/toolchain.ts 的 arduino-cli 封装，零新进程逻辑。
// 对齐 TrieCode「Arduino CLI 工具链」插件的「板卡 / 平台」能力，服务 ESP32 烧录前检查。
import {
  findToolchain,
  listConnectedBoardsWithSerial,
  listPlatforms,
  installPlatform,
  runArduinoCliCommand
} from '../../services/toolchain'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

const PLATFORM_INSTALL_TIMEOUT_MS = 180_000

function requireBin(): string | null {
  return findToolchain()
}

function notFound(): ToolResult {
  return {
    ok: false,
    content: '',
    error: '未找到 arduino-cli。请先在设置中一键安装，或手动配置 Arduino CLI 工具链（确保 arduino-cli 在 PATH 中）。'
  }
}

/** 流式跑一条 arduino-cli 命令，输出回传 ctx.onOutput，超时则终止 */
function runStream(args: string[], bin: string, ctx: ToolContext, timeoutMs: number, label: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    let out = ''
    const cp = runArduinoCliCommand(
      args,
      { bin },
      (c) => { out += c; ctx.onOutput?.(c) },
      (code) => {
        const ok = code === 0
        resolve({
          ok,
          content: `${label}${ok ? '成功' : '失败'}（退出码 ${code}）。\n${out.length > 2000 ? out.slice(-2000) : out}`,
          data: { exitCode: code }
        })
      }
    )
    const t = setTimeout(() => {
      try { cp.kill() } catch { /* 忽略 */ }
      resolve({ ok: false, content: out + '\n(超时，已终止)', error: `${label}超时（${timeoutMs / 1000}s）` })
    }, timeoutMs)
    cp.on('close', () => clearTimeout(t))
  })
}

// ── 工具1: board_list（只读）──
const boardList: ToolDefinition = {
  name: 'board_list',
  description: '列出当前通过 USB 连接的开发板（端口 / FQBN / 名称）。烧录前确认「插的是哪块板、占哪个 COM 口」。无板连接时返回空列表并提示。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read',
  execute: async (): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    try {
      const boards = await listConnectedBoardsWithSerial(bin)
      if (boards.length === 0) return { ok: true, content: '未检测到已连接的开发板。请检查 USB 连接、驱动与端口占用。' }
      const lines = boards.map((b, i) => `  ${i + 1}. 端口 ${b.port} | FQBN ${b.fqbn || '(未知)'} | ${b.name || ''}`)
      return { ok: true, content: `检测到 ${boards.length} 块已连接开发板：\n${lines.join('\n')}` }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具2: platform_list（只读）──
const platformList: ToolDefinition = {
  name: 'platform_list',
  description: '列出本机已安装的硬件平台（如 esp32:esp32）。确认 ESP32 平台是否就位；未装时用 platform_install 安装。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read',
  execute: async (): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    try {
      const ps = listPlatforms(bin)
      if (ps.length === 0) return { ok: true, content: '本机尚未安装任何硬件平台。ESP32 请调用 platform_install 安装 "esp32:esp32"。' }
      const lines = ps.map((p) => `  ${p.id} @ ${p.version}${p.architecture ? ' (' + p.architecture + ')' : ''}`)
      return { ok: true, content: `已安装 ${ps.length} 个平台：\n${lines.join('\n')}` }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 工具3: platform_install（写环境）──
const platformInstall: ToolDefinition = {
  name: 'platform_install',
  description: '安装硬件平台（写环境，需联网），如 "esp32:esp32"。确保 ESP32 工具链就位后再编译/烧录。不会在编译时偷偷安装——由你显式触发。',
  parameters: {
    type: 'object',
    properties: {
      platform: { type: 'string', description: '平台标识，如 "esp32:esp32"、"arduino:avr"' }
    },
    required: ['platform']
  },
  category: 'write',
  execute: async (args, ctx): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    const platform = String(args.platform)
    if (!platform) return { ok: false, content: '', error: 'platform 不能为空' }
    return runStream(['core', 'install', platform], bin, ctx, PLATFORM_INSTALL_TIMEOUT_MS, `安装平台 ${platform}`)
  }
}

// ── 工具4: board_detect（只读）──
const boardDetect: ToolDefinition = {
  name: 'board_detect',
  description: '探测当前烧录目标：返回已连接板子中第一块的 FQBN 与端口——即 compile/upload 工具将自动使用的目标。让 Agent 自证「我要烧到这块板」。无板连接时提示先接设备。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read',
  execute: async (): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    try {
      const boards = await listConnectedBoardsWithSerial(bin)
      if (boards.length === 0) return { ok: false, content: '', error: '未检测到已连接板子，无法确定烧录目标。请连接设备后重试。' }
      const b = boards[0]
      return {
        ok: true,
        content: `当前烧录目标：端口 ${b.port} | FQBN ${b.fqbn || '(未知)'} | ${b.name || ''}（共检测到 ${boards.length} 块，默认取第一块）`,
        data: { port: b.port, fqbn: b.fqbn, name: b.name }
      }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const boardTools: ToolDefinition[] = [boardList, platformList, platformInstall, boardDetect]

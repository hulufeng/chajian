// Arduino 库管理工具：搜索 / 列出已装库（只读） + 安装 / 卸载库（写环境）
// 全部复用 services/toolchain.ts 的 arduino-cli 封装，零新进程逻辑。
// 对齐 TrieCode「Arduino CLI 工具链」插件的「库管理」能力。
// 库装到 arduino-cli 默认 sketchbook（环境级），由 arduino-cli 自己管理位置。
import {
  findToolchain,
  searchLibraries,
  listInstalledLibraries,
  installLibrary,
  uninstallLibrary,
  runArduinoCliCommand
} from '../../services/toolchain'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

const INSTALL_TIMEOUT_MS = 120_000

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

function fmtLibs(libs: Array<{ name: string; version: string; author?: string; sentence?: string }>): string {
  if (libs.length === 0) return '（无）'
  return libs
    .map((l) => `  ${l.name} @ ${l.version}${l.author ? ' · ' + l.author : ''}${l.sentence ? ' — ' + l.sentence : ''}`)
    .join('\n')
}

// ── 只读工具：搜索 / 列出已装库 ──
const arduinoLib: ToolDefinition = {
  name: 'arduino_lib',
  description: 'Arduino 库管理（只读）：搜索官方库索引（action=search）或列出本机已安装库（action=list）。用于硬件编程时找库（如传感器/显示屏/WiFi 库 Adafruit_SSD1306、PubSubClient、ESP32 BLE Arduino）。库装到 arduino-cli 默认 sketchbook。安装/卸载请用 arduino_lib_install 工具。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '操作', enum: ['search', 'list'] },
      query: { type: 'string', description: 'action=search 时的关键字，如 "DHT"、"SSD1306"、"WiFi"；action=list 时忽略' }
    },
    required: ['action']
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    const action = String(args.action)
    try {
      if (action === 'search') {
        const q = String(args.query || '')
        const libs = searchLibraries(q, bin)
        if (libs.length === 0) return { ok: true, content: `未搜索到与"${q}"相关的库（可能关键字太窄，换短词试试）。` }
        return { ok: true, content: `搜索"${q}"得到 ${libs.length} 个库（取前若干）：\n${fmtLibs(libs.slice(0, 30))}` }
      }
      // list
      const libs = listInstalledLibraries(bin)
      return { ok: true, content: `本机已安装 ${libs.length} 个库：\n${fmtLibs(libs)}` }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

// ── 写工具：安装 / 卸载库（改环境，default 模式需确认）──
const arduinoLibInstall: ToolDefinition = {
  name: 'arduino_lib_install',
  description: 'Arduino 库管理（写环境）：安装库（action=install）或卸载库（action=uninstall），改动本机 sketchbook。用于给 ESP32 项目加传感器/显示屏/WiFi 等库。安装可能需联网下载。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '操作', enum: ['install', 'uninstall'] },
      name: { type: 'string', description: '库名，如 "Adafruit_SSD1306"；install 时可用 "名称@版本" 指定版本' },
      version: { type: 'string', description: 'action=install 时的版本（可选），不填装最新版' }
    },
    required: ['action', 'name']
  },
  category: 'write',
  execute: async (args, ctx): Promise<ToolResult> => {
    const bin = requireBin()
    if (!bin) return notFound()
    const action = String(args.action)
    const name = String(args.name)
    const version = args.version ? String(args.version) : ''
    const target = version ? `${name}@${version}` : name
    try {
      if (action === 'install') {
        return await runStream(['lib', 'install', target], bin, ctx, INSTALL_TIMEOUT_MS, `安装库 ${target}`)
      }
      return await runStream(['lib', 'uninstall', name], bin, ctx, INSTALL_TIMEOUT_MS, `卸载库 ${name}`)
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const arduinoLibTools: ToolDefinition[] = [arduinoLib, arduinoLibInstall]

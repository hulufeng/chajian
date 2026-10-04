import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { validateManifest, isValidManifest } from './validate-manifest'

export type ChannelName = 'internal' | 'backend' | 'cli' | 'http' | 'grpc' | 'mcp' | 'mqtt'

export interface ScaffoldFile {
  file: string
  content: string
}

export interface ProjectType {
  id: string
  title: string
  icon?: string
  scaffold: ScaffoldFile[]
}

export interface PluginManifest {
  id?: string
  name: string
  displayName: string
  version: string
  description: string
  author?: string
  developer?: string
  icon?: string
  minAppVersion?: string
  entry: string
  channels: Record<ChannelName, string[]>
  capabilities?: Record<string, { transport: string; service?: string; method?: string; output?: string }>
  tools?: Array<Record<string, unknown>>
  projectTypes?: ProjectType[]
  devicePanel?: Record<string, unknown>
  detection?: Record<string, unknown>
  commands?: Array<Record<string, unknown>>
  views?: Array<Record<string, unknown>>
}

export type CommandHandler = (args: unknown, emit?: (chunk: string) => void) => unknown

export interface PluginContext {
  /** 注册命令到指定通道 */
  register: (channel: ChannelName, command: string, handler: CommandHandler) => void
  /** 便捷：注册 backend 命令 */
  registerBackend: (command: string, handler: CommandHandler) => void
  /** 便捷：注册 internal 命令 */
  registerInternal: (command: string, handler: CommandHandler) => void
  /** 读插件目录内文件 */
  resolve: (...paths: string[]) => string
}

export interface LoadedPlugin {
  manifest: PluginManifest
  loaded: boolean
  error?: string
}

interface CommandEntry {
  plugin: string
  channel: ChannelName
  handler: CommandHandler
}

/** 流式任务约定：handler 返回 { start }, 由主进程调用方驱动 */
export interface StreamTask {
  start: (push: (chunk: string) => void, done: (code: number) => void) => () => void
}

export function isStreamTask(v: unknown): v is StreamTask {
  return !!v && typeof (v as StreamTask).start === 'function'
}

/**
 * 自研插件运行时（七类通用通道）：
 * internal（内部命令）/ backend（主进程后端命令）/ cli（命令行能力声明）
 * / http / grpc / mcp / mqtt（外部服务通道，预留）
 */
class PluginManager {
  private manifests: PluginManifest[] = []
  private commands = new Map<string, CommandEntry>()
  private builtins: Array<{ manifest: PluginManifest; load: (ctx: PluginContext) => void }> = []
  private loaded: LoadedPlugin[] = []

  /** 注册内置插件（随应用分发，编译进主进程） */
  registerBuiltin(
    manifest: PluginManifest,
    load: (ctx: PluginContext) => void
  ): void {
    this.builtins.push({ manifest, load })
  }

  /** 从磁盘目录加载插件（manifest 声明式发现，兼容 plugin.json / manifest.json） */
  loadFromDir(dir: string): void {
    try {
      // 标准 plugin.json 优先，回退 LabCode manifest.json
      const pluginJsonPath = join(dir, 'plugin.json')
      const manifestJsonPath = join(dir, 'manifest.json')
      const manifestPath = existsSync(pluginJsonPath) ? pluginJsonPath : existsSync(manifestJsonPath) ? manifestJsonPath : null
      if (!manifestPath) return
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
      const validation = validateManifest(manifest)
      if (!validation.valid) {
        console.warn(`[plugin] manifest 校验失败 ${dir}:`)
        for (const err of validation.errors) {
          console.warn(`  - ${err.field}: ${err.message}`)
        }
        return
      }
      this.manifests.push(manifest)
      const entryPath = join(dir, manifest.entry)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(entryPath) as {
        load?: (ctx: PluginContext) => void
        manifest?: PluginManifest
      }
      const load = mod.load
      if (typeof load === 'function') {
        this.builtins.push({ manifest, load })
      }
    } catch (e) {
      console.warn(`[plugin] 加载失败 ${dir}: ${(e as Error).message}`)
    }
  }

  private isValid(m: PluginManifest): boolean {
    // 完整 manifest 校验（10项：id/capabilities/tools/mqttServers/backends/commands/projectTypes/views/devicePanel/settings）
    return isValidManifest(m)
  }

  /** 初始化：校验 manifest、注册各通道命令 */
  init(): LoadedPlugin[] {
    this.loaded = []
    for (const b of this.builtins) {
      if (!this.isValid(b.manifest)) {
        this.loaded.push({ manifest: b.manifest, loaded: false, error: 'manifest 无效' })
        continue
      }
      if (this.manifests.every((m) => m.name !== b.manifest.name)) {
        this.manifests.push(b.manifest)
      }
      const ctx: PluginContext = {
        register: (channel, command, handler) => this.registerCommand(b.manifest.name, channel, command, handler),
        registerBackend: (command, handler) => this.registerCommand(b.manifest.name, 'backend', command, handler),
        registerInternal: (command, handler) => this.registerCommand(b.manifest.name, 'internal', command, handler),
        resolve: (...paths) => join(process.cwd(), 'src', 'main', 'plugins', b.manifest.name, ...paths)
      }
      try {
        b.load(ctx)
        // 自动注册 manifest.tools 中 transport: "cli" 的声明式工具（cli 通道规范）
        if (Array.isArray(b.manifest.tools)) {
          for (const tool of b.manifest.tools) {
            if (tool.transport === 'cli' && tool.name) {
              const toolDef = tool as { name: string; cli?: { command?: string[]; timeoutMs?: number; successCodes?: number[]; stream?: boolean } }
              this.registerCommand(b.manifest.name, 'cli', tool.name as string, (args, emit) =>
                this.runCliTool(toolDef, args as Record<string, unknown>, emit)
              )
            }
          }
        }
        this.loaded.push({ manifest: b.manifest, loaded: true })
        console.log(`[plugin] 已加载 ${b.manifest.displayName} v${b.manifest.version}`)
      } catch (e) {
        this.loaded.push({ manifest: b.manifest, loaded: false, error: (e as Error).message })
        console.warn(`[plugin] ${b.manifest.name} 初始化失败: ${(e as Error).message}`)
      }
    }
    return this.loaded
  }

  private registerCommand(
    plugin: string,
    channel: ChannelName,
    command: string,
    handler: CommandHandler
  ): void {
    const key = `${channel}:${command}`
    this.commands.set(key, { plugin, channel, handler })
  }

  has(channel: ChannelName, command: string): boolean {
    return this.commands.has(`${channel}:${command}`)
  }

  /** 调用插件命令（可传流式 emit 回调） */
  invoke(channel: ChannelName, command: string, args: unknown, emit?: (chunk: string) => void): unknown {
    const entry = this.commands.get(`${channel}:${command}`)
    if (!entry) {
      throw new Error(`插件命令未注册: ${channel}:${command}`)
    }
    return entry.handler(args, emit)
  }

  list(): LoadedPlugin[] {
    return this.loaded
  }

  /** 聚合所有插件声明的工程类型（projectTypes） */
  getProjectTypes(): ProjectType[] {
    const result: ProjectType[] = []
    for (const p of this.loaded) {
      if (p.manifest.projectTypes) {
        for (const pt of p.manifest.projectTypes) {
          if (!result.some((r) => r.id === pt.id)) result.push(pt)
        }
      }
    }
    return result
  }

  /** 获取所有插件声明的能力（capabilities） */
  getCapabilities(): Record<string, { transport: string; service?: string; method?: string; plugin: string }> {
    const result: Record<string, { transport: string; service?: string; method?: string; plugin: string }> = {}
    for (const p of this.loaded) {
      if (p.manifest.capabilities) {
        for (const [key, val] of Object.entries(p.manifest.capabilities)) {
          if (!result[key]) {
            result[key] = { ...val, plugin: p.manifest.name }
          }
        }
      }
    }
    return result
  }

  /** 获取所有插件声明的设备面板（devicePanel） */
  getDevicePanels(): Array<{ plugin: string; id: string; title: string; icon?: string; selectors: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }> {
    const result: Array<{ plugin: string; id: string; title: string; icon?: string; selectors: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }> = []
    for (const p of this.loaded) {
      const dp = p.manifest.devicePanel as Record<string, unknown> | undefined
      if (dp && dp.id) {
        result.push({
          plugin: p.manifest.name,
          id: dp.id as string,
          title: (dp.title as string) || p.manifest.displayName,
          icon: p.manifest.icon,
          selectors: (dp.selectors as Array<Record<string, unknown>>) || [],
          actions: (dp.actions as Array<Record<string, unknown>>) || []
        })
      }
    }
    return result
  }

  /**
   * CLI 通道执行器（cli transport）
   * spawn 数组参数防注入，{占位符} 替换，支持 timeout 和流式输出
   */
  runCliTool(
    toolDef: { name: string; cli?: { command?: string[]; timeoutMs?: number; successCodes?: number[]; stream?: boolean } },
    args: Record<string, unknown>,
    emit?: (chunk: string) => void
  ): () => void {
    const cli = toolDef.cli
    if (!cli || !cli.command || cli.command.length === 0) {
      emit?.(`[cli 错误] 工具 ${toolDef.name} 未声明 command\n`)
      return () => undefined
    }

    // 占位符替换：{argName} → args[argName]，{defaultPort}/{defaultFQBN} → 设备上下文
    const deviceCtx = this.getDeviceContext()
    const resolved = cli.command.map((arg) => {
      let result = arg
      for (const [key, val] of Object.entries(args)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val ?? ''))
      }
      result = result.replace(/\{defaultPort\}/g, deviceCtx.port || '')
      result = result.replace(/\{defaultFQBN\}/g, deviceCtx.board || '')
      return result
    })

    const [bin, ...params] = resolved
    const timeoutMs = cli.timeoutMs || 30000
    const successCodes = cli.successCodes || [0]

    emit?.(`\n▶ ${bin} ${params.join(' ')}\n`)

    const cp = spawn(bin, params, { stdio: ['ignore', 'pipe', 'pipe'] })
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      cp.kill('SIGKILL')
      emit?.(`\n[cli 超时] ${bin} 超过 ${timeoutMs}ms，已终止\n`)
    }, timeoutMs)

    cp.stdout?.on('data', (d: Buffer) => emit?.(d.toString()))
    cp.stderr?.on('data', (d: Buffer) => emit?.(d.toString()))
    cp.on('error', (err) => emit?.(`[cli 错误] ${err.message}\n`))
    cp.on('close', (code) => {
      clearTimeout(timer)
      if (!killed) {
        const ok = successCodes.includes(code ?? -1)
        emit?.(`\n[cli 完成] ${bin} 退出码 ${code}${ok ? '' : '（失败）'}\n`)
      }
    })

    return () => {
      clearTimeout(timer)
      if (!cp.killed) cp.kill('SIGKILL')
    }
  }

  /** 读取设备上下文（选中的开发板/端口） */
  private getDeviceContext(): { board: string; port: string } {
    try {
      // 延迟导入避免循环依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readSettings } = require('../updater')
      const s = readSettings()
      return { board: (s.deviceBoard as string) || '', port: (s.devicePort as string) || '' }
    } catch {
      return { board: '', port: '' }
    }
  }

  /** 聚合所有插件声明的命令（commands） */
  getCommands(): Array<{
    plugin: string
    id: string
    title: string
    icon?: string
    kind: string
    view?: string
    placement?: string
    when?: string
    transport?: string
  }> {
    const result: Array<{ plugin: string; id: string; title: string; icon?: string; kind: string; view?: string; placement?: string; when?: string; transport?: string }> = []
    for (const p of this.loaded) {
      const cmds = p.manifest.commands as Array<Record<string, unknown>> | undefined
      if (Array.isArray(cmds)) {
        for (const c of cmds) {
          result.push({
            plugin: p.manifest.name,
            id: `${p.manifest.name}.${c.id as string}`,
            title: (c.title as string) || (c.id as string),
            icon: c.icon as string | undefined,
            kind: (c.kind as string) || 'action',
            view: c.view as string | undefined,
            placement: c.placement as string | undefined,
            when: c.when as string | undefined,
            transport: c.transport as string | undefined
          })
        }
      }
    }
    return result
  }
}

export const pluginManager = new PluginManager()

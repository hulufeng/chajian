import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { validateManifest, isValidManifest } from './validate-manifest'

export type ChannelName = 'internal' | 'backend' | 'cli' | 'http' | 'grpc' | 'mcp' | 'mqtt'

import { resolvePlaceholders } from './settings-resolver'
import { mqttBridge, type MqttServerSpec } from './mqtt-bridge'
import type { ToolCategory } from '../engine/types'

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
  mqttServers?: Array<Record<string, unknown>>
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
  /**
   * 调用宿主（或别的插件）已注册的命令。
   * 插件不直接 require 宿主模块（打包后路径会变），一律走通道互调，
   * 这样插件运行时和宿主版本的耦合只靠命令名，不靠文件路径。
   */
  invoke: (channel: ChannelName, command: string, args?: unknown) => unknown
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
/** 插件工具声明（manifest.tools[] 元素，七通道绑定形状的并集） */
export interface PluginToolDef {
  name: string
  transport: ChannelName | string
  category?: string
  description?: string
  cli?: { command?: string[]; timeoutMs?: number; successCodes?: number[]; stream?: boolean }
  http?: { url: string; method?: string; headers?: Record<string, string>; body?: string; query?: Record<string, string>; timeoutMs?: number }
  grpc?: { service?: string; method?: string }
  mcp?: { server?: string; tool?: string }
  internal?: { service?: string; method?: string }
  backend?: { backendId?: string; method?: string }
  mqtt?: { server?: string; op?: string; topic?: string }
}

/** HTTP 请求渲染结果（纯数据，便于单测） */
export interface HttpRequestSpec {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

/** 把 {argName} 替换为调用参数（未知参数替换为空串，避免把密钥名泄漏到命令行） */
function substVars(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
    args[k] !== undefined && args[k] !== null ? String(args[k]) : ''
  )
}

/**
 * 渲染一次 HTTP 工具调用：先注入 {settings.*}（密钥不落包），再替换 {argName}，
 * 合并 query 参数，返回可直接 fetch 的请求规格（纯函数，不触网，便于单测）。
 */
export function renderHttpRequest(
  http: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    query?: Record<string, string>
    timeoutMs?: number
  },
  args: Record<string, unknown> = {},
  settings: Record<string, unknown> = {}
): HttpRequestSpec {
  const withSettings = (s: string) => resolvePlaceholders(s, settings)
  const query = { ...(http.query || {}) }
  for (const [k, v] of Object.entries(query)) query[k] = withSettings(String(v))

  let url = withSettings(http.url)
  const hashIdx = url.indexOf('#')
  let hash = ''
  let base = url
  if (hashIdx >= 0) {
    hash = url.slice(hashIdx)
    base = url.slice(0, hashIdx)
  }
  const qIdx = base.indexOf('?')
  const basePath = qIdx >= 0 ? base.slice(0, qIdx) : base
  const qp = new URLSearchParams(qIdx >= 0 ? base.slice(qIdx + 1) : '')
  for (const [k, v] of Object.entries(query)) qp.append(k, substVars(v, args))
  const queryStr = qp.toString()
  url = basePath + (queryStr ? '?' + queryStr : '') + hash
  url = substVars(url, args)

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(http.headers || {})) {
    headers[k] = substVars(withSettings(String(v)), args)
  }
  const body = http.body !== undefined ? substVars(withSettings(http.body), args) : undefined
  return {
    method: (http.method || 'GET').toUpperCase(),
    url,
    headers,
    body,
    timeoutMs: http.timeoutMs || 15000,
  }
}

/**
 * 插件 tools[].category（副作用维度 create/query/modify/delete/execute）
 * → 引擎权限维度 ToolCategory（read/write/query/execute）。
 * 让 Agent 复用权限策略对插件工具做确认门控，category 不再只是死声明。
 */
export function mapPluginCategoryToEngine(category?: string): ToolCategory {
  switch (category) {
    case 'create':
    case 'modify':
    case 'delete':
      return 'write'
    case 'query':
      return 'query'
    case 'execute':
      return 'execute'
    default:
      return 'execute'
  }
}

export class PluginManager {
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
      // 加载时注入 {settings.*} 占位符（密钥不硬编码、不随包分发）
      const resolved = resolvePlaceholders(manifest) as PluginManifest
      this.manifests.push(resolved)
      const entryPath = join(dir, resolved.entry)
      // 同一路径反复安装时会命中旧模块缓存，先摘掉再 require，保证加载到新落盘的文件
      delete require.cache[require.resolve(entryPath)]
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(entryPath) as {
        load?: (ctx: PluginContext) => void
        manifest?: PluginManifest
      }
      const load = mod.load
      if (typeof load === 'function') {
        this.builtins.push({ manifest: resolved, load })
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
      // 加载时注入 {settings.*} 占位符（密钥不硬编码、不随包分发）
      const manifest = resolvePlaceholders(b.manifest) as PluginManifest
      if (this.manifests.every((m) => m.name !== manifest.name)) {
        this.manifests.push(manifest)
      }
      const ctx: PluginContext = {
        register: (channel, command, handler) => this.registerCommand(manifest.name, channel, command, handler),
        registerBackend: (command, handler) => this.registerCommand(manifest.name, 'backend', command, handler),
        registerInternal: (command, handler) => this.registerCommand(manifest.name, 'internal', command, handler),
        resolve: (...paths) => join(process.cwd(), 'src', 'main', 'plugins', manifest.name, ...paths),
        // 插件调宿主：命令不存在时返回结构化错误对象（而不是抛），
        // 让插件能自己降级/报错，异常也不会顺着 IPC 冒到窗口级别。
        invoke: (channel, command, args) => {
          if (!this.commands.has(`${channel}:${command}`)) {
            return { ok: false, error: `宿主命令未注册: ${channel}:${command}` }
          }
          return this.invoke(channel, command, args)
        }
      }
      try {
        b.load(ctx)
        // 声明式工具自动注册：cli/http/mqtt/grpc/mcp 由运行时按绑定形状直接执行；
        // internal/backend 由插件/宿主在 load() 中手动 register，这里不重复注册（避免覆盖手动实现）。
        const DECLARATIVE = new Set(['cli', 'http', 'mqtt', 'grpc', 'mcp'])
        if (Array.isArray(manifest.tools)) {
          for (const tool of manifest.tools) {
            if (!tool || typeof tool.name !== 'string' || typeof tool.transport !== 'string') continue
            if (!DECLARATIVE.has(tool.transport)) continue
            const toolDef = tool as unknown as PluginToolDef
            this.registerCommand(manifest.name, tool.transport as ChannelName, tool.name, (args, emit) =>
              this.runTool(toolDef, (args || {}) as Record<string, unknown>, emit, manifest)
            )
          }
        }
        this.loaded.push({ manifest, loaded: true })
        console.log(`[plugin] 已加载 ${manifest.displayName} v${manifest.version}`)
      } catch (e) {
        this.loaded.push({ manifest, loaded: false, error: (e as Error).message })
        console.warn(`[plugin] ${manifest.name} 初始化失败: ${(e as Error).message}`)
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

  /** 聚合所有插件声明的技能（skills[]）——给 Agent / 命令面板做能力引导 */
  getSkills(): Array<{ plugin: string; name: string; description: string; prompt?: string }> {
    const out: Array<{ plugin: string; name: string; description: string; prompt?: string }> = []
    for (const p of this.loaded) {
      const skills = (p.manifest as unknown as Record<string, unknown>).skills
      if (Array.isArray(skills)) {
        for (const s of skills as Array<Record<string, unknown>>) {
          if (s && typeof s.name === 'string' && typeof s.description === 'string') {
            out.push({
              plugin: p.manifest.name,
              name: s.name as string,
              description: s.description as string,
              prompt: typeof s.prompt === 'string' ? (s.prompt as string) : undefined
            })
          }
        }
      }
    }
    return out
  }

  /** 聚合所有插件声明的工具（tools[]），带上 transport / category / sideEffect（已映射到引擎权限维度） */
  getTools(): Array<{
    plugin: string
    name: string
    transport: string
    category?: string
    sideEffect: ToolCategory
    description?: string
  }> {
    const out: Array<{ plugin: string; name: string; transport: string; category?: string; sideEffect: ToolCategory; description?: string }> = []
    for (const p of this.loaded) {
      const tools = (p.manifest as unknown as Record<string, unknown>).tools
      if (Array.isArray(tools)) {
        for (const t of tools as Array<Record<string, unknown>>) {
          if (t && typeof t.name === 'string' && typeof t.transport === 'string') {
            const category = typeof t.category === 'string' ? (t.category as string) : undefined
            out.push({
              plugin: p.manifest.name,
              name: t.name as string,
              transport: t.transport as string,
              category,
              sideEffect: mapPluginCategoryToEngine(category),
              description: typeof t.description === 'string' ? (t.description as string) : undefined
            })
          }
        }
      }
    }
    return out
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

  /** 安全读设置（不抛，降级为空对象） */
  private readSettingsSafe(): Record<string, unknown> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readSettings } = require('../settings')
      const s = readSettings()
      return (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  /**
   * 统一工具执行器：按 tools[].transport 分派到具体通道实现。
   * 此前只有 cli 被接进运行时，http/grpc/mcp/backend/internal/mqtt 是声明了却没人执行的"死声明"，
   * 这里把七通道统一成一条执行路径，外部/差异化通道不再空洞。
   */
  runTool(
    toolDef: PluginToolDef,
    args: Record<string, unknown> = {},
    emit?: (chunk: string) => void,
    manifest?: PluginManifest
  ): () => void {
    const t = toolDef.transport
    switch (t) {
      case 'cli':
        return this.runCliTool(toolDef, args, emit)
      case 'http':
        return this.runHttpTool(toolDef, args, emit)
      case 'mqtt':
        return this.runMqttTool(toolDef, args, emit, manifest)
      case 'grpc':
        return this.runGrpcTool(toolDef, args, emit)
      case 'mcp':
        return this.runMcpTool(toolDef, args, emit)
      case 'internal':
      case 'backend':
        // 指针型工具：命令由插件/宿主手动注册，运行时直接按通道名调用
        return this.runPointerTool(toolDef, args, emit)
      default:
        emit?.(`[tool 错误] 未知 transport: ${String(t)}\n`)
        return () => undefined
    }
  }

  /** HTTP 通道执行器（实装：fetch + 超时 + {settings.*}/{arg} 注入 + query 合并） */
  runHttpTool(toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void): () => void {
    const http = toolDef.http
    if (!http || !http.url) {
      emit?.('[http 错误] 工具未声明 http.url\n')
      return () => undefined
    }
    let spec: HttpRequestSpec
    try {
      spec = renderHttpRequest(http, args, this.readSettingsSafe())
    } catch (e) {
      emit?.(`[http 错误] 请求渲染失败: ${(e as Error).message}\n`)
      return () => undefined
    }
    emit?.(`\n▶ ${spec.method} ${spec.url}\n`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs)
    void (async () => {
      try {
        const res = await fetch(spec.url, {
          method: spec.method,
          headers: spec.headers,
          body: spec.body,
          signal: controller.signal as AbortSignal,
        })
        emit?.(`[http] 状态码 ${res.status} ${res.statusText}\n`)
        const text = await res.text()
        emit?.(text)
        emit?.(`\n[http 完成] 退出码 ${res.ok ? 0 : 1}\n`)
      } catch (e) {
        emit?.(`\n[http 错误] ${e instanceof Error ? e.message : String(e)}\n[http 完成] 退出码 1\n`)
      } finally {
        clearTimeout(timer)
      }
    })()
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /** 指针型工具（internal/backend）：直接调用已注册的通道命令，未注册则结构化报错 */
  runPointerTool(toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void): () => void {
    const ch = (toolDef.transport === 'backend' ? 'backend' : 'internal') as ChannelName
    const cmd = toolDef.name
    if (!this.has(ch, cmd)) {
      emit?.(
        `[${ch} 错误] 命令未注册: ${cmd}（请在插件 load() 中 ctx.register${ch === 'internal' ? 'Internal' : 'Backend'}(...) 注册，或由宿主提供）\n`
      )
      return () => undefined
    }
    try {
      const out = this.invoke(ch, cmd, args)
      emit?.(typeof out === 'string' ? out : JSON.stringify(out, null, 2) + '\n')
    } catch (e) {
      emit?.(`[${ch} 错误] ${(e as Error).message}\n`)
    }
    return () => undefined
  }

  /** 外部通道适配器（grpc/mcp 等需要真实客户端时由宿主注册；未注册则结构化降级，不崩溃） */
  private transportAdapters: Record<string, ((toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void) => (() => void) | void) | undefined> = {}

  registerTransportAdapter(
    transport: string,
    fn: (toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void) => (() => void) | void
  ): void {
    this.transportAdapters[transport] = fn
  }

  runGrpcTool(toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void): () => void {
    const adapter = this.transportAdapters['grpc']
    if (adapter) return (adapter(toolDef, args, emit) as (() => void) | void) || (() => undefined)
    emit?.('[grpc] 通道为框架预留：需宿主注册 gRPC 适配器（如 @grpc/grpc-js）后方可执行。\n')
    emit?.(`[grpc] 调用规格: ${JSON.stringify(toolDef.grpc || {})}\n`)
    return () => undefined
  }

  runMcpTool(toolDef: PluginToolDef, args: Record<string, unknown>, emit?: (chunk: string) => void): () => void {
    const adapter = this.transportAdapters['mcp']
    if (adapter) return (adapter(toolDef, args, emit) as (() => void) | void) || (() => undefined)
    emit?.('[mcp] 通道为框架预留：需宿主注册 MCP 客户端适配器后方可执行。\n')
    emit?.(`[mcp] 调用规格: ${JSON.stringify(toolDef.mcp || {})}\n`)
    return () => undefined
  }

  /** MQTT 通道执行器（差异化能力：串口↔MQTT 互转，依赖可选 mqtt 包，未装则结构化降级） */
  runMqttTool(
    toolDef: PluginToolDef,
    args: Record<string, unknown>,
    emit?: (chunk: string) => void,
    manifest?: PluginManifest
  ): () => void {
    const mqtt = toolDef.mqtt
    if (!mqtt || !mqtt.server || !mqtt.op) {
      emit?.('[mqtt 错误] 工具未声明 mqtt.server / mqtt.op\n')
      return () => undefined
    }
    const serverSpec = (manifest?.mqttServers as Array<MqttServerSpec> | undefined)?.find(
      (s) => s.name === mqtt.server
    )
    if (!serverSpec) {
      emit?.(`[mqtt 错误] 未在 manifest.mqttServers 找到服务器: ${mqtt.server}\n`)
      return () => undefined
    }
    const topic = mqtt.topic || String(args.topic || '')
    if (!topic) {
      emit?.('[mqtt 错误] 缺少 topic（工具 mqtt.topic 或调用参数 topic）\n')
      return () => undefined
    }
    const connectRes = mqttBridge.connect(serverSpec)
    if (!connectRes.ok) {
      emit?.(`[mqtt] ${connectRes.error}\n`)
      return () => undefined
    }
    if (mqtt.op === 'publish') {
      const payload = args.payload !== undefined ? String(args.payload) : ''
      const r = mqttBridge.publish(mqtt.server as string, topic, payload)
      emit?.(r.ok ? `[mqtt] 已发布到 ${topic}\n` : `[mqtt 错误] ${r.error}\n`)
      return () => undefined
    }
    if (mqtt.op === 'subscribe') {
      const r = mqttBridge.subscribe(mqtt.server as string, topic, (t, p) => emit?.(`[mqtt] ${t}: ${p}\n`))
      emit?.(r.ok ? `[mqtt] 已订阅 ${topic}\n` : `[mqtt 错误] ${r.error}\n`)
      return () => undefined
    }
    emit?.(`[mqtt 错误] 未知 op: ${mqtt.op}（支持 publish / subscribe）\n`)
    return () => undefined
  }

  /** 读取设备上下文（选中的开发板/端口） */
  private getDeviceContext(): { board: string; port: string } {
    try {
      // 延迟导入避免循环依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readSettings } = require('../settings')
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

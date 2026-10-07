// 插件 Manifest 校验器
// 对齐 TrieCode core/utils/validate-manifest.js：10项校验，防误配置不防恶意
import type { PluginManifest, ChannelName } from './pluginManager'

// 能力 ID 枚举（内置能力，插件可声明任意 kebab-case 扩展能力）
const VALID_CAPABILITIES = new Set([
  'compile', 'upload', 'flash', 'debug',
  'board-manage', 'board-select', 'board-search', 'board-list',
  'library-manage', 'library-install', 'library-search', 'library-list',
  'platform-install', 'platform-list', 'platform-uninstall',
  'serial-list', 'serial-open', 'serial-monitor',
  'toolchain-detect', 'project-create'
])

// 7种 transport
const VALID_TRANSPORTS = new Set(['cli', 'http', 'grpc', 'mcp', 'internal', 'backend', 'mqtt'])

// 命令 kind
const VALID_COMMAND_KINDS = new Set(['action', 'open-view'])

// 视图 slot
const VALID_VIEW_SLOTS = new Set(['sidebar', 'activitybar', 'panel'])

// 后端 type
const VALID_BACKEND_TYPES = new Set(['grpc', 'process', 'http', 'stdio'])

// 设置 type
const VALID_SETTING_TYPES = new Set(['string', 'number', 'boolean', 'select', 'url', 'urlArray', 'password'])

// 工具 category（元插件三件套用 create/query/modify；其余为通用执行类）
const VALID_TOOL_CATEGORIES = new Set(['create', 'query', 'modify', 'delete', 'execute'])

// kebab-case 正则
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// URL 协议正则
const URL_RE = /^https?:\/\//i

export interface ValidateError {
  field: string
  message: string
}

export interface ValidateResult {
  valid: boolean
  errors: ValidateError[]
}

/**
 * 校验插件 manifest，返回错误列表（空数组=合法）
 * 未知字段保留不删（前向兼容）
 */
export function validateManifest(manifest: unknown): ValidateResult {
  const errors: ValidateError[] = []
  const m = manifest as Record<string, unknown>

  if (!m || typeof m !== 'object') {
    return { valid: false, errors: [{ field: 'root', message: 'manifest 必须是对象' }] }
  }

  // 1. id: kebab-case
  const id = m.id
  if (id !== undefined) {
    if (typeof id !== 'string' || !KEBAB_RE.test(id)) {
      errors.push({ field: 'id', message: `id 必须是 kebab-case（小写字母+数字+连字符），当前: ${JSON.stringify(id)}` })
    }
  }

  // 必填基础字段
  if (!m.name || typeof m.name !== 'string') {
    errors.push({ field: 'name', message: 'name 必填且为字符串' })
  }
  if (!m.version || typeof m.version !== 'string') {
    errors.push({ field: 'version', message: 'version 必填且为字符串' })
  }

  // 2. capabilities
  if (m.capabilities !== undefined) {
    if (typeof m.capabilities !== 'object' || m.capabilities === null || Array.isArray(m.capabilities)) {
      errors.push({ field: 'capabilities', message: 'capabilities 必须是对象（map 形态）' })
    } else {
      for (const [key, val] of Object.entries(m.capabilities as Record<string, unknown>)) {
        if (!KEBAB_RE.test(key)) {
          errors.push({ field: `capabilities.${key}`, message: `能力 ID 必须是 kebab-case，当前: ${key}` })
          continue
        }
        if (!VALID_CAPABILITIES.has(key)) {
          // 插件可声明扩展能力，仅提示不拦截（前向兼容）
          console.warn(`[plugin manifest] 能力 ID "${key}" 不在内置白名单中，按扩展能力处理`)
        }
        const cap = val as Record<string, unknown>
        if (!cap || typeof cap !== 'object') {
          errors.push({ field: `capabilities.${key}`, message: '能力绑定必须是对象' })
          continue
        }
        const transport = cap.transport as string
        if (!transport || !VALID_TRANSPORTS.has(transport)) {
          errors.push({ field: `capabilities.${key}.transport`, message: `transport 必须是 ${[...VALID_TRANSPORTS].join('/')}，当前: ${transport}` })
          continue
        }
        // 绑定形状校验
        if (transport === 'internal' && (!cap.service || !cap.method)) {
          errors.push({ field: `capabilities.${key}`, message: 'internal 绑定需要 service 和 method' })
        }
        if (transport === 'cli' && !cap.command && !cap.steps) {
          errors.push({ field: `capabilities.${key}`, message: 'cli 绑定需要 command 或 steps' })
        }
        if (transport === 'http' && !cap.url) {
          errors.push({ field: `capabilities.${key}`, message: 'http 绑定需要 url' })
        }
      }
    }
  }

  // 3. tools
  if (m.tools !== undefined) {
    if (!Array.isArray(m.tools)) {
      errors.push({ field: 'tools', message: 'tools 必须是数组' })
    } else {
      for (let i = 0; i < (m.tools as unknown[]).length; i++) {
        const tool = (m.tools as Record<string, unknown>[])[i]
        if (!tool || typeof tool !== 'object') {
          errors.push({ field: `tools[${i}]`, message: '工具必须是对象' })
          continue
        }
        if (!tool.name || typeof tool.name !== 'string') {
          errors.push({ field: `tools[${i}].name`, message: '工具 name 必填' })
          continue
        }
        // category 可选枚举（元插件三件套用 create/query/modify）
        const category = tool.category as string | undefined
        if (category && !VALID_TOOL_CATEGORIES.has(category)) {
          errors.push({ field: `tools[${i}].category`, message: `工具 ${String(tool.name)} 的 category 必须是 ${[...VALID_TOOL_CATEGORIES].join('/')}` })
        }
        const transport = tool.transport as string
        if (!transport || !VALID_TRANSPORTS.has(transport)) {
          errors.push({ field: `tools[${i}].transport`, message: `工具 ${String(tool.name)} 的 transport 必须是 ${[...VALID_TRANSPORTS].join('/')}` })
          continue
        }
        // transport 专属字段
        if (transport === 'cli') {
          const cli = tool.cli as Record<string, unknown> | undefined
          if (!cli || !Array.isArray(cli.command) || cli.command.length === 0) {
            errors.push({ field: `tools[${i}].cli.command`, message: `工具 ${String(tool.name)} (cli) 需要非空 command 数组` })
          }
          if (cli && cli.timeoutMs !== undefined && typeof cli.timeoutMs !== 'number') {
            errors.push({ field: `tools[${i}].cli.timeoutMs`, message: 'timeoutMs 必须是数字' })
          }
        }
        if (transport === 'http') {
          const http = tool.http as Record<string, unknown> | undefined
          if (!http || !http.url || typeof http.url !== 'string') {
            errors.push({ field: `tools[${i}].http.url`, message: `工具 ${String(tool.name)} (http) 需要 url` })
          }
        }
        if (transport === 'grpc') {
          const grpc = tool.grpc as Record<string, unknown> | undefined
          if (!grpc || !grpc.service || !grpc.method) {
            errors.push({ field: `tools[${i}].grpc`, message: `工具 ${String(tool.name)} (grpc) 需要 service 和 method` })
          }
        }
        if (transport === 'mcp') {
          const mcp = tool.mcp as Record<string, unknown> | undefined
          if (!mcp || !mcp.server || !mcp.tool) {
            errors.push({ field: `tools[${i}].mcp`, message: `工具 ${String(tool.name)} (mcp) 需要 server 和 tool` })
          }
        }
        if (transport === 'internal') {
          const internal = tool.internal as Record<string, unknown> | undefined
          if (!internal || !internal.service || !internal.method) {
            errors.push({ field: `tools[${i}].internal`, message: `工具 ${String(tool.name)} (internal) 需要 service 和 method` })
          }
        }
        if (transport === 'backend') {
          const backend = tool.backend as Record<string, unknown> | undefined
          if (!backend || !backend.backendId || !backend.method) {
            errors.push({ field: `tools[${i}].backend`, message: `工具 ${String(tool.name)} (backend) 需要 backendId 和 method` })
          }
        }
        if (transport === 'mqtt') {
          const mqtt = tool.mqtt as Record<string, unknown> | undefined
          if (!mqtt || !mqtt.server || !mqtt.op) {
            errors.push({ field: `tools[${i}].mqtt`, message: `工具 ${String(tool.name)} (mqtt) 需要 server 和 op` })
          }
        }
      }
    }
  }

  // 4. mqttServers
  if (m.mqttServers !== undefined) {
    if (!Array.isArray(m.mqttServers)) {
      errors.push({ field: 'mqttServers', message: 'mqttServers 必须是数组' })
    } else {
      const names = new Set<string>()
      for (let i = 0; i < (m.mqttServers as unknown[]).length; i++) {
        const srv = (m.mqttServers as Record<string, unknown>[])[i]
        if (!srv || typeof srv !== 'object') continue
        const name = srv.name as string
        if (!name) {
          errors.push({ field: `mqttServers[${i}].name`, message: 'MQTT 服务器 name 必填' })
        } else if (names.has(name)) {
          errors.push({ field: `mqttServers[${i}].name`, message: `MQTT 服务器 name 重复: ${name}` })
        } else {
          names.add(name)
        }
        const url = srv.url as string
        if (url && !/^(mqtts?|tcp|ssl):\/\//i.test(url)) {
          errors.push({ field: `mqttServers[${i}].url`, message: `MQTT url 协议不合法: ${url}` })
        }
        const topics = srv.topics as string[] | undefined
        if (Array.isArray(topics)) {
          for (const t of topics) {
            if (typeof t === 'string' && t.includes('#')) {
              errors.push({ field: `mqttServers[${i}].topics`, message: `MQTT topic 不允许 # 通配符: ${t}` })
            }
          }
        }
      }
    }
  }

  // 5. backends
  if (m.backends !== undefined) {
    if (!Array.isArray(m.backends)) {
      errors.push({ field: 'backends', message: 'backends 必须是数组' })
    } else {
      for (let i = 0; i < (m.backends as unknown[]).length; i++) {
        const be = (m.backends as Record<string, unknown>[])[i]
        if (!be || typeof be !== 'object') continue
        const type = be.type as string
        if (type && !VALID_BACKEND_TYPES.has(type)) {
          errors.push({ field: `backends[${i}].type`, message: `backend type 必须是 ${[...VALID_BACKEND_TYPES].join('/')}，当前: ${type}` })
        }
        if (!be.command || typeof be.command !== 'string') {
          errors.push({ field: `backends[${i}].command`, message: 'backend command 必填' })
        }
      }
    }
  }

  // 6. commands
  if (m.commands !== undefined) {
    if (!Array.isArray(m.commands)) {
      errors.push({ field: 'commands', message: 'commands 必须是数组' })
    } else {
      for (let i = 0; i < (m.commands as unknown[]).length; i++) {
        const cmd = (m.commands as Record<string, unknown>[])[i]
        if (!cmd || typeof cmd !== 'object') continue
        if (!cmd.id || typeof cmd.id !== 'string') {
          errors.push({ field: `commands[${i}].id`, message: '命令 id 必填' })
        }
        if (!cmd.title || typeof cmd.title !== 'string') {
          errors.push({ field: `commands[${i}].title`, message: '命令 title 必填' })
        }
        const kind = cmd.kind as string
        if (kind && !VALID_COMMAND_KINDS.has(kind)) {
          errors.push({ field: `commands[${i}].kind`, message: `命令 kind 必须是 ${[...VALID_COMMAND_KINDS].join('/')}，当前: ${kind}` })
        }
        if (kind === 'open-view' && !cmd.view) {
          errors.push({ field: `commands[${i}].view`, message: 'open-view 命令需要 view 字段' })
        }
      }
    }
  }

  // 7. projectTypes + scaffold 路径安全
  if (m.projectTypes !== undefined) {
    if (!Array.isArray(m.projectTypes)) {
      errors.push({ field: 'projectTypes', message: 'projectTypes 必须是数组' })
    } else {
      for (let i = 0; i < (m.projectTypes as unknown[]).length; i++) {
        const pt = (m.projectTypes as Record<string, unknown>[])[i]
        if (!pt || typeof pt !== 'object') continue
        if (!pt.id || typeof pt.id !== 'string') {
          errors.push({ field: `projectTypes[${i}].id`, message: '项目类型 id 必填' })
        }
        const scaffold = pt.scaffold as Array<{ file: string; content: string }> | undefined
        if (Array.isArray(scaffold)) {
          for (let j = 0; j < scaffold.length; j++) {
            const file = scaffold[j].file
            if (typeof file !== 'string') continue
            // 路径安全：拒绝绝对路径和 .. 穿越
            if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/') || file.startsWith('\\')) {
              errors.push({ field: `projectTypes[${i}].scaffold[${j}].file`, message: `scaffold 文件不允许绝对路径: ${file}` })
            }
            // 按路径段判定 .. 穿越：拒绝 ../x、foo/../bar、独立 ..，但放行 main..js 这类正常文件名（避免误报）
            if (file.split(/[\\/]/).includes('..')) {
              errors.push({ field: `projectTypes[${i}].scaffold[${j}].file`, message: `scaffold 文件不允许 .. 路径穿越: ${file}` })
            }
          }
        }
      }
    }
  }

  // 8. views
  if (m.views !== undefined) {
    if (!Array.isArray(m.views)) {
      errors.push({ field: 'views', message: 'views 必须是数组' })
    } else {
      for (let i = 0; i < (m.views as unknown[]).length; i++) {
        const view = (m.views as Record<string, unknown>[])[i]
        if (!view || typeof view !== 'object') continue
        if (!view.id || typeof view.id !== 'string') {
          errors.push({ field: `views[${i}].id`, message: '视图 id 必填' })
        }
        const slot = view.slot as string
        if (slot && !VALID_VIEW_SLOTS.has(slot)) {
          errors.push({ field: `views[${i}].slot`, message: `视图 slot 必须是 ${[...VALID_VIEW_SLOTS].join('/')}，当前: ${slot}` })
        }
        if (view.type === 'webview' && !view.entry) {
          errors.push({ field: `views[${i}].entry`, message: 'webview 视图需要 entry 字段' })
        }
      }
    }
  }

  // 9. devicePanel
  if (m.devicePanel !== undefined) {
    const dp = m.devicePanel as Record<string, unknown>
    if (!dp || typeof dp !== 'object' || Array.isArray(dp)) {
      errors.push({ field: 'devicePanel', message: 'devicePanel 必须是对象' })
    } else {
      if (!dp.id || typeof dp.id !== 'string') {
        errors.push({ field: 'devicePanel.id', message: 'devicePanel id 必填' })
      }
      const selectors = dp.selectors as unknown[] | undefined
      if (!Array.isArray(selectors) || selectors.length === 0) {
        errors.push({ field: 'devicePanel.selectors', message: 'devicePanel 至少需要一个 selector' })
      } else {
        for (let i = 0; i < selectors.length; i++) {
          const sel = selectors[i] as Record<string, unknown>
          if (!sel || typeof sel !== 'object') continue
          if (!sel.id || typeof sel.id !== 'string') {
            errors.push({ field: `devicePanel.selectors[${i}].id`, message: 'selector id 必填' })
          }
        }
      }
    }
  }

  // 10. settings
  if (m.settings !== undefined) {
    if (!Array.isArray(m.settings)) {
      errors.push({ field: 'settings', message: 'settings 必须是数组' })
    } else {
      for (let i = 0; i < (m.settings as unknown[]).length; i++) {
        const setting = (m.settings as Record<string, unknown>[])[i]
        if (!setting || typeof setting !== 'object') continue
        if (!setting.key || typeof setting.key !== 'string') {
          errors.push({ field: `settings[${i}].key`, message: '设置项 key 必填' })
        }
        const type = setting.type as string
        if (type && !VALID_SETTING_TYPES.has(type)) {
          errors.push({ field: `settings[${i}].type`, message: `设置 type 必须是 ${[...VALID_SETTING_TYPES].join('/')}，当前: ${type}` })
        }
        // password 类型不允许在 manifest 里写死默认值（密钥必须走 {settings.*} 运行时注入，
        // 不能随包分发落库——否则等于把密钥明文打进 zip，校验器在这里直接拦下）。
        if (type === 'password') {
          const def = setting.default
          if (def !== undefined && def !== '') {
            errors.push({
              field: `settings[${i}].default`,
              message: 'password 类型不允许在 manifest 中写死默认值（密钥应走 {settings.*} 运行时注入，不随包分发）',
            })
          }
        }
      }
    }
  }

  // 11. skills（技能层：多步规划与选型引导）
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills)) {
      errors.push({ field: 'skills', message: 'skills 必须是数组' })
    } else {
      for (let i = 0; i < (m.skills as unknown[]).length; i++) {
        const skill = (m.skills as Record<string, unknown>[])[i]
        if (!skill || typeof skill !== 'object') continue
        if (!skill.name || typeof skill.name !== 'string') {
          errors.push({ field: `skills[${i}].name`, message: '技能 name 必填' })
        }
        if (!skill.description || typeof skill.description !== 'string') {
          errors.push({ field: `skills[${i}].description`, message: '技能 description 必填' })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/** 便捷：校验并返回是否合法（非法时打印警告） */
export function isValidManifest(manifest: unknown): boolean {
  const result = validateManifest(manifest)
  if (!result.valid) {
    for (const err of result.errors) {
      console.warn(`[plugin manifest] ${err.field}: ${err.message}`)
    }
  }
  return result.valid
}

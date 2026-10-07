'use strict'
/**
 * plugin-dev-toolchain —— 元插件（用来设计插件的插件）。
 *
 * 三件套（全部经宿主内通道复用单一事实来源，自身保持自包含）：
 *   plugin-dev.create    生成插件骨架（plugin.json + index.js）落盘
 *   plugin-dev.validate 复用宿主 app.validateManifest 校验 plugin.json
 *   plugin-dev.install  落盘 userData/plugins/<id> 后调 app.reloadPlugins 热加载
 *
 * 不跨插件 require、不 require 宿主模块；与宿主的耦合只靠通道命令名
 * （app.validateManifest / app.reloadPlugins），路径解析交给运行时 ctx.invoke。
 */

const fs = require('node:fs')
const path = require('node:path')

const TRANSPORTS = ['cli', 'internal', 'http', 'grpc', 'mcp', 'backend', 'mqtt']
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 取本机插件根目录：优先 electron app，回退 null（让调用方决定 targetDir） */
function pluginsRoot() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'plugins')
  } catch {
    return null
  }
}

// ── create：生成骨架 ───────────────────────────────────────────────────
function createSkeleton(args) {
  const id = String((args && args.id) || '').trim()
  const name = String((args && args.name) || id || '').trim()
  const displayName = String((args && args.displayName) || name || '').trim()
  const transport = String((args && args.transport) || 'internal').trim()
  const author = String((args && args.author) || '插件作者').trim()
  const outDir = String((args && args.outDir) || '').trim()

  if (!KEBAB_RE.test(id)) return { ok: false, error: `id 必须是 kebab-case（当前: ${id}）` }
  if (!TRANSPORTS.includes(transport)) return { ok: false, error: `transport 必须是 ${TRANSPORTS.join('/')}（当前: ${transport}）` }
  if (!outDir) return { ok: false, error: 'outDir 必填（骨架输出根目录）' }

  const root = path.join(outDir, id)
  if (fs.existsSync(root)) return { ok: false, error: `目标目录已存在：${root}` }

  const manifest = buildManifest({ id, name, displayName, transport, author })
  const indexSrc = buildIndexSource({ id, transport })

  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(root, 'index.js'), indexSrc, 'utf8')

  // 信任配套文件：第三方/本地插件应明确声明来源与授权，避免被误当官方插件
  const year = new Date().getFullYear()
  fs.writeFileSync(
    path.join(root, 'LICENSE'),
    `MIT License\n\nCopyright (c) ${year} ${author}\n\n` +
      '本插件按 MIT 协议开源。安装即表示你已阅读并理解：本插件未被 CodeLab 官方审计或随应用分发，\n' +
      '其运行风险由使用者自行承担。\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'NOTICE'),
    `NOTICE\n======\n\n` +
      `插件标识：${id}\n显示名：${displayName}\n作者：${author}\n主通道：${transport}\n\n` +
      '本插件不属于 CodeLab 官方插件，未经官方审计或签名。\n' +
      '若其声称“官方”，请向 CodeLab 官方核实来源，谨防仿冒。\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'CONTRIBUTING.md'),
    `# 贡献指南（${displayName}）\n\n` +
      '- 提交前请先在本机用 `plugin-dev.validate` 校验 plugin.json。\n' +
      '- 修改 manifest 后务必重新打包插件 zip 并刷新清单 sha256。\n' +
      '- 安全相关改动请附威胁说明（通道越权 / 密钥处理 / 文件写范围）。\n',
    'utf8'
  )

  return {
    ok: true,
    path: root,
    files: ['plugin.json', 'index.js', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md'],
    next: [
      `补全 ${path.join(root, 'plugin.json')} 的 description / capabilities / settings`,
      `在 ${path.join(root, 'index.js')} 的 load() 里实现 ${transport} 通道绑定`,
      `核对 ${path.join(root, 'LICENSE')} / ${path.join(root, 'NOTICE')} 的署名与来源声明`,
      '运行 plugin-dev.validate 校验',
      '运行 plugin-dev.install 安装到本机'
    ]
  }
}

function buildManifest({ id, name, displayName, transport, author }) {
  const toolName = `${id}.hello`
  const manifest = {
    id,
    name,
    displayName,
    version: '0.1.0',
    description: `${displayName}（由 plugin-dev.create 生成，请补全描述）`,
    author,
    minAppVersion: '0.0.1',
    entry: 'index.js',
    channels: { internal: [], backend: [], cli: [], http: [], grpc: [], mcp: [], mqtt: [] }
  }
  const tool = {
    name: toolName,
    transport,
    category: 'execute',
    description: `示例工具：来自 ${displayName}（由脚手架生成，请补全领域知识）`,
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '示例参数' } },
      additionalProperties: false
    }
  }
  if (transport === 'internal') tool.internal = { service: 'host', method: 'echo' }
  else if (transport === 'cli') tool.cli = { command: ['echo', 'hello'], timeoutMs: 30000 }
  else if (transport === 'http') tool.http = { url: 'https://example.com/api' }
  else if (transport === 'grpc') tool.grpc = { service: 'Demo', method: 'Hello' }
  else if (transport === 'mcp') tool.mcp = { server: 'demo', tool: 'hello' }
  else if (transport === 'backend') tool.backend = { backendId: id, method: 'hello' }
  else if (transport === 'mqtt') tool.mqtt = { server: 'local', op: 'publish' }
  manifest.tools = [tool]
  manifest.channels[transport].push(toolName)
  return manifest
}

function buildIndexSource({ id, transport }) {
  const toolName = `${id}.hello`
  const registerFn =
    transport === 'internal' ? 'registerInternal' : transport === 'backend' ? 'registerBackend' : 'registerInternal'
  return (
    "'use strict'\n" +
    `/**\n * ${id} —— 由 plugin-dev-toolchain 生成的骨架。\n` +
    ` * 主通道：${transport}。请在此实现业务逻辑，保持自包含\n` +
    ` * （不跨插件 require、不 require 宿主模块，耦合只靠 ctx.invoke 通道命令名）。\n */\n\n` +
    'function load(ctx) {\n' +
    `  ctx.${registerFn}('${toolName}', (args, emit) => {\n` +
    `    emit?.('[${id}] 收到调用：' + JSON.stringify(args || {}) + '\\n')\n` +
    '    return { ok: true, echo: args }\n' +
    '  })\n' +
    '}\n\n' +
    'module.exports = { load }\n'
  )
}

// ── validate：复用宿主 app.validateManifest ────────────────────────────
function validatePlugin(args, ctx) {
  const p = String((args && args.path) || '').trim()
  if (!p) return { ok: false, error: 'path 必填（plugin.json 所在目录或文件）' }
  const manifestPath = p.endsWith('.json') ? p : path.join(p, 'plugin.json')
  if (!fs.existsSync(manifestPath)) return { ok: false, error: `找不到 plugin.json：${manifestPath}` }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `plugin.json 解析失败：${e.message}` }
  }
  if (!ctx || typeof ctx.invoke !== 'function') {
    return { ok: false, error: '宿主未提供 invoke 通道，无法复用宿主校验' }
  }
  const result = ctx.invoke('internal', 'app.validateManifest', { manifest })
  return { ok: true, valid: result.valid, errors: result.errors || [], path: manifestPath }
}

// ── install：落盘 + 热加载 ─────────────────────────────────────────────
function installPlugin(args, ctx) {
  const p = String((args && args.path) || '').trim()
  if (!p) return { ok: false, error: 'path 必填（插件目录）' }
  const manifestPath = path.join(p, 'plugin.json')
  if (!fs.existsSync(manifestPath)) return { ok: false, error: `插件目录无 plugin.json：${p}` }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `plugin.json 解析失败：${e.message}` }
  }
  const id = manifest.id || manifest.name
  if (!id) return { ok: false, error: 'plugin.json 缺 id/name' }

  // 先复用宿主校验，不通过则中止
  if (ctx && typeof ctx.invoke === 'function') {
    const vr = ctx.invoke('internal', 'app.validateManifest', { manifest })
    if (!vr.valid) {
      const detail = (vr.errors || []).map((e) => `${e.field} ${e.message}`).join('；')
      return { ok: false, error: `manifest 校验未通过，已中止安装：${detail}` }
    }
  }

  const root = pluginsRoot()
  if (!root) return { ok: false, error: '无法解析 userData/plugins 路径（非宿主运行时？请显式传入 targetDir）' }
  const target = path.join(root, id)

  // 原子落盘：staging 与 target 同在 userData 下，rename 是原子操作
  const stage = path.join(root, `.staging-${id}-${Date.now()}`)
  try {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    copyDir(p, stage)
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(stage, target)
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true })
    return { ok: false, error: `落盘失败：${e.message}` }
  }

  let reloaded = null
  if (ctx && typeof ctx.invoke === 'function') {
    try {
      reloaded = ctx.invoke('internal', 'app.reloadPlugins', {})
    } catch {
      /* 宿主无此命令也可接受，提示手动扫描 */
    }
  }
  return {
    ok: true,
    installed: id,
    path: target,
    reloaded: reloaded ? `${reloaded.enabled}/${reloaded.loaded} 已启用/已加载` : '未触发热加载（请在设置页或命令面板重新扫描）'
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      // 跳过开发态依赖，避免把 node_modules/.git 打进安装包
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      copyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

function load(ctx) {
  ctx.registerInternal('plugin-dev.create', (args) => createSkeleton(args))
  ctx.registerInternal('plugin-dev.validate', (args) => validatePlugin(args, ctx))
  ctx.registerInternal('plugin-dev.install', (args) => installPlugin(args, ctx))
}

module.exports = { load, createSkeleton, validatePlugin, installPlugin }

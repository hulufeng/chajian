// ============================================================
// 插件系统（对齐 TrieCode manifest 架构）
// ------------------------------------------------------------
// 一个插件 = 一个目录，目录里有 plugin.json：
//   {
//     "id": "my-plugin",
//     "name": "...",
//     "version": "0.1.0",
//     "description": "...",
//     "tools": [
//       {
//         "name": "greet",            // 实际注册名自动加 {id}_ 前缀，除非已带
//         "description": "...",
//         "parameters": { "type":"object","properties":{...}, "required":[...] },
//         "category": "query",         // query | modify | execute | delete
//         "transport": "internal",     // 第一阶段只支持 internal
//         "internal": { "service":"demo", "method":"greet" }
//       }
//     ],
//     "skills": [ { "name":"...", "description":"...", "prompt":"...", "metadata": { "keywords": ["..."] }, "references": ["..."] } ],
    // 技能遵循 Hermes SKILL.md 规范：frontmatter(name/description/metadata.keywords) + 可选 references（懒加载参考文档）
//     "projectTypes": [ ... ],
//     "views": [ ... ],
//     "dependencies": [ ... ]
//   }
//
// transport 路线图（对齐 TrieCode 7 通道）：
//   ✅ internal —— 调用宿主预注册的 service 函数（本阶段实现）
//   🔜 cli      —— spawn 外部命令，占位符 {argName}/{settings.x}/{projectPath}
//   🔜 http     —— REST fetch
//   🔜 mcp      —— MCP server stdio/websocket
//   🔜 grpc     —— 插件自带 daemon
//   🔜 stdio    —— JSON-RPC 子进程后端
//   🔜 mqtt     —— IoT 桥
// ============================================================

/**
 * 内置 service 注册表。插件 manifest 里写 internal:{service,method}，
 * 运行时在这里找到对应函数执行。宿主预注册：arduinoCli / terminal / demo 等。
 */
const INTERNAL_SERVICES = new Map();
function registerInternalService(name, methods) {
  INTERNAL_SERVICES.set(name, methods || {});
}

/**
 * 运行时工具注册表。BUILTIN 来自 app.js 硬编码；PLUGIN 来自 manifest。
 * getToolDef(name) / _buildToolDefs() 读这里。
 */
const PLUGIN_TOOL_DEFS = [];   // {name, description, parameters, category, execute}
const PLUGIN_REGISTRY = new Map(); // id -> manifest
const PLUGIN_SKILLS = [];        // {name, description, prompt, pluginId}
const PLUGIN_VIEWS = new Map();  // "pluginId:viewId" -> {pluginId,id,title,webviewUrl}

// ============================================================
// transport 分发（plugin 工具 execute 与 capabilities 路由共用）
// 对齐 TrieCode createPluginToolExecutor.dispatchTool：一个执行体，两个入口
// ============================================================
async function dispatchTool(t, id, autoName, args) {
  const a = args || {};
  const transport = t.transport || 'internal';
  try {
    if (transport === 'internal') {
      const svcName = t.internal && t.internal.service;
      const method = t.internal && t.internal.method;
      const svc = INTERNAL_SERVICES.get(svcName);
      if (!svc || typeof svc[method] !== 'function') {
        return `Error: 内部服务 ${svcName}.${method} 未注册`;
      }
      return await svc[method](a, t);
    }
    if (transport === 'cli') {
      // t.cli = { command: "arduino-cli core {core}", timeoutMs: 600000, cwd: "{projectPath}", resolve: "arduino-cli", envScript: "export.ps1" }
      const cli = t.cli || {};
      const cmdTpl = cli.command || '';
      if (!cmdTpl) return 'Error: cli.command 未配置';
      const projectPath = (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath) || '';
      const ctx = Object.assign({}, a, { projectPath });
      // 引号感知分词："a b" 是一个参数；占位符按 token 替换——
      // AI 传入的参数值永远只是单个 argv 元素，绝不拼进 shell 字符串（防注入）
      const tokenize = (s) => {
        const out = []; let cur = ''; let q = null;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (q) { if (c === q) q = null; else cur += c; }
          else if (c === '"' || c === "'") q = c;
          else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
          else cur += c;
        }
        if (cur) out.push(cur);
        return out;
      };
      // 插件自身设置（工具链检测/一键安装结果存 pluginSettings.<id>.toolchain，供 {settings.*} 占位符用）
      let pset = {};
      try {
        const cfg = (window.LabCode && window.LabCode.config && await window.LabCode.config.get()) || {};
        pset = (cfg.pluginSettings && cfg.pluginSettings[id]) || {};
      } catch (e) { /* 设置读取失败按未配置处理 */ }
      const getDeep = (obj, path) => String(path).split('.').reduce((o, k) => (o == null || o[k] == null ? undefined : o[k]), obj);
      const unresolved = [];
      // 引号感知分词后按 token 替换；占位符支持点路径（{settings.toolchain.active.pythonExe}）
      const argv = tokenize(cmdTpl).map(tok => tok.replace(/\{([\w.]+)\}/g, (m, k) => {
        if (k.indexOf('settings.') === 0) {
          const v = getDeep(pset, k.slice(9));
          if (v == null || v === '') { unresolved.push(k); return m; }
          return String(v);
        }
        return (ctx[k] != null ? String(ctx[k]) : m);
      }));
      // resolve: 用宿主已有的路径解析器替换命令首段（arduino-cli 不在 PATH，必须解析）
      const tc = window.LabCode && window.LabCode.toolchain;
      if (argv.length && tc && tc.getArduinoCliPath && (cli.resolve === 'arduino-cli' || argv[0] === 'arduino-cli')) {
        try {
          const p = await tc.getArduinoCliPath();
          if (p && p.path) argv[0] = p.path;
        } catch (e) { /* 解析失败就用原命令 */ }
      }
      if (!argv.length || !argv[0]) return 'Error: cli.command 解析后为空';
      if (unresolved.length) {
        return 'Error: 工具链未配置——占位符 {' + unresolved.join('},{') + '} 无值（pluginSettings.' + id + ' 中未找到）。请先在「设备」面板完成该工具链的检测/一键安装，或在插件设置中手动填写路径（如 IDF_PATH / pythonExe）。';
      }
      // 主进程 spawn（数组参数，无 shell）；envScript 由主进程逐参数安全引用后包装
      const bridge = window.LabCode && window.LabCode.plugin;
      if (!bridge || !bridge.cliCall) return 'Error: plugin bridge 不可用（cli，需升级主进程）';
      const r = await bridge.cliCall({
        command: argv[0],
        args: argv.slice(1),
        cwd: (cli.cwd || '').replace(/\{projectPath\}/g, projectPath) || undefined,
        timeoutMs: cli.timeoutMs || 120000,
        envScript: cli.envScript ? String(cli.envScript).replace(/\{projectPath\}/g, projectPath) : ''
      });
      if (!r || !r.success) {
        return `Error (exit ${r && r.exitCode}): ${(r && r.error) || (r && r.stderr) || 'unknown'}\n${(r && r.stdout) || ''}`;
      }
      return (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
    }
    if (transport === 'http') {
      const http = t.http || {};
      const urlTpl = http.url || '';
      const projectPath = (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath) || '';
      const ctx = Object.assign({}, a, { projectPath });
      const url = urlTpl.replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null ? encodeURIComponent(ctx[k]) : m));
      const method = (http.method || 'POST').toUpperCase();
      const opts = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, http.headers || {}) };
      if (method !== 'GET') opts.body = JSON.stringify(a);
      const resp = await fetch(url, opts);
      const text = await resp.text();
      return text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text;
    }
    if (transport === 'mcp') {
      const mcp = t.mcp || {};
      if (!window.LabCode || !window.LabCode.mcp || !window.LabCode.mcp.callTool) {
        return 'Error: MCP 桥不可用';
      }
      const r = await window.LabCode.mcp.callTool(mcp.server, mcp.tool, a);
      return typeof r === 'string' ? r : JSON.stringify(r);
    }
    if (transport === 'grpc') {
      // t.grpc = { protoPath, service, method, host, request, insecure, timeoutMs }
      // 由主进程加载 proto 并发起 unary 调用（需要 socket，渲染层做不了）
      const bridge = window.LabCode && window.LabCode.plugin;
      if (!bridge || !bridge.grpcCall) return 'Error: plugin bridge 不可用（grpc）';
      const g = t.grpc || {};
      const r = await bridge.grpcCall({
        protoPath: g.protoPath, service: g.service, method: g.method,
        host: g.host, request: Object.assign({}, g.request || {}, a),
        insecure: g.insecure !== false, timeoutMs: g.timeoutMs || 30000
      });
      if (!r || !r.success) return 'Error: grpc 调用失败: ' + ((r && r.error) || 'unknown');
      return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
    }
    if (transport === 'stdio') {
      // t.stdio = { command, args, cwd, timeoutMs }；参数以 {argName} 模板注入 args
      const bridge = window.LabCode && window.LabCode.plugin;
      if (!bridge || !bridge.stdioCall) return 'Error: plugin bridge 不可用（stdio）';
      const sd = t.stdio || {};
      const projectPath = (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath) || '';
      const ctx = Object.assign({}, a, { projectPath });
      const args = Array.isArray(sd.args) ? sd.args.map(x => String(x).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null ? String(ctx[k]) : m))) : [];
      const r = await bridge.stdioCall({
        command: sd.command, args,
        cwd: (sd.cwd || '').replace(/\{projectPath\}/g, projectPath) || undefined,
        request: a, timeoutMs: sd.timeoutMs || 30000
      });
      if (!r || !r.success) return 'Error: stdio 调用失败: ' + ((r && r.error) || 'unknown') + ((r && r.stderr) ? '\n' + r.stderr : '');
      if (r.result !== undefined) return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return r.raw || '';
    }
    if (transport === 'mqtt') {
      // t.mqtt = { brokerUrl, topic, responseTopic, payload, qos, username, password, timeoutMs }
      const bridge = window.LabCode && window.LabCode.plugin;
      if (!bridge || !bridge.mqttCall) return 'Error: plugin bridge 不可用（mqtt）';
      const mq = t.mqtt || {};
      const projectPath = (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath) || '';
      const ctx = Object.assign({}, a, { projectPath });
      const fill = (s) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null ? String(ctx[k]) : m));
      const r = await bridge.mqttCall({
        brokerUrl: fill(mq.brokerUrl), topic: fill(mq.topic),
        responseTopic: mq.responseTopic ? fill(mq.responseTopic) : '',
        payload: Object.assign({}, mq.payload || {}, a),
        qos: mq.qos || 0, username: mq.username, password: mq.password,
        timeoutMs: mq.timeoutMs || 15000
      });
      if (!r || !r.success) return 'Error: mqtt 调用失败: ' + ((r && r.error) || 'unknown');
      if (r.published) return 'OK: 已发布到 ' + fill(mq.topic);
      if (r.result !== undefined) return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return r.raw || '';
    }
    return `Error: transport "${transport}" 尚未实现（插件 ${id}）`;
  } catch (e) {
    return `Error: 工具 ${autoName} 执行失败: ${e.message}`;
  }
}

// ============================================================
// capabilities 路由（对齐 TrieCode runCapability）
// UI 按钮 / 菜单 / AI 都经 runCapability(cap) 一个入口，
// 由它按「项目绑定的主动工具链」解析到具体插件的具体 transport。
// ============================================================
/** 能力 id 词汇表（宿主 UI 契约；LabCode 在 TrieCode 集基础上扩展 monitor/plot） */
const CAPABILITY_IDS = [
  'compile', 'upload', 'flash', 'debug',
  'board-manage', 'board-select', 'library-manage', 'library-install',
  'platform-install', 'platform-list',
  'monitor', 'plot'
];
/** map 未覆盖某能力时，按约定工具名兜底找本插件的 tools[] */
const CAPABILITY_TOOL_FALLBACK = {
  compile: 'compile',
  upload: 'upload',
  'board-select': 'select_board',
  'board-manage': 'search_boards',
  'library-manage': 'search_libraries',
  'platform-install': 'install_platform',
  monitor: 'serial_log_open',
  plot: 'serial_log_open'
};

/** 是否工具链插件（声明了 capabilities 或 id 带 toolchain） */
function isToolchainPlugin(m) {
  if (!m) return false;
  if (String(m.id || '').indexOf('toolchain') >= 0) return true;
  const c = m.capabilities;
  if (!c) return false;
  return Array.isArray(c) ? c.length > 0 : Object.keys(c).length > 0;
}

/**
 * 项目 → 主动工具链插件 id（三级解析）：
 *  1. <projectPath>/.labcode.json 的 toolchain 字段（建项目时写入，权威）
 *  2. 兜底：当前启用中的工具链插件恰好只有一个 → 用它
 *  3. 都没有 → null（调用方给可操作提示，不静默失败）
 */
async function resolveActiveToolchain(projectPath) {
  const p = projectPath
    || (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath)
    || '';
  if (p) {
    try {
      const fsApi = window.LabCode && window.LabCode.fs;
      if (fsApi) {
        const rr = await fsApi.readFile(String(p).replace(/[\\\/]+$/, '') + '/.labcode.json');
        if (rr && rr.success && rr.content) {
          const meta = JSON.parse(rr.content);
          const tc = meta && meta.toolchain;
          if (tc) {
            const m = PLUGIN_REGISTRY.get(tc);
            if (m && !PLUGIN_DISABLED.has(tc)) return tc;
          }
        }
      }
    } catch (e) { /* 读不到/解析失败 → 走兜底 */ }
  }
  const active = Array.from(PLUGIN_REGISTRY.values()).filter(m => isToolchainPlugin(m) && !PLUGIN_DISABLED.has(m.id));
  if (active.length === 1) return active[0].id;
  return null;
}

/** 能力 → binding：map 显式绑定优先；数组/未覆盖 → FALLBACK 约定工具名 */
function resolveCapabilityBinding(manifest, cap) {
  if (!manifest) return null;
  const caps = manifest.capabilities;
  if (caps && !Array.isArray(caps) && typeof caps === 'object') {
    const b = caps[cap];
    if (b) return b;   // 简写 {tool:'compile'} 或显式 {transport:...}
  }
  const toolName = CAPABILITY_TOOL_FALLBACK[cap];
  if (!toolName) return null;
  const has = (manifest.tools || []).some(t => (t && t.name) === toolName);
  return has ? { tool: toolName } : null;
}

/**
 * 能力路由总入口（UI/AI 共用）。
 * @returns {Promise<{ok:boolean, text?:string, error?:string, pluginId?:string, capability?:string}>}
 */
async function runCapability(cap, params, opts) {
  params = params || {};
  opts = opts || {};
  if (CAPABILITY_IDS.indexOf(cap) < 0) {
    return { ok: false, error: `未知能力「${cap}」。可用：${CAPABILITY_IDS.join(' / ')}` };
  }
  const projectPath = (opts.projectPath != null ? opts.projectPath
    : (window.LabCodeUI && window.LabCodeUI.state && window.LabCodeUI.state.projectPath)) || '';
  const pluginId = opts.pluginId || await resolveActiveToolchain(projectPath);
  if (!pluginId) {
    return { ok: false, error: '未绑定工具链：请打开一个项目（.labcode.json 含 toolchain），或到插件市场安装 arduino-cli-toolchain / esp-idf-toolchain' };
  }
  const manifest = PLUGIN_REGISTRY.get(pluginId);
  if (!manifest) return { ok: false, error: '工具链插件不存在: ' + pluginId };
  if (PLUGIN_DISABLED.has(pluginId)) return { ok: false, error: `工具链插件「${manifest.name}」已被禁用，请先在插件面板启用` };
  const binding = resolveCapabilityBinding(manifest, cap);
  if (!binding) return { ok: false, error: `插件「${manifest.name}」未提供能力「${cap}」` };
  let text;
  if (binding.tool) {
    // 简写：复用已注册工具的 execute（参数 schema / 权限 category 全部沿用）
    const def = PLUGIN_TOOL_DEFS.find(x => x.name === `plugin_${pluginId}_${binding.tool}`);
    if (!def) return { ok: false, error: `插件「${manifest.name}」未注册工具 ${binding.tool}` };
    text = await def.execute(params);
  } else {
    // 显式 binding：合成 toolDecl 走 dispatchTool（同一执行体）
    text = await dispatchTool(Object.assign({ name: cap }, binding), pluginId, `plugin_${pluginId}_${cap}`, params);
  }
  const failed = typeof text === 'string' && (/(^|\n)\s*Error[:( ]/.test(text) || /错误[:：]/.test(text));
  return { ok: !failed, text: text, pluginId: pluginId, capability: cap };
}

/**
 * 把 plugin.json 清单加载进运行时。
 * 方案 D：外层沙箱 —— 任何单个 manifest 的异常都只影响它自己，绝不冒泡拖垮渲染进程
 * （历史上有插件加载导致渲染进程重启的记录）。内部实现逐 tool/skill 也各有 try/catch。
 * @param {object} manifest
 * @returns {loaded:{tools:number, skills:number, errors:string[]}}
 */
function loadPluginManifest(manifest) {
  try {
    return loadPluginManifestUnsafe(manifest);
  } catch (e) {
    // 回滚该插件已部分注册的工具/技能，避免半加载状态污染全局
    const id = manifest && manifest.id;
    if (id) {
      for (let i = PLUGIN_TOOL_DEFS.length - 1; i >= 0; i--) {
        if (PLUGIN_TOOL_DEFS[i]._pluginId === id) PLUGIN_TOOL_DEFS.splice(i, 1);
      }
      for (let i = PLUGIN_SKILLS.length - 1; i >= 0; i--) {
        if (PLUGIN_SKILLS[i].pluginId === id) PLUGIN_SKILLS.splice(i, 1);
      }
      PLUGIN_REGISTRY.delete(id);
    }
    try { console.error('[PluginSystem] manifest 加载被沙箱拦截:', id || '?', e && e.message); } catch (e2) {}
    return { loaded: { tools: 0, skills: 0, errors: ['沙箱拦截: ' + (e && e.message || String(e))] } };
  }
}

function loadPluginManifestUnsafe(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { loaded: { tools: 0, skills: 0, errors: ['manifest 不是对象'] } };
  }
  const id = manifest.id;
  if (!id) {
    return { loaded: { tools: 0, skills: 0, errors: ['manifest 缺 id'] } };
  }
  // 幂等：先清掉同 id 旧工具
  for (let i = PLUGIN_TOOL_DEFS.length - 1; i >= 0; i--) {
    if (PLUGIN_TOOL_DEFS[i]._pluginId === id) PLUGIN_TOOL_DEFS.splice(i, 1);
  }
  for (let i = PLUGIN_SKILLS.length - 1; i >= 0; i--) {
    if (PLUGIN_SKILLS[i].pluginId === id) PLUGIN_SKILLS.splice(i, 1);
  }

  let toolCount = 0, skillCount = 0;

  // ---- tools ----
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  for (const t of tools) {
    try {
      // 工具名自动加 plugin_<id>_ 前缀，对齐 TrieCode
      const autoName = t.name && !t.name.startsWith('plugin_' + id + '_')
        ? `plugin_${id}_${t.name}`
        : (t.name || `plugin_${id}_tool`);

      const toolDef = {
        name: autoName,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
        category: t.category || 'query',
        _pluginId: id,
        _decl: t,
        // transport 分发统一走 dispatchTool（capabilities 路由复用同一执行体，对齐 TrieCode）
        execute: (args) => dispatchTool(t, id, autoName, args)
      };
      PLUGIN_TOOL_DEFS.push(toolDef);
      toolCount++;
    } catch (e) {
      errors.push(`tool ${t && t.name}: ${e.message}`);
    }
  }

  // ---- skills ----
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
  for (const s of skills) {
    if (s && s.name && s.prompt) {
      PLUGIN_SKILLS.push({ name: s.name, description: s.description || '', prompt: s.prompt, pluginId: id, metadata: s.metadata || {} });
      skillCount++;
    }
  }

  PLUGIN_REGISTRY.set(id, {
    id,
    name: manifest.name || id,
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    category: manifest.category || 'plugin',
    tools: tools.map(t => ({ name: t.name, category: t.category })),
    skills: skills.map(s => s.name),
    projectTypes: manifest.projectTypes || [],
    views: Array.isArray(manifest.views) ? manifest.views : [],
    settings: Array.isArray(manifest.settings) ? manifest.settings : [],
    capabilities: manifest.capabilities || [],
    active: true
  });

  // 收集所有 views（去重）
  if (Array.isArray(manifest.views)) {
    for (const v of manifest.views) {
      if (v && v.id && v.webviewUrl) {
        PLUGIN_VIEWS.set(id + ':' + v.id, { pluginId: id, id: v.id, title: v.title || v.id, webviewUrl: v.webviewUrl });
      }
    }
  }

  return { loaded: { tools: toolCount, skills: skillCount, errors } };
}

/**
 * 从目录加载所有插件：扫描 pluginsRoot 下每个子目录的 plugin.json
 * @param {string} pluginsRoot
 * @param {(path:string)=>Promise<string>} readFileAsync
 */
async function loadPluginsFromDir(pluginsRoot) {
  const fsApi = (typeof window !== 'undefined' && window.LabCode && window.LabCode.fs) || null;
  const results = { loaded: [], errors: [] };
  if (!fsApi) { results.errors.push('window.LabCode.fs 不可用'); return results; }
  let files = [];
  try {
    const exists = await fsApi.exists(pluginsRoot);
    if (!exists) return results;
    const r = await fsApi.listDir(pluginsRoot);
    files = (r && r.success && Array.isArray(r.files)) ? r.files : [];
  } catch (e) { results.errors.push('读插件目录失败: ' + e.message); return results; }

  for (const entry of files) {
    if (!entry || !entry.isDirectory) continue;
    const name = entry.name;
    if (!name || name.startsWith('.')) continue;
    const sep = pluginsRoot.includes('/') ? '/' : '\\';
    const manifestPath = pluginsRoot.replace(/[\\\/]$/, '') + sep + name + sep + 'plugin.json';
    try {
      const rr = await fsApi.readFile(manifestPath);
      if (!rr || !rr.success) throw new Error(rr && rr.error ? rr.error : 'read failed');
      const manifest = JSON.parse(rr.content);
      const r2 = loadPluginManifest(manifest);
      results.loaded.push({ id: manifest.id || name, ...r2.loaded });
    } catch (e) {
      results.errors.push(`${name}: ${e.message}`);
    }
  }
  return results;
}

// 已移除 loadPluginsFromRemote（旧 GitHub-raw index.json 市场，已废弃）。
// 插件市场改走官网网关 GET /api/plugins（见 app.js fetchRemotePlugins），安装后落本地目录、由 loadPluginsFromDir 加载。

// ============================================================
// 安装 / 卸载 / 启用禁用（真落盘，重启后仍生效）
// ------------------------------------------------------------
// 插件根目录：<userData>/plugins/<id>/plugin.json
// 启用禁用状态：config.pluginStates.disabled[]（字符串数组）
// ============================================================
const PLUGIN_DISABLED = new Set();
let PLUGIN_ROOT_CACHE = '';

async function getPluginsRoot() {
  if (PLUGIN_ROOT_CACHE) return PLUGIN_ROOT_CACHE;
  try {
    if (window.LabCode && window.LabCode.app && window.LabCode.app.getPath) {
      const userData = await window.LabCode.app.getPath('userData');
      if (userData) {
        PLUGIN_ROOT_CACHE = String(userData).replace(/[\\\/]+$/, '') + '/plugins';
        return PLUGIN_ROOT_CACHE;
      }
    }
  } catch (e) { /* 忽略 */ }
  return '';
}

function joinPath(a, b) {
  const sep = String(a).includes('/') ? '/' : '\\';
  return String(a).replace(/[\\\/]+$/, '') + sep + String(b).replace(/^[\\\/]+/, '');
}

/** 从 config 读取禁用列表（启动时调用一次） */
async function loadPluginStates() {
  try {
    const cfg = await window.LabCode?.config?.get?.() || {};
    const disabled = cfg?.pluginStates?.disabled;
    PLUGIN_DISABLED.clear();
    if (Array.isArray(disabled)) disabled.forEach(id => PLUGIN_DISABLED.add(String(id)));
    return Array.from(PLUGIN_DISABLED);
  } catch (e) { return []; }
}

async function savePluginStates() {
  try {
    await window.LabCode?.config?.set?.('pluginStates', { disabled: Array.from(PLUGIN_DISABLED) });
    return true;
  } catch (e) { return false; }
}

/** 递归拷贝目录（跳过 node_modules / .git / 隐藏目录） */
async function copyDir(fsApi, src, dst) {
  const r = await fsApi.listDir(src);
  const files = (r && r.success && Array.isArray(r.files)) ? r.files : [];
  await fsApi.mkdir(dst);
  let n = 0;
  for (const f of files) {
    if (!f || !f.name || f.name.startsWith('.')) continue;
    if (f.name === 'node_modules' || f.name === '.git') continue;
    const s = joinPath(src, f.name);
    const d = joinPath(dst, f.name);
    if (f.isDirectory) {
      n += await copyDir(fsApi, s, d);
    } else {
      const cr = await fsApi.copyFile(s, d);
      if (cr && cr.success) n++;
    }
  }
  return n;
}

/**
 * 安装本地插件目录：把 srcDir 拷进插件目录并立即注册。
 * @param {string} srcDir 含 plugin.json 的目录
 * @returns {Promise<{success:boolean, id?:string, tools?:number, error?:string}>}
 */
async function installFromDir(srcDir) {
  const fsApi = (typeof window !== 'undefined' && window.LabCode && window.LabCode.fs) || null;
  if (!fsApi) return { success: false, error: 'window.LabCode.fs 不可用' };
  if (!srcDir) return { success: false, error: '缺插件目录路径' };
  try {
    const manifestPath = joinPath(srcDir, 'plugin.json');
    const exists = await fsApi.exists(manifestPath);
    if (!exists) return { success: false, error: '目录内没有 plugin.json: ' + manifestPath };
    const rr = await fsApi.readFile(manifestPath);
    if (!rr || !rr.success) return { success: false, error: '读 plugin.json 失败: ' + (rr && rr.error) };
    let manifest;
    try {
      manifest = JSON.parse(rr.content);
    } catch (e) {
      return { success: false, error: 'plugin.json 不是合法 JSON: ' + e.message };
    }
    if (!manifest || !manifest.id) return { success: false, error: 'plugin.json 缺 id' };
    const root = await getPluginsRoot();
    if (!root) return { success: false, error: '拿不到插件目录（userData）' };
    const dst = joinPath(root, String(manifest.id));
    const copied = await copyDir(fsApi, srcDir, dst);
    if (!copied) return { success: false, error: '没有拷贝到任何文件' };
    const r2 = loadPluginManifest(manifest);
    return { success: true, id: manifest.id, name: manifest.name || manifest.id, version: manifest.version || '', path: dst, tools: r2.loaded.tools, skills: r2.loaded.skills, errors: r2.loaded.errors };
  } catch (e) {
    return { success: false, error: '安装失败: ' + e.message };
  }
}

/**
 * 在目录里递归找含 plugin.json 的目录（ZIP 解压后常多包一层目录）
 * @param {string} dir 起始目录
 * @param {number} maxDepth 最大递归深度
 * @returns {Promise<string|null>}
 */
async function findManifestDir(dir, maxDepth) {
  const fsApi = (typeof window !== 'undefined' && window.LabCode && window.LabCode.fs) || null;
  if (!fsApi || !dir) return null;
  const sep = String(dir).includes('/') ? '/' : '\\';
  const walk = async (d, depth) => {
    let r;
    try { r = await fsApi.listDir(d); } catch (e) { return null; }
    const items = (r && r.success && Array.isArray(r.files)) ? r.files : [];
    if (items.some(it => it && it.name === 'plugin.json')) return d;
    if (depth >= (maxDepth || 3)) return null;
    for (const it of items) {
      if (it && it.isDirectory && !String(it.name).startsWith('.')) {
        const found = await walk(String(d).replace(/[\\\/]+$/, '') + sep + it.name, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  try { return await walk(dir, 0); } catch (e) { return null; }
}

/**
 * 直接用 manifest 对象安装（内置插件走这条：写成 plugin.json 落盘后注册）
 * @param {object} manifest
 */
async function installManifest(manifest) {
  const fsApi = (typeof window !== 'undefined' && window.LabCode && window.LabCode.fs) || null;
  if (!fsApi) return { success: false, error: 'window.LabCode.fs 不可用' };
  if (!manifest || !manifest.id) return { success: false, error: 'manifest 缺 id' };
  try {
    const root = await getPluginsRoot();
    if (!root) return { success: false, error: '拿不到插件目录（userData）' };
    const dir = joinPath(root, String(manifest.id));
    await fsApi.mkdir(dir);
    const wr = await fsApi.writeFile(joinPath(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
    if (wr && wr.success === false) return { success: false, error: '写 plugin.json 失败: ' + (wr.error || '') };
    const r2 = loadPluginManifest(manifest);
    return { success: true, id: manifest.id, name: manifest.name || manifest.id, path: dir, tools: r2.loaded.tools, skills: r2.loaded.skills };
  } catch (e) {
    return { success: false, error: '安装失败: ' + e.message };
  }
}

/** 卸载：删目录 + 从运行时注销工具/skills/views */
async function uninstall(id) {
  const fsApi = (typeof window !== 'undefined' && window.LabCode && window.LabCode.fs) || null;
  // 1) 运行时注销
  for (let i = PLUGIN_TOOL_DEFS.length - 1; i >= 0; i--) {
    if (PLUGIN_TOOL_DEFS[i]._pluginId === id) PLUGIN_TOOL_DEFS.splice(i, 1);
  }
  for (let i = PLUGIN_SKILLS.length - 1; i >= 0; i--) {
    if (PLUGIN_SKILLS[i].pluginId === id) PLUGIN_SKILLS.splice(i, 1);
  }
  for (const k of Array.from(PLUGIN_VIEWS.keys())) {
    if (k.startsWith(id + ':')) PLUGIN_VIEWS.delete(k);
  }
  PLUGIN_REGISTRY.delete(id);
  PLUGIN_DISABLED.delete(id);
  await savePluginStates();
  // 2) 删目录（deleteFile 对目录是递归删）
  if (fsApi) {
    try {
      const root = await getPluginsRoot();
      if (root) {
        const dir = joinPath(root, String(id));
        const ex = await fsApi.exists(dir);
        if (ex) await fsApi.deleteFile(dir);
      }
    } catch (e) { /* 删目录失败不影响运行时卸载 */ }
  }
  return { success: true, id };
}

/** 启用 / 禁用（禁用后工具不再注入给 AI，但插件仍在磁盘上） */
async function setActive(id, active) {
  if (!id) return { success: false, error: '缺 id' };
  if (active) PLUGIN_DISABLED.delete(id); else PLUGIN_DISABLED.add(id);
  await savePluginStates();
  return { success: true, id, active: !!active };
}

function isActive(id) {
  return !PLUGIN_DISABLED.has(id);
}

// 暴露到 window 供 app.js 调用
window.PluginSystem = {
  registerInternalService,
  // 方案 D 收尾：让 UI（如「生成工程统计报告」命令）能取到已注册的内部服务实例
  getInternalService: (name) => INTERNAL_SERVICES.get(name),
  loadPluginManifest,
  loadPluginsFromDir,
  // ---- 安装 / 卸载 / 启用禁用 ----
  getPluginsRoot,
  findManifestDir,
  getViews: () => Array.from(PLUGIN_VIEWS.values()),
  installFromDir,
  installManifest,
  uninstall,
  setActive,
  isActive,
  loadPluginStates,
  // 禁用的插件：工具/技能不再注入给 AI（listPlugins 里仍可见，active=false）
  getToolDef: (name) => {
    const t = PLUGIN_TOOL_DEFS.find(x => x.name === name);
    if (!t) return undefined;
    return PLUGIN_DISABLED.has(t._pluginId) ? undefined : t;
  },
  allTools: () => PLUGIN_TOOL_DEFS.filter(t => !PLUGIN_DISABLED.has(t._pluginId)),
  // 按项目类型过滤后的工具(AI 工具清单用;UI 按钮/getToolDef 不过滤——用户主动点击不受项目类型限制)
  // 工具级 projectTypes 优先,其次插件级;空=全项目可用;projectType 为空(未开项目)=不过滤
  allToolsForProject: (projectType) => PLUGIN_TOOL_DEFS.filter(t => {
    if (PLUGIN_DISABLED.has(t._pluginId)) return false;
    const m = PLUGIN_REGISTRY.get(t._pluginId);
    const pts = (t._decl && Array.isArray(t._decl.projectTypes) && t._decl.projectTypes)
      || (m && Array.isArray(m.projectTypes) && m.projectTypes) || [];
    return !pts.length || !projectType || pts.indexOf(projectType) >= 0;
  }),
  allSkills: () => PLUGIN_SKILLS.filter(s => !PLUGIN_DISABLED.has(s.pluginId)),
  listPlugins: () => Array.from(PLUGIN_REGISTRY.values()).map(p => Object.assign({}, p, { active: !PLUGIN_DISABLED.has(p.id) })),
  listViews: () => Array.from(PLUGIN_VIEWS.values()),
  getView: (key) => PLUGIN_VIEWS.get(key),
  // ---- capabilities 路由（UI 按钮/AI 共用；对齐 TrieCode runCapability）----
  CAPABILITY_IDS,
  CAPABILITY_TOOL_FALLBACK,
  resolveActiveToolchain,
  runCapability,
  // 某插件提供了哪些能力（UI 状态栏/设置页展示用）
  listCapabilities: (pluginId) => {
    const m = PLUGIN_REGISTRY.get(pluginId);
    if (!m) return [];
    const caps = m.capabilities;
    const declared = Array.isArray(caps) ? caps.slice() : (caps && typeof caps === 'object' ? Object.keys(caps) : []);
    const extra = Object.keys(CAPABILITY_TOOL_FALLBACK).filter(c => declared.indexOf(c) < 0 && resolveCapabilityBinding(m, c));
    return declared.concat(extra);
  },
  // 2026-09-15 对齐 TrieCode settings：插件声明 settings 项 → UI 自动渲染
  getSettings: (pluginId) => {
    const p = PLUGIN_REGISTRY.get(pluginId);
    return p?.settings || [];
  },
  getSetting: async (pluginId, key) => {
    try {
      const cfg = await window.LabCode?.config?.get?.() || {};
      return cfg?.pluginSettings?.[pluginId]?.[key];
    } catch (e) { return undefined; }
  },
  setSetting: async (pluginId, key, value) => {
    try {
      await window.LabCode?.config?.set?.('pluginSettings.' + pluginId + '.' + key, value);
      return true;
    } catch (e) { return false; }
  }
};

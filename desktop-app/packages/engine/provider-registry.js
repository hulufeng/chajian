// ============ LabCode AI provider 注册表（单一数据源，参考 TrieCode provider-registry）============
// 合并三层：本地内置(builtin) + 用户自定义(config.ai.customProviders) + 未来云端(setCloud，云端优先覆盖同名)
// main 用 toAiProviders() 派生旧版 AI_PROVIDERS 形状，渲染端用 getProviders() 拿完整元数据做统一注册 UI。
// 本文件从 main/ 迁入 packages/engine，作为零 Electron 依赖的纯模块，可 headless/CLI 复用（对齐 TrieCode engine 包）。

const BUILTIN = [
  { id: 'gateway', name: 'LabCode 云端', type: 'gateway', baseURL: 'https://bluebubai.work', defaultModel: 'qwen3-8b', builtin: true, enabled: true, needsApiKey: false, description: '登录后使用的云端模型（积分扣费）' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', builtin: true, enabled: true, needsApiKey: true, description: 'DeepSeek 官方 API' },
  { id: 'siliconflow', name: '硅基流动', type: 'openai', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-7B-Instruct', builtin: true, enabled: true, needsApiKey: true, description: '硅基流动（SiliconFlow）兼容端点' },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', builtin: true, enabled: true, needsApiKey: true, description: 'OpenAI 官方 API' },
  { id: 'ollama', name: 'Ollama', type: 'ollama', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3', builtin: true, enabled: true, needsApiKey: false, description: '本机 Ollama' },
  { id: 'local', name: '本地模型 (llama.cpp)', type: 'local', baseURL: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', builtin: true, enabled: true, needsApiKey: false, description: '本机 llama.cpp 引擎' },
  { id: 'custom', name: '自定义 OpenAI 兼容', type: 'openai', baseURL: '', defaultModel: '', builtin: true, enabled: true, needsApiKey: false, custom: true, description: '任意 OpenAI 兼容端点' }
];

class ProviderRegistry {
  constructor() { this._cloud = null; this._custom = []; this._overrides = {}; }

  // 注入用户自定义 provider 列表（config.ai.customProviders）
  setCustom(list) { this._custom = Array.isArray(list) ? list.map((p) => Object.assign({}, p)) : []; }
  // 未来：云端拉取的 provider 定义（云端同名覆盖内置的 baseURL/defaultModel/description）
  setCloud(list) { this._cloud = Array.isArray(list) ? list : null; }
  // 覆盖单个 provider 的字段（当前用于 enabled 状态）
  setOverride(id, patch) { this._overrides[id] = Object.assign({}, this._overrides[id], patch); }

  getProviders() {
    const map = new Map();
    for (const p of BUILTIN) map.set(p.id, Object.assign({}, p));
    if (this._cloud) {
      for (const c of this._cloud) {
        if (map.has(c.id)) map.set(c.id, Object.assign({}, map.get(c.id), c, { builtin: true }));
        else map.set(c.id, Object.assign({ id: c.id, name: c.id, type: 'openai', enabled: true, builtin: false }, c));
      }
    }
    for (const u of this._custom) {
      if (map.has(u.id)) map.set(u.id, Object.assign({}, map.get(u.id), u));
      else map.set(u.id, Object.assign({ id: u.id, name: u.id, type: 'openai', enabled: true, builtin: false }, u));
    }
    for (const id of Object.keys(this._overrides)) {
      if (map.has(id)) map.set(id, Object.assign({}, map.get(id), this._overrides[id]));
    }
    return Array.from(map.values());
  }

  getProvider(id) { return this.getProviders().find((p) => p.id === id) || null; }

  // 派生旧版 AI_PROVIDERS 形状（仅 enabled），供 main 聊天路径零改动复用
  toAiProviders() {
    const m = {};
    for (const p of this.getProviders()) {
      if (p.enabled !== false) m[p.id] = { baseURL: p.baseURL || '', defaultModel: p.defaultModel || '', type: p.type };
    }
    return m;
  }

  addCustom(p) { this._custom.push(p); return this._custom; }
  removeCustom(id) { this._custom = this._custom.filter((p) => p.id !== id); return this._custom; }
}

const registry = new ProviderRegistry();
registry.BUILTIN = BUILTIN;
module.exports = registry;
module.exports.ProviderRegistry = ProviderRegistry;
module.exports.BUILTIN = BUILTIN;

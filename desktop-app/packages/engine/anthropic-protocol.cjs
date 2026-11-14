'use strict';
/**
 * anthropic-protocol.cjs — Anthropic (/v1/messages) 协议适配纯函数层
 *
 * 存在的理由：BubaiCode 主进程长期只有 OpenAI 兼容端点，导致
 *  ① 无法使用 Anthropic 模型；
 *  ② 参考基线 的 `cache_control:{type:'ephemeral'}` 前缀缓存断点无处可发
 *     （OpenAI 兼容端靠「前缀不变」隐式命中，不接受该字段）。
 * 本模块把 OpenAI 形状的请求/响应/事件翻译成 Anthropic 形状，纯函数、可单测。
 *
 * 全部纯函数、零副作用、CommonJS，Node 18+ 可直接 require。
 * 契约见 docs/技术文档-BubaiCode-Agent架构.md §11。
 */

/** Anthropic 要求 max_tokens 必填；给一个保守默认。 */
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * OpenAI 工具定义 → Anthropic 工具定义。
 * OpenAI: { type:'function', function:{ name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const fn = (t && t.function) ? t.function : t;
    if (!fn || !fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
    });
  }
  return out;
}

/**
 * OpenAI 消息数组 → Anthropic 的 { system: [...blocks], messages: [...] }。
 * 规则：
 *  - role==='system' 的消息上提到顶层 system（多个 system 按顺序拼接成多 block，
 *    这样第 1 块是静态前缀、后续块是动态段，正好对应 参考基线 的双 system 拆分）；
 *  - role==='tool' 转为 { role:'user', content:[{ type:'tool_result', tool_use_id, content }] }；
 *  - assistant 的 tool_calls 转为 { role:'assistant', content:[{ type:'tool_use', id, name, input }] }；
 *  - 其余 user/assistant 文本原样保留。
 */
function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const pushUser = (content) => {
    // Anthropic 要求 user/assistant 交替；连续 user 合并，避免 400
    const last = out[out.length - 1];
    if (last && last.role === 'user') { last.content.push(content); return; }
    out.push({ role: 'user', content: [content] });
  };

  for (const m of (messages || [])) {
    if (!m) continue;
    if (m.role === 'system') {
      system.push({ type: 'text', text: String(m.content == null ? '' : m.content) });
      continue;
    }
    if (m.role === 'tool') {
      const res = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.toolUseId || m.id || '',
        content: String(m.content == null ? '' : m.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user') last.content.push(res);
      else out.push({ role: 'user', content: [res] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      const text = String(m.content == null ? '' : m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); }
        catch (_) { input = { _raw: (tc.function && tc.function.arguments) || '' }; }
        blocks.push({
          type: 'tool_use',
          id: tc.id || ('call_' + Math.random().toString(36).slice(2, 11)),
          name: (tc.function && tc.function.name) || tc.name || '',
          input,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: [{ type: 'text', text: String(m.content == null ? '' : m.content) }] });
      continue;
    }
    // user / 其它
    pushUser({ type: 'text', text: String(m.content == null ? '' : m.content) });
  }
  return { system, messages: out };
}

/**
 * 组装 Anthropic 请求体。
 * @param {object} o
 * @param {Array} o.messages  OpenAI 形状消息
 * @param {Array} [o.tools]   OpenAI 形状工具
 * @param {string} o.model
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {boolean} [o.cacheControl] 是否打前缀缓存断点（默认 true）
 */
function toAnthropicBody(o) {
  const opt = o || {};
  const { system, messages } = toAnthropicMessages(opt.messages);
  const tools = toAnthropicTools(opt.tools);

  // 前缀缓存断点：system 第 1 块（静态前缀）+ 最后一个 tool（对齐参考基线 claude-provider.js:144-191）
  const sysBlocks = system.map((b, i) => {
    const copy = { type: 'text', text: b.text };
    if (opt.cacheControl !== false && i === 0) copy.cache_control = { type: 'ephemeral' };
    return copy;
  });
  const toolBlocks = tools.map((t, i, arr) => {
    const copy = Object.assign({}, t);
    if (opt.cacheControl !== false && i === arr.length - 1) copy.cache_control = { type: 'ephemeral' };
    return copy;
  });

  const body = {
    model: opt.model || '',
    max_tokens: Number(opt.maxTokens) > 0 ? Number(opt.maxTokens) : DEFAULT_MAX_TOKENS,
    messages,
  };
  if (sysBlocks.length) body.system = sysBlocks;
  if (toolBlocks.length) body.tools = toolBlocks;
  if (typeof opt.temperature === 'number') body.temperature = opt.temperature;
  if (opt.thinking && typeof opt.thinking === 'object' && Object.keys(opt.thinking).length) {
    body.thinking = opt.thinking;
  }
  return body;
}

/** Anthropic 请求头：x-api-key + anthropic-version（无 Bearer）。 */
function toAnthropicHeaders(apiKey, extra) {
  const h = Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION }, extra || {});
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

/** baseURL 拼接：Anthropic 端点固定 /v1/messages；baseURL 不应含 /v1。 */
function buildAnthropicUrl(baseURL) {
  let b = String(baseURL || '').replace(/\/+$/, '');
  b = b.replace(/\/v1$/i, '');
  return b + '/v1/messages';
}

/**
 * 解析 Anthropic 非流式响应 → OpenAI 形状 { content, toolCalls, usage, stopReason }。
 */
function parseAnthropicResponse(json) {
  const j = json || {};
  const parts = Array.isArray(j.content) ? j.content : [];
  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'text') text += String(p.text || '');
    else if (p.type === 'tool_use') {
      toolCalls.push({
        id: p.id || ('call_' + Math.random().toString(36).slice(2, 11)),
        name: p.name || '',
        arguments: JSON.stringify(p.input || {}),
      });
    }
  }
  const u = j.usage || {};
  const usage = {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
  };
  // 缓存可观测性（Anthropic 独有）
  if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
  return { content: text, toolCalls, usage, stopReason: j.stop_reason || null };
}

/**
 * 解析一个 Anthropic SSE 事件（已由 parseSSEStream 抽出 obj + obj._event）→ 归一化事件。
 * 返回 null 表示忽略该事件。
 * @returns {{type:'text'|'tool_start'|'tool_delta'|'usage'|'done'|'error', ...}}
 */
function parseAnthropicEvent(evt) {
  if (!evt) return null;
  const ev = evt._event || '';
  const d = evt;

  if (ev === 'message_start') {
    const u = (d.message && d.message.usage) || {};
    return {
      type: 'usage',
      usage: {
        prompt_tokens: u.input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        ...(typeof u.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
        ...(typeof u.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
      },
    };
  }

  if (ev === 'content_block_start') {
    const cb = d.content_block || {};
    if (cb.type === 'tool_use') {
      return { type: 'tool_start', index: d.index || 0, id: cb.id || '', name: cb.name || '' };
    }
    return null;
  }

  if (ev === 'content_block_delta') {
    const dl = d.delta || {};
    if (dl.type === 'text_delta') return { type: 'text', delta: String(dl.text || '') };
    if (dl.type === 'input_json_delta') return { type: 'tool_delta', index: d.index || 0, delta: String(dl.partial_json || '') };
    if (dl.type === 'thinking_delta') return { type: 'thinking', delta: String(dl.thinking || '') };
    return null;
  }

  if (ev === 'message_delta') {
    const u = d.usage || {};
    const out = { type: 'usage', usage: {} };
    if (u.output_tokens != null) {
      out.usage.completion_tokens = u.output_tokens;
      out.usage.total_tokens = u.output_tokens;
    }
    if (d.delta && d.delta.stop_reason) out.stopReason = d.delta.stop_reason;
    return out;
  }

  if (ev === 'message_stop') return { type: 'done' };

  if (ev === 'error') {
    const e = d.error || {};
    return { type: 'error', error: e.message || String(d.message || 'Anthropic 流式错误') };
  }

  // 网关透传事件（credits / error）保持原样
  if (ev === 'credits' || ev === 'error-gateway') return { type: 'raw', event: d };

  return null;
}

module.exports = {
  DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  toAnthropicTools,
  toAnthropicMessages,
  toAnthropicBody,
  toAnthropicHeaders,
  buildAnthropicUrl,
  parseAnthropicResponse,
  parseAnthropicEvent,
};

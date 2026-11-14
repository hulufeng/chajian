'use strict';
/**
 * P3 验收：Anthropic 原生协议（/v1/messages）+ cache_control 断点真正可发送。
 * 运行：node scripts/verify-anthropic-protocol.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AP = require(path.join(ROOT, 'packages/engine/anthropic-protocol.cjs'));
const REG = require(path.join(ROOT, 'packages/engine/provider-registry.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const ALIGN = require(path.join(ROOT, 'packages/engine/chipcode-align.cjs'));

test('toAnthropicTools：parameters → input_schema', () => {
  const out = AP.toAnthropicTools([
    { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { p: { type: 'string' } } } } },
    { name: 'bare', description: '裸形状' },
    { type: 'function' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'read_file');
  assert.deepEqual(out[0].input_schema, { type: 'object', properties: { p: { type: 'string' } } });
  assert.equal(out[0].input_schema, out[0].input_schema);
  assert.ok(!('parameters' in out[0]));
  assert.equal(out[1].input_schema.type, 'object');
});

test('toAnthropicMessages：system 上提、tool→tool_result、assistant tool_calls→tool_use', () => {
  const r = AP.toAnthropicMessages([
    { role: 'system', content: '静态前缀' },
    { role: 'system', content: '动态段' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '调工具', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
    { role: 'assistant', content: '完成' },
  ]);
  assert.equal(r.system.length, 2);
  assert.equal(r.system[0].text, '静态前缀');
  assert.equal(r.system[1].text, '动态段');
  // system 不出现在 messages 里
  assert.ok(!r.messages.some(m => m.role === 'system'));
  // assistant tool_calls → content 里是 tool_use
  const asst = r.messages.find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'));
  assert.ok(asst, '应存在 tool_use 块');
  const tu = asst.content.find(b => b.type === 'tool_use');
  assert.equal(tu.name, 'read_file');
  assert.deepEqual(tu.input, { file_path: 'a.txt' });
  // tool → user + tool_result
  const tr = r.messages.find(m => m.role === 'user' && m.content.some(b => b.type === 'tool_result'));
  assert.ok(tr, '应存在 tool_result 块');
  assert.equal(tr.content.find(b => b.type === 'tool_result').tool_use_id, 'call_1');
});

test('toAnthropicBody：max_tokens 必填、system/tools 带 cache_control 断点', () => {
  const body = AP.toAnthropicBody({
    messages: [
      { role: 'system', content: '静态前缀' },
      { role: 'system', content: '动态段' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ type: 'function', function: { name: 'a', parameters: {} } }, { type: 'function', function: { name: 'b', parameters: {} } }],
    model: 'claude-sonnet-4-5',
    maxTokens: 4096,
    temperature: 0.3,
  });
  assert.equal(body.model, 'claude-sonnet-4-5');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, 0.3);
  // system 第 1 块打断点，第 2 块不打（动态段不进缓存）
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.equal(body.system[1].cache_control, undefined);
  // 最后一个 tool 打断点
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(body.tools[1].cache_control.type, 'ephemeral');
  // 无 max_tokens 时用默认
  const d = AP.toAnthropicBody({ messages: [{ role: 'user', content: 'x' }], model: 'm' });
  assert.equal(d.max_tokens, AP.DEFAULT_MAX_TOKENS);
  // cacheControl:false 时不打
  const nb = AP.toAnthropicBody({ messages: [{ role: 'system', content: 's' }], model: 'm', cacheControl: false });
  assert.equal(nb.system[0].cache_control, undefined);
});

test('toAnthropicHeaders / buildAnthropicUrl', () => {
  const h = AP.toAnthropicHeaders('sk-ant-xxx');
  assert.equal(h['x-api-key'], 'sk-ant-xxx');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['Authorization'], undefined, 'Anthropic 不用 Bearer');
  assert.equal(AP.buildAnthropicUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(AP.buildAnthropicUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(AP.buildAnthropicUrl('https://x.cn/v1'), 'https://x.cn/v1/messages', 'baseURL 尾 /v1 应去重');
});

test('parseAnthropicResponse：text + tool_use + usage（含缓存可观测）', () => {
  const r = AP.parseAnthropicResponse({
    content: [
      { type: 'text', text: '回答' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { file_path: 'a.txt' } },
    ],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
    stop_reason: 'tool_use',
  });
  assert.equal(r.content, '回答');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'read_file');
  assert.equal(r.toolCalls[0].arguments, '{"file_path":"a.txt"}');
  assert.equal(r.usage.prompt_tokens, 100);
  assert.equal(r.usage.total_tokens, 120);
  assert.equal(r.usage.cache_read_input_tokens, 80, '缓存命中应可观测');
  assert.equal(r.stopReason, 'tool_use');
});

test('parseAnthropicEvent：message_start/content_block_*/message_delta/message_stop', () => {
  const s = AP.parseAnthropicEvent({
    _event: 'message_start',
    message: { usage: { input_tokens: 50, cache_read_input_tokens: 40 } },
  });
  assert.equal(s.type, 'usage');
  assert.equal(s.usage.prompt_tokens, 50);
  assert.equal(s.usage.cache_read_input_tokens, 40);

  const ts = AP.parseAnthropicEvent({ _event: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'run_test' } });
  assert.equal(ts.type, 'tool_start');
  assert.equal(ts.name, 'run_test');

  const td = AP.parseAnthropicEvent({ _event: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
  assert.equal(td.type, 'text');
  assert.equal(td.delta, '你好');

  const jd = AP.parseAnthropicEvent({ _event: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } });
  assert.equal(jd.type, 'tool_delta');
  assert.equal(jd.delta, '{"a":');

  const th = AP.parseAnthropicEvent({ _event: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } });
  assert.equal(th.type, 'thinking');

  const md = AP.parseAnthropicEvent({ _event: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
  assert.equal(md.type, 'usage');
  assert.equal(md.usage.completion_tokens, 7);
  assert.equal(md.stopReason, 'end_turn');

  assert.equal(AP.parseAnthropicEvent({ _event: 'message_stop' }).type, 'done');
  assert.equal(AP.parseAnthropicEvent({ _event: 'error', error: { message: 'boom' } }).error, 'boom');
  assert.equal(AP.parseAnthropicEvent({ _event: 'ping' }), null);
});

test('provider 注册表：claude 已注册且 type 可用', () => {
  const claude = REG.getProviders ? REG.getProviders().find(p => p.id === 'claude') : REG.BUILTIN.find(p => p.id === 'claude');
  assert.ok(claude, 'claude provider 应已注册');
  assert.equal(claude.type, 'claude');
  assert.equal(claude.baseURL, 'https://api.anthropic.com');
  assert.ok(!/\/v1$/.test(claude.baseURL), 'baseURL 不应含 /v1（拼接时补）');
  // toAiProviders 必须带出 type（主进程唯一判定依据）
  const m = REG.toAiProviders();
  assert.ok(m.claude, 'toAiProviders 应产出 claude');
  assert.equal(m.claude.type, 'claude');
});

test('主进程两处分支 + SSE 消费分支均已接线', () => {
  // 非流式分支
  assert.ok(MAIN.includes("provider.type === 'claude'"), 'ai:chat 缺 claude 分支');
  assert.ok(MAIN.includes("require('../packages/engine/anthropic-protocol.cjs')"), '未引用协议模块');
  // 流式分支
  assert.ok(MAIN.includes('const isClaude ='), 'streamChatCompletion 缺 isClaude 判定');
  assert.ok(MAIN.includes('AP.buildAnthropicUrl(baseURL)'), '流式 URL 未走 Anthropic');
  assert.ok(MAIN.includes('AP.toAnthropicHeaders(apiKey)'), '流式 headers 未走 x-api-key');
  assert.ok(MAIN.includes('AP.toAnthropicBody('), '流式 body 未走协议转换');
  // SSE 消费分支必须在 choices 解析之前
  const claudeIdx = MAIN.indexOf('AP.parseAnthropicEvent(evt)');
  const choiceIdx = MAIN.indexOf('const choice = evt.choices && evt.choices[0];');
  assert.ok(claudeIdx > 0 && choiceIdx > 0, '两处都要存在');
  assert.ok(claudeIdx < choiceIdx, 'Anthropic 事件分支必须排在 OpenAI choices 分支之前');
});

test('渲染层可选择 claude 类型', () => {
  assert.ok(APP.includes('<option value="claude">claude</option>'), '自定义 provider 类型下拉缺 claude');
});

test('与既有对齐模块断点逻辑一致（同一语义：首 system + 末 tool）', () => {
  const msgs = [{ role: 'system', content: '静态' }, { role: 'system', content: '动态' }];
  const tools = [{ name: 'a' }, { name: 'b' }];
  const a = ALIGN.markCacheBreakpoints(msgs, tools);
  const b = AP.toAnthropicBody({ messages: msgs, tools, model: 'm' });
  assert.equal(a.system[0].cache_control.type, b.system[0].cache_control.type);
  assert.equal(a.system[1].cache_control, b.system[1].cache_control);
  assert.equal(a.tools[a.tools.length - 1].cache_control.type, b.tools[b.tools.length - 1].cache_control.type);
});

test('OpenAI 路径不受影响：非 claude provider 行为逐字不变', () => {
  // claude 分支必须是有条件的，OpenAI 分支代码仍在
  assert.ok(MAIN.includes("const url = baseURL.replace(/\\/$/, '') + '/chat/completions';"), 'OpenAI URL 分支丢失');
  assert.ok(MAIN.includes("headers['Authorization'] = 'Bearer ' + apiKey"), 'OpenAI Bearer 分支丢失');
  // registry 里除 claude 外全部 type 不变
  const others = REG.BUILTIN.filter(p => p.id !== 'claude');
  for (const p of others) {
    if (p.id === 'custom') continue;
    assert.ok(['gateway', 'openai', 'ollama', 'local'].includes(p.type), `provider ${p.id} type 被改动`);
  }
});

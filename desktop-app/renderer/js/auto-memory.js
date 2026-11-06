// Phase B+ · 会话结束自动提炼长期记忆（对齐 ChipCode auto-memory.js / ai:extractMemory）
// 约束：只在 LLM 成功返回且结果通过白名单校验时写入；网络失败静默跳过，绝不写推测内容。
// fire-and-forget，不阻塞 UI；同一会话内容用指纹去重，避免重复提炼。
(function () {
  var MAX_MEMORIES_PER_SESSION = 5;
  var TYPES = ['user', 'feedback', 'project', 'reference'];
  var lastFingerprint = '';
  var running = false;

  function messages() {
    var st = window.LabCodeUI && window.LabCodeUI.state;
    var log = window._chatLog || (st && st.agent && st.agent.messages) || [];
    return (Array.isArray(log) ? log : []).map(function (m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 2000) };
    }).filter(function (m) { return m.content; });
  }

  function fingerprint(list) {
    var s = list.map(function (m) { return m.role + ':' + m.content; }).join('\n');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16) + ':' + list.length;
  }

  function parseReply(text) {
    var t = String(text || '').trim();
    // 容忍 ```json 围栏与前后解释文字
    var a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    var arr;
    try { arr = JSON.parse(t.slice(a, b + 1)); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, MAX_MEMORIES_PER_SESSION).map(function (x) {
      if (!x || typeof x !== 'object') return null;
      var name = String(x.name || '').trim().slice(0, 60);
      var content = String(x.content || '').trim().slice(0, 600);
      var type = TYPES.indexOf(x.type) >= 0 ? x.type : 'project';
      if (!name || !content) return null;
      return { name: name, content: content, type: type };
    }).filter(Boolean);
  }

  async function upsert(entries) {
    var def = typeof getToolDef === 'function' && getToolDef('remember');
    if (!def || typeof def.execute !== 'function') return 0;
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      try { await def.execute(entries[i]); n++; } catch (e) {}
    }
    return n;
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }

  async function extract(list) {
    if (!window.LabCode || !window.LabCode.ai || !window.LabCode.ai.once) return 0;
    var prompt = [
      { role: 'system', content: '你是长期记忆提炼器。只输出 JSON 数组，不要解释、不要代码围栏。' +
        '每条格式 {"name":"简短标识","content":"可复用的事实或偏好","type":"user|feedback|project|reference"}。' +
        '只提炼对未来会话真正有用的稳定信息（用户偏好、项目事实、明确反馈），最多 5 条；' +
        '没有值得记住的内容就输出 []。不要复述临时对话、不要猜测、不要编造。' },
      { role: 'user', content: '对话内容：\n' + list.slice(-12).map(function (m) { return m.role + ': ' + m.content.slice(0, 800); }).join('\n') }
    ];
    var r;
    try { r = await withTimeout(window.LabCode.ai.once({ messages: prompt, maxTokens: 800 }), 20000); }
    catch (e) { return 0; }
    if (!r || !r.success || !r.content) return 0; // 失败不写记忆
    var entries = parseReply(r.content);
    if (!entries.length) return 0;
    return upsert(entries);
  }

  function queueExtract() {
    var list = messages();
    if (list.length < 2) return;              // 太短的会话不提炼
    var fp = fingerprint(list);
    if (fp === lastFingerprint || running) return;
    lastFingerprint = fp;
    running = true;
    // 让出主线程，避免与切换/重置逻辑争用
    setTimeout(function () {
      extract(list).then(function () { running = false; }).catch(function () { running = false; });
    }, 300);
  }

  window.AutoMemory = { queueExtract: queueExtract, parseReply: parseReply, fingerprint: fingerprint };
})();

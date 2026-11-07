// Phase B：完整会话 store（对齐 ChipCode session-store.js）
// 设计要点：
//  1) 单一数据源：把此前互不相通的两套持久化（localStorage['bubaicode.chatSessions'] UI 列表
//     与 main/userData/sessions/<id>.json 富会话）合并为一份内存镜像，磁盘为权威。
//  2) 同步内存镜像 + 异步防抖落盘：现有 6 处同步 UI 代码无需改成 async。
//  3) 单一写者：AgentRunner._persistSession 与 UI 保存都经本模块，消除双写 id/字段分裂。
//  4) 消息带稳定 id/ts，display 展示字段原样保留（对齐 ChipCode session_message.display）。
//  5) load / save / revise / search 四级能力，revise 的 ops 语义与 main/index.js 完全一致。
(function () {
  var LEGACY_KEY = 'bubaicode.chatSessions';
  var api = (window.BubaiCode && window.BubaiCode.sessions) || null;
  var cache = [];
  var currentId = null;
  var listeners = [];
  var pending = {};
  var flushTimer = null;
  var ready = false;
  var uid = 0;

  function nowId() { return 'session_' + Date.now().toString(36) + '_' + (++uid).toString(36); }
  function tsOf(s) { return s.updatedAt || s.ts || s.timestamp || Date.now(); }

  function normalizeMessage(m, i) {
    var base = (m && typeof m === 'object') ? m : { role: 'user', content: String(m || '') };
    var role = (base.role === 'assistant' || base.role === 'ai') ? 'assistant'
      : (base.role === 'user' ? 'user' : (base.role || 'user'));
    var out = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    out.role = role;
    out.content = base.content == null ? '' : String(base.content);
    out.id = base.id || ('m' + i + '_' + (base.ts || Date.now()).toString(36));
    out.ts = base.ts || Date.now();
    return out;
  }

  function normalizeSession(s) {
    if (!s || !s.id) return null;
    var msgs = (Array.isArray(s.messages) ? s.messages : []).map(normalizeMessage);
    return {
      id: String(s.id),
      title: s.title || '未命名对话',
      titleLocked: !!s.titleLocked,
      ts: s.ts || s.timestamp || s.updatedAt || Date.now(),
      updatedAt: s.updatedAt || s.ts || s.timestamp || Date.now(),
      messages: msgs,
      mode: s.mode || null,
      modelId: s.modelId || null,
      projectPath: s.projectPath || null,
      projectType: s.projectType || null,
      plan: s.plan || null,
      thinking: s.thinking || null,
      workLog: Array.isArray(s.workLog) ? s.workLog : [],
      usage: s.usage || null,
      // Phase B+：turn 批次快照与 todo 清单随会话持久化（跨重启/切换恢复）
      turns: s.turns || null,
      todoList: Array.isArray(s.todoList) ? s.todoList : []
    };
  }

  function sortCache() { cache.sort(function (a, b) { return tsOf(b) - tsOf(a); }); }

  function upsert(s) {
    var n = normalizeSession(s);
    if (!n) return null;
    var idx = -1;
    for (var i = 0; i < cache.length; i++) if (cache[i].id === n.id) { idx = i; break; }
    if (idx >= 0) cache[idx] = n; else cache.push(n);
    sortCache();
    return n;
  }

  function persist(s) {
    if (!api || !api.save) return;
    pending[s.id] = s;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 250);
  }

  function flush() {
    flushTimer = null;
    var batch = pending;
    pending = {};
    Object.keys(batch).forEach(function (id) {
      var payload = {};
      for (var k in batch[id]) if (Object.prototype.hasOwnProperty.call(batch[id], k)) payload[k] = batch[id][k];
      Promise.resolve(api.save(payload)).catch(function (e) { console.warn('[SessionStore] save failed', e); });
    });
  }

  function emit(evt) {
    listeners.forEach(function (fn) { try { fn(evt || 'change'); } catch (e) {} });
  }

  // ---- ops 在内存镜像上的应用（与主进程 reviseSession 同语义）----
  function applyOps(s, ops) {
    var msgs = s.messages.slice();
    (ops || []).forEach(function (op) {
      if (!op || !op.type) return;
      if (op.type === 'replace_all') {
        msgs = (op.messages || []).map(normalizeMessage);
        if (op.meta) for (var k in op.meta) s[k] = op.meta[k];
      } else if (op.type === 'delete_range') {
        var from = Math.max(0, Number(op.fromSeq) || 0);
        var to = op.toSeq == null ? msgs.length - 1 : Math.min(msgs.length - 1, Number(op.toSeq));
        if (from <= to && from < msgs.length) msgs.splice(from, to - from + 1);
      } else if (op.type === 'insert') {
        var at = Math.min(msgs.length, Math.max(-1, Number(op.atSeq) || 0));
        var add = (op.messages || []).map(normalizeMessage);
        msgs.splice.apply(msgs, [at + 1, 0].concat(add));
      } else if (op.type === 'update') {
        var seq = Number(op.seq);
        if (seq >= 0 && seq < msgs.length) msgs[seq] = normalizeMessage(Object.assign({}, msgs[seq], op.message || {}), seq);
      } else if (op.type === 'rename') {
        s.title = String(op.title || '').slice(0, 120);
        s.titleLocked = true;
      } else if (op.type === 'meta') {
        var src = op.meta || op; // 与主进程一致：兼容 {type:'meta', plan:...}
        for (var m in src) if (m !== 'type') s[m] = src[m];
      }
    });
    s.messages = msgs;
    s.updatedAt = Date.now();
  }

  // ---- 启动：hydrate（磁盘权威 + localStorage legacy 一次性迁移）----
  async function init() {
    var disk = [];
    if (api && api.list) {
      try { disk = await api.list() || []; } catch (e) { console.warn('[SessionStore] list failed', e); }
    }
    var byId = {};
    (Array.isArray(disk) ? disk : []).forEach(function (s) {
      var n = normalizeSession(s);
      if (n) byId[n.id] = n;
    });
    var migrations = [];
    try {
      var legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
      (Array.isArray(legacy) ? legacy : []).forEach(function (s) {
        var n = normalizeSession(s);
        if (n && !byId[n.id]) { byId[n.id] = n; migrations.push(n); }
      });
    } catch (e) { /* legacy 损坏则忽略 */ }
    cache = Object.keys(byId).map(function (k) { return byId[k]; });
    sortCache();
    migrations.forEach(function (s) { persist(s); });
    if (migrations.length) {
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      console.info('[SessionStore] migrated ' + migrations.length + ' legacy sessions to disk');
    }
    currentId = window._currentSessionId || null;
    ready = true;
    emit('ready');
  }

  var Store = {
    isReady: function () { return ready; },
    all: function () { return cache; },
    get: function (id) {
      for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return cache[i];
      return null;
    },
    current: function () { return currentId; },
    on: function (fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); },
    off: function (fn) { listeners = listeners.filter(function (x) { return x !== fn; }); },

    // 单一写者入口：把当前可见对话同步进 store（替代 saveCurrentSessionToHistory）
    syncCurrent: function (log, meta) {
      if (!Array.isArray(log) || !log.length) return null;
      var firstUser = null;
      for (var i = 0; i < log.length; i++) if (log[i].role === 'user') { firstUser = log[i]; break; }
      var title = String((firstUser && firstUser.content) || '对话').replace(/\s+/g, ' ').trim().slice(0, 40) || '对话';
      var id = currentId;
      var s = id ? Store.get(id) : null;
      if (id && !s) id = null; // 指向已删除会话：尊重删除，不写回
      if (!id) id = nowId();
      var prevMsgs = s ? s.messages : [];
      var msgs = log.map(function (m, i2) {
        var old = prevMsgs[i2];
        var keep = (old && old.role === (m.role === 'assistant' || m.role === 'ai' ? 'assistant' : 'user')) ? old : {};
        return normalizeMessage(Object.assign({}, keep, m), i2);
      });
      var entry = Object.assign({}, s || { ts: Date.now() }, {
        id: id,
        title: (s && s.titleLocked) ? s.title : title,
        titleLocked: !!(s && s.titleLocked),
        updatedAt: Date.now(),
        messages: msgs
      }, meta || {});
      upsert(entry);
      currentId = id;
      window._currentSessionId = id;
      persist(Store.get(id));
      emit('change');
      return id;
    },

    // AgentRunner 收尾时把富字段（thinking/workLog/plan/usage）合并进同一条会话
    captureFromAgent: function (agent, meta) {
      if (!agent) return;
      var id = currentId || agent.sessionId;
      if (!id) return;
      var s = Store.get(id) || { id: id, ts: Date.now() };
      s.title = agent.sessionTitle || s.title || '未命名对话';
      s.messages = (Array.isArray(agent.messages) ? agent.messages : []).map(normalizeMessage);
      s.thinking = agent.thinkingAcc || null;
      s.workLog = Array.isArray(agent.workLog) ? agent.workLog : [];
      s.mode = agent.mode || 'default';
      s.usage = agent.usageAcc || null;
      for (var k in (meta || {})) s[k] = meta[k];
      s.updatedAt = Date.now();
      upsert(s);
      currentId = id;
      window._currentSessionId = id;
      persist(Store.get(id));
      emit('change');
    },

    newSession: function () { currentId = null; window._currentSessionId = null; emit('change'); },

    setCurrent: function (id) { currentId = id; window._currentSessionId = id; },

    // 确保有一个稳定的当前会话 id（AgentRunner 构造时调用；不立即建条目，等首次保存）
    ensureCurrent: function () {
      if (!currentId) { currentId = nowId(); window._currentSessionId = currentId; }
      return currentId;
    },

    remove: function (id) {
      cache = cache.filter(function (s) { return s.id !== id; });
      delete pending[id];
      if (currentId === id) { currentId = null; window._currentSessionId = null; }
      if (api && api.delete) Promise.resolve(api.delete(id)).catch(function (e) { console.warn('[SessionStore] delete failed', e); });
      emit('change');
    },

    rename: function (id, title) {
      var s = Store.get(id);
      if (!s) return;
      s.title = String(title || '').slice(0, 120);
      s.titleLocked = true;
      s.updatedAt = Date.now();
      persist(s);
      if (api && api.rename) Promise.resolve(api.rename(id, s.title)).catch(function (e) { console.warn('[SessionStore] rename failed', e); });
      emit('change');
    },

    revise: function (id, ops) {
      var s = Store.get(id);
      if (!s) return Promise.resolve(false);
      applyOps(s, ops);
      upsert(s);
      persist(s);
      emit('change');
      if (api && api.revise) return Promise.resolve(api.revise(id, ops)).catch(function (e) { console.warn('[SessionStore] revise failed', e); return false; });
      return Promise.resolve(true);
    },

    // 从某条消息分叉重来：截断 store / 可见日志 / agent 上下文 / DOM，然后由用户重新发送
    truncateAt: function (seq) {
      var s = Store.get(currentId);
      if (!s) return false;
      var from = Math.max(0, Number(seq) || 0);
      Store.revise(s.id, [{ type: 'delete_range', fromSeq: from, toSeq: s.messages.length - 1 }]);
      var kept = s.messages.slice(0, from).map(function (m) { return { role: m.role, content: m.content }; });
      window._chatLog = kept;
      var st = window.BubaiCodeUI && window.BubaiCodeUI.state;
      if (st && st.agent) st.agent.messages = kept.slice();
      var nodes = document.querySelectorAll('#ai-chat-area .chat-message');
      for (var i = 0; i < nodes.length; i++) if (i >= from) nodes[i].remove();
      // 文件变更 turn 与消息 seq 不同坐标系，不在此联动（避免误回滚用户文件）
      emit('change');
      return true;
    },

    search: function (q, opts) {
      // 本地镜像兜底：IPC 不可用 / 返回空时仍能让 UI 显示结果
      var fallback = function () {
        var s = String(q || '').trim().toLowerCase();
        return cache.filter(function (x) {
          if (!s) return true;
          if ((x.title || '').toLowerCase().indexOf(s) >= 0) return true;
          return x.messages.some(function (m) { return String(m.content || '').toLowerCase().indexOf(s) >= 0; });
        }).map(function (x) {
          return { id: x.id, title: x.title, ts: tsOf(x), messageCount: x.messages.length, snippet: '', messageSeq: -1 };
        });
      };
      if (api && api.search) {
        return Promise.resolve(api.search(q, opts || {}))
          .then(function (r) { return (Array.isArray(r) && r.length) ? r : fallback(); })
          .catch(fallback);
      }
      return Promise.resolve(fallback());
    },

    // 内存镜像即权威：刚 syncCurrent/captureFromAgent 的会话无需等防抖落盘即可读到
    loadFull: function (id) {
      var local = Store.get(id);
      if (local) return Promise.resolve(local);
      if (api && api.load) return Promise.resolve(api.load(id)).catch(function () { return null; });
      return Promise.resolve(null);
    },

    flushNow: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
    },

    init: init
  };

  window.SessionStore = Store;
  // 关窗 / 切后台时强制 flush，避免 250ms 防抖窗口内丢失会话
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', function () { Store.flushNow(); });
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') Store.flushNow();
    });
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

// Phase C · MQTT 设备面板（底栏 tab，对齐 ChipCode mqtt manager 的可观测性）
// 复用 app.js 已泛化的 .bottom-tab[data-panel] 切换逻辑，无需改其代码。
(function () {
  function api() { return window.LabCode && window.LabCode.mqtt; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var MAX_LINES = 200;
  var lines = [];

  function build() {
    if ($('mqtt-panel')) return;
    var bottom = document.querySelector('.bottom-content');
    if (!bottom) return;
    var panel = document.createElement('div');
    panel.className = 'bottom-panel-content';
    panel.id = 'mqtt-panel';
    panel.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%;font-size:12px;">' +
      '<div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-color);align-items:center;flex-wrap:wrap;">' +
      '<span id="mqtt-state" style="font-size:11px;color:var(--text-secondary);min-width:74px;">未连接</span>' +
      '<input id="mqtt-url" placeholder="mqtt://broker:1883 或 ws://host:9001" style="flex:1;min-width:190px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<input id="mqtt-user" placeholder="用户名(可选)" style="width:100px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<input id="mqtt-pass" type="password" placeholder="密码(可选)" style="width:100px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<button class="btn btn-primary btn-sm" id="mqtt-connect-btn" style="padding:4px 12px;font-size:10.5px;">连接</button>' +
      '<button class="btn btn-secondary btn-sm" id="mqtt-test-btn" style="padding:4px 12px;font-size:10.5px;">测试</button>' +
      '<button class="btn btn-secondary btn-sm" id="mqtt-clear-btn" style="padding:4px 12px;font-size:10.5px;">清空</button>' +
      '</div>' +
      '<div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-color);align-items:center;flex-wrap:wrap;">' +
      '<input id="mqtt-sub-topic" placeholder="订阅 topic（支持 + / #）" style="flex:1;min-width:160px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<button class="btn btn-secondary btn-sm" id="mqtt-sub-btn" style="padding:4px 12px;font-size:10.5px;">订阅</button>' +
      '<input id="mqtt-pub-topic" placeholder="发布 topic" style="flex:1;min-width:130px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<input id="mqtt-pub-payload" placeholder="payload" style="flex:1;min-width:130px;font-size:11.5px;padding:3px 7px;background:var(--card-color);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);" />' +
      '<button class="btn btn-secondary btn-sm" id="mqtt-pub-btn" style="padding:4px 12px;font-size:10.5px;">发布</button>' +
      '<span id="mqtt-topics" style="font-size:10.5px;color:var(--text-secondary);"></span>' +
      '</div>' +
      '<div id="mqtt-log" style="flex:1;overflow:auto;padding:6px 10px;font-family:var(--font-mono,monospace);font-size:11.5px;white-space:pre-wrap;word-break:break-all;"></div>' +
      '</div>';
    bottom.appendChild(panel);

    var tabs = document.querySelector('.bottom-tabs');
    if (tabs && !tabs.querySelector('[data-panel="mqtt"]')) {
      var tab = document.createElement('button');
      tab.className = 'bottom-tab';
      tab.dataset.panel = 'mqtt';
      tab.textContent = 'MQTT';
      // app.js 的 .bottom-tab 委托在初始化时已绑定；这里补一份点击委托（幂等）
      tab.addEventListener('click', function () {
        document.querySelectorAll('.bottom-tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.bottom-panel-content').forEach(function (v) { v.classList.remove('active'); });
        tab.classList.add('active');
        panel.classList.add('active');
      });
      tabs.appendChild(tab);
    }
    bind();
  }

  function log(text, color) {
    lines.push({ text: text, color: color });
    if (lines.length > MAX_LINES) lines.shift();
    var el = $('mqtt-log');
    if (!el) return;
    el.innerHTML = lines.map(function (l) {
      return '<div style="color:' + (l.color || 'var(--text-color)') + '">' + esc(l.text) + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function cfg() {
    return {
      id: 'default',
      url: $('mqtt-url').value.trim(),
      username: $('mqtt-user').value,
      password: $('mqtt-pass').value,
      topics: [],
      allowedPublishTopics: [],
      qos: 0
    };
  }

  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'info'); }

  function bind() {
    $('mqtt-connect-btn').addEventListener('click', async function () {
      var a = api(); if (!a) return toast('仅桌面版支持 MQTT', 'warn');
      var c = cfg();
      if (!c.url) return toast('请填写 broker 地址', 'warn');
      var btn = $('mqtt-connect-btn');
      if (btn.dataset.on === '1') {
        await a.disconnect('default');
        btn.dataset.on = '0'; btn.textContent = '连接';
        log('已断开', '#f59e0b');
        return;
      }
      var r = await a.connect(c);
      if (!r.success) return toast('连接失败: ' + r.error, 'error');
      btn.dataset.on = '1'; btn.textContent = '断开';
      log('正在连接 ' + c.url);
    });
    $('mqtt-test-btn').addEventListener('click', async function () {
      var a = api(); if (!a) return;
      var c = cfg();
      if (!c.url) return toast('请填写 broker 地址', 'warn');
      var r = await a.testConnection({ config: c });
      toast(r.success ? '连接测试成功' : ('测试失败: ' + r.error), r.success ? 'success' : 'error');
      log(r.success ? '连接测试成功' : ('连接测试失败: ' + r.error), r.success ? '#52C41A' : '#ef4444');
    });
    $('mqtt-sub-btn').addEventListener('click', async function () {
      var a = api(); if (!a) return;
      var t = $('mqtt-sub-topic').value.trim();
      if (!t) return toast('请填写订阅 topic', 'warn');
      var r = await a.subscribe({ id: 'default', topic: t, qos: 0 });
      if (!r.success) return toast('订阅失败: ' + r.error, 'error');
      $('mqtt-sub-topic').value = '';
      log('已订阅 ' + t);
    });
    $('mqtt-pub-btn').addEventListener('click', async function () {
      var a = api(); if (!a) return;
      var t = $('mqtt-pub-topic').value.trim();
      if (!t) return toast('请填写发布 topic', 'warn');
      var r = await a.publish({ id: 'default', topic: t, payload: $('mqtt-pub-payload').value, qos: 0 });
      if (!r.success) return toast('发布失败: ' + r.error, 'error');
      log('发布成功 ' + t);
    });
    $('mqtt-clear-btn').addEventListener('click', function () { lines = []; if ($('mqtt-log')) $('mqtt-log').innerHTML = ''; });

    var a = api();
    if (!a) return;
    if (a.onStatus) a.onStatus(function (data) {
      var st = (data && data.statuses && data.statuses[0]) || null;
      var el = $('mqtt-state');
      if (!el) return;
      if (!st) { el.textContent = '未连接'; el.style.color = 'var(--text-secondary)'; $('mqtt-topics').textContent = ''; return; }
      var map = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', offline: '离线', error: '错误', disconnected: '已断开' };
      el.textContent = map[st.status] || st.status;
      el.style.color = st.status === 'connected' ? '#52C41A' : (st.status === 'error' ? '#ef4444' : '#f59e0b');
      if (st.error) el.title = st.error;
      $('mqtt-topics').textContent = st.topics && st.topics.length ? ('订阅: ' + st.topics.join(', ')) : '';
    });
    if (a.onMessage) a.onMessage(function (m) {
      if (!m) return;
      var d = new Date(m.ts || Date.now());
      var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      log('[' + ts + '] ' + m.topic + '  ' + m.payload, String(m.payload).indexOf('[TX]') === 0 ? '#3b82f6' : null);
    });
  }

  function init() {
    build();
    var a = api();
    if (a && a.getStatus) a.getStatus().then(function (list) {
      if (Array.isArray(list) && list.length) {
        var st = list[0];
        var btn = $('mqtt-connect-btn');
        if (btn && st.status === 'connected') { btn.dataset.on = '1'; btn.textContent = '断开'; }
        if ($('mqtt-url') && st.url) $('mqtt-url').value = st.url;
      }
    }).catch(function () {});
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

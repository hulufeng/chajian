// Phase C · 账户订阅 / 套餐面板（对齐参考基线 设置 → 账户与计费 + payment.getPlans + 外部购买入口）
// 桌面端不做本地 checkout / 订单 / 订阅状态机（参考基线 同样如此），只展示套餐与权益并跳转账户页。
(function () {
  function api() { return window.BubaiCode && window.BubaiCode.payment; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    if ($('panel-subscription')) return;
    var nav = document.querySelector('.settings-sidebar .settings-nav-group');
    var panels = document.querySelector('.settings-panels');
    if (!nav || !panels) return;
    var item = document.createElement('div');
    item.className = 'settings-nav-item';
    item.dataset.target = 'panel-subscription';
    item.textContent = '订阅与套餐';
    nav.appendChild(item);
    var panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.id = 'panel-subscription';
    panel.innerHTML =
      '<h3 style="margin:0 0 6px;font-size:15px;">订阅与套餐</h3>' +
      '<p style="margin:0 0 16px;font-size:12px;color:var(--text-secondary);line-height:1.6;">' +
      '内置账号模型按 token 消耗积分；自带 Key 的本地模型不消耗积分。购买与发票在账户中心完成，本应用不处理支付。</p>' +
      '<div id="sub-current" style="padding:12px;border:1px solid var(--border-color);border-radius:8px;margin-bottom:14px;"></div>' +
      '<div id="sub-plans" style="display:flex;gap:10px;flex-wrap:wrap;"></div>' +
      '<div id="sub-source" style="margin-top:12px;font-size:11px;color:var(--text-secondary);"></div>';
    panels.appendChild(panel);
  }

  function currentHtml() {
    var plan = $('gw-plan-badge') ? $('gw-plan-badge').textContent.trim() : '';
    var total = $('gw-total-credits') ? $('gw-total-credits').textContent.trim() : '';
    var daily = $('gw-daily-badge') ? $('gw-daily-badge').textContent.trim() : '';
    return '<div style="font-size:12px;line-height:1.9;">' +
      '<div><b>当前套餐</b>：' + esc(plan || '免费版') + '</div>' +
      '<div><b>可用积分</b>：' + esc(total || '—') + '</div>' +
      '<div><b>今日额度</b>：' + esc(daily || '—') + '</div></div>';
  }

  function renderPlans(plans) {
    var el = $('sub-plans');
    if (!el) return;
    el.innerHTML = plans.map(function (p) {
      var id = esc(p.id || '');
      var name = esc(p.name || p.id || '套餐');
      var price = (p.price == null) ? '详见账户中心' : (Number(p.price) === 0 ? '免费' : String(p.price));
      var feats = Array.isArray(p.features) ? p.features : [];
      var li = feats.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
      return '<div style="flex:1;min-width:150px;max-width:220px;border:1px solid var(--border-color);border-radius:8px;padding:12px;">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:4px;">' + name + '</div>' +
        '<div style="font-size:12px;color:var(--accent);margin-bottom:8px;">' + esc(price) + '</div>' +
        '<ul style="margin:0 0 10px;padding-left:16px;font-size:11.5px;color:var(--text-secondary);line-height:1.7;">' + li + '</ul>' +
        '<button class="btn btn-secondary btn-sm sub-buy" data-plan="' + id + '" style="font-size:11px;padding:4px 10px;">选择</button>' +
        '</div>';
    }).join('');
    el.querySelectorAll('.sub-buy').forEach(function (b) {
      b.addEventListener('click', async function () {
        var a = api(); if (!a) return;
        var r = await a.openPortal({ plan: b.dataset.plan });
        if (r && !r.success && window.showToast) window.showToast('打开失败: ' + r.error, 'error');
      });
    });
  }

  async function refresh() {
    var c = $('sub-current');
    if (c) c.innerHTML = currentHtml();
    var a = api();
    if (!a) return;
    var r = await a.getPlans();
    var plans = (r && Array.isArray(r.plans)) ? r.plans : [];
    renderPlans(plans);
    var src = $('sub-source');
    if (src) src.textContent = r && r.source === 'gateway' ? '套餐数据来自账号服务' : '账号服务暂不可用，显示内置套餐摘要（以账户中心为准）';
  }

  function init() {
    build();
    // 设置面板打开时刷新（事件委托，避免依赖 app.js 内部函数）
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && (t.dataset && t.dataset.target === 'panel-subscription')) refresh();
      if (t && t.id === 'settings-btn') refresh();
    });
    refresh();
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

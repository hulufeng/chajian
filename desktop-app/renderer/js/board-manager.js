// 开发板核心与库管理器（对齐参考基线 board:*/core:*/lib:* 通道）
// 入口按钮：index.html 的 #board-manager-btn；通道：window.BubaiCode.board.*
(function () {
  'use strict';
  const api = (window.BubaiCode && window.BubaiCode.board) ? window.BubaiCode.board : null;

  // ---------- 注入模态框 DOM ----------
  function injectModal() {
    if (document.getElementById('board-manager-modal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'board-manager-modal';
    wrap.style.display = 'none';
    wrap.innerHTML =
      '<div class="modal" style="width:760px;max-width:92vw;">' +
        '<div class="modal-header">' +
          '<h3>开发板核心与库管理器</h3>' +
          '<button class="modal-close" id="bm-close" title="关闭">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="padding:14px 16px;">' +
          '<div class="bm-tabs" style="display:flex;gap:6px;margin-bottom:12px;">' +
            '<div class="bm-tab btn btn-secondary btn-sm active" data-tab="core">核心</div>' +
            '<div class="bm-tab btn btn-secondary btn-sm" data-tab="lib">库</div>' +
            '<div class="bm-tab btn btn-secondary btn-sm" data-tab="installed">已装库</div>' +
          '</div>' +
          '<div class="bm-toolbar" style="display:flex;gap:8px;margin-bottom:12px;">' +
            '<input id="bm-search-input" placeholder="搜索平台 / 库（如 esp32、Servo、OLED）…" ' +
              'style="flex:1;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:12px;outline:none;"/>' +
            '<button class="btn btn-primary btn-sm" id="bm-search-btn">搜索</button>' +
            '<button class="btn btn-secondary btn-sm" id="bm-refresh-btn">刷新</button>' +
            '<button class="btn btn-secondary btn-sm" id="bm-updateindex-btn" title="更新平台与库索引">更新索引</button>' +
          '</div>' +
          '<div id="bm-results" class="bm-results" style="max-height:46vh;overflow-y:auto;"></div>' +
          '<div id="bm-status" class="bm-status" style="margin-top:10px;font-size:11.5px;color:var(--text-secondary);min-height:16px;"></div>' +
          '<div id="bm-progress" class="bm-progress" style="display:none;margin-top:8px;">' +
            '<div style="height:8px;background:var(--bg-secondary);border-radius:6px;overflow:hidden;border:1px solid var(--border-color);">' +
              '<div id="bm-progress-fill" style="height:100%;width:0%;background:var(--accent-color,#2563eb);transition:width .2s;"></div>' +
            '</div>' +
            '<span id="bm-progress-text" style="display:inline-block;margin-top:4px;font-size:11px;color:var(--text-tertiary);"></span>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    document.getElementById('bm-close').addEventListener('click', closeModal);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    wrap.querySelectorAll('.bm-tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
    });
    document.getElementById('bm-search-btn').addEventListener('click', doSearch);
    document.getElementById('bm-refresh-btn').addEventListener('click', refreshCurrent);
    document.getElementById('bm-updateindex-btn').addEventListener('click', updateIndex);
    const input = document.getElementById('bm-search-input');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    // 安装进度订阅（核心 / 库）
    if (api && api.onLibInstallProgress) {
      api.onLibInstallProgress((d) => onInstallProgress(d));
    }
    if (api && api.onCoreInstallProgress) {
      api.onCoreInstallProgress((d) => onInstallProgress(d));
    }
  }

  // ---------- 状态 / 进度 ----------
  function setStatus(msg, isError) {
    const el = document.getElementById('bm-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? 'var(--danger-color,#e5484d)' : 'var(--text-secondary)';
  }
  function showProgress(pct, msg) {
    const box = document.getElementById('bm-progress');
    if (!box) return;
    box.style.display = 'block';
    const fill = document.getElementById('bm-progress-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
    const txt = document.getElementById('bm-progress-text');
    if (txt) txt.textContent = (msg || '') + (pct != null ? '  (' + pct + '%)' : '');
  }
  function hideProgress() {
    const box = document.getElementById('bm-progress');
    if (box) box.style.display = 'none';
  }
  function onInstallProgress(d) {
    if (!d) return;
    if (d.stage === 'complete') { showProgress(100, '完成'); setTimeout(hideProgress, 800); }
    else if (d.stage === 'error') { showProgress(0, '失败: ' + (d.error || '')); }
    else if (d.stage === 'reset') { hideProgress(); }
    else { showProgress(d.percent || 0, d.message || (d.name || '')); }
  }

  // ---------- 渲染结果列表 ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderList(items, kind) {
    const box = document.getElementById('bm-results');
    if (!box) return;
    if (!items || !items.length) {
      box.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-tertiary);font-size:12px;">暂无数据</div>';
      return;
    }
    const rows = items.map((it) => {
      let title, sub, action;
      if (kind === 'core') {
        title = escapeHtml(it.name || it.id);
        sub = 'ID: ' + escapeHtml(it.id) + (it.installed ? '  ·  已装 ' + escapeHtml(it.installed) : '') +
              (it.latest ? '  ·  最新 ' + escapeHtml(it.latest) : '') +
              (it.architectures && it.architectures.length ? '  ·  ' + escapeHtml(it.architectures.join(', ')) : '');
        const installed = !!it.installed;
        action = installed
          ? '<button class="btn btn-danger btn-sm bm-uninstall" data-id="' + escapeHtml(it.id) + '">卸载</button>'
          : '<button class="btn btn-primary btn-sm bm-install" data-id="' + escapeHtml(it.id) + '">安装</button>';
      } else {
        title = escapeHtml(it.name) + (it.version ? '  <span style="color:var(--text-tertiary);font-size:11px;">v' + escapeHtml(it.version) + '</span>' : '');
        sub = escapeHtml((it.author ? it.author + '  ·  ' : '') + (it.sentence || it.paragraph || ''));
        if (kind === 'installed') {
          action = '<button class="btn btn-danger btn-sm bm-uninstall-lib" data-name="' + escapeHtml(it.name) + '">卸载</button>';
        } else {
          action = '<button class="btn btn-primary btn-sm bm-install-lib" data-name="' + escapeHtml(it.name) + '">安装</button>';
        }
      }
      return '<div class="bm-row" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--border-color);border-radius:7px;margin-bottom:7px;background:var(--bg-secondary);">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12.5px;color:var(--text);font-weight:600;">' + title + '</div>' +
          '<div style="font-size:11px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + sub + '</div>' +
        '</div>' +
        '<div style="flex:none;">' + action + '</div>' +
      '</div>';
    }).join('');
    box.innerHTML = rows;

    box.querySelectorAll('.bm-install').forEach((b) => b.addEventListener('click', () => installCore(b.getAttribute('data-id'))));
    box.querySelectorAll('.bm-uninstall').forEach((b) => b.addEventListener('click', () => uninstallCore(b.getAttribute('data-id'))));
    box.querySelectorAll('.bm-install-lib').forEach((b) => b.addEventListener('click', () => installLib(b.getAttribute('data-name'))));
    box.querySelectorAll('.bm-uninstall-lib').forEach((b) => b.addEventListener('click', () => uninstallLib(b.getAttribute('data-name'))));
  }

  // ---------- 操作 ----------
  let activeTab = 'core';

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.bm-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    const input = document.getElementById('bm-search-input');
    if (input) input.placeholder = (tab === 'core' ? '搜索平台（如 esp32、arduino:avr）…' : '搜索库（如 Servo、OLED、WiFi）…');
    refreshCurrent();
  }

  function refreshCurrent() {
    if (activeTab === 'core') loadCores();
    else if (activeTab === 'installed') loadInstalledLibs();
    else doSearch();
  }

  async function loadCores() {
    if (!api) { setStatus('board 接口不可用', true); return; }
    setStatus('加载已装核心…');
    try {
      const r = await api.coreList();
      if (!r.ok) { setStatus('加载失败: ' + (r.error || ''), true); return; }
      renderList(r.platforms || [], 'core');
      setStatus((r.platforms && r.platforms.length ? '已装核心 ' + r.platforms.length + ' 个' : '尚未安装任何核心') + '，可在「库/核心」搜索框输入关键词安装');
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  async function loadInstalledLibs() {
    if (!api) { setStatus('board 接口不可用', true); return; }
    setStatus('加载已装库…');
    try {
      const r = await api.libList();
      if (!r.ok) { setStatus('加载失败: ' + (r.error || ''), true); return; }
      renderList(r.libraries || [], 'installed');
      setStatus(r.libraries && r.libraries.length ? ('已装库 ' + r.libraries.length + ' 个') : '尚未安装任何库');
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  async function doSearch() {
    const q = (document.getElementById('bm-search-input') || {}).value || '';
    if (!api) { setStatus('board 接口不可用', true); return; }
    if (!q.trim()) {
      setStatus('请输入搜索关键词');
      return;
    }
    setStatus('搜索中: ' + q + ' …');
    try {
      if (activeTab === 'core') {
        const r = await api.coreSearch(q);
        if (!r.ok) { setStatus('搜索失败: ' + (r.error || ''), true); return; }
        renderList(r.platforms || [], 'core');
        setStatus('找到 ' + ((r.platforms || []).length) + ' 个平台');
      } else {
        const r = await api.libSearch(q);
        if (!r.ok) { setStatus('搜索失败: ' + (r.error || ''), true); return; }
        renderList(r.libraries || [], 'lib');
        setStatus('找到 ' + ((r.libraries || []).length) + ' 个库（最多显示前若干）');
      }
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  async function installCore(id) {
    if (!api) return;
    setStatus('正在安装核心 ' + id + ' …');
    showProgress(2, '准备安装 ' + id);
    try {
      const r = await api.coreInstall({ id });
      if (!r.ok) { setStatus('安装失败: ' + (r.error || ''), true); hideProgress(); return; }
      setStatus('核心 ' + id + ' 安装成功');
      hideProgress();
      loadCores();
    } catch (e) { setStatus('异常: ' + e.message, true); hideProgress(); }
  }

  async function uninstallCore(id) {
    if (!api) return;
    if (!confirm('确认卸载核心 ' + id + ' ？')) return;
    setStatus('正在卸载核心 ' + id + ' …');
    try {
      const r = await api.coreUninstall({ id });
      if (!r.ok) { setStatus('卸载失败: ' + (r.error || ''), true); return; }
      setStatus('核心 ' + id + ' 已卸载');
      loadCores();
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  async function installLib(name) {
    if (!api) return;
    setStatus('正在安装库 ' + name + ' …');
    showProgress(2, '准备安装 ' + name);
    try {
      const r = await api.libInstall({ name });
      if (!r.ok) { setStatus('安装失败: ' + (r.error || ''), true); hideProgress(); return; }
      setStatus('库 ' + name + ' 安装成功');
      hideProgress();
    } catch (e) { setStatus('异常: ' + e.message, true); hideProgress(); }
  }

  async function uninstallLib(name) {
    if (!api) return;
    if (!confirm('确认卸载库 ' + name + ' ？')) return;
    setStatus('正在卸载库 ' + name + ' …');
    try {
      const r = await api.libUninstall({ name });
      if (!r.ok) { setStatus('卸载失败: ' + (r.error || ''), true); return; }
      setStatus('库 ' + name + ' 已卸载');
      loadInstalledLibs();
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  async function updateIndex() {
    if (!api) return;
    setStatus('正在更新平台 / 库索引…');
    try {
      const [c, l] = await Promise.all([api.coreUpdateIndex(), api.libUpdateIndex()]);
      if (!c.ok && !l.ok) { setStatus('更新失败: ' + ((c.error || '') + ' ' + (l.error || '')), true); return; }
      setStatus('索引已更新，可重新搜索');
      refreshCurrent();
    } catch (e) { setStatus('异常: ' + e.message, true); }
  }

  // ---------- 开关 ----------
  function openModal() {
    injectModal();
    const m = document.getElementById('board-manager-modal');
    if (!m) return;
    m.style.display = 'flex';
    switchTab(activeTab);
  }
  function closeModal() {
    const m = document.getElementById('board-manager-modal');
    if (m) m.style.display = 'none';
    hideProgress();
  }

  // ---------- 入口绑定 ----------
  function bind() {
    const btn = document.getElementById('board-manager-btn');
    if (btn) btn.addEventListener('click', openModal);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 暴露给命令面板等其他模块调用
  window.openBoardManager = openModal;
})();

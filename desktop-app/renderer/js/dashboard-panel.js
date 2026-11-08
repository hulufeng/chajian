// dashboard-panel.js — 看板（对齐 Ekko 看板）：项目统计 / 扩展名分布 / 最近修改 / Git / 系统信息
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function getProjectPath() {
    try {
      if (window.BubaiCodeUI && window.BubaiCodeUI.state && window.BubaiCodeUI.state.projectPath) {
        return window.BubaiCodeUI.state.projectPath;
      }
    } catch (e) {}
    return '';
  }

  function showDashboard() {
    const v = el('dashboard-view');
    const gc = el('groupchat-view');
    const wf = el('workflow-view');
    if (v) v.style.display = 'flex';
    if (gc) gc.style.display = 'none';
    if (wf) wf.style.display = 'none';
    refresh();
  }

  function hideDashboard() {
    const v = el('dashboard-view');
    if (v) v.style.display = 'none';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function refresh() {
    const body = el('dash-body');
    if (!body) return;
    const project = getProjectPath();
    if (!project) {
      body.innerHTML = '<div class="dash-empty">尚未打开项目 — 请先在左侧「文件」面板打开一个文件夹</div>';
      return;
    }
    body.innerHTML = '<div class="dash-empty">正在扫描项目统计…</div>';

    let stats = { files: 0, dirs: 0, totalBytes: 0, topExts: [], recent: [], elapsedMs: 0 };
    let gitInfo = null;
    try {
      if (window.BubaiCode && window.BubaiCode.dashboard) stats = await window.BubaiCode.dashboard.stats(project);
      if (window.BubaiCode && window.BubaiCode.git) {
        const st = await window.BubaiCode.git.status(project);
        const br = st.success ? await window.BubaiCode.git.branches(project).catch(() => null) : null;
        gitInfo = {
          isRepo: !!st.success,
          branch: br && br.success ? br.current : (st.success ? '?' : null),
          files: st.files || [],
          message: st.message || ''
        };
      }
    } catch (e) {
      stats.error = e.message;
    }

    const extTotal = stats.topExts.reduce((s, x) => s + x[1], 0) || 1;
    const maxExt = stats.topExts.length ? stats.topExts[0][1] : 1;
    const hasProcess = typeof process !== 'undefined';
    const sys = {
      electron: hasProcess && process.versions ? process.versions.electron || '-' : '-',
      node: hasProcess && process.versions ? process.versions.node || '-' : '-',
      chrome: hasProcess && process.versions ? process.versions.chrome || '-' : '-',
      platform: hasProcess ? process.platform : (navigator.platform || '-')
    };

    body.innerHTML =
      '<div class="dash-card"><h3>📊 项目概览</h3><div class="dash-metrics">' +
      '<div class="dash-metric"><div class="v">' + stats.files.toLocaleString() + '</div><div class="k">文件</div></div>' +
      '<div class="dash-metric"><div class="v">' + stats.dirs.toLocaleString() + '</div><div class="k">目录</div></div>' +
      '<div class="dash-metric"><div class="v">' + fmtBytes(stats.totalBytes) + '</div><div class="k">总大小</div></div>' +
      '<div class="dash-metric"><div class="v">' + stats.elapsedMs + 'ms</div><div class="k">扫描耗时</div></div>' +
      '</div><div class="dash-kv"><span class="k">项目路径</span><span class="v" title="' + esc(project) + '" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;">' + esc(project) + '</span></div></div>' +

      '<div class="dash-card"><h3>📁 文件类型 TOP</h3>' +
      (stats.topExts.length ? stats.topExts.map(x => {
        const pct = Math.round(x[1] / extTotal * 100);
        return '<div class="dash-ext-bar"><span class="lab">' + esc(x[0]) + '</span>' +
          '<span class="track"><span class="fill" style="width:' + Math.round(x[1] / maxExt * 100) + '%"></span></span>' +
          '<span class="cnt">' + x[1] + ' · ' + pct + '%</span></div>';
      }).join('') : '<div class="dash-empty" style="height:60px;">无数据</div>') + '</div>' +

      '<div class="dash-card"><h3>🕒 最近修改文件</h3>' +
      (stats.recent.length ? stats.recent.map(f =>
        '<div class="dash-file"><span class="nm" title="' + esc(f.path) + '">' + esc(f.name) + '</span><span class="tm">' + fmtTime(f.mtime) + '</span></div>'
      ).join('') : '<div class="dash-empty" style="height:60px;">无数据</div>') + '</div>' +

      '<div class="dash-card"><h3>🐙 Git 状态</h3>' +
      (gitInfo && gitInfo.isRepo
        ? '<div class="dash-kv"><span class="k">分支</span><span class="v">' + esc(gitInfo.branch || '?') + '</span></div>' +
          '<div class="dash-kv"><span class="k">未提交改动</span><span class="v">' + (gitInfo.files ? gitInfo.files.length : 0) + '</span></div>' +
          (gitInfo.message ? '<div class="dash-kv"><span class="k">状态</span><span class="v" style="font-weight:400;">' + esc(gitInfo.message) + '</span></div>' : '')
        : '<div class="dash-empty" style="height:60px;">当前项目不是 Git 仓库</div>') + '</div>' +

      '<div class="dash-card"><h3>⚙️ 运行环境</h3>' +
      '<div class="dash-kv"><span class="k">Electron</span><span class="v">' + esc(sys.electron) + '</span></div>' +
      '<div class="dash-kv"><span class="k">Node</span><span class="v">' + esc(sys.node) + '</span></div>' +
      '<div class="dash-kv"><span class="k">Chromium</span><span class="v">' + esc(sys.chrome) + '</span></div>' +
      '<div class="dash-kv"><span class="k">平台</span><span class="v">' + esc(sys.platform) + '</span></div></div>';
  }

  function init() {
    // 方案 D：活动栏共 6 项（文件/产品工厂/源代码管理/上下文/插件/设备），没有 data-panel="dashboard" 按钮。
    // 旧实现因 !btn 直接 return，导致刷新/关闭按钮与 openDashboard 全都没绑定（死 UI）。
    // 现在始终绑定，看板改由命令面板「打开看板」调用 window.BubaiCodeUI.openDashboard 打开。
    const btn = document.querySelector('.activity-btn[data-panel="dashboard"]');
    document.querySelectorAll('.activity-btn').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.panel !== 'dashboard') hideDashboard();
      });
    });
    if (btn) btn.addEventListener('click', showDashboard);
    const rf = el('dash-refresh'); if (rf) rf.addEventListener('click', refresh);
    const cl = el('dash-close');
    if (cl) cl.addEventListener('click', () => {
      hideDashboard();
      const ab = document.querySelector('.activity-btn[data-panel="dashboard"]');
      if (ab) ab.classList.remove('active');
      const ex = document.querySelector('.activity-btn[data-panel="explorer"]');
      if (ex) ex.classList.add('active');
      const sb = el('sidebar'); if (sb) sb.style.display = 'flex';
    });
    window.BubaiCodeUI = window.BubaiCodeUI || {};
    window.BubaiCodeUI.openDashboard = showDashboard;
    window.BubaiCodeUI.closeDashboard = hideDashboard;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

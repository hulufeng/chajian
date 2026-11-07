// Phase D · 产品工厂（对齐 ChipCode 侧栏 LOe() / 五阶段导航 / 产品包）
// 复用 #product-factory-view 容器与活动栏 data-panel 切换；磁盘状态由主进程 product:state 计算。
(function () {
  function api() { return window.LabCode && window.LabCode.product; }
  function root() {
    const st = window.LabCodeUI && window.LabCodeUI.state;
    return (st && st.projectPath) || null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m, t) { if (window.showToast) window.showToast(m, t || 'info'); }

  var view = null;
  var snapshot = null;
  var activeStage = 'idea';
  var boardOpen = true;
  var listeners = [];
  var refreshTimer = null;
  var watchedRoot = null;
  var fileTreeOpen = false;
  var viewClosed = false;

  var STAGE_FILES = {
    idea: ['spec.md', 'spec.json'],
    shape: ['design/shape.json', 'design/views/'],
    hardware: ['bom.json', 'constraints.json'],
    software: ['firmware/'],
    integration: ['evidence.jsonl']
  };

  function build() {
    view = document.getElementById('product-factory-view');
    if (!view || view.dataset.pfReady) return;
    view.dataset.pfReady = '1';
    view.innerHTML =
      '<div class="pf-header">' +
      '<div class="pf-title">产品工厂</div>' +
      '<div class="pf-actions">' +
      '<button class="pf-btn icon" id="pf-open" title="打开已有项目"><svg class="icon icon-xs"><use href="#icon-folder-open"></use></svg></button>' +
      '<button class="pf-btn icon" id="pf-new" title="新建产品项目"><svg class="icon icon-xs"><use href="#icon-plus"></use></svg></button>' +
      '</div></div>' +
      '<div class="pf-body" id="pf-body"></div>';
    document.getElementById('pf-new').addEventListener('click', createProject);
    document.getElementById('pf-open').addEventListener('click', openProject);
    ensureActivityTab();
  }

  function ensureActivityTab() {
    const bar = document.querySelector('.activity-bar') || document.querySelector('.activity-btns');
    if (!bar || bar.querySelector('[data-panel="product-factory"]')) return;
    const btn = document.createElement('button');
    btn.className = 'activity-btn';
    btn.dataset.panel = 'product-factory';
    btn.title = '产品工厂';
    btn.innerHTML = '<svg class="icon"><use href="#icon-box"></use></svg><span class="activity-label">产品工厂</span>';
    bar.appendChild(btn);
  }

  // 产品名称输入模态（Electron 不支持 window.prompt，自制模态对齐克隆流程做法；返回 Promise，取消/关闭安全收尾）
  function promptProductName(defaultName) {
    return new Promise(resolve => {
      const old = document.getElementById('pf-name-modal');
      if (old) old.remove();
      let done = false;
      const finish = (val) => { if (done) return; done = true; wrap.remove(); document.removeEventListener('keydown', onKey, true); resolve(val || null); };
      const wrap = document.createElement('div');
      wrap.id = 'pf-name-modal';
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
      wrap.innerHTML =
        '<div style="width:440px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:10px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.4);">' +
          '<div style="font-size: 13px;font-weight:600;color:var(--text-color);margin-bottom:12px;">新建产品项目</div>' +
          '<label style="display:block;font-size: 11.5px;color:var(--text-secondary);margin-bottom:6px;">产品名称</label>' +
          '<input id="pf-name-input" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-elevated);color:var(--text-color);font-size: 12.5px;outline:none;" />' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">' +
            '<button id="pf-name-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);cursor:pointer;font-size: 12px;">取消</button>' +
            '<button id="pf-name-ok" style="padding:6px 14px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size: 12px;">创建</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      const input = wrap.querySelector('#pf-name-input');
      input.value = defaultName || '我的产品';
      setTimeout(() => { input.focus(); input.select(); }, 30);
      const ok = () => finish(input.value.trim());
      wrap.querySelector('#pf-name-ok').addEventListener('click', ok);
      wrap.querySelector('#pf-name-cancel').addEventListener('click', () => finish(null));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
      const onKey = (e) => {
        if (done) return;
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  async function createProject() {
    const a = api(); if (!a) return toast('仅桌面版支持', 'warn');
    let parent = null;
    try { parent = await window.LabCode.dialog.openDirectory(); } catch (e) {}
    if (!parent) return;
    if (typeof parent === 'object') parent = parent.path || parent.filePaths && parent.filePaths[0];
    const name = await promptProductName('我的产品');
    if (!name) return;
    const r = await a.create({ root: parent, name: name });
    if (!r.success) return toast('创建失败: ' + r.error, 'error');
    if (typeof window.loadProjectFromDisk === 'function') {
      try { await window.loadProjectFromDisk(r.path); } catch (e) {}
    }
    toast('产品项目已创建：' + r.name, 'success');
    viewClosed = false;
    await refresh(true);
  }

  async function openProject() {
    let dir = null;
    try { dir = await window.LabCode.dialog.openDirectory(); } catch (e) {}
    if (!dir) return;
    if (typeof dir === 'object') dir = dir.path || dir.filePaths && dir.filePaths[0];
    if (typeof window.loadProjectFromDisk === 'function') {
      try { await window.loadProjectFromDisk(dir); } catch (e) {}
    }
    viewClosed = false;
    await refresh(true);
  }

  async function exportPackage() {
    const a = api(); if (!a) return;
    if (!snapshot || !snapshot.isProduct) return toast('请先打开一个产品项目', 'warn');
    // 1:1 仿写 ChipCode：产品包已生成时点击在文件管理器打开，未生成时才导出
    if (snapshot.package && snapshot.package.built) {
      try {
        if (window.LabCode && window.LabCode.shell && window.LabCode.shell.showItemInFolder) {
          await window.LabCode.shell.showItemInFolder(root() + '/hardware-package');
          return;
        }
      } catch (e) { /* 退回重新导出 */ }
    }
    const r = await a.package({ root: root() });
    if (!r.success) return toast('导出失败: ' + r.error, 'error');
    toast('产品包已生成（' + r.files.length + ' 个文件）', 'success');
    await refresh(true);
  }

  function emptyHtml(projectName) {
    const hint = projectName
      ? '正在打开「' + esc(projectName) + '」。产品工厂需要新建或打开一个产品项目。'
      : '先新建或打开一个产品项目，才会出现五阶段导航。';
    return '<div class="pf-nav__empty">' +
      '<div class="pf-nav__empty-ico"><svg class="icon" style="width:28px;height:28px;"><use href="#icon-box"></use></svg></div>' +
      '<div class="pf-nav__empty-title">当前不是产品项目</div>' +
      '<div class="pf-nav__empty-hint">' + hint + '</div>' +
      '<button class="pf-btn primary" id="pf-empty-new">+ 新建产品项目</button>' +
      '<button class="pf-btn outline" id="pf-empty-open">打开已有项目</button>' +
      '</div>';
  }

  function stageHtml(s) {
    const cls = 'pf-nav__stage' + (activeStage === s.id ? ' is-active' : '') + ' pf-nav__stage--' + s.state;
    return '<button class="' + cls + '" data-stage="' + s.id + '" title="' + esc(s.note) + '">' +
      '<span class="pf-nav__idx pf-mono">0' + s.index + '</span>' +
      '<span class="pf-nav__dot pf-nav__dot--' + s.state + '"></span>' +
      '<span class="pf-nav__name">' + esc(s.label) + '</span>' +
      '<span class="pf-nav__state">' + ({ done: '完成', in_progress: '进行中', blocked: '阻塞', not_started: '未开始' }[s.state] || s.state) + '</span>' +
      '<span class="pf-nav__note">' + esc(s.note) + '</span></button>';
  }

  function previewHtml(d, stage) {
    if (stage === 'shape') {
      const shape = d.shape || {};
      const imgs = (d.viewFiles || []).slice(0, 4).map(f =>
        '<div class="pf-view" data-file="design/views/' + esc(f) + '">' + esc(f) + '</div>').join('');
      return '<div class="pf-card"><div class="pf-card-title">造型 / 3D 预览</div>' +
        '<div class="pf-kv">单位：' + esc(shape.unit || 'mm') + ' · 尺寸：' + esc(shape.dims ? JSON.stringify(shape.dims) : '未定义') + '</div>' +
        '<div class="pf-mesh">' + (shape.mesh ? esc(String(shape.mesh)) : '暂无网格文件（STL/OBJ/3MF）') + '</div>' +
        '<div class="pf-views">' + (imgs || '<span class="pf-dim">暂无 2D 视图</span>') + '</div></div>';
    }
    if (stage === 'hardware') {
      const rows = (d.bomItems || []).map(it =>
        '<tr><td>' + esc(it.role) + '</td><td>' + esc(it.part) + '</td><td>' + esc(it.qty) + '</td><td>' + esc(it.status) + '</td><td>' + esc(it.source && it.source.url || '—') + '</td></tr>').join('');
      return '<div class="pf-card"><div class="pf-card-title">硬件 / BOM 选型</div>' +
        '<table class="pf-table"><thead><tr><th>角色</th><th>器件</th><th>数量</th><th>状态</th><th>来源</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="pf-dim">BOM 为空</td></tr>') + '</tbody></table></div>';
    }
    if (stage === 'idea') {
      return '<div class="pf-card"><div class="pf-card-title">创意 / 需求原文</div>' +
        '<div class="pf-pre">' + esc(d.spec.body || '（待 AI 填写）') + '</div>' +
        '<div class="pf-card-title" style="margin-top:12px;">验收条件</div>' +
        (d.spec.criteria.length
          ? '<ul class="pf-list">' + d.spec.criteria.map(c => '<li>' + esc(c.id) + ' · ' + esc(c.text) + (c.verify ? '（' + esc(c.verify) + '）' : '') + '</li>').join('') + '</ul>'
          : '<div class="pf-dim">未定义验收条件</div>') +
        '<div class="pf-kv">确认状态：' + (d.spec.confirmed ? '已确认' : '未确认') + '</div></div>';
    }
    if (stage === 'software') {
      return '<div class="pf-card"><div class="pf-card-title">软件 / 固件</div>' +
        (d.firmwareFiles.length
          ? '<ul class="pf-list">' + d.firmwareFiles.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>'
          : '<div class="pf-dim">firmware/ 下暂无文件</div>') + '</div>';
    }
    const ev = d.evidence || [];
    return '<div class="pf-card"><div class="pf-card-title">联调 / 验证证据</div>' +
      (snapshot.unproven.length ? '<div class="pf-warn">未证明：' + esc(snapshot.unproven.join(', ')) + '</div>' : '') +
      (ev.length
        ? '<table class="pf-table"><thead><tr><th>id</th><th>阶段</th><th>结果</th><th>声明</th></tr></thead><tbody>' +
          ev.map(r => '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.stage) + '</td><td>' + esc(r.result) + '</td><td>' + esc(r.claim) + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="pf-dim">暂无证据</div>') +
      '<div class="pf-kv">产品包：' + (snapshot.package.built ? (snapshot.package.stale ? '<span class="pf-warn">已过期，请重新导出</span>' : '最新') : '未生成') + '</div></div>';
  }

  function render() {
    const body = document.getElementById('pf-body');
    if (!body) return;
    if (viewClosed || !snapshot || !snapshot.isProduct) {
      body.innerHTML = emptyHtml(viewClosed ? '' : (root() ? String(root()).split(/[\\/]/).pop() : ''));
      const n = document.getElementById('pf-empty-new');
      const o = document.getElementById('pf-empty-open');
      if (n) n.addEventListener('click', createProject);
      if (o) o.addEventListener('click', openProject);
      return;
    }
    const m = snapshot.meter;
    const pct = Math.round((m.total ? m.hit / m.total : 0) * 100);
    // 1:1 仿写 ChipCode pf-export：产品包已生成/过期三态 + 文件数徽标
    const pkg = snapshot.package || {};
    const pkgCount = pkg.fileCount || 0;
    const exportLabel = pkgCount ? (pkg.stale ? '产品包 · 已过期' : '产品包') : '生成产品包';
    const exportTitle = pkgCount
      ? (pkg.stale ? '输入已变（spec / 选型 / 证据 / 结构），这个产品包已过期——建议重新生成' : '产品包已生成，点击重新生成')
      : '把当前项目整理成产品包，写到 hardware-package/';
    body.innerHTML =
      '<div class="pf-nav__actions">' +
      '<button class="pf-btn" id="pf-refresh" style="padding:3px 10px;font-size:12px">刷新</button>' +
      '<button class="pf-btn primary' + (pkg.stale ? ' pf-export--stale' : '') + '" id="pf-export" title="' + esc(exportTitle) + '" style="padding:3px 10px;font-size:12px">' +
      (pkgCount ? '<span class="pf-mono" style="margin-right:6px;">' + pkgCount + (pkg.stale ? '!' : '') + '</span>' : '') + esc(exportLabel) + '</button>' +
      '<button class="pf-btn" id="pf-close-view" style="padding:3px 10px;font-size:12px">关闭</button>' +
      '</div>' +
      '<div class="pf-nav">' +
      '<div class="pf-nav__meter"><span>证据覆盖</span><b>' + m.hit + ' / ' + m.total + '</b>' +
      '<div class="pf-nav__meter-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="pf-nav__progress">阶段进度 ' + m.doneCount + ' / 5</div></div>' +
      '<div class="pf-nav__stages">' + snapshot.stages.map(stageHtml).join('') + '</div>' +
      '<button class="pf-nav__files-toggle" id="pf-files-toggle">' + (fileTreeOpen ? '▾' : '▸') + ' 项目文件</button>' +
      '<div id="pf-files" class="pf-files" style="display:' + (fileTreeOpen ? 'block' : 'none') + '">' +
      Object.keys(STAGE_FILES).map(k => '<div class="pf-file-group"><b>0' + (snapshot.stages.findIndex(s => s.id === k) + 1) + ' ' +
        esc(snapshot.stages.find(s => s.id === k).label) + '</b>' + STAGE_FILES[k].map(f => '<div>· ' + esc(f) + '</div>').join('') + '</div>').join('') +
      '</div></div>' +
      '<div class="pf-board" id="pf-board">' + (boardOpen ? previewHtml(snapshot.data, activeStage) : '') + '</div>';
    const ex = document.getElementById('pf-export'); if (ex) ex.addEventListener('click', exportPackage);
    const rf = document.getElementById('pf-refresh'); if (rf) rf.addEventListener('click', function () { refresh(true); });
    const cv = document.getElementById('pf-close-view'); if (cv) cv.addEventListener('click', function () { viewClosed = true; snapshot = null; render(); });
    body.querySelectorAll('.pf-nav__stage').forEach(function (b) {
      b.addEventListener('click', function () {
        activeStage = b.dataset.stage;
        boardOpen = true;
        listeners.forEach(function (fn) { try { fn(activeStage); } catch (e) {} });
        render();
      });
    });
    const ft = document.getElementById('pf-files-toggle');
    if (ft) ft.addEventListener('click', function () { fileTreeOpen = !fileTreeOpen; render(); });
    // 2D 视图：通过 readImageDataUrl 加载本地图片
    body.querySelectorAll('.pf-view').forEach(async function (v) {
      try {
        const p = root() + (String(root()).indexOf('\\') >= 0 ? '\\' : '/') + v.dataset.file.replace(/\//g, String(root()).indexOf('\\') >= 0 ? '\\' : '/');
        const r = await window.LabCode.fs.readImageDataUrl(p);
        if (r && r.dataUrl) {
          const img = document.createElement('img');
          img.src = r.dataUrl; img.className = 'pf-view-img';
          v.appendChild(img);
        }
      } catch (e) {}
    });
  }

  async function refresh(force) {
    const a = api();
    if (!a) return;
    const r = root();
    if (!r) { snapshot = null; render(); return; }
    try {
      const s = await a.state({ root: r });
      if (s && s.success) snapshot = s;
      else snapshot = null;
    } catch (e) { snapshot = null; }
    if (watchedRoot !== r) {
      watchedRoot = r;
      try { await a.watch({ root: r }); } catch (e) {}
    }
    render();
    if (force) { /* 手动刷新无额外动作 */ }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refresh(); }, 300);
  }

  function init() {
    build();
    const a = api();
    if (a && a.onFilesChanged) a.onFilesChanged(function () { scheduleRefresh(); });
    // 视图被打开时刷新（活动栏 click 与欢迎页 pill 都会触发）
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (!t) return;
      const act = t.closest ? t.closest('.activity-btn[data-panel="product-factory"], #welcome-pill-product') : null;
      if (act) setTimeout(function () { refresh(); }, 60);
    });
    refresh();
  }

  window.ProductFactory = {
    get activeStage() { return activeStage; },
    get snapshot() { return snapshot; },
    root: root,
    refresh: refresh,
    onStageChange: function (fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); },
    writeFile: async function (rel, content) {
      const a = api(); if (!a) return { success: false, error: '仅桌面版' };
      const r = await a.writeFile({ root: root(), rel: rel, content: content });
      scheduleRefresh();
      return r;
    },
    readFile: async function (rel) {
      const a = api(); if (!a) return { success: false, error: '仅桌面版' };
      return a.readFile({ root: root(), rel: rel });
    }
  };

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

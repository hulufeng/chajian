// context-panel.js — 上下文用量 / 压缩预览面板
(function () {
  'use strict';
  const BubaiCodeUI = (window.BubaiCodeUI = window.BubaiCodeUI || {});
  const ipcInvoke = BubaiCodeUI.ipcInvoke, escapeHtml = BubaiCodeUI.escapeHtml, toast = BubaiCodeUI.toast;
  const CTX_SOFT_LIMIT = 128000; // 进度条满刻度（可按真实窗口调整）
  let panelEl = null, built = false;

  // token 估算：前端近似（没有服务端 tokenizer）。
  // 经验值：CJK（中/日/韩）约 1 字 ≈ 1 token；其余（英文/代码）约 4 字符 ≈ 1 token。
  // 比统一「字符/4」贴近真实——中文为主的工程原来会低估约 4 倍。
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g;
  function estimateTokensFromState() {
    let chars = 0, cjk = 0;
    const add = (s) => {
      if (!s) return;
      chars += s.length;
      const m = s.match(CJK_RE);
      if (m) cjk += m.length;
    };
    if (state && state.files) for (const k in state.files) { const f = state.files[k]; if (f && typeof f.content === 'string') add(f.content); }
    if (state && state.editor && typeof state.editor.getValue === 'function') {
      const v = state.editor.getValue() || '';
      if (!(state.activeTab && state.files[state.activeTab])) add(v);
    }
    return { chars, tokens: Math.round(cjk + (chars - cjk) / 4) };
  }

  function buildPanel() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || built) return;
    panelEl = document.createElement('div');
    panelEl.id = 'context-panel'; panelEl.className = 'context-panel'; panelEl.style.display = 'none';
    panelEl.innerHTML = `
      <div class="sidebar-header">
        <span>上下文用量</span>
        <div class="sidebar-actions">
          <button class="icon-btn" id="ctx-refresh" title="刷新估算"><svg class="icon"><use href="#icon-refresh"></use></svg></button>
        </div>
      </div>
      <div class="ctx-body">
        <div class="ctx-card">
          <div class="ctx-stat"><span class="ctx-stat-label">估算 Token</span><span class="ctx-stat-value" id="ctx-tokens">0</span></div>
          <div class="ctx-stat-sub" id="ctx-chars">字符：0</div>
          <div class="ctx-bar"><div class="ctx-bar-fill" id="ctx-bar-fill"></div></div>
          <div class="ctx-note">前端近似估算（字符/4）。<span class="ctx-flag">估算</span></div>
        </div>
        <div class="ctx-section">
          <button class="btn btn-secondary btn-sm btn-full" id="ctx-compact-btn">
            <svg class="icon icon-xs"><use href="#icon-arrow-counter-clockwise"></use></svg> 压缩预览
          </button>
          <div class="ctx-hint">点击查看将被压缩 / 剪裁的内容预览（依赖 app.js 代理实现）。</div>
        </div>
        <div class="ctx-preview" id="ctx-preview" style="display:none;">
          <div class="ctx-preview-header">压缩预览</div>
          <div class="ctx-preview-body" id="ctx-preview-body"></div>
        </div>
      </div>`;
    sidebar.appendChild(panelEl);
    panelEl.querySelector('#ctx-refresh').addEventListener('click', refreshContextPanel);
    panelEl.querySelector('#ctx-compact-btn').addEventListener('click', openCompactPreview);
    built = true;
  }

  function refreshContextPanel() {
    if (!panelEl) buildPanel();
    const { chars, tokens } = estimateTokensFromState();
    const t = panelEl.querySelector('#ctx-tokens'), c = panelEl.querySelector('#ctx-chars'), f = panelEl.querySelector('#ctx-bar-fill');
    if (t) t.textContent = tokens.toLocaleString();
    if (c) c.textContent = '字符：' + chars.toLocaleString();
    if (f) { const pct = Math.min(100, Math.round((tokens / CTX_SOFT_LIMIT) * 100)); f.style.width = pct + '%'; f.classList.toggle('warn', pct >= 70); f.classList.toggle('danger', pct >= 90); }
  }

  // 压缩预览：优先 window.getCompactPreview / window.BubaiCode.getCompactPreview，回退 IPC context:compactPreview
  async function openCompactPreview() {
    const previewEl = panelEl.querySelector('#ctx-preview'), bodyEl = panelEl.querySelector('#ctx-preview-body');
    if (!previewEl || !bodyEl) return;
    previewEl.style.display = 'block'; bodyEl.innerHTML = '<div class="ctx-empty">正在获取压缩预览…</div>';
    try {
      let preview = null;
      if (typeof window.getCompactPreview === 'function') preview = await window.getCompactPreview();
      else if (window.BubaiCode && typeof window.BubaiCode.getCompactPreview === 'function') preview = await window.BubaiCode.getCompactPreview();
      else preview = await ipcInvoke('context:compactPreview');
      renderCompactPreview(preview, bodyEl);
    } catch (e) {
      bodyEl.innerHTML = '<div class="ctx-empty ctx-error">压缩预览尚未就绪（依赖 app.js/main 实现 context:compactPreview）：' + escapeHtml(e && e.message) + '</div>';
      toast('压缩预览未就绪（依赖其它代理实现）', 'warning');
    }
  }
  function renderCompactPreview(preview, bodyEl) {
    if (!preview) { bodyEl.innerHTML = '<div class="ctx-empty">暂无将被压缩的内容。</div>'; return; }
    let html = '';
    if (typeof preview === 'string') html = '<pre class="ctx-pre">' + escapeHtml(preview) + '</pre>';
    else {
      if (preview.summary) html += '<div class="ctx-summary">' + escapeHtml(preview.summary) + '</div>';
      if (Array.isArray(preview.kept)) { html += '<div class="ctx-group-title">保留（' + preview.kept.length + '）</div>' + preview.kept.map(x => '<div class="ctx-line">' + escapeHtml(typeof x === 'string' ? x : JSON.stringify(x)) + '</div>').join(''); }
      if (Array.isArray(preview.dropped)) { html += '<div class="ctx-group-title ctx-dropped-title">将被剪裁（' + preview.dropped.length + '）</div>' + preview.dropped.map(x => '<div class="ctx-line ctx-dropped">' + escapeHtml(typeof x === 'string' ? x : JSON.stringify(x)) + '</div>').join(''); }
    }
    bodyEl.innerHTML = html || '<div class="ctx-empty">无预览内容。</div>';
  }

  setInterval(function () { if (panelEl && panelEl.style.display !== 'none') refreshContextPanel(); }, 2000);
  BubaiCodeUI.refreshContextPanel = refreshContextPanel;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel); else buildPanel();
})();

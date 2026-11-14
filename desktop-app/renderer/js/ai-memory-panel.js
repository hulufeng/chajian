// 记忆库侧栏（列出 / 删除长期记忆，对齐参考基线 memory）
// 复用现有 state.memories + saveMemoriesToDisk（后端 remember/forget 工具已存在）。
(function () {
  function S() { return window.BubaiCodeUI && window.BubaiCodeUI.state; }
  var panel = null, listEl = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    if (panel) return;
    var top = document.querySelector('.ai-top-right');
    if (top) {
      var btn = document.createElement('button');
      btn.className = 'ai-top-btn';
      btn.id = 'ai-memory-btn';
      btn.title = '记忆库（长期记忆）';
      btn.innerHTML = '<svg class="icon"><use href="#icon-sparkles"></use></svg>';
      top.appendChild(btn);
      btn.addEventListener('click', toggle);
    }
    var aiPanel = document.getElementById('ai-panel');
    panel = document.createElement('div');
    panel.className = 'ai-side-panel';
    panel.id = 'ai-memory-panel';
    panel.style.display = 'none';
    panel.innerHTML =
      '<div class="ai-side-header"><span>记忆库</span>' +
      '<div class="ai-side-actions">' +
      '<button class="icon-btn" id="ai-memory-refresh" title="刷新">⟳</button>' +
      '<button class="icon-btn" id="ai-memory-close" title="关闭">×</button></div></div>' +
      '<div class="ai-memory-list" id="ai-memory-list"></div>';
    if (aiPanel) aiPanel.appendChild(panel);
    listEl = panel.querySelector('#ai-memory-list');
    panel.querySelector('#ai-memory-close').addEventListener('click', function () { panel.style.display = 'none'; });
    panel.querySelector('#ai-memory-refresh').addEventListener('click', render);
  }

  function render() {
    if (!listEl) return;
    var st = S();
    var mem = (st && st.memories) || [];
    if (!mem.length) {
      listEl.innerHTML = '<div class="ai-memory-empty">暂无记忆。可在对话中让 AI 用 remember 保存用户偏好、项目事实等。</div>';
      return;
    }
    listEl.innerHTML = mem.map(function (m, i) {
      var content = String(m.content || '');
      var snippet = content.length > 200 ? content.slice(0, 200) + '…' : content;
      return '<div class="ai-memory-item" data-i="' + i + '">' +
        '<div class="ai-memory-name">' + escapeHtml(m.name || '未命名') +
        ' <span class="ai-memory-type">' + escapeHtml(m.type || '') + '</span></div>' +
        '<div class="ai-memory-content">' + escapeHtml(snippet) + '</div>' +
        '<button class="ai-memory-del" data-i="' + i + '" title="删除">删除</button></div>';
    }).join('');
    listEl.querySelectorAll('.ai-memory-del').forEach(function (b) {
      b.addEventListener('click', function () {
        var idx = parseInt(b.dataset.i, 10);
        var st2 = S();
        if (!st2 || !st2.memories) return;
        var name = st2.memories[idx] && st2.memories[idx].name;
        st2.memories.splice(idx, 1);
        if (typeof saveMemoriesToDisk === 'function') saveMemoriesToDisk(st2.memories);
        if (st2.onMemoryChange) st2.onMemoryChange();
        render();
        if (window.showToast) window.showToast('已删除记忆：' + (name || ''), 'success');
      });
    });
  }

  function toggle() {
    build();
    if (!panel) return;
    var show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    if (show) render();
  }

  function init() {
    build();
    var st = S();
    if (st) st.onMemoryChange = function () { if (panel && panel.style.display !== 'none') render(); };
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

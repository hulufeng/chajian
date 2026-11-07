// 批量 rewind 控制条（变更批次历史 + 恢复至此 / 截断此后，对齐 ChipCode rewindCode）
// 复用现有 fileChangeTracker（undoLastTurn 已具备安全回滚：不覆盖用户改动）。
(function () {
  var bar = null;

  function tracker() {
    var ui = window.BubaiCodeUI || {};
    if (!ui.fileTracker && typeof fileChangeTracker !== 'undefined') ui.fileTracker = fileChangeTracker;
    return ui.fileTracker;
  }

  function allBatches() {
    var t = tracker();
    if (!t) return [];
    var batches = [];
    ['default', 'stream'].forEach(function (sid) {
      var h = t.getTurnHistory(sid);
      (h || []).forEach(function (b) { batches.push(Object.assign({ session: sid }, b)); });
    });
    batches.sort(function (a, b) { return b.turn - a.turn; });
    return batches;
  }

  function build() {
    if (bar) return;
    var aiPanel = document.getElementById('ai-panel');
    if (!aiPanel) return;
    bar = document.createElement('div');
    bar.className = 'ai-rewind-bar';
    bar.id = 'ai-rewind-bar';
    bar.style.display = 'none';
    var msgs = aiPanel.querySelector('.ai-messages');
    if (msgs) aiPanel.insertBefore(bar, msgs);
    else aiPanel.appendChild(bar);
    render();
  }

  function render() {
    if (!bar) return;
    var batches = allBatches();
    if (!batches.length) {
      bar.innerHTML = '<span class="ai-rewind-empty">暂无文件变更批次</span>';
      return;
    }
    var html = '<div class="ai-rewind-title">变更批次（时间旅行）</div><div class="ai-rewind-list">';
    batches.forEach(function (b) {
      var files = (b.files || []).map(function (f) { return f.path.split(/[\\/]/).pop(); }).join(', ');
      html += '<div class="ai-rewind-item" data-turn="' + b.turn + '">' +
        '<span class="ai-rewind-turn"># ' + b.turn + '</span>' +
        '<span class="ai-rewind-info">' + b.changeCount + ' 项 · ' + (b.session === 'stream' ? '流式' : '工具') + ' · ' + escapeHtml(files) + '</span>' +
        '<span class="ai-rewind-actions">' +
        '<button class="ai-rewind-keep" data-turn="' + b.turn + '">恢复至此</button>' +
        '<button class="ai-rewind-trunc" data-turn="' + b.turn + '">截断此后</button>' +
        '</span></div>';
    });
    html += '</div>';
    bar.innerHTML = html;
    bar.querySelectorAll('.ai-rewind-keep').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var turn = parseInt(btn.dataset.turn, 10);
        var t = tracker();
        if (t && t.keepBatchesUpTo) {
          t.keepBatchesUpTo(turn).then(function (r) {
            if (window.showToast) window.showToast('已恢复到第 ' + turn + ' 批（' + (r.rolledBack || 0) + ' 项回滚）', 'success');
            render();
          });
        }
      });
    });
    bar.querySelectorAll('.ai-rewind-trunc').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var turn = parseInt(btn.dataset.turn, 10);
        var t = tracker();
        if (t && t.truncateBatches) t.truncateBatches(turn);
        if (window.showToast) window.showToast('已截断第 ' + turn + ' 批之后的历史', 'success');
        render();
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toggle() {
    build();
    if (!bar) return;
    var show = bar.style.display === 'none';
    bar.style.display = show ? 'block' : 'none';
    if (show) render();
  }

  function init() {
    var top = document.querySelector('.ai-top-right');
    if (top) {
      var btn = document.createElement('button');
      btn.className = 'ai-top-btn';
      btn.id = 'ai-rewind-btn';
      btn.title = '变更批次 / 时间旅行';
      btn.innerHTML = '<svg class="icon"><use href="#icon-arrow-counter-clockwise"></use></svg>';
      top.appendChild(btn);
      btn.addEventListener('click', toggle);
    }
    build();
  }

  window.BubaiCodeUI = window.BubaiCodeUI || {};
  window.BubaiCodeUI.toggleRewindBar = toggle;
  window.BubaiCodeUI.renderRewindBar = render;
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

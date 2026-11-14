// git-review.js —— 审阅本轮 AI 改动（对齐参考基线 git:review / git:applyAndStage）
// 由渲染层从 window.BubaiCodeUI.fileTracker 取本轮 AI 文件变更，交给主进程拆 hunk，
// 用户逐 hunk 接受/拒绝后，主进程回写磁盘并 git add 暂存。
(function () {
  'use strict';

  const DIFF_ADD = '#2ea043';
  const DIFF_DEL = '#f85149';
  const DIFF_CTX = 'var(--text-secondary)';

  function getCwd() {
    try { return (state && state.projectPath) || null; } catch (e) { return null; }
  }

  // 从 FileChangeTracker 收集本轮 AI 改动（合并 default/stream 两个会话、未回滚的变更，按路径去重）
  function collectAiChanges() {
    const ft = window.BubaiCodeUI && window.BubaiCodeUI.fileTracker;
    if (!ft || !ft.turns || typeof ft.turns.get !== 'function') return [];
    const out = new Map();
    for (const sid of ['default', 'stream']) {
      const arr = ft.turns.get(sid);
      if (!arr || !arr.length) continue;
      for (const t of arr) {
        if (!t || t.rolledBack || !t.changes) continue;
        for (const ch of t.changes) {
          if (!ch || !ch.path) continue;
          out.set(ch.path, {
            path: ch.path,
            before: ch.before == null ? null : ch.before,
            after: ch.after == null ? null : ch.after,
            action: ch.action || 'modify'
          });
        }
      }
    }
    return Array.from(out.values());
  }

  const _state = { review: null, decisions: {} /* relPath#hunkIndex -> 'keep'|'reject'；create/delete 无 hunk 时用 relPath#all */ };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type); else console.log('[git-review] ' + msg);
  }
  function refreshStatus() {
    if (typeof window.appRefreshGitStatus === 'function') window.appRefreshGitStatus();
    else if (typeof refreshGitStatus === 'function') refreshGitStatus();
  }

  function openPanel() {
    const panel = document.getElementById('git-review-panel');
    if (panel) panel.style.display = 'block';
    loadReview();
  }
  function closePanel() {
    const panel = document.getElementById('git-review-panel');
    if (panel) panel.style.display = 'none';
    _state.review = null; _state.decisions = {};
    const list = document.getElementById('git-review-list');
    if (list) list.innerHTML = '';
  }

  async function loadReview() {
    const cwd = getCwd();
    const list = document.getElementById('git-review-list');
    if (!cwd) { if (list) list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">未选择项目</div>'; return; }
    if (list) list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">加载中…</div>';
    const changes = collectAiChanges();
    let res;
    try {
      res = await window.BubaiCode.git.review(cwd, 'default', { changes });
    } catch (e) {
      if (list) list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">审阅失败：' + escapeHtml((e && e.message) || e) + '</div>';
      return;
    }
    if (!res || !res.ok) {
      if (list) list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">审阅失败：' + escapeHtml((res && res.error) || '未知错误') + '</div>';
      return;
    }
    _state.review = res.review;
    _state.decisions = {};
    renderReview(res.review);
  }

  function renderReview(review) {
    const list = document.getElementById('git-review-list');
    if (!list) return;
    list.innerHTML = '';
    const files = (review && review.files) || [];
    if (!files.length) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">本轮没有检测到 AI 文件改动。</div>';
      return;
    }
    for (const f of files) {
      const fileEl = document.createElement('div');
      fileEl.style.cssText = 'border:1px solid var(--border-color);border-radius:6px;overflow:hidden;';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-secondary);font-size:11.5px;';
      const actionLabel = { create: '新建', modify: '修改', delete: '删除' }[f.action] || f.action;
      head.innerHTML = '<span style="font-weight:600;color:var(--text-primary);word-break:break-all;">' + escapeHtml(f.relPath) + '</span>' +
        '<span style="flex:0 0 auto;margin-left:8px;color:var(--text-tertiary);white-space:nowrap;">' + actionLabel +
        (f.addLines ? ' +' + f.addLines : '') + (f.delLines ? ' -' + f.delLines : '') + '</span>';
      fileEl.appendChild(head);

      const hunks = f.hunks || [];
      if (!hunks.length) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:6px 8px;font-size:11px;color:var(--text-tertiary);';
        note.textContent = f.binary ? '二进制文件，无法逐行审阅。' : (f.action === 'create' ? '整个文件为新增内容（默认保留）。' : '无差异。');
        fileEl.appendChild(note);
        if (f.action === 'create' || f.action === 'delete') fileEl.appendChild(buildFileToggle(f.relPath));
      } else {
        for (const h of hunks) fileEl.appendChild(buildHunk(f.relPath, h));
      }
      list.appendChild(fileEl);
    }
  }

  function buildHunk(relPath, hunk) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'border-top:1px solid var(--border-color);';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 8px;font-size:10.5px;color:var(--text-tertiary);background:rgba(255,255,255,0.02);';
    const title = document.createElement('span');
    title.textContent = (hunk.header || ('@@ hunk ' + hunk.hunkIndex + ' @@'));
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-secondary btn-sm';
    toggle.style.cssText = 'font-size:10.5px;padding:1px 8px;';
    const key = relPath + '#' + hunk.hunkIndex;
    if (!_state.decisions[key]) _state.decisions[key] = 'keep';
    const setLbl = () => { toggle.textContent = _state.decisions[key] === 'keep' ? '保留' : '拒绝'; toggle.style.opacity = _state.decisions[key] === 'keep' ? '1' : '0.7'; };
    setLbl();
    toggle.addEventListener('click', () => { _state.decisions[key] = _state.decisions[key] === 'keep' ? 'reject' : 'keep'; setLbl(); });
    bar.appendChild(title); bar.appendChild(toggle);
    wrap.appendChild(bar);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:4px 8px;font-size:11px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;';
    for (const ln of (hunk.lines || [])) {
      const line = document.createElement('div');
      let color = DIFF_CTX, prefix = ' ';
      if (ln.type === 'add') { color = DIFF_ADD; prefix = '+'; }
      else if (ln.type === 'del') { color = DIFF_DEL; prefix = '-'; }
      line.style.color = color;
      line.textContent = prefix + (ln.text === undefined ? '' : ln.text);
      pre.appendChild(line);
    }
    wrap.appendChild(pre);
    return wrap;
  }

  // 针对 create/delete 单文件级（无 hunk）的整体接受/拒绝开关
  function buildFileToggle(relPath) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;padding:3px 8px;border-top:1px solid var(--border-color);';
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-secondary btn-sm';
    toggle.style.cssText = 'font-size:10.5px;padding:1px 8px;';
    const key = relPath + '#all';
    if (!_state.decisions[key]) _state.decisions[key] = 'keep';
    const setLbl = () => { toggle.textContent = _state.decisions[key] === 'keep' ? '保留' : '拒绝'; };
    setLbl();
    toggle.addEventListener('click', () => { _state.decisions[key] = _state.decisions[key] === 'keep' ? 'reject' : 'keep'; setLbl(); });
    bar.appendChild(toggle);
    return bar;
  }

  function getDecisions() {
    const review = _state.review;
    if (!review) return [];
    const out = [];
    for (const f of (review.files || [])) {
      const hunks = f.hunks || [];
      if (hunks.length) {
        for (const h of hunks) {
          const key = f.relPath + '#' + h.hunkIndex;
          if (_state.decisions[key] === 'reject') out.push({ file: f.relPath, hunkIndex: h.hunkIndex, action: 'reject' });
        }
      } else if (f.action === 'create' || f.action === 'delete') {
        const key = f.relPath + '#all';
        if (_state.decisions[key] === 'reject') out.push({ file: f.relPath, hunkIndex: -1, action: 'reject' });
      }
    }
    return out;
  }

  async function applyReview() {
    const cwd = getCwd();
    if (!cwd || !_state.review) { toast('请先加载审阅', 'warn'); return; }
    const decisions = getDecisions();
    const btn = document.getElementById('git-review-apply');
    if (btn) btn.disabled = true;
    try {
      const res = await window.BubaiCode.git.reviewApply(cwd, decisions, {});
      if (res && res.ok) {
        let msg = '已应用 ' + (res.applied ? res.applied.length : 0) + ' 个文件，暂存 ' + (res.staged ? res.staged.length : 0) + ' 个。';
        if (res.skipped && res.skipped.length) msg += ' 跳过 ' + res.skipped.length + ' 个（磁盘已变更）。';
        toast(msg, 'success');
        refreshStatus();
        closePanel();
      } else {
        toast('应用失败：' + ((res && res.error) || '未知'), 'error');
      }
    } catch (e) {
      toast('应用异常：' + ((e && e.message) || e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function setAll(decision) {
    for (const k in _state.decisions) _state.decisions[k] = decision;
    if (_state.review) renderReview(_state.review);
  }

  function init() {
    const btn = document.getElementById('git-review-btn');
    if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', openPanel); }
    const keepAll = document.getElementById('git-review-keep-all');
    if (keepAll && !keepAll._wired) { keepAll._wired = true; keepAll.addEventListener('click', () => setAll('keep')); }
    const rejectAll = document.getElementById('git-review-reject-all');
    if (rejectAll && !rejectAll._wired) { rejectAll._wired = true; rejectAll.addEventListener('click', () => setAll('reject')); }
    const apply = document.getElementById('git-review-apply');
    if (apply && !apply._wired) { apply._wired = true; apply.addEventListener('click', applyReview); }
    const close = document.getElementById('git-review-close');
    if (close && !close._wired) { close._wired = true; close.addEventListener('click', closePanel); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

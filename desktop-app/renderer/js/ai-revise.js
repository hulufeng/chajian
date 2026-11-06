// Phase B · revise：气泡级「编辑并从这条重来」（对齐 ChipCode reviseSession / 从某条消息分叉）
// 复用既有但未接线的 .ai-message-actions / .ai-message-action-btn 样式。
// 设计：截断由 SessionStore.truncateAt 统一完成（store / _chatLog / agent.messages / DOM 四处同步），
// 再把原文放进输入框由用户编辑后正常发送 —— 不侵入 handleAISend。
(function () {
  function area() { return document.getElementById('ai-chat-area'); }

  function decorate(msg) {
    if (!msg || msg.querySelector('.ai-message-actions')) return;
    var acts = document.createElement('div');
    acts.className = 'ai-message-actions';
    acts.innerHTML =
      '<button class="ai-message-action-btn" data-revise-act="edit" title="编辑这条消息并从这里重来">编辑重来</button>' +
      '<button class="ai-message-action-btn" data-revise-act="copy" title="复制内容">复制</button>';
    msg.appendChild(acts);
  }

  function scan() {
    var a = area();
    if (!a) return;
    Array.prototype.forEach.call(a.querySelectorAll('.chat-message'), decorate);
  }

  function textOf(msg) {
    var b = msg.querySelector('.chat-bubble');
    return b ? (b.innerText || b.textContent || '') : '';
  }

  function init() {
    var a = area();
    if (!a) return;
    scan();
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { scan(); });
      mo.observe(a, { childList: true, subtree: false });
    }
    a.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.ai-message-action-btn') : null;
      if (!btn) return;
      var msg = btn.closest ? btn.closest('.chat-message') : null;
      if (!msg) return;
      var text = textOf(msg);
      var act = btn.getAttribute('data-revise-act');
      if (act === 'copy') {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            if (window.showToast) window.showToast('已复制消息', 'success');
          }).catch(function () {});
        }
        return;
      }
      if (act !== 'edit') return;
      var nodes = Array.prototype.slice.call(a.querySelectorAll('.chat-message'));
      var seq = nodes.indexOf(msg);
      if (seq < 0) return;
      if (window.SessionStore && typeof window.SessionStore.truncateAt === 'function') {
        window.SessionStore.truncateAt(seq);
      } else {
        // 降级：无 store 时至少同步可见日志与 DOM
        nodes.slice(seq).forEach(function (n) { n.remove(); });
        if (window._chatLog) window._chatLog = window._chatLog.slice(0, seq);
      }
      var input = document.getElementById('ai-input');
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
          try { input.setSelectionRange(text.length, text.length); } catch (err) {}
        }
      }
      if (window.showToast) window.showToast('已回退到第 ' + (seq + 1) + ' 条，编辑后发送即从此分叉', 'info');
    });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

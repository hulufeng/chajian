// 助手消息操作条：复制 / 重新生成 / 删除（对齐 ChipCode .chat-ai-actions）
// 消息 DOM 由 app.js addChatMessage 构建，这里只做事件代理与截断/删除动作。
(function () {
  function area() { return document.getElementById('ai-chat-area'); }

  function bubbleText(node) {
    if (!node) return '';
    var b = node.querySelector('.chat-bubble');
    return b ? (b.innerText || b.textContent || '') : '';
  }

  function handleAct(btn) {
    var msg = btn.closest ? btn.closest('.chat-message') : null;
    var a = area();
    if (!msg || !a) return;
    var act = btn.getAttribute('data-act');
    var nodes = Array.prototype.slice.call(a.querySelectorAll('.chat-message'));
    var seq = nodes.indexOf(msg);
    if (seq < 0) return;

    if (act === 'copy') {
      var text = bubbleText(msg);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          if (window.showToast) window.showToast('已复制消息', 'success');
        }).catch(function () {});
      }
      return;
    }

    if (act === 'delete') {
      if (window.SessionStore && typeof window.SessionStore.deleteAt === 'function') {
        window.SessionStore.deleteAt(seq);
      } else {
        nodes[seq].remove();
        if (window._chatLog && seq < window._chatLog.length) window._chatLog.splice(seq, 1);
      }
      if (window.showToast) window.showToast('已删除该消息', 'info');
      return;
    }

    if (act === 'retry') {
      // 重新生成：回退到本条之前的最后一条用户提问，重填输入框并重新发送
      var prevSeq = -1;
      for (var i = seq - 1; i >= 0; i--) { if (nodes[i].classList.contains('user')) { prevSeq = i; break; } }
      if (prevSeq < 0) { if (window.showToast) window.showToast('没有可重发的提问', 'warn'); return; }
      var text = bubbleText(nodes[prevSeq]);
      if (window.SessionStore && typeof window.SessionStore.truncateAt === 'function') {
        window.SessionStore.truncateAt(prevSeq);
      } else {
        for (var j = prevSeq; j < nodes.length; j++) nodes[j].remove();
        if (window._chatLog) window._chatLog = window._chatLog.slice(0, prevSeq);
      }
      var input = document.getElementById('ai-input');
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var send = document.getElementById('ai-send-btn');
      if (send) send.click();
      return;
    }
  }

  function init() {
    var a = area();
    if (!a || a.__chatActsWired) return;
    a.__chatActsWired = true;
    a.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.chat-ai-act') : null;
      if (btn) handleAct(btn);
    });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

// ghost-completion.js — Monaco ghost 内联补全（对齐参考基线 ai:getCompletion）
(function () {
  'use strict';
  const BubaiCodeUI = (window.BubaiCodeUI = window.BubaiCodeUI || {});
  const ipcInvoke = BubaiCodeUI.ipcInvoke;
  const DEBOUNCE_MS = 350, MIN_PREFIX = 3;
  let registered = false, seq = 0, lastInvokeAt = 0;

  function getMonaco() { if (state && state.monaco) return state.monaco; if (typeof monaco !== 'undefined' && monaco && monaco.languages) return monaco; return null; }

  function setup() {
    const m = getMonaco();
    if (!m || registered || !(state && state.editor)) return;
    registered = true;
    m.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      provideInlineCompletions: async function (model, position, context, token) {
        // 实时读取设置（开启开关 / 触发延迟），无需重启
        const ui = (window.BubaiCodeUI = window.BubaiCodeUI || {});
        const enabled = (ui.completionEnabled === undefined ? true : ui.completionEnabled);
        if (!enabled) return { items: [] };
        const DEB = (ui.completionDelay || DEBOUNCE_MS);
        const mySeq = ++seq, now = Date.now();
        if (now - lastInvokeAt < DEB) return { items: [] };
        if (token.isCancellationRequested) return { items: [] };
        const prefix = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
        const suffix = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) });
        if (!prefix || prefix.trim().length < MIN_PREFIX) return { items: [] };
        lastInvokeAt = now;
        try {
          const res = await ipcInvoke('ai:getCompletion', { prefix, suffix, language: model.getLanguageId(), line: position.lineNumber, column: position.column });
          if (mySeq !== seq || token.isCancellationRequested) return { items: [] };
          const text = res && (res.completion || res.text || res.insertText);
          if (!text || !String(text).trim()) return { items: [] };
          return { items: [{ insertText: String(text), range: new m.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
        } catch (e) { if (mySeq === seq) console.warn('[ghost] ai:getCompletion 调用失败:', e && e.message); return { items: [] }; }
      },
      freeInlineCompletions: function () {}
    });
    console.log('[ghost] Monaco 内联补全 provider 已注册');
  }
  function waitForMonaco() { if (getMonaco() && state && state.editor) { setup(); return; } setTimeout(waitForMonaco, 500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForMonaco); else waitForMonaco();
})();

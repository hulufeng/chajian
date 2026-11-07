// ipc-bridge.js — 渲染层统一 IPC invoke 封装 + 面板互斥隐藏
(function () {
  'use strict';
  const BubaiCodeUI = (window.BubaiCodeUI = window.BubaiCodeUI || {});

  // 约定 channel（由 main/index.js 实现）：schedule:* / ai:getCompletion / context:*
  BubaiCodeUI.ipcInvoke = function ipcInvoke(channel, payload) {
    if (window.BubaiCode && window.BubaiCode.ipc && typeof window.BubaiCode.ipc.invoke === 'function') {
      return Promise.resolve(window.BubaiCode.ipc.invoke(channel, payload));
    }
    try {
      if (typeof require === 'function') {
        const electron = require('electron');
        if (electron && electron.ipcRenderer) {
          return electron.ipcRenderer.invoke(channel, payload);
        }
      }
    } catch (e) {
      console.warn('[ipc-bridge] require("electron").ipcRenderer 不可用:', e && e.message);
    }
    return Promise.reject(new Error('[ipc-bridge] 无可用 IPC 通道，需 main 实现 channel: ' + channel));
  };

  BubaiCodeUI.toast = function (msg, type) {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    console.log('[BubaiCodeUI]', type || 'info', msg);
  };
  BubaiCodeUI.escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // 活动栏切换时，隐藏本模块新增面板（app.js 的其它分支未显式隐藏它们）
  document.querySelectorAll('.activity-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const p = btn.dataset.panel;
      const cp = document.getElementById('context-panel');
      const sp = document.getElementById('schedule-panel');
      if (p !== 'context' && cp) cp.style.display = 'none';
      if (p !== 'schedule' && sp) sp.style.display = 'none';
    });
  });
})();

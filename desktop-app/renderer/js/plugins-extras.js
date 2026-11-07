// ============================================================
// 插件管理增强（对齐 ChipCode plugins:* 主进程通道的渲染层桥接）
// ------------------------------------------------------------
// 主进程现提供 plugins:* 通道（list/getManifest/getSettings/setSettings/setActive/
// uninstall/installFromPath/retryDeps/marketList/marketInstall）并广播 plugins:changed
// 与 plugins:installProgress。本文件负责：
//  1) 暴露 window.LabCodePluginsExtras 统一 API 给 UI / AI agent 调用；
//  2) 监听主进程 changed 推送 → 重载渲染层 PluginSystem 注册表 + 刷新面板；
//  3) 监听 installProgress 推送 → 复用现有安装进度条；
//  4) 在插件面板头部注入「重试全部依赖」按钮（无依赖时不报错）。
// 现有渲染层 PluginSystem 的安装/卸载/启停 UI 保持不变，本文件只做增量对齐。
// ============================================================
(function () {
  if (!window.LabCode) window.LabCode = {};

  const PluginsExtras = {
    list: () => (window.LabCode.plugins ? window.LabCode.plugins.list() : Promise.resolve([])),
    getManifest: (id) => (window.LabCode.plugins ? window.LabCode.plugins.getManifest(id) : Promise.resolve({ ok: false })),
    getSettings: (id) => (window.LabCode.plugins ? window.LabCode.plugins.getSettings(id) : Promise.resolve({ ok: true, settings: {} })),
    setSettings: (id, s) => (window.LabCode.plugins ? window.LabCode.plugins.setSettings(id, s) : Promise.resolve({ ok: false })),
    setActive: (id, active) => (window.LabCode.plugins ? window.LabCode.plugins.setActive(id, active) : Promise.resolve({ ok: false })),
    uninstall: (id) => (window.LabCode.plugins ? window.LabCode.plugins.uninstall(id) : Promise.resolve({ ok: false })),
    installFromPath: (dir) => (window.LabCode.plugins ? window.LabCode.plugins.installFromPath(dir) : Promise.resolve({ ok: false })),
    retryDeps: (id) => (window.LabCode.plugins ? window.LabCode.plugins.retryDeps(id) : Promise.resolve({ ok: false })),
    marketList: () => (window.LabCode.plugins ? window.LabCode.plugins.marketList() : Promise.resolve({ ok: true, plugins: [] })),
    marketInstall: (id) => (window.LabCode.plugins ? window.LabCode.plugins.marketInstall(id) : Promise.resolve({ ok: false }))
  };
  window.LabCodePluginsExtras = PluginsExtras;

  // 主进程 plugins:* 变更广播 → 渲染层注册表重载（对齐 TrieCode：主进程装/卸/启停后推送 changed）
  async function reconcilePlugins(changed) {
    const PS = window.PluginSystem;
    if (!PS) return;
    try { if (PS.loadPluginStates) await PS.loadPluginStates(); } catch (e) {}
    try {
      const root = PS.getPluginsRoot ? await PS.getPluginsRoot() : '';
      if (root && PS.loadPluginsFromDir) await PS.loadPluginsFromDir(root);
    } catch (e) {}
    // 处理 removed：主进程已删磁盘，渲染层只清注册表（PluginSystem.uninstall 在磁盘缺失时只清注册表）
    try {
      const removed = (changed && changed.removed) || [];
      const installed = PS.listPlugins ? PS.listPlugins().map(p => p.id) : [];
      removed.forEach(id => { if (id && installed.indexOf(id) >= 0 && PS.uninstall) PS.uninstall(id); });
    } catch (e) {}
    // 通知现有插件面板刷新（优先全局刷新函数，否则派发既有事件）
    try { if (typeof window.renderPluginsList === 'function') window.renderPluginsList(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('labcode:plugins-changed')); } catch (e) {}
  }

  if (window.LabCode && window.LabCode.plugins && window.LabCode.plugins.onChanged) {
    window.LabCode.plugins.onChanged(reconcilePlugins);
  }
  if (window.LabCode && window.LabCode.plugins && window.LabCode.plugins.onInstallProgress) {
    window.LabCode.plugins.onInstallProgress((p) => {
      try {
        if (typeof window.setInstallProgress === 'function' && p && typeof p.percent === 'number') {
          window.setInstallProgress(p.percent, (p.name || '') + ' ' + (p.phase || ''));
        }
      } catch (e) {}
    });
  }

  // 在插件面板头部注入「重试全部依赖」按钮（稳定锚点 #plugins-panel .sidebar-actions）
  function injectRetryButton() {
    const actions = document.querySelector('#plugins-panel .sidebar-actions');
    if (!actions || document.getElementById('plugins-retry-deps')) return;
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.id = 'plugins-retry-deps';
    btn.title = '重试全部插件依赖';
    btn.textContent = '↻';
    btn.addEventListener('click', async () => {
      let list = [];
      try { list = await PluginsExtras.list(); } catch (e) { list = []; }
      if (!Array.isArray(list) || !list.length) {
        if (typeof window.showToast === 'function') window.showToast('没有已安装插件', 'info');
        return;
      }
      let ok = 0, fail = 0;
      for (const p of list) {
        try { const r = await PluginsExtras.retryDeps(p.id); if (r && r.ok) ok++; else fail++; }
        catch (e) { fail++; }
      }
      if (typeof window.showToast === 'function') {
        window.showToast(fail ? ('依赖重试完成：' + ok + ' 成功，' + fail + ' 失败') : '全部插件依赖已就绪', fail ? 'warning' : 'success');
      }
    });
    actions.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectRetryButton);
  else injectRetryButton();
})();

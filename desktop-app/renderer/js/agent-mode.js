// ============ BubaiCode Agent 模式选择器（对齐参考基线 ai:setAgentMode）============
// 复用既有 UI：AI 面板顶部的 .safety-mode-btn 与底部的 .mode-btn（data-mode = auto|default|plan）。
// 本文件只负责把「模式选择」与 config.agentMode 打通：
//   ① 启动时从 config.agentMode 恢复当前选中态（覆盖默认 'default'）；
//   ② 切换时把选择持久化到 config.agentMode（经既有 config:set IPC，落盘 config.json）。
// 引擎（AgentRunner）已按 this.mode 区分 auto/plan/default 语义（PLAN 门控 / 自动执行 / 权限），
// 无需改动；主进程也无需新增 IPC —— 渲染层 state.mode 即可驱动引擎。
// 注意：本文件以经典 <script> 在 app.js 之后加载，可直接按名访问 app.js 暴露的
// 全局词法作用域符号（state / syncSafetyModeUI / MODE_DESC 等）。
(function () {
  'use strict';
  var VALID = ['auto', 'default', 'plan'];

  // 切换到合法模式时持久化（app.js 点击处理器与任何其它入口均可复用）
  window.__persistAgentMode = function (mode) {
    if (!mode || VALID.indexOf(mode) === -1) return;
    try {
      if (window.BubaiCode && window.BubaiCode.config) {
        window.BubaiCode.config.set('agentMode', mode);
      }
    } catch (e) { /* 持久化失败不阻塞切换，下次仍可手动重设 */ }
  };

  // 其它模块（如计划模式联动）读取当前模式
  window.__getAgentMode = function () {
    try { return (typeof state !== 'undefined' && state.mode) || 'default'; }
    catch (e) { return 'default'; }
  };

  // 启动时从 config.agentMode 恢复选中态
  async function restoreAgentMode() {
    try {
      if (!(window.BubaiCode && window.BubaiCode.config)) return;
      const cfg = await window.BubaiCode.config.get();
      const saved = cfg && cfg.agentMode;
      if (saved && VALID.indexOf(saved) !== -1) {
        if (typeof state !== 'undefined') {
          state.mode = saved;
          if (state.agent) state.agent.mode = saved;
        }
        if (typeof syncSafetyModeUI === 'function') syncSafetyModeUI();
      }
    } catch (e) { /* 读取失败则用默认 default，不阻塞启动 */ }
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreAgentMode);
  } else {
    restoreAgentMode();
  }
})();

// git-probe.js — Git 凭据连通性探测 UI
// 对齐 ChipCode git:probe 的「连接性预检」语义：在添加/选择 git 凭据后，或尝试 Issues/PR 前，
// 验证该 host 的 PAT 能否真正访问对应平台 API（GitHub / Gitee / GitLab 的 /user 端点）。
(function () {
  'use strict';

  function getCwd() {
    try { return (typeof state !== 'undefined' && state && state.projectPath) || null; }
    catch (e) { return null; }
  }

  function setStatus(msg, type) {
    const el = document.getElementById('git-probe-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = type === 'success' ? 'var(--accent, #2563eb)'
      : type === 'error' ? 'var(--danger, #e11d48)'
      : 'var(--text-tertiary)';
  }

  const btn = document.getElementById('git-probe-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cwd = getCwd();
      if (!cwd) {
        if (typeof showToast === 'function') showToast('未选择项目', 'warn');
        setStatus('未选择项目', 'error');
        return;
      }
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '测试中…';
      setStatus('正在探测凭据连通性…');
      try {
        const r = await window.LabCode.git.probe(cwd);
        if (r && r.connected) {
          const text = '✅ 已连接 ' + (r.provider || '') + '（@' + (r.user || '') + '）';
          if (typeof showToast === 'function') showToast(text, 'success');
          setStatus(text, 'success');
        } else if (r && r.error === 'no-credential') {
          const text = '❌ ' + (r.message || '未配置凭据');
          if (typeof showToast === 'function') showToast(text, 'error');
          setStatus(text, 'error');
        } else if (r && r.error === 'invalid-token') {
          const text = '❌ 凭据无效：' + (r.message || '401');
          if (typeof showToast === 'function') showToast(text, 'error');
          setStatus(text, 'error');
        } else if (r && r.error === 'no-permission') {
          const text = '❌ 权限不足：' + (r.message || '403');
          if (typeof showToast === 'function') showToast(text, 'error');
          setStatus(text, 'error');
        } else {
          const text = '❌ ' + (r && r.message ? r.message : '探测失败');
          if (typeof showToast === 'function') showToast(text, 'error');
          setStatus(text, 'error');
        }
      } catch (e) {
        const text = '❌ 探测异常：' + e.message;
        if (typeof showToast === 'function') showToast(text, 'error');
        setStatus(text, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  // 供设置→服务商凭据处调用：传入 host（如 github.com）直接探测，
  // 无需仓库 cwd（主进程会在无 cwd 时仅依赖 host 入参）。
  window.gitProbeByHost = async function (host) {
    try {
      const r = await window.LabCode.git.probe(null, host);
      return r || { ok: false, error: 'no-result', message: '无返回' };
    } catch (e) {
      return { ok: false, error: 'exception', message: e.message };
    }
  };
})();

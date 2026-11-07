// ===== Git 远程通道 UI（git:fetch / git:pullRebase / git:remoteStatus）=====
// 独立文件，避免与 app.js 等共享文件整文件覆盖冲突（对齐 chipcode-align 并行纪律）
(function () {
  'use strict';

  function getCwd() {
    try { return (typeof state !== 'undefined' && state && state.projectPath) || null; }
    catch (e) { return null; }
  }

  // 获取（fetch --all --prune）
  const fetchBtn = document.getElementById('git-fetch-btn');
  if (fetchBtn) fetchBtn.addEventListener('click', async () => {
    const cwd = getCwd();
    if (!cwd) { if (typeof showToast === 'function') showToast('未选择项目', 'warn'); return; }
    fetchBtn.disabled = true;
    const old = fetchBtn.textContent;
    fetchBtn.textContent = '获取中…';
    try {
      const r = await window.LabCode.git.fetch(cwd);
      if (r && r.ok) {
        if (typeof showToast === 'function') showToast('已获取（fetch --all --prune）', 'success');
        if (typeof refreshGitStatus === 'function') refreshGitStatus();
        else if (typeof window.renderGitRemoteStatus === 'function') window.renderGitRemoteStatus(cwd);
      } else {
        if (typeof showToast === 'function') showToast('获取失败: ' + ((r && r.error) || ''), 'error');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('获取异常: ' + e.message, 'error');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = old;
    }
  });

  // 拉取并变基（pull --rebase）
  const prBtn = document.getElementById('git-pull-rebase-btn');
  if (prBtn) prBtn.addEventListener('click', async () => {
    const cwd = getCwd();
    if (!cwd) { if (typeof showToast === 'function') showToast('未选择项目', 'warn'); return; }
    if (!confirm('拉取并变基（pull --rebase）会把本地提交重放到远程之后，如有冲突需手动解决。继续？')) return;
    prBtn.disabled = true;
    const old = prBtn.textContent;
    prBtn.textContent = '变基中…';
    try {
      const r = await window.LabCode.git.pullRebase(cwd);
      if (r && r.ok) {
        if (typeof showToast === 'function') showToast('已拉取并变基', 'success');
        if (typeof refreshGitStatus === 'function') refreshGitStatus();
      } else {
        const conflicts = (r && r.conflicts) || [];
        if ((r && r.conflict) || conflicts.length) {
          const list = conflicts.length ? '\n' + conflicts.join('\n') : '';
          if (typeof showToast === 'function') showToast('拉取变基出现冲突，请解决以下文件：' + list, 'error');
          if (typeof refreshGitStatus === 'function') refreshGitStatus();
        } else {
          if (typeof showToast === 'function') showToast('拉取变基失败: ' + ((r && r.error) || ''), 'error');
        }
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('拉取变基异常: ' + e.message, 'error');
    } finally {
      prBtn.disabled = false;
      prBtn.textContent = old;
    }
  });

  // 渲染远程状态：↑N ↓M → upstream（无 upstream 时隐藏）
  // 暴露到 window 供 app.js 的 refreshGitStatus 钩子调用
  window.renderGitRemoteStatus = async function (cwd) {
    const el = document.getElementById('git-remote-status');
    if (!el) return;
    if (!cwd) { el.style.display = 'none'; return; }
    try {
      const r = await window.LabCode.git.remoteStatus(cwd);
      if (!r || !r.ok || !r.upstream) { el.style.display = 'none'; return; }
      const ahead = r.ahead || 0;
      const behind = r.behind || 0;
      let txt = '';
      if (ahead > 0) txt += '↑' + ahead + ' ';
      if (behind > 0) txt += '↓' + behind + ' ';
      if (!txt.trim()) txt = '✓ 已同步 ';
      txt += '→ ' + r.upstream;
      if (r.remoteUrl) txt += '  (' + r.remoteUrl + ')';
      el.textContent = txt.trim();
      el.style.display = '';
    } catch (e) {
      el.style.display = 'none';
    }
  };
})();

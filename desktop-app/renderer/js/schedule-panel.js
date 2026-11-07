// schedule-panel.js — 定时任务面板（配合 main 的 schedule:* IPC）
(function () {
  'use strict';
  const BubaiCodeUI = (window.BubaiCodeUI = window.BubaiCodeUI || {});
  const ipcInvoke = BubaiCodeUI.ipcInvoke, escapeHtml = BubaiCodeUI.escapeHtml, toast = BubaiCodeUI.toast;
  let panelEl = null, built = false, editingId = null;

  function buildPanel() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || built) return;
    panelEl = document.createElement('div');
    panelEl.id = 'schedule-panel'; panelEl.className = 'schedule-panel'; panelEl.style.display = 'none';
    panelEl.innerHTML = `
      <div class="sidebar-header">
        <span>定时任务</span>
        <div class="sidebar-actions">
          <button class="icon-btn" id="sched-refresh" title="刷新"><svg class="icon"><use href="#icon-refresh"></use></svg></button>
          <button class="icon-btn" id="sched-new" title="新建任务"><svg class="icon"><use href="#icon-plus"></use></svg></button>
        </div>
      </div>
      <div class="sched-status" id="sched-status">状态：加载中…</div>
      <div class="sched-form" id="sched-form" style="display:none;">
        <div class="sched-field"><label>名称</label>
          <input id="sched-name" type="text" placeholder="任务名称（可选）" /></div>
        <div class="sched-field"><label>类型</label>
          <select id="sched-type"><option value="cron">Cron</option><option value="interval">Interval</option></select></div>
        <div class="sched-field"><label>执行类型</label>
          <select id="sched-mode">
            <option value="chat">AI 对话</option>
            <option value="workflow">触发工作流</option>
          </select></div>
        <div class="sched-field"><label id="sched-expr-label">Cron 表达式</label>
          <input id="sched-expr" type="text" placeholder="*/5 * * * *" /></div>
        <div class="sched-field"><label>Prompt / 附加指令</label>
          <textarea id="sched-prompt" rows="3" placeholder="定时执行的指令（工作流模式作为附加指令）…"></textarea></div>
        <div class="sched-form-actions">
          <button class="btn btn-primary btn-sm" id="sched-create">创建</button>
          <button class="btn btn-secondary btn-sm" id="sched-cancel">取消</button></div>
      </div>
      <div class="sched-list" id="sched-list"><div class="sched-empty">暂无定时任务</div></div>
      <div class="sched-detail" id="sched-detail" style="display:none;"></div>`;
    sidebar.appendChild(panelEl);
    panelEl.querySelector('#sched-refresh').addEventListener('click', refreshSchedulePanel);
    panelEl.querySelector('#sched-new').addEventListener('click', () => openForm(null));
    panelEl.querySelector('#sched-cancel').addEventListener('click', () => { resetForm(); const f = panelEl.querySelector('#sched-form'); if (f) f.style.display = 'none'; });
    panelEl.querySelector('#sched-create').addEventListener('click', onSaveClick);
    panelEl.querySelector('#sched-type').addEventListener('change', function () {
      const label = panelEl.querySelector('#sched-expr-label'), expr = panelEl.querySelector('#sched-expr');
      if (this.value === 'interval') { label.textContent = '间隔（毫秒）'; expr.placeholder = '600000'; }
      else { label.textContent = 'Cron 表达式'; expr.placeholder = '*/5 * * * *'; }
    });
    built = true;
  }
  function toggleForm() { const f = panelEl.querySelector('#sched-form'); if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none'; }

  async function refreshSchedulePanel() {
    if (!panelEl) buildPanel();
    if (panelEl.style.display === 'none') return;
    try { const st = await ipcInvoke('schedule:status'); const el = panelEl.querySelector('#sched-status'); if (el) el.textContent = '状态：' + (st && st.message ? st.message : (st ? JSON.stringify(st) : '未知')); }
    catch (e) { const el = panelEl.querySelector('#sched-status'); if (el) el.textContent = '状态：未连接（依赖 main 实现 schedule:status）'; }
    let tasks = [], runs = [];
    try { tasks = await ipcInvoke('schedule:listInbox'); } catch (e) { tasks = []; }
    try { runs = await ipcInvoke('schedule:listRuns'); } catch (e) { runs = []; }
    if (!Array.isArray(tasks)) tasks = []; if (!Array.isArray(runs)) runs = [];
    const listEl = panelEl.querySelector('#sched-list'); if (!listEl) return;
    if (tasks.length === 0 && runs.length === 0) { listEl.innerHTML = '<div class="sched-empty">暂无定时任务（先用「+」新建）</div>'; return; }
    let html = '';
    tasks.forEach(t => {
      const id = t.id || t.taskId || '', type = t.type || 'cron', expr = t.expr || t.cron || t.interval || '', prompt = t.prompt || '', enabled = t.enabled !== false;
      html += `<div class="sched-item" data-task-id="${escapeHtml(id)}">
        <div class="sched-item-top"><span class="sched-item-title">${escapeHtml(t.name || prompt.slice(0, 24) || id || '未命名任务')}</span>
          <span class="badge ${enabled ? 'badge-info' : 'badge-muted'}">${enabled ? '启用' : '停用'}</span></div>
        <div class="sched-item-meta">${escapeHtml(type)} · ${escapeHtml(expr)}${t.mode === 'workflow' ? ' · <span class="sched-mode-tag">工作流</span>' : ''}</div>
        <div class="sched-item-actions">
          <button class="btn btn-sm btn-secondary" data-act="run" data-id="${escapeHtml(id)}">立即运行</button>
          <button class="btn btn-sm btn-secondary" data-act="runs" data-id="${escapeHtml(id)}">产出</button>
          <button class="btn btn-sm btn-secondary" data-act="toggle" data-id="${escapeHtml(id)}" data-enabled="${enabled ? '1' : '0'}">${enabled ? '停用' : '启用'}</button>
          <button class="btn btn-sm btn-secondary" data-act="edit" data-id="${escapeHtml(id)}">编辑</button>
          <button class="btn btn-sm btn-secondary" data-act="delete" data-id="${escapeHtml(id)}">删除</button></div></div>`;
    });
    if (runs.length) {
      html += '<div class="sched-group-title">最近运行</div>';
      runs.slice(0, 10).forEach(r => {
        const id = r.id || r.runId || '';
        html += `<div class="sched-item sched-run" data-run-id="${escapeHtml(id)}">
          <div class="sched-item-top"><span class="sched-item-title">${escapeHtml(r.taskName || r.taskId || '运行')}</span>
            <span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status || 'unknown')}</span></div>
          <div class="sched-item-meta">${escapeHtml(r.time || r.startedAt || '')}</div>
          <div class="sched-item-actions"><button class="btn btn-sm btn-secondary" data-act="patch" data-run="${escapeHtml(id)}">查看补丁</button></div></div>`;
      });
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', function () {
      const act = this.getAttribute('data-act'), taskId = this.getAttribute('data-id') || '', runId = this.getAttribute('data-run') || '';
      if (act === 'run') runNow(taskId); else if (act === 'runs') viewRuns(taskId); else if (act === 'patch') viewPatch(runId);
      else if (act === 'toggle') toggleEnabled(taskId, this.getAttribute('data-enabled') === '1');
      else if (act === 'edit') editTask(taskId);
      else if (act === 'delete') deleteTaskConfirm(taskId);
    }));
  }
  function badgeClass(s) { if (s === 'success' || s === 'done') return 'badge-success'; if (s === 'failed' || s === 'error') return 'badge-error'; if (s === 'running') return 'badge-info'; return 'badge-muted'; }

  function resetForm() {
    editingId = null;
    const f = panelEl.querySelector('#sched-form'); if (!f) return;
    const nameEl = f.querySelector('#sched-name'); if (nameEl) nameEl.value = '';
    f.querySelector('#sched-type').value = 'cron';
    f.querySelector('#sched-mode').value = 'chat';
    f.querySelector('#sched-expr').value = '';
    f.querySelector('#sched-prompt').value = '';
    const btn = f.querySelector('#sched-create'); if (btn) btn.textContent = '创建';
  }
  function openForm(task) {
    const f = panelEl.querySelector('#sched-form'); if (!f) return;
    if (task) {
      editingId = task.id;
      const nameEl = f.querySelector('#sched-name'); if (nameEl) nameEl.value = task.name || '';
      f.querySelector('#sched-type').value = task.type || 'cron';
      f.querySelector('#sched-mode').value = task.mode || 'chat';
      f.querySelector('#sched-expr').value = task.expr || '';
      f.querySelector('#sched-prompt').value = task.prompt || '';
      const btn = f.querySelector('#sched-create'); if (btn) btn.textContent = '保存';
    } else { resetForm(); }
    f.style.display = 'block';
  }
  function onSaveClick() { if (editingId) saveEdit(editingId); else createTask(); }
  async function createTask() {
    const name = panelEl.querySelector('#sched-name').value.trim();
    const type = panelEl.querySelector('#sched-type').value, expr = panelEl.querySelector('#sched-expr').value.trim(), prompt = panelEl.querySelector('#sched-prompt').value.trim();
    const mode = panelEl.querySelector('#sched-mode') ? panelEl.querySelector('#sched-mode').value : 'chat';
    if (!expr || !prompt) { toast('请填写表达式与 prompt', 'warning'); return; }
    try { const res = await ipcInvoke('schedule:createTask', { name, type, expr, prompt, mode }); toast('已创建任务：' + (res && res.id ? res.id : 'ok'), 'success'); resetForm(); panelEl.querySelector('#sched-form').style.display = 'none'; refreshSchedulePanel(); }
    catch (e) { toast('创建失败（依赖 main 实现 schedule:createTask）：' + e.message, 'error'); }
  }
  async function saveEdit(taskId) {
    const name = panelEl.querySelector('#sched-name').value.trim();
    const type = panelEl.querySelector('#sched-type').value, expr = panelEl.querySelector('#sched-expr').value.trim(), prompt = panelEl.querySelector('#sched-prompt').value.trim();
    const mode = panelEl.querySelector('#sched-mode') ? panelEl.querySelector('#sched-mode').value : 'chat';
    if (!expr || !prompt) { toast('请填写表达式与 prompt', 'warning'); return; }
    try {
      const res = await ipcInvoke('schedule:update', { taskId, name, type, expr, prompt, mode });
      if (!res || !res.success) { toast('保存失败：' + (res && res.error ? res.error : '未知'), 'error'); return; }
      toast('已保存任务：' + taskId, 'success');
      resetForm();
      panelEl.querySelector('#sched-form').style.display = 'none';
      refreshSchedulePanel();
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  }
  async function editTask(taskId) {
    let task = null;
    try { const res = await ipcInvoke('schedule:getTask', { taskId }); task = res && res.task; } catch (e) {}
    if (!task) { try { const tasks = await ipcInvoke('schedule:listInbox'); task = (tasks || []).find(t => t.id === taskId); } catch (e) {} }
    openForm(task);
  }
  async function toggleEnabled(taskId, enabled) {
    try { const res = await ipcInvoke('schedule:setEnabled', { taskId, enabled: !enabled }); if (res && res.success) toast('已' + (res.enabled ? '启用' : '停用') + '任务', 'success'); refreshSchedulePanel(); }
    catch (e) { toast('操作失败（依赖 main 实现 schedule:setEnabled）：' + e.message, 'error'); }
  }
  async function deleteTaskConfirm(taskId) {
    if (typeof window.confirm === 'function' && !window.confirm('确定删除该定时任务？相关运行记录也会一并清除，且不可撤销。')) return;
    try { const res = await ipcInvoke('schedule:delete', { taskId }); if (res && res.success) toast('已删除任务', 'success'); else toast('删除失败：' + (res && res.error ? res.error : ''), 'error'); refreshSchedulePanel(); }
    catch (e) { toast('删除失败（依赖 main 实现 schedule:delete）：' + e.message, 'error'); }
  }
  async function runNow(taskId) { try { const res = await ipcInvoke('schedule:runNow', { taskId }); toast('已触发运行：' + (res && res.runId ? res.runId : taskId), 'success'); refreshSchedulePanel(); } catch (e) { toast('运行失败（依赖 main 实现 schedule:runNow）：' + e.message, 'error'); } }
  async function viewRuns(taskId) { let runs = []; try { runs = await ipcInvoke('schedule:listRuns', { taskId }); } catch (e) { runs = []; } if (!Array.isArray(runs) || !runs.length) { toast('该任务暂无运行记录', 'info'); return; } const last = runs[0], runId = last.id || last.runId; if (runId) viewPatch(runId); }

  async function viewPatch(runId) {
    const detail = panelEl.querySelector('#sched-detail'), list = panelEl.querySelector('#sched-list'); if (!detail || !list) return;
    list.style.display = 'none'; detail.style.display = 'block';
    detail.innerHTML = `
      <div class="sched-detail-header"><button class="icon-btn" id="sched-back" title="返回"><svg class="icon"><use href="#icon-arrow-back-up"></use></svg></button>
        <span>产出补丁 · ${escapeHtml(runId)}</span></div>
      <div class="sched-detail-body" id="sched-patch-body"><div class="sched-empty">加载中…</div></div>
      <div class="sched-detail-actions">
        <button class="btn btn-sm btn-secondary" id="sched-preview-slots">预览槽位</button>
        <button class="btn btn-sm btn-primary" id="sched-apply">应用</button>
        <button class="btn btn-sm btn-secondary" id="sched-discard">丢弃</button></div>`;
    detail.querySelector('#sched-back').addEventListener('click', () => { detail.style.display = 'none'; list.style.display = 'block'; });
    detail.querySelector('#sched-preview-slots').addEventListener('click', () => previewSlots(runId, detail));
    detail.querySelector('#sched-apply').addEventListener('click', () => applyPatch(runId));
    detail.querySelector('#sched-discard').addEventListener('click', () => discardPatch(runId, detail));
    try { const patch = await ipcInvoke('schedule:getPatch', { runId }); detail.querySelector('#sched-patch-body').innerHTML = renderPatch(patch); }
    catch (e) { detail.querySelector('#sched-patch-body').innerHTML = '<div class="sched-empty ctx-error">获取补丁失败（依赖 main 实现 schedule:getPatch）：' + escapeHtml(e.message) + '</div>'; }
  }
  function renderPatch(patch) {
    if (!patch) return '<div class="sched-empty">无产出补丁</div>';
    if (typeof patch === 'string') return '<pre class="patch-diff">' + escapeHtml(patch) + '</pre>';
    let html = '';
    if (patch.summary) html += '<div class="sched-summary">' + escapeHtml(patch.summary) + '</div>';
    if (Array.isArray(patch.files) && patch.files.length) html += patch.files.map(f => '<div class="patch-file"><div class="patch-file-name">' + escapeHtml(f.path) + '</div><pre class="patch-diff">' + escapeHtml(f.diff || f.content || '') + '</pre></div>').join('');
    else if (patch.diff) html += '<pre class="patch-diff">' + escapeHtml(patch.diff) + '</pre>';
    return html || '<div class="sched-empty">无产出补丁</div>';
  }
  async function previewSlots(runId, detail) { try { const slots = await ipcInvoke('schedule:previewSlots', { runId }); const body = detail.querySelector('#sched-patch-body'); let html = '<div class="sched-group-title">预览槽位</div>'; if (Array.isArray(slots)) html += slots.map(s => '<div class="ctx-line">' + escapeHtml(typeof s === 'string' ? s : JSON.stringify(s)) + '</div>').join(''); else if (slots) html += '<pre class="patch-diff">' + escapeHtml(JSON.stringify(slots, null, 2)) + '</pre>'; else html += '<div class="sched-empty">无槽位信息</div>'; body.innerHTML = html; } catch (e) { toast('预览槽位失败（依赖 main 实现 schedule:previewSlots）：' + e.message, 'error'); } }
  async function applyPatch(runId) { try { const res = await ipcInvoke('schedule:applyPatch', { runId }); toast('已应用补丁：' + (res && res.message ? res.message : runId), 'success'); } catch (e) { toast('应用失败（依赖 main 实现 schedule:applyPatch）：' + e.message, 'error'); } }
  async function discardPatch(runId, detail) { try { const res = await ipcInvoke('schedule:discardPatch', { runId }); toast('已丢弃补丁：' + (res && res.message ? res.message : runId), 'info'); detail.style.display = 'none'; panelEl.querySelector('#sched-list').style.display = 'block'; refreshSchedulePanel(); } catch (e) { toast('丢弃失败（依赖 main 实现 schedule:discardPatch）：' + e.message, 'error'); } }

  setInterval(function () { if (panelEl && panelEl.style.display !== 'none') refreshSchedulePanel(); }, 5000);
  BubaiCodeUI.refreshSchedulePanel = refreshSchedulePanel;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel); else buildPanel();
})();

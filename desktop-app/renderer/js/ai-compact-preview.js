// 压缩预览数据源（接通 ctx-compact-btn → openCompactPreview）
// 复用 AgentRunner.compressContext 的三级裁剪边界（keepTurns=3 的 cutIdx），给出"保留/剪裁"预览。
(function () {
  function summarize(m) {
    var role = m.role || 'unknown';
    var content = String(m.content || (m.tool_calls ? JSON.stringify(m.tool_calls) : ''));
    var head = content.length > 120 ? content.slice(0, 120) + '…' : content;
    return '[' + role + '] ' + head.replace(/\n/g, ' ');
  }

  function preview() {
    var st = window.BubaiCodeUI && window.BubaiCodeUI.state;
    var agent = st && st.agent;
    if (!agent || !Array.isArray(agent.messages) || agent.messages.length === 0) return null;
    var msgs = agent.messages;
    var keepTurns = 3;
    var userCount = 0, cutIdx = -1;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        userCount++;
        if (userCount >= keepTurns) { cutIdx = i; break; }
      }
    }
    if (cutIdx <= 0) {
      return { summary: '当前对话较短，压缩不会移除任何消息。', kept: msgs.map(summarize), dropped: [] };
    }
    var kept = msgs.slice(cutIdx).map(summarize);
    var dropped = msgs.slice(0, cutIdx).map(summarize);
    return {
      summary: '将保留最近 ' + kept.length + ' 条消息（最近 ' + keepTurns + ' 轮），并把较早的 ' + dropped.length + ' 条折叠为历史摘要（旧工具结果将被裁剪）。',
      kept: kept,
      dropped: dropped
    };
  }

  window.getCompactPreview = preview;
  window.BubaiCode = window.BubaiCode || {};
  window.BubaiCode.getCompactPreview = preview;
})();

// ============ LabCode 上下文压缩（packages/engine，纯 CommonJS）============
// 参考 TrieCode：当上下文超 token 阈值时，把旧轮次折叠成一条 LLM 生成的「历史背景摘要」，
// 仅保留最近 N 个 user 轮（B1：LLM 摘要压缩，区别于 app.js 原 compressContext 的「仅删旧工具结果无摘要」）。

// summarizeOldTurns(callModel, messages, opts) -> 压缩后的 messages（调用失败则原样回退，不破坏上下文）
// callModel(messages): Promise<{ content }> —— 由调用方注入（通常是 ai.generateResponse）
async function summarizeOldTurns(callModel, messages, { keepRecent = 3, tokenBudget = 30000, maxLen = 1500, maxSummary = 800 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let userCount = 0, cutIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userCount++;
      if (userCount >= keepRecent) { cutIdx = i; break; }
    }
  }
  if (cutIdx <= 0) return messages; // 不足 keepRecent 个 user 轮，无需压缩
  const old = messages.slice(0, cutIdx);
  const keep = messages.slice(cutIdx);
  if (old.length === 0) return messages;

  const transcript = old
    .map((m) => `${m.role}: ${String(m.content || (m.tool_calls ? '[tool_calls]' : '')).slice(0, maxLen)}`)
    .join('\n\n');

  let summary = '';
  try {
    const r = await callModel([
      {
        role: 'system',
        content:
          '你是 AI 编程智能体的历史整理器。请把以下对话历史摘要成简洁的结构化「历史背景」，' +
          '保留：关键技术决策、已创建/修改的文件及其作用、已验证的结论、未解决的问题。用中文，不超过 ' +
          maxSummary + ' 字。只输出摘要本身，不要解释。'
      },
      { role: 'user', content: transcript }
    ]);
    summary = (r && (r.content || r.summary || '')) || '';
  } catch (e) {
    summary = '';
  }
  if (!summary) return messages; // 摘要失败回退原样

  return [{ role: 'system', content: `【历史背景摘要】\n${summary}` }, ...keep];
}

module.exports = { summarizeOldTurns };

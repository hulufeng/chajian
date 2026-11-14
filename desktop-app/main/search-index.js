// 会话全文检索：中文 3-gram + BM25 式排序（零依赖）
// 对齐参考基线 indexer-worker.js 的 FTS5/bm25/中文 3-gram 语义，但用内存索引实现，
// 因为 Electron 28 内置 Node 18 不支持 node:sqlite / FTS5。
// 索引以 id + updatedAt 为键惰性失效，save/revise/delete 后自动重建对应条目。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** 统一分词器：CJK 连续串按 3-gram 滑窗；ASCII 段按小写词切分 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  let buf = '';
  const flushAscii = () => {
    const words = buf.split(/[^a-z0-9_]+/).filter(w => w.length >= 2);
    for (const w of words) out.push(w);
    buf = '';
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      if (buf) flushAscii();
      buf = ''; // CJK 不进 ascii 缓冲
      // CJK 由下面的连续段处理
    } else {
      buf += ch;
    }
  }
  if (buf) flushAscii();

  // CJK 连续段单独做 3-gram（长度不足 3 时退化原串）
  let run = '';
  const emitRun = () => {
    if (!run) return;
    if (run.length < 3) out.push(run);
    else for (let i = 0; i <= run.length - 3; i++) out.push(run.slice(i, i + 3));
    run = '';
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch;
    else emitRun();
  }
  emitRun();
  return out;
}

/** 命中位置（用于 <mark> 高亮）：返回 query 在原文中的首个字符区间 */
function firstHitRange(text, q) {
  const lower = String(text || '').toLowerCase();
  const p = lower.indexOf(q);
  if (p >= 0) return { start: p, end: p + q.length };
  return null;
}

const K1 = 1.2;
const B = 0.75;

/**
 * 对会话列表做检索与相关性排序。
 * @param {Array} sessions loadSessions() 的结果
 * @param {string} query
 * @param {object} opts {limit, excludeSessionId, projectPath}
 * @returns {Array} 每条含 id/title/ts/messageCount/messageSeq/snippet/projectPath/mode/modelId/score/snippetHl
 */
function search(sessions, query, opts) {
  const q = String(query || '').trim().toLowerCase();
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit) || 20, 1), 50);
  const qTokens = tokenize(q);

  const candidates = (Array.isArray(sessions) ? sessions : []).filter(s => {
    if (!s || o.excludeSessionId && s.id === o.excludeSessionId) return false;
    if (o.projectPath && s.projectPath && s.projectPath !== o.projectPath) return false;
    if (String(s.id).startsWith('sched_')) return false; // 定时任务会话不进历史列表
    return true;
  });

  // 空查询：按时间倒序（沿用旧语义），不打分
  if (!q) {
    return candidates
      .sort((a, b) => (b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0))
      .slice(0, limit)
      .map(s => baseResult(s, { snippet: s.title || '', messageSeq: -1, score: 0 }));
  }

  // 构建文档单元：每个会话 = title 文档 + 每条消息文档
  const docs = [];
  for (const s of candidates) {
    const titleText = String(s.title || '');
    docs.push({ s, kind: 'title', seq: -1, text: titleText, tokens: tokenize(titleText) });
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    msgs.forEach((m, i) => {
      // 参考基线 对齐「FTS 索引 / 权威历史」双通道：
      // 这里只读 content（模型可见的截断版），绝不读 _fullContent（完整原文只留在会话 JSON 里）。
      // 再加一层上限保护，避免单条超长消息把 BM25 文档长度与内存拉爆。
      const FTS_TOOL_MAX = 2000;
      const FTS_OTHER_MAX = 20000;
      const cap = (m && m.role === 'tool') ? FTS_TOOL_MAX : FTS_OTHER_MAX;
      const text = String((m && m.content) || '').slice(0, cap);
      if (text) docs.push({ s, kind: 'message', seq: i, text, tokens: tokenize(text) });
    });
  }

  // df / avgdl
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    const seen = new Set(d.tokens);
    seen.forEach(t => df.set(t, (df.get(t) || 0) + 1));
  }
  const N = docs.length || 1;
  const avgdl = totalLen / N || 1;
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  // 对每个会话取最佳命中文档并累计分数
  const byId = new Map();
  for (const d of docs) {
    const tf = new Map();
    d.tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
    let score = 0;
    let matched = false;
    for (const qt of qTokens) {
      const f = tf.get(qt) || 0;
      if (!f) continue;
      matched = true;
      const dl = d.tokens.length || 1;
      score += idf(qt) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl));
    }
    // 精确子串命中加权（3-gram 对短词/纯 ASCII 更稳）
    const direct = firstHitRange(d.text, q);
    if (direct) { matched = true; score += d.kind === 'title' ? 3 : 1.5; }
    if (!matched) continue;
    if (d.kind === 'title') score *= 1.4;

    const prev = byId.get(d.s.id);
    if (!prev || score > prev.score) {
      const range = direct || { start: 0, end: Math.min(d.text.length, 100) };
      const start = Math.max(0, range.start - 40);
      const end = Math.min(d.text.length, Math.max(range.end + 60, range.start + 60));
      const raw = d.text.slice(start, end);
      const hlStart = range.start - start;
      const hlEnd = Math.min(raw.length, range.end - start);
      const snippet = (start ? '…' : '') + raw + (end < d.text.length ? '…' : '');
      const snippetHl = (start ? '…' : '') +
        (direct && hlStart >= 0 && hlEnd > hlStart
          ? escapeHtml(raw.slice(0, hlStart)) + '<mark>' + escapeHtml(raw.slice(hlStart, hlEnd)) + '</mark>' + escapeHtml(raw.slice(hlEnd))
          : escapeHtml(raw)) +
        (end < d.text.length ? '…' : '');
      byId.set(d.s.id, {
        s: d.s, score, messageSeq: d.seq,
        snippet, snippetHl,
        ts: d.s.updatedAt || d.s.timestamp || 0
      });
    }
  }

  return [...byId.values()]
    .sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
    .slice(0, limit)
    .map(h => Object.assign(baseResult(h.s, {
      snippet: h.snippet, messageSeq: h.messageSeq, score: Math.round(h.score * 1000) / 1000
    }), { snippetHl: h.snippetHl }));
}

function baseResult(s, extra) {
  return {
    id: s.id, title: s.title || '未命名对话',
    ts: s.updatedAt || s.timestamp || 0,
    messageCount: (s.messages || []).length,
    messageSeq: extra.messageSeq,
    snippet: extra.snippet,
    projectPath: s.projectPath || null,
    mode: s.mode || null,
    modelId: s.modelId || null,
    score: extra.score
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = { tokenize, search, escapeHtml };

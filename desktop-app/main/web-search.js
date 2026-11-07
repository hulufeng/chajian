// ============ BubaiCode Web 搜索模块（主进程）============
// 真实联网搜索（Bing HTML 端点，无需 API Key）+ 网页抓取转 Markdown
// 设计：SSRF 防护 / 15min 缓存 / 会话上限 / 超时熔断，与渲染端 WebTools 互补
// 渲染端优先走本模块，失败时降级为 mock 并明确标注

const { net } = require('electron');
const SEARCH_TIMEOUT = 15000;       // 搜索超时（毫秒）
const FETCH_TIMEOUT = 20000;        // 抓取超时（毫秒）
const MAX_RESULTS = 8;              // 单次搜索返回结果上限
const MAX_FETCH_BYTES = 300 * 1024; // 抓取正文上限（300KB）
const MAX_FETCH_CHARS = 40000;      // 转文本后上限（40K 字符）

// 15min 缓存（LRU，上限 200 条）
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const CACHE_MAX = 200;

// 会话搜索上限（对齐渲染端 WebTools 的 200 次）
let searchCount = 0;
const SESSION_LIMIT = 200;

// SSRF 防护：阻断内网 / 云元数据 / 保留地址
const BLOCKED_IPS = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/, /^fe80:/, /^100\.64\./,
  /metadata\.google\.internal/i, /169\.254\.169\.254/,
];

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { safe: false, reason: `不允许的协议: ${u.protocol}` };
    }
    for (const p of BLOCKED_IPS) {
      if (p.test(u.hostname)) {
        return { safe: false, reason: `内网/元数据地址被阻断: ${u.hostname}` };
      }
    }
    if (u.hostname === 'localhost') return { safe: false, reason: 'localhost 被阻断' };
    return { safe: true, hostname: u.hostname };
  } catch (e) {
    return { safe: false, reason: `URL 解析失败: ${e.message}` };
  }
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, entry); // LRU 触碰
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

/** 用 Electron net 抓取 URL（带超时 + 大小上限），返回 {ok, body, error} */
async function rawFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 BubaiCode/1.0',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    const arr = await resp.arrayBuffer();
    return { ok: true, body: Buffer.from(arr) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

function decodeBody(buf) {
  // 优先 UTF-8；带 BOM 直接解；否则尝试 GBK（Bing 中文页多为 UTF-8）
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);
  }
  const utf8 = buf.toString('utf8');
  // 检测乱码率：U+FFFD 过多说明非 UTF-8
  const replaced = (utf8.match(/\uFFFD/g) || []).length;
  if (replaced < Math.max(2, utf8.length / 500)) return utf8;
  try { return buf.toString('gbk'); } catch (e) { return utf8; }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&ensp;|&#8194;/gi, ' ')
    .replace(/&emsp;|&#8195;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 真实搜索：cn.bing.com/search?q=...，解析 b_algo 结果块
 * @returns {Promise<{success:boolean, results?:Array, error?:string, fromCache?:boolean}>}
 */
async function search(query, options = {}) {
  if (!query || !String(query).trim()) return { success: false, error: '搜索关键词不能为空' };
  if (searchCount >= SESSION_LIMIT) {
    return { success: false, error: `已达会话搜索上限（${SESSION_LIMIT}次）` };
  }
  searchCount++;
  const cacheKey = `search:${String(query).trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { success: true, results: cached, fromCache: true };

  const q = encodeURIComponent(String(query).trim());
  const url = `https://cn.bing.com/search?q=${q}&setlang=zh-CN`;
  const fetched = await rawFetch(url, SEARCH_TIMEOUT);
  if (!fetched.ok) {
    return { success: false, error: `搜索请求失败: ${fetched.error}` };
  }
  const html = decodeBody(fetched.body);
  // 解析 b_algo 结果块
  const results = [];
  const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  let match;
  while ((match = algoRe.exec(html)) !== null && results.length < MAX_RESULTS) {
    const block = match[0];
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const urlRaw = link[1];
    const title = stripHtml(link[2]);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (urlRaw && title) {
      results.push({ title, url: urlRaw, snippet: snippet.slice(0, 300), source: safeHost(urlRaw) });
    }
  }
  if (!results.length) {
    // 可能是反爬/改版：退回 mock 兜底并明确标注（不让 AI 拿到空结果当作"无信息"）
    return {
      success: false,
      error: '搜索页面无有效结果（可能被反爬），请稍后重试或换关键词'
    };
  }
  cacheSet(cacheKey, results);
  return { success: true, results, fromCache: false };
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

/**
 * 真实网页抓取：SSRF 防护 + 超时 + 体积上限，转纯文本
 */
async function fetchPage(url, options = {}) {
  const safety = isSafeUrl(url);
  if (!safety.safe) return { success: false, error: `SSRF 防护: ${safety.reason}` };
  const cacheKey = `fetch:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { success: true, content: cached, fromCache: true, url };

  const fetched = await rawFetch(url, FETCH_TIMEOUT);
  if (!fetched.ok) return { success: false, error: `抓取失败: ${fetched.error}` };
  let body = fetched.body;
  if (body.length > MAX_FETCH_BYTES) body = body.slice(0, MAX_FETCH_BYTES);
  let text = decodeBody(body);
  // 尝试提取正文（粗过滤导航/脚本噪音由 stripHtml 完成）
  text = stripHtml(text);
  if (text.length > MAX_FETCH_CHARS) text = text.slice(0, MAX_FETCH_CHARS);
  cacheSet(cacheKey, text);
  return { success: true, content: text, fromCache: false, url };
}

function getStats() {
  return { cacheSize: cache.size, searchCount, sessionLimit: SESSION_LIMIT };
}

function clearCache() { cache.clear(); searchCount = 0; }

module.exports = { search, fetchPage, getStats, clearCache, isSafeUrl };

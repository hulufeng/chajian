// BubaiCode Cloud BFF —— 最小可用代理骨架
// 作用：客户端 → 本机/ECS 本服务（鉴权+计费）→ DeepSeek 官方 API
// 零依赖：Node 18+ 原生 http/fetch。本地 `node server.js` 即可跑。
//
// 环境变量：
//   PORT                 默认 8787
//   DEEPSEEK_API_KEY     DeepSeek 官方 key（sk-...）
//   DEEPSEEK_BASE        默认 https://api.deepseek.com
//   BFF_USERS            "user1=token1,user2=token2"  允许的客户端 token 清单
//   RATE_PER_MIN         每用户每分钟最大请求数，默认 20
//
// 部署注意：
//   - 本服务不跑模型，只做转发，普通 ECS CPU 即可；
//   - 上线前必须前面挂 HTTPS（Nginx/Caddy），裸 HTTP 只用于内网联调；
//   - DEEPSEEK_API_KEY 只在服务端，客户端拿不到。

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || '20', 10);

// 用户表：token -> { name, quota }
const users = {};
(String(process.env.BFF_USERS || 'demo=changeme-token-123')).split(',').forEach(pair => {
  const [name, token] = pair.split('=');
  if (name && token) users[token.trim()] = { name: name.trim(), quota: Infinity };
});

// 简单内存态：每分钟计数 + token 用量
const counters = new Map(); // token -> { windowStart, count, usedTokens }
const usageLog = []; // 可换成写文件/数据库

function auth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return users[m[1].trim()] || null;
}

function rateOk(user) {
  const now = Date.now();
  let c = counters.get(user.name);
  if (!c || now - c.windowStart > 60000) {
    c = { windowStart: now, count: 0, usedTokens: 0 };
    counters.set(user.name, c);
  }
  c.count += 1;
  return c.count <= RATE_PER_MIN;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // 健康检查（不鉴权）
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, ts: Date.now(), users: Object.keys(users).length });
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    return json(res, 404, { error: 'not_found' });
  }

  const user = auth(req);
  if (!user) return json(res, 401, { error: { message: 'unauthorized' } });
  if (!rateOk(user)) return json(res, 429, { error: { message: 'rate_limit' } });
  if (!DEEPSEEK_KEY) return json(res, 500, { error: { message: 'bff_not_configured: missing DEEPSEEK_API_KEY' } });

  // 读请求体
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_json' }); }

    // 默认模型 + 透传客户端指定
    payload.model = payload.model || 'deepseek-chat';
    const wantStream = payload.stream !== false;
    payload.stream = wantStream;

    try {
      const upstream = await fetch(DEEPSEEK_BASE + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_KEY
        },
        body: JSON.stringify(payload)
      });

      if (!upstream.ok) {
        const t = await upstream.text();
        return json(res, upstream.status, { error: { message: 'upstream_' + upstream.status, detail: t.slice(0, 300) } });
      }

      // 用量记账（无论流与否都记 usage；流式时 DeepSeek 在最后一个 chunk 给 usage）
      let totalTokens = 0;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // 从 SSE chunk 里粗提取 usage
        chunk.split('\n').forEach(line => {
          if (line.startsWith('data: ') && line.includes('"usage"')) {
            try {
              const j = JSON.parse(line.slice(6));
              if (j.usage) totalTokens = (j.usage.total_tokens || 0);
            } catch {}
          }
        });
        res.write(chunk);
      }
      res.end();

      usageLog.push({ user: user.name, ts: Date.now(), model: payload.model, tokens: totalTokens });
      console.log(`[${new Date().toISOString()}] ${user.name} model=${payload.model} tokens=${totalTokens}`);
    } catch (e) {
      try { json(res, 502, { error: { message: 'bff_upstream_error', detail: e.message } }); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`BubaiCode BFF listening on http://0.0.0.0:${PORT}`);
  console.log(`  upstream: ${DEEPSEEK_BASE}  users: ${Object.keys(users).join(', ')}  rate: ${RATE_PER_MIN}/min`);
});

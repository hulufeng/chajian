'use strict';
/**
 * AI 出站退避重试验收（ALIGN_LEDGER R3：429/5xx/网络抖有界补发，确定性失败不补发）。
 * 运行：node scripts/verify-backoff.cjs
 * 手段：真跑 renderer/js/ai-backoff.js 的判定与重试循环（vm 里驱动 UI 提示函数），
 *       再静态扫主进程/渲染层接线 —— 判据只允许存在一份实现。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, 'renderer/js/ai-backoff.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

const err = (status, msg) => Object.assign(new Error(msg || ('API 返回 ' + status)), { status });

test('状态码判定：5xx/429/408 可重试，其余 4xx 不可重试', () => {
  for (const s of [500, 502, 503, 504, 529, 429, 408]) {
    const v = B.classifyError(err(s));
    assert.equal(v.isRetryable, true, s + ' 属于暂时性故障，该补发');
    assert.equal(v.kind, 'transient', s + ' 归 transient');
  }
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(B.classifyError(err(s)).isRetryable, false, s + ' 重发也是同样错话');
  }
});

test('429 必须赢在确定性字面之前（限流可重试，不是客户端错误）', () => {
  // 429 同时命中「4xx」和确定性文案，判定顺序错了就把限流当成用户错误直接抛
  assert.equal(B.classifyError(err(429)).kind, 'transient');
  assert.equal(B.classifyError({ message: 'HTTP 429 Too Many Requests' }).isRetryable, true, '无 status 时按文案也要判可重试');
  assert.equal(B.classifyError({ message: '上游限流 rate limit exceeded' }).isRetryable, true);
});

test('文案判定：网络抖可重试，认证/超限/模型不存在不重试', () => {
  const retryable = ['fetch failed', 'ECONNRESET', 'socket hang up', '请求超时（网络或代理问题）', '服务暂时不可用', '503 Service Unavailable'];
  for (const m of retryable) assert.equal(B.classifyError(new Error(m)).isRetryable, true, m);
  const hardStop = ['invalid api key', '401 认证失败', 'prompt_too_long: context length exceeded', 'model not found: qwen-x', '积分不足，请充值', '文件不存在'];
  for (const m of hardStop) assert.equal(B.classifyError(new Error(m)).isRetryable, false, m);
  // 没见过的错话乐观当瞬态：偶发抖动报成永久故障的代价更大
  assert.equal(B.classifyError(new Error('完全没见过的错话')).kind, 'unknown');
  assert.equal(B.classifyError(new Error('完全没见过的错话')).isRetryable, true);
});

test('取消不是错误：AbortError / 已停止 一律不补发', () => {
  assert.equal(B.classifyError(Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })).isRetryable, false);
  assert.equal(B.classifyError(new Error('用户已取消')).isRetryable, false);
  assert.equal(B.classifyError(err(503, '请求已取消')).kind, 'cancelled', '取消优先于状态码：别把停止当成服务器故障');
});

test('Retry-After 三种写法都认，且换算成毫秒', () => {
  assert.equal(B.parseRetryAfter({ headers: { get: (n) => n === 'retry-after' ? '3' : '' } }), 3000, '秒');
  assert.equal(B.parseRetryAfter({ headers: { get: (n) => n === 'retry-after-ms' ? '2500' : '' } }), 2500, '毫秒头优先');
  const soon = new Date(Date.now() + 9000).toUTCString();
  const parsed = B.parseRetryAfter({ headers: { get: () => soon } });
  assert.ok(parsed > 0 && parsed <= 10000, 'HTTP-date → 距该时刻的毫秒：' + parsed);
  assert.equal(B.parseRetryAfter({ headers: { get: () => null } }), 0, '没有该头就是 0');
  assert.equal(B.parseRetryAfter({ headers: { get: () => 'Wed, 21 Oct 2015 07:28:00 GMT' } }), 0, '过去的时间不等待');
  assert.equal(B.parseRetryAfter({ 'retry-after': '2' }), 2000, '裸对象也要能用');
});

test('退避时长：阶梯递增、Retry-After 更长才说话、封顶 30s、抖动只加不减', () => {
  assert.equal(B.backoffDelayMs(1, 0, () => 0), 1500, 'random=0 时正好是基数');
  assert.ok(B.backoffDelayMs(2, 0, () => 0) > B.backoffDelayMs(1, 0, () => 0), '第二次等更久');
  assert.ok(B.backoffDelayMs(1, 0, () => 1) <= B.BASE_DELAY_MS * (1 + 0.3), '抖动只在上浮范围内');
  assert.equal(B.backoffDelayMs(1, 20000, () => 0), 20000, '上游说等 20s 就等 20s');
  assert.equal(B.backoffDelayMs(1, 3600000, () => 0), B.CAP_DELAY_MS, '上游写一小时也不能真等一小时');
  assert.equal(B.CAP_DELAY_MS, 30000);
});

test('withBackoff 真跑：补发额度用完即止，成功即停，不可重试的原样抛', async () => {
  let calls = 0; const notes = [];
  const out = await B.withBackoff(async () => {
    calls++;
    if (calls < 3) {
      throw B.annotateError(new Error('API 返回 503: busy'), 503, 10);
    }
    return 'ok';
  }, { random: () => 0, onRetry: (i) => notes.push(i.attempt + '/' + i.maxRetries + '@' + i.delayMs) });
  assert.equal(out, 'ok');
  assert.equal(calls, 3, '首次 + 2 次补发');
  assert.equal(notes.join(','), '1/2@1500,2/2@3000', '重试通知带第几次与等待时长，UI 才有得显示');

  calls = 0;
  const boom = err(401, 'API 返回 401: invalid api key');
  await assert.rejects(B.withBackoff(async () => { calls++; throw boom; }, { random: () => 0 }), /invalid api key/);
  assert.equal(calls, 1, '确定性失败一次就停，不浪费时间');

  calls = 0;
  await assert.rejects(B.withBackoff(async () => { calls++; throw err(503); }, { random: () => 0 }));
  assert.equal(calls, B.MAX_RETRIES + 1, '重试用完抛出最后一个原始错误，调用点错话不变');
});

test('withBackoff 可取消：等待中被 abort 立刻结束，且不把取消当可重试错误', async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = B.withBackoff(async () => { calls++; throw err(503); }, { signal: ac.signal, random: () => 0 });
  setTimeout(() => ac.abort(), 60);
  await assert.rejects(p, (e) => {
    assert.equal(e.name, 'AbortError', '抛的是取消，不是 503');
    assert.match(e.message, /已取消/);
    return true;
  });
  assert.equal(calls, 1, '等待期被中止：一次请求都不该再发，取消不该变成第三次撞墙');

  const ac2 = new AbortController(); ac2.abort();
  await assert.rejects(B.withBackoff(async () => { throw new Error('不该被调用'); }, { signal: ac2.signal }), /已取消/);
});

test('主进程接线：出站点走 fetchWithBackoff，判据不出现第二份实现', () => {
  assert.equal((MAIN.match(/async function fetchWithBackoff/g) || []).length, 1, '统一入口只定义一次');
  const wired = (MAIN.match(/await fetchWithBackoff\(/g) || []).length;
  assert.ok(wired >= 8, 'AI 出站点至少 8 处走退避，实测 ' + wired + ' 处');
  // 这些位置必须是流式/非流式对话、网关、Anthropic、识图、callAiOnce —— 少一个就是一处裸奔
  for (const label of ['ai:chat 网关非流式', 'ai:chat Anthropic', 'ai:chat 非流式', 'ai:chatStream', 'ai:chatStream 续写', 'ai:chatStream 无思考降级', 'fs:analyzeImage', 'callAiOnce', '网关回退']) {
    assert.ok(MAIN.includes("label: '" + label + "'"), '缺少出站点接线：' + label);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'packages/engine/ai-backoff.js')), '判定实现只能有一份，不许再开一个文件');
  assert.match(MAIN, /require\(path\.join\(__dirname, '\.\.', 'renderer', 'js', 'ai-backoff\.js'\)\)/, '主进程 require 渲染层同一份');
  // 连接性探测（测试按钮/健康检查）必须保持快速失败，不能被退避拖成 6 秒
  assert.ok(!/const response = await fetchWithBackoff\(\s*\(\) => net\.fetch\(url, \{[^}]*max_tokens: 5/.test(MAIN), '本地引擎健康探针不套退避');
});

test('流式重试把状态推给渲染层，正文一回来黄条就撤', () => {
  assert.ok(/onRetry: \(info\) => send\('status', \{/.test(MAIN), 'doStreamOnce 必须把重试事件发出去');
  const sends = (MAIN.match(/status: 'retrying'/g) || []).length;
  assert.ok(sends >= 3, '流式的三个出站点都发 retrying：' + sends);
  assert.match(MAIN, /retryCount: info\.attempt/, '事件里带第几次');
  assert.match(MAIN, /retryMax: info\.maxRetries/, '事件里带总次数上限');

  const appHasStatus = /if \(evt\.type === 'status'\) \{[\s\S]{0,220}showRetryHint\(evt\.retryCount, evt\.retryMax, evt\.delayMs\)/.test(APP);
  assert.ok(appHasStatus, '渲染层 onEvent 缺 status/retrying 分支');
  assert.match(APP, /thinking_delta'\) \{[\s\S]{0,120}?hideRetryHint\(\)/, '思考流恢复即撤条');
  assert.match(APP, /evt\.type === 'delta'\) \{\s*hideRetryHint\(\)/, '正文恢复即撤条');
  assert.match(APP, /clearInterval\(watchdog\);\s*hideRetryHint\(\)/, 'done/error/取消收尾撤条');
});

test('提示条文案与时长：网络波动，N 秒后自动重试（第 x/y 次），到点自己消失', () => {
  const s = APP.indexOf('let retryHintTimer = null;');
  const e = APP.indexOf('function addToolStep');
  assert.ok(s > 0 && e > s, 'app.js 里找不到退避提示函数');
  const src = APP.slice(s, e);
  const el = { id: 'ai-retry-hint', textContent: '', style: {} };
  const tickFns = [];
  const ctx = vm.createContext({
    el,
    document: { getElementById: () => el },
    setInterval: (fn) => { tickFns.push(fn); return tickFns.length; },
    clearInterval: () => {},
    Math, String, Number,
    __out: {},
  });
  // 一次性在同一作用域里跑完「出现 → 倒数 → 撤掉」：retryHintTimer 是模块级状态，分两次注入会各自归零
  vm.runInContext('(function(){' + src + `
    showRetryHint(1, 2, 3000);
    __out.shown = el.style.display; __out.first = el.textContent;
    hideRetryHint();
    __out.hidden = el.style.display;
  })()`, ctx);
  assert.equal(ctx.__out.first, '网络波动，3 秒后自动重试（第 1/2 次）');
  assert.equal(ctx.__out.shown, '', '出现（display 清空让 CSS 的 flex 生效）');
  assert.equal(ctx.__out.hidden, 'none', '撤掉后不留永久黄条');

  // 倒数逐秒走：用户看得见数字在动，才不会以为软件卡死
  el.textContent = ''; el.style.display = 'none'; tickFns.length = 0;
  vm.runInContext('(function(){' + src + ' showRetryHint(2, 2, 5000); })()', ctx);
  tickFns[0]();
  assert.match(el.textContent, /4 秒后自动重试（第 2\/2 次）/, '倒计时递减一格：' + el.textContent);
  tickFns[0]();
  assert.match(el.textContent, /3 秒后自动重试/, '再等一秒又减一格：' + el.textContent);

  assert.match(HTML, /id="ai-retry-hint"/, 'index.html 缺提示条容器');
  assert.ok(HTML.indexOf('js/ai-backoff.js') < HTML.indexOf('js/app.js'), 'ai-backoff.js 必须早于 app.js 加载');
  assert.match(fs.readFileSync(path.join(ROOT, 'renderer/css/style.css'), 'utf8'), /\.ai-retry-hint \{/, '样式缺失');
});

test('渲染层分类器委托同一份判据，且真的被调用（此前是零调用点的死代码）', () => {
  assert.ok(!/this\.transientPatterns = \[/.test(APP), '第二套 transient 规则必须删掉');
  assert.ok(!/this\.deterministicPatterns = \[/.test(APP), '第二套 deterministic 规则必须删掉');
  assert.match(APP, /const v = B\.classifyError\(asErr\);/, '分类交给 ai-backoff');
  const calls = (APP.match(/aiErrorClassifier\.classify\(/g) || []).length;
  assert.ok(calls >= 1, 'aiErrorClassifier 至少有一个真实调用点：' + calls);
  assert.match(APP, /verdict\.retryable === false[\s\S]{0,120}确定性失败|verdict\.retryable === false/, '确定性失败要告诉用户重发没意义');
  // 模块没加载成功时不许假装会重试（fail-closed）
  assert.match(APP, /退避模块未加载，不自动重试/);
});

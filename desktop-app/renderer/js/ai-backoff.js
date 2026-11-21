/**
 * AI 出站退避重试 —— 判定与等待，纯函数、零依赖。
 *
 * 为什么要它：429 / 5xx / 网络抖是「等一下就能过」，认证失败、参数错、上下文超限是
 * 「重发一百次也是同样错话」。以前这条判定只存在于渲染层的 AIErrorClassifier，
 * 定义完一次都没被调用过，各出站点各自把 503 当「AI 请求失败」直接抛给用户。
 * 现在判定收敛到这一份实现：主进程所有 AI 出站点用它补发，渲染层分类错误也用它，
 * 两处判据不会漂移（散在各处复制粘贴迟早会漂）。
 *
 * 只补发「还没产生任何输出」的请求 —— 正文已经吐给 UI 之后重发会出现两段答案，
 * 所以调用点包的是取响应头那一步（见 main/index.js 的 fetchWithBackoff），不是整轮对话。
 *
 * UMD：渲染层用 window.BubaiCodeAiBackoff，主进程 require 同一份实现。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BubaiCodeAiBackoff = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  const MAX_RETRIES = 2;        // 单次请求最多补发 2 次：再多就是在替上游的故障买单
  const BASE_DELAY_MS = 1500;   // 第 1 次等 1.5s、第 2 次等 3s —— 够限流窗口翻篇，又不至于让人干等
  const CAP_DELAY_MS = 30000;   // 上限：上游 Retry-After 写「一小时」也不能真等一小时
  const JITTER_RATIO = 0.25;    // 只加不减的抖动，把同时到点的客户端错开，避免第二次一起撞上限

  // 瞬态：网络层异常 + 服务端 5xx + 限流 + 超时 → 值得退避重试
  const TRANSIENT_RE = /(?:timeout|timed\s?out|超时|network|网络|fetch failed|socket hang|econnreset|econnrefused|enotfound|eai_again|etimedout|rate.?limit|too many requests|overloaded|过载|繁忙|暂时|服务不可用|不可用|unavailable|degraded|busy|capacity|500|502|503|504|529)/i;
  // 确定性：认证 / 参数 / 配额权限 / 上下文超限 / 内容过滤 / 本地文件错误 → 重试无意义，应立即把错喂回模型或终止
  const DETERMINISTIC_RE = /(?:401|403|400|invalid\s?api\s?key|api.?key|unauthorized|authentication|认证失败|forbidden|permission denied|access denied|bad request|invalid_request|非法参数|invalid parameter|prompt_too_long|context.?(?:length|window)|exceeded|too long|超限|content.?filter|unknown model|model.?not|不支持的模型|not found|不存在|未找到|outside\s?workspace|outside the workspace|积分不足|余额不足|enoent|eacces|eperm)/i;
  // 429 落在确定性正则的字面（HTTP 4xx）里，但语义是限流 → 必须抢在确定性之前判为可重试
  const RATE_LIMIT_RE = /(?:429|rate.?limit|too many requests|quota|配额)/i;
  // 取消（用户按停止 / AbortSignal）：不是错误，绝不能重试
  const CANCELLED_RE = /(?:abort|cancel|已取消|已停止|signal is aborted)/i;

  // 把错误分成 transient / deterministic / cancelled / unknown。永不抛错。
  // HTTP 状态码优先（provider 抛错时会挂上 status），没有状态码才按消息正则兜底。
  function classifyError(err) {
    if (!err) return { kind: 'unknown', isRetryable: true };
    const status = typeof err.status === 'number' ? err.status : 0;
    const msg = String(err.message || err);
    if (err.name === 'AbortError' || CANCELLED_RE.test(String(err.code || '') + ' ' + msg)) {
      return { kind: 'cancelled', isRetryable: false };
    }
    if (status >= 500 || status === 429 || status === 408) return { kind: 'transient', isRetryable: true };
    if (status >= 400 && status < 500) return { kind: 'deterministic', isRetryable: false };
    if (RATE_LIMIT_RE.test(msg)) return { kind: 'transient', isRetryable: true };
    if (TRANSIENT_RE.test(msg)) return { kind: 'transient', isRetryable: true };
    if (DETERMINISTIC_RE.test(msg)) return { kind: 'deterministic', isRetryable: false };
    // 未知错误乐观按瞬态处理：多试一次的代价远小于把一次偶发抖动报成永久故障
    return { kind: 'unknown', isRetryable: true };
  }

  // 这个 HTTP 状态值不值得重发（响应已经拿到、但 !ok 时用；不抛错的调用点走这里）
  function isRetryableStatus(status) {
    const s = Number(status);
    return s === 429 || s === 408 || (s >= 500 && s <= 599);
  }

  // 把 HTTP 状态与 Retry-After 挂到 Error 上（返回同一个实例，方便 `throw annotate(...)` 链式写）。
  // 挂了 status，classifyError 才能按状态码判而不是猜消息文案。
  function annotateError(err, status, retryAfterMs) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (status) e.status = Number(status) || 0;
    if (retryAfterMs && retryAfterMs > 0) e.retryAfterMs = Math.round(Number(retryAfterMs));
    return e;
  }

  // 解析 Retry-After。三种写法都得认：`retry-after-ms`（毫秒）、`retry-after`（秒）、
  // HTTP-date（`Wed, 21 Oct 2026 07:28:00 GMT` → 距该时刻的毫秒）。返回毫秒或 0（没有/不合理）。
  function parseRetryAfter(source) {
    const headers = source && source.headers ? source.headers : source;
    const get = (name) => {
      if (!headers) return '';
      if (typeof headers.get === 'function') {
        try { return String(headers.get(name) || ''); } catch (e) { return ''; }
      }
      // 兼容裸对象（测试与某些自造响应里直接写 { 'retry-after': '3' }）
      if (typeof headers === 'object') {
        if (headers[name] != null) return String(headers[name]);
        const lower = String(name).toLowerCase();
        if (headers[lower] != null) return String(headers[lower]);
      }
      return '';
    };
    const msRaw = get('retry-after-ms');
    if (msRaw !== '' && Number.isFinite(Number(msRaw)) && Number(msRaw) > 0) return Math.round(Number(msRaw));
    const secRaw = get('retry-after');
    if (secRaw === '') return 0;
    const sec = Number(secRaw);
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    const when = Date.parse(secRaw);
    if (Number.isFinite(when)) {
      const wait = when - Date.now();
      if (wait > 0) return Math.round(wait);
    }
    return 0;
  }

  // 第 attempt 次（从 1 数）重试要等多久：阶梯基数与 Retry-After 取较大者，再叠只加不减的抖动，最后封顶。
  // Retry-After 只在「比我们的阶梯更长」时才说话 —— 上游写 0 秒不代表我们该立刻再撞一次。
  function backoffDelayMs(attempt, retryAfterMs, random) {
    const rnd = typeof random === 'function' ? random : Math.random;
    const n = Math.max(1, Math.floor(Number(attempt)) || 1);
    const base = BASE_DELAY_MS * Math.min(n, MAX_RETRIES);
    const upstream = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : 0;
    const jittered = base + rnd() * (base * JITTER_RATIO);
    return Math.min(CAP_DELAY_MS, Math.round(Math.max(jittered, upstream)));
  }

  function cancelError() {
    const e = new Error('已取消');
    e.name = 'AbortError';
    return e;
  }

  // 可取消的等待：signal 已经/中途触发就立刻 reject；正常醒来先把监听器摘掉（否则会攒泄漏）。
  function sleepCancelled(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(cancelError()); return; }
      let timer = null;
      const onAbort = () => { clearTimeout(timer); reject(cancelError()); };
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, Math.round(Number(ms)) || 0));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // 退避重试的总入口：task 抛错 → 分类 → 可重试且还有额度 → 通知一次（给 UI 出「N 秒后自动重试」）→ 等 → 再来。
  // 不可重试 / 额度用完 / 已取消，一律把**原始错误**原样抛出，让各调用点现有的错话保持不变。
  async function withBackoff(task, opts) {
    const o = opts || {};
    const maxRetries = Number.isFinite(Number(o.maxRetries))
      ? Math.max(0, Math.min(Number(o.maxRetries), MAX_RETRIES))
      : MAX_RETRIES;
    const signal = o.signal || null;
    const onRetry = typeof o.onRetry === 'function' ? o.onRetry : () => {};
    let attempt = 0;
    for (;;) {
      if (signal && signal.aborted) throw cancelError();
      try {
        return await task(attempt);
      } catch (err) {
        const verdict = classifyError(err);
        if (!verdict.isRetryable) throw err;
        attempt++;
        if (attempt > maxRetries || (signal && signal.aborted)) throw err;
        const delayMs = backoffDelayMs(attempt, err && err.retryAfterMs, o.random);
        onRetry({ attempt, maxRetries, delayMs, kind: verdict.kind, error: err });
        await sleepCancelled(delayMs, signal);
      }
    }
  }

  return {
    MAX_RETRIES,
    BASE_DELAY_MS,
    CAP_DELAY_MS,
    classifyError,
    isRetryableStatus,
    annotateError,
    parseRetryAfter,
    backoffDelayMs,
    sleepCancelled,
    withBackoff,
  };
});

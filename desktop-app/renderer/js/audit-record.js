/**
 * 审批审计记录（UMD，主进程 require + 渲染层 <script>，对齐 ai-backoff.js 的双载模式）。
 * 存在的理由只有一个：落盘前「脱敏规则」和「取值闭集」必须有且只有一份实现，
 * 否则渲染层记成 ***REDACTED***、主进程把同一条命令原文写进磁盘，等于审计自己泄密。
 * ALIGN_LEDGER R2。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.BubaiAuditRecord = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REDACTED = '***REDACTED***';

  // 键名比较前先去掉大小写与下划线/连字符：apiKey / api_key / API-KEY 是同一个东西
  var SECRET_KEYS = [
    'apikey', 'password', 'passwd', 'pwd', 'token', 'refreshtoken', 'accesstoken',
    'secret', 'secretkey', 'accesskey', 'key', 'authorization', 'auth', 'cookie', 'privatekey'
  ];

  // 值里嵌的密钥（命令串、URL、header）没有键名可依，只能按形态抓
  var BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
  var INLINE_RE = /([\w"'-]*(?:api[_-]?key|secret[_-]?key|access[_-]?key|accesskey|secret|token|password|passwd|pwd|private[_-]?key|authorization)[\w"'-]*\s*[:=]\s*["']?)(\S{4,})/gi;

  var MAX_TEXT_CHARS = 1000;
  var MAX_DEPTH = 4;
  var MAX_ARRAY = 50;

  // 两个轴的闭集分开列：agent 轴记「用户怎么处置」，guard 轴记「护栏怎么判」
  var APPROVAL_OUTCOMES = ['allowed-once', 'allowed-session', 'allowed-always', 'rejected', 'cancelled', 'unavailable'];
  var GUARD_OUTCOMES = ['blocked-deny', 'blocked-confirm', 'forced'];
  var DECISIONS = ['allow', 'ask', 'deny'];
  var VERDICTS = ['allow', 'confirm', 'deny'];
  var EVENT_KINDS = ['decision', 'outcome', 'guard'];

  function isSecretKey(key) {
    return SECRET_KEYS.indexOf(String(key == null ? '' : key).toLowerCase().replace(/[_\-\s]/g, '')) !== -1;
  }

  function redactText(text) {
    var s = String(text == null ? '' : text);
    s = s.replace(BEARER_RE, '$1' + REDACTED);
    s = s.replace(INLINE_RE, '$1' + REDACTED);
    // 换行折叠：JSON.stringify 已保证「一条记录一行」，这里是为了面板不被一条长命令撑散
    s = s.replace(/[\r\n]+/g, ' ');
    if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS) + '…[截断]';
    return s;
  }

  function redactValue(value, depth) {
    var d = depth || 0;
    if (value == null) return value;
    if (typeof value === 'string') return redactText(value);
    if (typeof value !== 'object') return value;
    if (d >= MAX_DEPTH) return Array.isArray(value) ? '[array]' : '[object]';
    if (Array.isArray(value)) {
      var arr = value.slice(0, MAX_ARRAY).map(function (v) { return redactValue(v, d + 1); });
      if (value.length > MAX_ARRAY) arr.push('…[共 ' + value.length + ' 项]');
      return arr;
    }
    var out = {};
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      out[key] = isSecretKey(key) ? REDACTED : redactValue(value[key], d + 1);
    }
    return out;
  }

  // 工具参数 / 命令的单一脱敏入口
  function redactArgs(args) {
    return redactValue(args, 0);
  }

  function normalizeOutcome(outcome, list) {
    var allowed = list || APPROVAL_OUTCOMES;
    return allowed.indexOf(outcome) !== -1 ? outcome : 'rejected';
  }

  // 护栏结论 → 事件。allow 不该到这里（没发生决策），来错了也照样如实记。
  function guardOutcome(verdict, force) {
    if (verdict === 'deny') return 'blocked-deny';
    return force ? 'forced' : 'blocked-confirm';
  }

  function buildGuardEvent(command, cwd, verdict, reason, force) {
    var v = VERDICTS.indexOf(String(verdict || '')) !== -1 ? String(verdict) : 'allow';
    return {
      kind: 'guard',
      tool: 'terminal',
      verdict: v,
      outcome: guardOutcome(v, force === true),
      reason: redactText(reason),
      command: redactText(command),
      cwd: redactText(cwd),
      ts: Date.now()
    };
  }

  // 主进程收到 IPC 事件时的白名单重建：字段只认这几个，值一律再过一遍脱敏。
  // 渲染层被什么代码污染了都写不出带原文密钥的行。
  function normalizeEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var kind = EVENT_KINDS.indexOf(ev.kind) !== -1 ? ev.kind : '';
    if (!kind) return null;
    var out = {
      kind: kind,
      tool: redactText(ev.tool).slice(0, 80),
      ts: Number.isFinite(ev.ts) ? Math.floor(ev.ts) : Date.now()
    };
    if (kind === 'decision') {
      out.decision = DECISIONS.indexOf(ev.decision) !== -1 ? ev.decision : 'ask';
      out.mode = redactText(ev.mode).slice(0, 40);
      out.reason = redactText(ev.reason);
      out.args = redactArgs(ev.args);
      out.timestamp = redactText(ev.timestamp).slice(0, 40);
    } else if (kind === 'outcome') {
      out.outcome = normalizeOutcome(ev.outcome, APPROVAL_OUTCOMES);
      out.reason = redactText(ev.reason);
      out.timestamp = redactText(ev.timestamp).slice(0, 40);
    } else {
      out.verdict = VERDICTS.indexOf(ev.verdict) !== -1 ? ev.verdict : 'allow';
      // 护栏轴的 outcome 不认 rejected（那是 agent 轴的处置），乱值按 verdict 重新推导，
      // 且不带 force ——把「说不清的 force」降级成「被拦下」，宁可少记一次放行
      out.outcome = GUARD_OUTCOMES.indexOf(ev.outcome) !== -1 ? ev.outcome : guardOutcome(out.verdict, false);
      out.reason = redactText(ev.reason);
      out.command = redactText(ev.command);
      out.cwd = redactText(ev.cwd);
    }
    return out;
  }

  return {
    REDACTED: REDACTED,
    SECRET_KEYS: SECRET_KEYS,
    APPROVAL_OUTCOMES: APPROVAL_OUTCOMES,
    GUARD_OUTCOMES: GUARD_OUTCOMES,
    DECISIONS: DECISIONS,
    VERDICTS: VERDICTS,
    EVENT_KINDS: EVENT_KINDS,
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    isSecretKey: isSecretKey,
    redactText: redactText,
    redactArgs: redactArgs,
    normalizeOutcome: normalizeOutcome,
    guardOutcome: guardOutcome,
    buildGuardEvent: buildGuardEvent,
    normalizeEvent: normalizeEvent
  };
});

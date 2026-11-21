/**
 * 审批审计落盘（ALIGN_LEDGER R2）。
 * 一行一个事件的 JSONL，按天切文件：<userData>/audit/approval-YYYY-MM-DD.jsonl
 * 只追加、不改写历史 —— 审计文件要能被 text editor / grep 直接看，格式越笨越好。
 * 任何 IO 失败都是 fail-open：记账失败绝不能让用户跑不了命令。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AR = require('../renderer/js/audit-record.js');

const FILE_RE = /^approval-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RETENTION_DAYS = 30;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

let dirOverride = '';
let pruned = false;

function getDir() {
  if (dirOverride) return dirOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'audit');
}

// 门禁测试注入临时目录用；生产代码不传
function setDirForTest(dir) {
  dirOverride = dir || '';
  pruned = false;
}

function dayKey(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 过期清理只在进程首次写入时跑一次：审计不是备份，30 天前的审批记录没人回头查
function pruneExpired() {
  if (pruned) return;
  pruned = true;
  try {
    const dir = getDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(dir)) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      if (new Date(m[1] + 'T23:59:59').getTime() >= cutoff) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) {}
    }
  } catch (e) {
    console.warn('[audit-store] 过期清理失败（不影响写入）: ' + (e && e.message));
  }
}

/**
 * 追加一条事件（护栏轴 / agent 轴共用）。
 * @returns {{ok:boolean, error?:string}}
 */
function appendEvent(ev) {
  let line;
  try {
    const clean = AR.normalizeEvent(ev);
    if (!clean) return { ok: false, error: '不是合法的审计事件（缺 kind 或 kind 不在闭集）' };
    line = JSON.stringify(clean) + '\n';
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
  try {
    pruneExpired();
    const dir = getDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'approval-' + dayKey(Date.now()) + '.jsonl'), line, 'utf8');
    return { ok: true };
  } catch (e) {
    console.warn('[audit-store] 写入失败: ' + (e && e.message));
    return { ok: false, error: String(e && e.message) };
  }
}

// 护栏出结论 → 事件（terminal.js 唯一的调用入口，判定还是 guard.checkCommand 说了算）
function recordGuardVerdict(command, cwd, verdict, reason, force) {
  return appendEvent(AR.buildGuardEvent(command, cwd, verdict, reason, force));
}

/**
 * 读历史事件，返回时间升序（面板直接按这个顺序显示）。
 * @param {{limit?:number, days?:number}} filter
 */
function listEvents(filter) {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number((filter && filter.limit) || DEFAULT_LIMIT)));
  const days = Number((filter && filter.days) || 0);
  const oldestDay = days > 0 ? dayKey(Date.now() - days * 86400000) : '';
  try {
    const dir = getDir();
    if (!fs.existsSync(dir)) return { ok: true, events: [], files: [], skipped: 0 };
    const names = fs.readdirSync(dir)
      .map((n) => FILE_RE.exec(n))
      .filter(Boolean)
      .map((m) => m[0])
      .sort()
      .reverse();
    const events = [];
    const files = [];
    let skipped = 0;
    for (const name of names) {
      const day = name.slice('approval-'.length, -'.jsonl'.length);
      if (oldestDay && day < oldestDay) break;
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (e) {
        skipped++;
        continue;
      }
      const dayEvents = [];
      for (const raw of text.split('\n')) {
        const s = raw.trim();
        if (!s) continue;
        let parsed = null;
        try { parsed = AR.normalizeEvent(JSON.parse(s)); } catch (e) { parsed = null; }
        if (!parsed) { skipped++; continue; }
        dayEvents.push(parsed);
      }
      if (dayEvents.length) files.push(name);
      // 从最新一天往回收集，够数就停
      for (let i = dayEvents.length - 1; i >= 0 && events.length < limit; i--) events.push(dayEvents[i]);
    }
    return { ok: true, events: events.reverse(), files, skipped, limit };
  } catch (e) {
    return { ok: false, events: [], files: [], skipped: 0, error: String(e && e.message) };
  }
}

function clearEvents() {
  try {
    const dir = getDir();
    if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!FILE_RE.test(name)) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch (e) {}
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, removed: 0, error: String(e && e.message) };
  }
}

module.exports = {
  getDir,
  setDirForTest,
  appendEvent,
  recordGuardVerdict,
  listEvents,
  clearEvents,
  RETENTION_DAYS
};

/**
 * Git 冲突标记（<<<<<<< / ======= / >>>>>>> / |||||||）的解析与解决 —— 纯函数、零依赖。
 *
 * 对齐参考基线 conflict-markers 的三条安全性质：
 * 1. 不猜：标记不成对（缺 `=======`、缺 `>>>>>>>`、嵌套 `<<<<<<<`）时不编造区域，
 *    只如实返回 malformed，由调用方拒绝写盘。
 * 2. 解决后必须再验一次：结果仍含标记（模型残留、畸形区域）不得写盘 —— hasConflictMarkers。
 * 3. 只认行首 7 个字符：`<<<<<<<` 出现在行中间（注释、字符串）不算标记，这也是 git 自己的判据。
 *
 * 另外两条来自实测教训的硬约束：
 * - diff3 风格（merge.conflictStyle=diff3/zdiff3 的 `|||||||` 基线段）必须一起认，
 *   否则只认三段的解析会把基线段当成「我的」内容，静默产出错误结果。
 * - 行尾逐行保真：解析阶段要剥 `\r`，但写回时非冲突区仍带原 `\r\n`，
 *   若解决区只剩 `\n` 就造出混合行尾，在 autocrlf=false / eol=crlf 的仓库里会凭空多出一份 diff。
 *
 * 变基（git rebase / git pull --rebase）期间 git 把 HEAD 挪到对方提交上，两侧身份是反的：
 * 此时 ours 是远端、theirs 才是用户自己。调用方（知道仓库处于什么操作态）传 swapSides: true，
 * 交换后本模块对外恒定的语义就是「ours = 用户的、theirs = 别人的」。
 * ⚠️ 解析（展示）与解决（写盘）必须传同一个值，一个换一个不换等于把用户改动反向写回。
 *
 * UMD：渲染层用 window.BubaiCodeConflict，主进程 require 同一份实现（避免两处判据漂移）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BubaiCodeConflict = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  var MARK_LEN = 7;

  /** 行首是否为标记行；返回标记字符与标签（行内非标记返回 null） */
  function markerOf(line) {
    var s = String(line == null ? '' : line).replace(/\r$/, '');
    if (s.length < MARK_LEN) return null;
    var ch = s.charAt(0);
    if (ch !== '<' && ch !== '=' && ch !== '>' && ch !== '|') return null;
    for (var i = 1; i < MARK_LEN; i++) { if (s.charAt(i) !== ch) return null; }
    return { ch: ch, label: s.slice(MARK_LEN).trim() };
  }

  /** 快速判据：文本里还有冲突标记吗（写盘前的最后一道闸） */
  function hasConflictMarkers(text) {
    var lines = String(text == null ? '' : text).split('\n');
    for (var i = 0; i < lines.length; i++) { if (markerOf(lines[i])) return true; }
    return false;
  }

  /**
   * 解析冲突区域。返回 { hasMarkers, malformed, regions }；
   * malformed 时 regions 里仍带已解析出的区域（供界面指出哪里坏了），但不得据此写盘。
   * region: { index, startLine, endLine, oursLabel, theirsLabel, ours:{startLine,endLine,lines}, theirs:{...}, base?:{...} }
   * 行号一律 1-based，指向内容行（不含标记行）。
   */
  function parseConflictMarkers(text, opts) {
    var swap = !!(opts && opts.swapSides);
    var lines = String(text == null ? '' : text).split('\n').map(function (l) { return l.replace(/\r$/, ''); });
    var regions = [];
    var hasMarkers = false;
    var malformed = false;
    var i = 0;
    while (i < lines.length) {
      var m = markerOf(lines[i]);
      if (!m || m.ch !== '<') { i++; continue; }
      hasMarkers = true;
      var startIdx = i;
      var oursLabel = m.label;
      var ours = [], base = [], theirs = [];
      var phase = 'ours';
      var oursStart = 0, oursEnd = 0, baseStart = 0, baseEnd = 0, theirsStart = 0, theirsEnd = 0;
      var endIdx = -1;
      for (var j = i + 1; j < lines.length; j++) {
        var mm = markerOf(lines[j]);
        if (mm && mm.ch === '<') { malformed = true; break; }
        if (mm && mm.ch === '|' && phase === 'ours') {
          // 必须先记下 ours 区间：diff3 下进入 base 相后，下面的 `=======` 分支不会再补这一次
          oursStart = startIdx + 2;
          oursEnd = j;
          phase = 'base';
          baseStart = j + 2;
          continue;
        }
        if (mm && mm.ch === '=' && phase !== 'theirs') {
          if (phase === 'ours') { oursStart = startIdx + 2; oursEnd = j; } else { baseEnd = j; }
          phase = 'theirs';
          theirsStart = j + 2;
          continue;
        }
        if (mm && mm.ch === '>') {
          if (phase === 'theirs') theirsEnd = j;
          else if (phase === 'base') baseEnd = j;
          else oursEnd = j;
          endIdx = j;
          break;
        }
        if (phase === 'ours') ours.push(lines[j]);
        else if (phase === 'base') base.push(lines[j]);
        else theirs.push(lines[j]);
      }
      // 没有配对的 `>>>>>>>`，或没有 `=======` 分隔 → 畸形，就地中止（不猜）
      if (endIdx < 0 || theirsStart === 0) { malformed = true; break; }
      var region = {
        index: regions.length,
        startLine: startIdx + 1,
        endLine: endIdx + 1,
        oursLabel: oursLabel,
        theirsLabel: (markerOf(lines[endIdx]) || { label: '' }).label,
        ours: { startLine: oursStart, endLine: Math.max(oursStart, oursEnd), lines: ours },
        theirs: { startLine: theirsStart, endLine: Math.max(theirsStart, theirsEnd), lines: theirs }
      };
      if (baseStart) region.base = { startLine: baseStart, endLine: Math.max(baseStart, baseEnd), lines: base };
      if (swap) {
        var o = region.ours; region.ours = region.theirs; region.theirs = o;
        var l = region.oursLabel; region.oursLabel = region.theirsLabel; region.theirsLabel = l;
      }
      regions.push(region);
      i = endIdx + 1;
    }
    return { hasMarkers: hasMarkers, malformed: malformed, regions: regions };
  }

  var PICK_KEYWORDS = { ours: 1, theirs: 1, both: 1 };

  /**
   * 按每处选择替换冲突区域，返回解决后的文本。
   * choices[i] ∈ 'ours'|'theirs'|'both'，或一段自定义正文（AI 合并结果走这条路，同样享受行尾保真）。
   * 畸形文本抛错；choices 数目与区域数目不一致抛错 —— 绝不「缺的当 ours 用」，那会静默丢掉一侧改动。
   */
  function resolveConflicts(text, choices, opts) {
    var parsed = parseConflictMarkers(text, opts);
    if (parsed.malformed) throw new Error('冲突标记不成对，无法可靠解决（请手工处理）');
    var picks = choices || [];
    if (picks.length !== parsed.regions.length) {
      throw new Error('选择数目（' + picks.length + '）与冲突区域数目（' + parsed.regions.length + '）不一致');
    }
    var raw = String(text == null ? '' : text);
    var parts = raw.split('\n');
    /** 第 i 行（0-based）自己的行尾；越界或最后一段不带换行 → '' */
    var eolAt = function (idx) {
      if (idx < 0 || idx >= parts.length - 1) return '';
      return parts[idx].slice(-1) === '\r' ? '\r\n' : '\n';
    };
    var at = function (idx) { return (parts[idx] == null ? '' : parts[idx]).replace(/\r$/, ''); };
    var out = [];
    var cursor = 0;
    parsed.regions.forEach(function (r) {
      var startIdx = r.startLine - 1;
      var endIdx = r.endLine - 1;
      for (; cursor < startIdx; cursor++) out.push(at(cursor) + eolAt(cursor));
      // 插入行的行尾优先取 `<<<<<<<` 那行（git 按本文件约定写出来的），逐级兜底
      var eol = eolAt(startIdx) || eolAt(cursor - 1) || eolAt(endIdx) || '\n';
      var pick = picks[r.index];
      if (pick == null || typeof pick !== 'string') throw new Error('第 ' + (r.index + 1) + ' 处冲突缺少有效选择');
      if (PICK_KEYWORDS[pick]) {
        if (pick === 'ours' || pick === 'both') {
          for (var a = 0; a < r.ours.lines.length; a++) out.push(r.ours.lines[a] + eol);
        }
        if (pick === 'theirs' || pick === 'both') {
          for (var b = 0; b < r.theirs.lines.length; b++) out.push(r.theirs.lines[b] + eol);
        }
      } else {
        // 自定义正文：按插入位置的行尾拆开，避免把模型的 \n 混进 CRLF 文件
        var body = pick.replace(/\r\n/g, '\n').split('\n');
        for (var c = 0; c < body.length; c++) out.push(body[c] + eol);
      }
      cursor = endIdx + 1;
    });
    for (; cursor < parts.length; cursor++) out.push(at(cursor) + eolAt(cursor));
    var resolved = out.join('');
    // 原文没有尾换行 → 结果也不能凭空多一个
    if (!raw.endsWith('\n') && /(\r?\n)$/.test(resolved)) resolved = resolved.replace(/\r?\n$/, '');
    return resolved;
  }

  /** 界面用的一句话摘要 */
  function summarizeConflicts(parsed) {
    if (parsed && parsed.malformed) return '冲突标记不成对（畸形），无法自动解决';
    var n = (parsed && parsed.regions ? parsed.regions.length : 0);
    if (!n) return '没有冲突区域';
    return n + ' 处冲突';
  }

  return {
    MARK_LEN: MARK_LEN,
    markerOf: markerOf,
    hasConflictMarkers: hasConflictMarkers,
    parseConflictMarkers: parseConflictMarkers,
    resolveConflicts: resolveConflicts,
    summarizeConflicts: summarizeConflicts
  };
});

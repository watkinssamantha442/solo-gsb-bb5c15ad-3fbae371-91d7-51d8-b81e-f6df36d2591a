/*
 * layout.js —— 展签排版核心算法（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 分词规则：
 *   1. 英文单词（连续拉丁字母/数字及单词内部连字符、撇号）为不可拆整体；
 *   2. 每个汉字为一个可断点的独立 token；
 *   3. 闭标点（、。，！？：；）”’】》〉…—· 等）不得出现在行首；
 *      开标点（“‘【《〈 等）不得出现在行尾；
 *   4. 连续空白合并为一个空格，换行符作为强制分段。
 *
 * 断行算法：动态规划。在满足宽度与标点规则的所有可行排法中，
 * 最小化「非末行的空白宽度平方和」（与 TeX 段落断行同一思想），
 * 代价比相同时取行数更少、断点更靠右的方案，保证结果确定唯一。
 */
(function (global) {
  'use strict';

  var PX_PER_MM = 96 / 25.4; // CSS 标准：1mm = 96/25.4 px ≈ 3.7795px

  // ---------- 标点集合（按码位构造，支持 BMP 与增补平面） ----------
  function codeSet(str) {
    var set = Object.create(null);
    var cp = Array.from(str);
    for (var i = 0; i < cp.length; i++) set[cp[i].codePointAt(0)] = true;
    return set;
  }

  // 开标点（含左括号、左引号）：不得置于行尾
  var OPEN_CHARS =
    '“‘〖【《〈「『｟（〔［｛([{';
  var OPEN_SET = codeSet(OPEN_CHARS);

  // 闭标点（含句读点、右括号、右引号、省略号/破折号等）：不得置于行首
  var CLOSE_CHARS =
    '”’〗】》〉」』｠）〕］｝)]}' +
    '、。，．！？：；.,!?;:' +
    '…—–·・‥～〽′″〟»' +
    '％%‰℃℉°＇›';
  var CLOSE_SET = codeSet(CLOSE_CHARS);

  var SPACE_CODES = (function () {
    var s = Object.create(null);
    [0x20, 0x09, 0x0b, 0x0c, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
     0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f,
     0x3000].forEach(function (c) { s[c] = true; });
    return s;
  })();

  // 构成英文单词的码位：拉丁字母（含扩展区）、数字、单词内部的 - / '
  function isWordCode(ch) {
    if (ch === 0x2d || ch === 0x27 || ch === 0x2010 || ch === 0x2011 ||
        ch === 0x2012 || ch === 0x2013 || ch === 0x2019) {
      return true;
    }
    if (ch >= 0x30 && ch <= 0x39) return true;            // 0-9
    if (ch >= 0x41 && ch <= 0x5a) return true;            // A-Z
    if (ch >= 0x61 && ch <= 0x7a) return true;            // a-z
    if (ch >= 0xc0 && ch <= 0x024f) return true;          // 拉丁扩展
    if (ch >= 0x1e00 && ch <= 0x1eff) return true;        // 拉丁扩展增补
    if (ch >= 0x2c60 && ch <= 0x2c7f) return true;        // 拉丁扩展-C
    if (ch >= 0xa720 && ch <= 0xa7ff) return true;        // 拉丁扩展-D
    if (ch >= 0xab30 && ch <= 0xab6f) return true;        // 拉丁扩展-E
    if (ch >= 0xff10 && ch <= 0xff19) return true;        // 全角数字
    if (ch >= 0xff21 && ch <= 0xff3a) return true;        // 全角大写
    if (ch >= 0xff41 && ch <= 0xff5a) return true;        // 全角小写
    return false;
  }

  // 全角样式的拉丁/数字在排版中等价于普通词字符
  function isCJKCode(ch) {
    return (
      (ch >= 0x2e80 && ch <= 0x9fff) ||   // CJK 部首/汉字（含假名 0x3040 区段、兼容）
      (ch >= 0x3040 && ch <= 0x30ff) ||   // 平假名、片假名
      (ch >= 0x3400 && ch <= 0x4dbf) ||   // 扩展 A
      (ch >= 0xf900 && ch <= 0xfaff) ||   // 兼容汉字
      (ch >= 0x20000 && ch <= 0x2a6df) ||
      (ch >= 0x2a700 && ch <= 0x2b73f) ||
      (ch >= 0x2b740 && ch <= 0x2b81f) ||
      (ch >= 0x2b820 && ch <= 0x2ceaf) ||
      (ch >= 0x30000 && ch <= 0x3134f)
    );
  }

  function typeOf(ch) {
    if (SPACE_CODES[ch]) return 'space';
    if (OPEN_SET[ch]) return 'open';
    if (CLOSE_SET[ch]) return 'close';
    if (isWordCode(ch)) return 'word';
    return 'char'; // 汉字及其他字符：按不可再分、两侧可断处理
  }

  /**
   * 分词 → 段落数组。返回 Array<Array<Token>>，每个 token：
   * { t: 文本, type: 'word'|'char'|'open'|'close'|'space', ch: 码位 }
   * 已去除空段、合并连续空白、去掉段首尾空白。
   */
  function tokenize(text) {
    var paragraphs = [];
    var cur = null;

    function flush() {
      if (cur && cur.length) paragraphs.push(cur);
      cur = null;
    }

    var chars = Array.from(String(text == null ? '' : text));
    for (var i = 0; i < chars.length; i++) {
      var raw = chars[i];
      var ch = raw.codePointAt(0);

      if (ch === 0x0a || ch === 0x0d) {
        if (ch === 0x0d && chars[i + 1] && chars[i + 1].codePointAt(0) === 0x0a) i++;
        flush();
        continue;
      }

      var type = typeOf(ch);
      if (type === 'space') {
        if (cur && cur.length && cur[cur.length - 1].type !== 'space') {
          cur.push({ t: ' ', type: 'space', ch: 0x20 });
        }
        continue;
      }

      if (!cur) cur = [];

      if (type === 'word') {
        // 合并连续词字符（含词内 - '），遇到标点/空格/汉字即停止
        var s = raw;
        while (i + 1 < chars.length) {
          var nch = chars[i + 1].codePointAt(0);
          if (!isWordCode(nch)) break;
          s += chars[++i];
        }
        cur.push({ t: s, type: 'word', ch: s.codePointAt(0) });
      } else if (isCJKCode(ch) || type === 'open' || type === 'close') {
        cur.push({ t: raw, type: type === 'char' ? 'char' : type, ch: ch });
      } else {
        cur.push({ t: raw, type: 'char', ch: ch });
      }
    }
    flush();

    // 去掉每段首尾空格 token
    return paragraphs.map(function (tokens) {
      var a = 0, b = tokens.length;
      while (a < b && tokens[a].type === 'space') a++;
      while (b > a && tokens[b - 1].type === 'space') b--;
      return tokens.slice(a, b);
    }).filter(function (tokens) { return tokens.length > 0; });
  }

  var DASH_CHARS = (function () {
    var s = Object.create(null);
    [0x2014, 0x2015, 0x2013, 0x2012].forEach(function (c) { s[c] = true; });
    return s;
  })();

  /**
   * 单段动态规划断行。
   * @param {Token[]} tokens   已分段的 token
   * @param {number} maxWidth  行宽（px）
   * @param {(s:string)=>number} measure 文本宽度函数（px）
   * @param {boolean} lastLineFree 末行是否不计空白代价（正文最后一段为 true）
   * @returns {{lines:string[], widths:number[], tokens:Token[][]}|null}
   *          放不下（存在超过行宽的不可拆整体）时返回 null
   */
  function planParagraph(tokens, maxWidth, measure, lastLineFree) {
    var n = tokens.length;
    if (n === 0) return { lines: [], widths: [], tokens: [] };

    // 预处理：左右最近的非空格 token 下标，用于跨行标点判断
    var prevNonSpace = new Int32Array(n);
    var nextNonSpace = new Int32Array(n);
    var p = -1;
    for (var i = 0; i < n; i++) {
      prevNonSpace[i] = p;
      if (tokens[i].type !== 'space') p = i;
    }
    var q = n;
    for (var j = n - 1; j >= 0; j--) {
      nextNonSpace[j] = q;
      if (tokens[j].type !== 'space') q = j;
    }

    // w[i] = token 宽度
    var w = new Array(n);
    for (var k = 0; k < n; k++) {
      w[k] = tokens[k].type === 'space' ? measure(' ') : measure(tokens[k].t);
      if (w[k] > maxWidth + 0.5 && tokens[k].type !== 'space') return null; // 整体超宽
    }

    function canBreakBetween(a, b) {
      if (a < 0 || b >= n) return true;
      var L = tokens[a], R = tokens[b];
      // 左侧最后一个可见 token 不能是开标点（开标点不在行尾）
      if (L.type === 'open') return false;
      // 右侧第一个可见 token 不能是闭标点（闭标点不在行首）
      if (R.type === 'close') return false;
      // 两个成对标点（破折号/省略号）不可拆为两行
      if (DASH_CHARS[L.ch] && DASH_CHARS[R.ch]) return false;
      if (L.ch === 0x2026 && R.ch === 0x2026) return false;
      return true;
    }

    var INF = Infinity;
    var cost = new Array(n + 1); // cost[i]：排好 tokens[0..i-1] 的最小代价
    var link = new Int32Array(n + 1);
    var linesEnding = new Int32Array(n + 1);
    for (var c = 0; c <= n; c++) { cost[c] = INF; link[c] = -1; }
    cost[0] = 0;
    linesEnding[0] = 0;

    for (var end = 1; end <= n; end++) {
      // 从 end-1 向左枚举起点 start，行内容为 tokens[start..end-1]。
      // 增量维护「可见宽度」：行首空格不计，两个可见 token 之间的空格计入。
      var lineWidth = 0;
      var seenVisible = false;   // 当前窗口中是否已遇到可见 token
      var pendingSpace = 0;      // 已遇到可见 token 之后、下一个可见 token 之前的空格宽
      var visEnd = end;          // 窗口内最后一个可见 token 下标
      for (var start = end - 1; start >= 0; start--) {
        var tok = tokens[start];
        if (tok.type === 'space') {
          if (seenVisible) pendingSpace += w[start];
        } else {
          if (!seenVisible) visEnd = start;
          lineWidth += w[start] + pendingSpace;
          pendingSpace = 0;
          seenVisible = true;
        }
        if (lineWidth > maxWidth + 0.5) break;
        if (!seenVisible) continue; // 窗口只有空格

        var visStart = start;
        while (tokens[visStart].type === 'space') visStart++;

        var isLastLine = (visEnd === n - 1);
        var slack = maxWidth - lineWidth;

        // 断点合法性：行尾可见 token 与下一段可见 token 之间
        var nextVis = nextNonSpace[visEnd];
        var prevVis = prevNonSpace[visStart];
        if (!canBreakBetween(visEnd, nextVis)) continue;
        if (start > 0 && prevVis >= 0) {
          if (!canBreakBetween(prevVis, visStart)) continue;
        }

        if (cost[start] === INF) continue;

        var edge = (isLastLine && lastLineFree) ? 0 : slack * slack;
        var cand = cost[start] + edge;
        var candLines = linesEnding[start] + 1;
        var better =
          cand < cost[end] ||
          (cand === cost[end] &&
            (candLines < linesEnding[end] ||
              (candLines === linesEnding[end] && link[end] < start)));
        if (better) {
          cost[end] = cand;
          link[end] = start;
          linesEnding[end] = candLines;
        }
      }
    }

    if (link[n] < 0 && n > 0) return null;

    // 回溯
    var ranges = [];
    var e = n;
    while (e > 0) {
      var s = link[e];
      ranges.push([s, e]);
      e = s;
    }
    ranges.reverse();

    var result = { lines: [], widths: [], tokens: [] };
    ranges.forEach(function (rg) {
      var seg = tokens.slice(rg[0], rg[1]);
      // 去掉行首行尾空格（已由断点规则保证不出现，这里兜底）
      var a = 0, b = seg.length;
      while (a < b && seg[a].type === 'space') a++;
      while (b > a && seg[b - 1].type === 'space') b--;
      seg = seg.slice(a, b);
      var lw = 0, seen = false;
      seg.forEach(function (tk) {
        if (tk.type === 'space') { if (seen) lw += measure(' '); }
        else { lw += measure(tk.t); seen = true; }
      });
      result.lines.push(seg.map(function (t) { return t.t; }).join(''));
      result.widths.push(lw);
      result.tokens.push(seg);
    });
    return result;
  }

  /**
   * 多段排版。最后一段的末行不计空白代价。
   * @returns {{ paragraphs: Array<{lines:string[],widths:number[]}>,
   *            totalLines:number, maxLineWidth:number }|null}
   */
  function planText(text, maxWidth, measure) {
    var paras = tokenize(text);
    var out = [];
    var totalLines = 0;
    var maxLineWidth = 0;
    for (var i = 0; i < paras.length; i++) {
      var r = planParagraph(paras[i], maxWidth, measure, i === paras.length - 1);
      if (!r) return null;
      out.push({ lines: r.lines, widths: r.widths, tokens: r.tokens });
      totalLines += r.lines.length;
      r.widths.forEach(function (wd) { if (wd > maxLineWidth) maxLineWidth = wd; });
    }
    return { paragraphs: out, totalLines: totalLines, maxLineWidth: maxLineWidth };
  }

  var api = {
    PX_PER_MM: PX_PER_MM,
    tokenize: tokenize,
    planParagraph: planParagraph,
    planText: planText,
    isWordCode: isWordCode,
    isCJKCode: isCJKCode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);

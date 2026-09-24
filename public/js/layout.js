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
 * 专名保护：parseProtectTable 解析保护表（每行一词、去空行/去重、
 *   空白与长度校验）；applyProtection 在每个段落内从左到右贪婪匹配，
 *   同位置取最长词、同长按录入顺序，已匹配字符不再参与匹配，
 *   命中的词合并为不可断行的 protect token，其首尾边界仍参与避头尾判断。
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

  // ---------- 中文专名保护表 ----------
  var PROTECT_MAX_WORDS = 20;
  var PROTECT_MAX_LEN = 12; // 每个词最多 12 个 Unicode 字符（码位）

  // 含「换行以外的空白」：空格/制表符等不得出现在词中（换行已先行分段）
  var NON_NEWLINE_WS = /[^\S\r\n]/;

  /**
   * 解析保护表文本。
   * 规则：每行一个词；空行（含仅空白字符的行）忽略；重复词去重
   *      （保留首次录入位置，决定同长匹配顺序）；
   *      含换行以外空白的词报错；每个词 1～12 个 Unicode 字符；
   *      去重后有效词最多 20 个。
   * @returns {{words:string[], errors:string[]}}
   */
  function parseProtectTable(text) {
    var errors = [];
    var words = [];
    var seen = Object.create(null);
    var lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (raw.trim() === '') continue;          // 空行 / 仅空白行：忽略
      if (NON_NEWLINE_WS.test(raw)) {
        errors.push('第 ' + (i + 1) + ' 行「' + raw +
          '」含有空格或制表符等空白字符（词中不允许换行以外的空白）');
        continue;
      }
      var cps = Array.from(raw);
      if (cps.length < 1 || cps.length > PROTECT_MAX_LEN) {
        errors.push('第 ' + (i + 1) + ' 行「' + raw +
          '」长度为 ' + cps.length + ' 个字符，须为 1～12 个 Unicode 字符');
        continue;
      }
      if (seen[raw]) continue;                  // 重复词去重
      seen[raw] = true;
      words.push(raw);
    }
    if (words.length > PROTECT_MAX_WORDS) {
      errors.push('保护词最多 ' + PROTECT_MAX_WORDS +
        ' 个（去重后当前有 ' + words.length + ' 个），请删除多余的词');
    }
    return { words: words.slice(0, PROTECT_MAX_WORDS), errors: errors };
  }

  /**
   * 在一个段落的 token 序列上应用保护词：
   * 从左到右扫描，同位置取最长命中词、同长按录入顺序，已匹配字符不再
   * 参与后续匹配。匹配在码位级进行，命中区间吸附到所属 token 的整体
   * 边界（连续英文单词本身即不可拆整体，会被整体并入；区间不跨越空格），
   * 再合并为不可断行的 protect token。
   * 合并 token 记录首/尾码位，边界仍走原有避头尾规则。
   * @param {Token[]} tokens
   * @param {string[]} words 去重后的保护词（顺序即同长优先级）
   * @returns {Token[]}
   */
  function applyProtection(tokens, words) {
    if (!words || !words.length) return tokens;

    // 码位级匹配单元：非空格 token 按其实际码位序列展开（英文单词 token
    // 含多个码位），每个单元记录所属 token 下标；空格 token 为屏障。
    var units = [];
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'space') {
        units.push({ ch: -1, tok: -1 });
        continue;
      }
      var tcs = Array.from(tokens[i].t);
      for (var ti = 0; ti < tcs.length; ti++) {
        units.push({ ch: tcs[ti].codePointAt(0), tok: i });
      }
    }
    var m = units.length;

    // 按长度降序、长度相同按录入顺序排列，便于每点取「最长优先、同长先录入」
    var ordered = words.map(function (w, idx) {
      return { w: w, cps: Array.from(w), idx: idx };
    }).sort(function (a, b) {
      return b.cps.length - a.cps.length || a.idx - b.idx;
    });

    function wordAt(wordCps, pos) {
      var L = wordCps.length;
      if (pos + L > m) return false;
      for (var k = 0; k < L; k++) {
        if (units[pos + k].ch < 0) return false; // 命中屏障空格
        if (units[pos + k].ch !== wordCps[k].codePointAt(0)) return false;
      }
      return true;
    }

    // 收集命中的码位区间（单元下标，闭区间），并标记被匹配占用的单元
    var hits = [];
    var used = new Uint8Array(m);
    for (var pos = 0; pos < m;) {
      if (units[pos].ch < 0) { pos++; continue; }
      var hit = null;
      for (var j = 0; j < ordered.length; j++) {
        var wd = ordered[j];
        if (wd.cps.length === 0) continue;
        if (wordAt(wd.cps, pos)) {
          var k2;
          for (k2 = 0; k2 < wd.cps.length; k2++) {
            if (used[pos + k2]) break;
          }
          if (k2 === wd.cps.length) { hit = wd; break; }
        }
      }
      if (hit) {
        hits.push([pos, pos + hit.cps.length - 1]);
        for (var u = 0; u < hit.cps.length; u++) used[pos + u] = 1;
        pos += hit.cps.length;
      } else {
        pos++;
      }
    }
    if (!hits.length) return tokens;

    // 命中区间吸附到 token 整体边界：英文单词等多码位原子 token 要么整体
    // 并入、要么整体不并入，与「英文单词不可拆」规则保持一致。
    var spans = hits.map(function (h) {
      return { from: units[h[0]].tok, to: units[h[1]].tok };
    });

    // 仅合并因吸附而重叠的区间；相邻但不重叠的命中词保持独立（词间可断行）
    spans.sort(function (x, y) { return x.from - y.from; });
    var merged = [];
    spans.forEach(function (sp) {
      var last = merged[merged.length - 1];
      if (last && sp.from <= last.to) {
        if (sp.to > last.to) last.to = sp.to;
      } else {
        merged.push({ from: sp.from, to: sp.to });
      }
    });

    var out = [];
    var si = 0;
    for (var t = 0; t < tokens.length;) {
      if (si < merged.length && t === merged[si].from) {
        var end = merged[si].to;
        var text = '';
        for (var x = t; x <= end; x++) text += tokens[x].t;
        out.push({
          t: text, type: 'protect', ch: tokens[t].ch,
          lead: tokens[t].ch, trail: tokens[end].ch
        });
        t = end + 1;
        si++;
      } else {
        out.push(tokens[t]);
        t++;
      }
    }
    return out;
  }

  /**
   * 单段动态规划断行。
   * @param {Token[]} tokens   已分段的 token
   * @param {number} maxWidth  行宽（px）
   * @param {(s:string)=>number} measure 文本宽度函数（px）
   * @param {boolean} lastLineFree 末行是否不计空白代价（正文最后一段为 true）
   * @returns {{lines:string[], widths:number[], tokens:Token[][]}|
   *           {overflow:true, items:Array<{text:string,width:number,protect:boolean}>}}
   *          放不下（存在超过行宽的不可拆整体）时返回 overflow（含每个超宽整体）
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
    var overflowItems = [];
    for (var k = 0; k < n; k++) {
      w[k] = tokens[k].type === 'space' ? measure(' ') : measure(tokens[k].t);
      if (w[k] > maxWidth + 0.5 && tokens[k].type !== 'space') {
        // 不可拆整体（英文单词 / 专名保护词）超出行宽
        overflowItems.push({
          text: tokens[k].t,
          width: w[k],
          protect: tokens[k].type === 'protect'
        });
      }
    }
    if (overflowItems.length) return { overflow: true, items: overflowItems };

    function boundaryCh(tok, end) {
      if (tok.type === 'protect') return end ? tok.trail : tok.lead;
      return tok.ch;
    }

    function canBreakBetween(a, b) {
      if (a < 0 || b >= n) return true;
      var L = tokens[a], R = tokens[b];
      var lCh = boundaryCh(L, true), rCh = boundaryCh(R, false);
      // 左侧最后一个可见字符不能是开标点（开标点不在行尾）
      if (OPEN_SET[lCh]) return false;
      // 右侧第一个可见字符不能是闭标点（闭标点不在行首）
      if (CLOSE_SET[rCh]) return false;
      // 两个成对标点（破折号/省略号）不可拆为两行
      if (DASH_CHARS[lCh] && DASH_CHARS[rCh]) return false;
      if (lCh === 0x2026 && rCh === 0x2026) return false;
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

    if (link[n] < 0 && n > 0) {
      // 理论上不应到达：所有不可拆整体已在前置检查中超宽返回；
      // 兜底按整体不可容纳处理（不指明具体词）。
      return { overflow: true, items: [] };
    }

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
   * @param {string} text
   * @param {number} maxWidth 行宽（px）
   * @param {(s:string)=>number} measure 文本宽度函数（px）
   * @param {string[]} [protectWords] 专名保护词表（同一表逐段应用）
   * @returns {{ paragraphs: Array<{lines:string[],widths:number[]}>,
   *            totalLines:number, maxLineWidth:number }|
   *           { overflow:true,
   *             items:Array<{text:string,width:number,protect:boolean}> }}
   */
  function planText(text, maxWidth, measure, protectWords) {
    var paras = tokenize(text);
    var out = [];
    var totalLines = 0;
    var maxLineWidth = 0;
    var overflow = [];
    for (var i = 0; i < paras.length; i++) {
      var tokens = applyProtection(paras[i], protectWords);
      var r = planParagraph(tokens, maxWidth, measure, i === paras.length - 1);
      if (r.overflow) {
        r.items.forEach(function (it) { overflow.push(it); });
        continue;
      }
      out.push({ lines: r.lines, widths: r.widths, tokens: r.tokens });
      totalLines += r.lines.length;
      r.widths.forEach(function (wd) { if (wd > maxLineWidth) maxLineWidth = wd });
    }
    if (overflow.length) return { overflow: true, items: overflow };
    return { paragraphs: out, totalLines: totalLines, maxLineWidth: maxLineWidth };
  }

  var api = {
    PX_PER_MM: PX_PER_MM,
    tokenize: tokenize,
    planParagraph: planParagraph,
    planText: planText,
    isWordCode: isWordCode,
    isCJKCode: isCJKCode,
    parseProtectTable: parseProtectTable,
    applyProtection: applyProtection,
    PROTECT_MAX_WORDS: PROTECT_MAX_WORDS,
    PROTECT_MAX_LEN: PROTECT_MAX_LEN
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);

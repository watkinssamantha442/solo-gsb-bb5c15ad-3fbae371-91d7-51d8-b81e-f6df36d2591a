/*
 * diff.js —— 中文正文修订对照：按 Unicode 字符（码位）求最短增删对齐
 *
 * 算法：仅插入/删除的编辑距离（等价于最长公共子序列）。
 *   1. 后缀动态规划：d[i][j] = 把原文 A[i..n) 变为修订稿 B[j..m) 的最少增删次数；
 *   2. 正向回溯构造对齐：字符相同必同行（匹配不增加代价）；
 *      删除 A[i] 与插入 B[j] 代价相同时，固定选择「插入」——
 *      即不删除当前最早的原文字符，从而在所有最短对齐中
 *      固定优先保留原文较早的字符，结果确定唯一。
 *
 * 字符按码位处理（Array.from），增补平面字符（如 emoji）视为一个字符。
 * 无 DOM 依赖，可在浏览器与 Node 中运行。
 */
(function (global) {
  'use strict';

  function toChars(s) {
    return Array.from(String(s == null ? '' : s));
  }

  /**
   * 最短增删对齐。
   * @param {string} a 原稿
   * @param {string} b 修订稿
   * @returns {{segments:Array<{type:'keep'|'del'|'ins',text:string}>,
   *            kept:number, deleted:number, inserted:number}}
   *   segments 为按顺序合并后的连续片段：keep 共有、del 仅原稿有（删除）、ins 仅修订稿有（新增）。
   */
  function align(a, b) {
    var A = toChars(a);
    var B = toChars(b);
    var n = A.length;
    var m = B.length;
    var i, j;

    // d[i][j]：A[i..n) → B[j..m) 的最少增删次数
    var d = new Array(n + 1);
    for (i = 0; i <= n; i++) d[i] = new Array(m + 1);
    for (j = 0; j <= m; j++) d[n][j] = m - j;   // 原文用完，剩余全为插入
    for (i = 0; i <= n; i++) d[i][m] = n - i;   // 修订稿用完，剩余全为删除
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        d[i][j] = A[i] === B[j]
          ? d[i + 1][j + 1]
          : 1 + Math.min(d[i + 1][j], d[i][j + 1]);
      }
    }

    // 正向回溯：相同即匹配；删除严格更优才删除；同代价取插入（保留原文较早字符）
    var ops = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push({ t: 'keep', ch: A[i] });
        i++;
        j++;
      } else if (d[i + 1][j] < d[i][j + 1]) {
        ops.push({ t: 'del', ch: A[i] });
        i++;
      } else {
        ops.push({ t: 'ins', ch: B[j] });
        j++;
      }
    }
    while (i < n) { ops.push({ t: 'del', ch: A[i] }); i++; }
    while (j < m) { ops.push({ t: 'ins', ch: B[j] }); j++; }

    // 合并连续同类操作并统计
    var segments = [];
    var kept = 0, deleted = 0, inserted = 0;
    for (var k = 0; k < ops.length; k++) {
      var op = ops[k];
      if (op.t === 'keep') kept++;
      else if (op.t === 'del') deleted++;
      else inserted++;
      var last = segments[segments.length - 1];
      if (last && last.type === op.t) last.text += op.ch;
      else segments.push({ type: op.t, text: op.ch });
    }

    return { segments: segments, kept: kept, deleted: deleted, inserted: inserted };
  }

  var api = { align: align };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelDiff = api;
})(typeof window !== 'undefined' ? window : globalThis);

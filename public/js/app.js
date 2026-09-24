/* app.js —— 交互、字宽测量、字号搜索、修订对照、渲染与打印 */
(function () {
  'use strict';

  var PX_PER_MM = window.LabelLayout.PX_PER_MM;
  var MIN_BODY = 12, MAX_BODY = 24;
  var TITLE_RATIO = 1.4;          // 标题字号 = 正文 × 1.4
  var PADDING_MM = 8;             // 展签内边距
  var COL_GAP_MM = 6;             // 双栏模式下中英两栏的栏间距
  var TITLE_LINE_HEIGHT = 1.3;
  var BODY_LINE_HEIGHT = 1.6;
  var TITLE_GAP_PX_FACTOR = 0.5;  // 标题与正文间距 = 0.5 个正文字号
  var PARA_GAP_PX_FACTOR = 0.6;   // 段间距 = 0.6 个正文字号
  var REV_LIMIT = 300;            // 修订稿字数上限（按 Unicode 字符计）

  var el = {
    title: document.getElementById('title'),
    body: document.getElementById('body'),
    bodyEn: document.getElementById('bodyEn'),
    bodyRev: document.getElementById('bodyRev'),
    revCount: document.getElementById('revCount'),
    widthMm: document.getElementById('widthMm'),
    heightMm: document.getElementById('heightMm'),
    printBtn: document.getElementById('printBtn'),
    status: document.getElementById('status'),
    stage: document.getElementById('stage'),
    label: document.getElementById('label'),
    labelTitle: document.getElementById('labelTitle'),
    labelContent: document.getElementById('labelContent'),
    labelBody: document.getElementById('labelBody'),
    labelBodyEn: document.getElementById('labelBodyEn'),
    labelError: document.getElementById('labelError'),
    compare: document.getElementById('compare'),
    diffView: document.getElementById('diffView'),
    diffStats: document.getElementById('diffStats'),
    fitBody: document.getElementById('fitBody'),
    fitDelta: document.getElementById('fitDelta'),
    finalOrig: document.getElementById('finalOrig'),
    finalRev: document.getElementById('finalRev')
  };

  // ---------- Canvas 实际字宽测量（按 font 分别缓存） ----------
  // 正文与标题（加粗、1.4×）字号不同：每 font 一个独立 context，
  // 避免交替调用互相改写 ctx.font；缓存也按 font 隔离，避免拼接 key 碰撞。
  var measurers = {};

  function makeMeasure(font) {
    if (!measurers[font]) {
      var context = document.createElement('canvas').getContext('2d');
      context.font = font;
      var cache = {};
      measurers[font] = function (text) {
        var v = cache[text];
        if (v === undefined) {
          v = context.measureText(text).width;
          cache[text] = v;
        }
        return v;
      };
    }
    return measurers[font];
  }

  function fontString(size, weight) {
    var family = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", ' +
                 '"SimSun", "Times New Roman", serif';
    return (weight || 400) + ' ' + size + 'px ' + family;
  }

  // 一栏正文的渲染高度（px）：行高 + 段间距
  function columnHeight(plan, bodyPx) {
    if (!plan) return 0;
    var paraGaps = (plan.paragraphs.length - 1) * bodyPx * PARA_GAP_PX_FACTOR;
    return plan.totalLines * bodyPx * BODY_LINE_HEIGHT + paraGaps;
  }

  // ---------- 一次排版尝试 ----------
  // 单栏（无英文译文）：正文占满内容宽。
  // 双栏（填写译文）：标题横跨整签，中文/英文按扣除 6mm 栏间距后的实际栏宽
  //                  各自独立断行，共用同一个正文字号。
  // 返回 { ok:true, ... } 或 { ok:false, reason: 'config'|'width'|'height', ... }
  // 各种返回均带 zhLines / enLines（中文/英文行数；宽度失败无法规划时为 null），
  // 供修订对照表展示两版行数。
  function tryLayout(input, widthMm, heightMm, bodyPx) {
    var contentW = (widthMm - PADDING_MM * 2) * PX_PER_MM;
    var contentH = (heightMm - PADDING_MM * 2) * PX_PER_MM;
    if (contentW <= 4 || contentH <= 4) {
      return { ok: false, reason: 'config', message: '标签尺寸过小：内边距为 8mm，请加大宽或高。' };
    }

    var dual = !!input.dual;
    var hasZh = !!input.bodyTrim;
    var hasEn = !!input.enTrim;

    var titlePx = Math.round(bodyPx * TITLE_RATIO * 100) / 100;
    var bodyMeasure = makeMeasure(fontString(bodyPx, 400));
    var titleMeasure = makeMeasure(fontString(titlePx, 700));

    // 栏宽：单栏占满；双栏扣除栏间距后平分
    var colW = dual
      ? (contentW - COL_GAP_MM * PX_PER_MM) / 2
      : contentW;
    if (colW <= 1) {
      var narrow = [];
      if (hasZh) narrow.push({ key: 'zh', widthMm: 0 });
      if (dual && hasEn) narrow.push({ key: 'en', widthMm: 0 });
      return {
        ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: narrow,
        zhLines: null, enLines: null
      };
    }

    // 标题横跨整签（两种模式均按内容全宽规划，允许折行）
    var titlePlan = null;
    var titleWidthFail = false;
    if (input.titleTrim) {
      titlePlan = window.LabelLayout.planText(input.titleTrim, contentW, titleMeasure);
      if (!titlePlan) titleWidthFail = true;
    }

    var zhPlan = null, enPlan = null;
    var widthFailures = [];
    if (titleWidthFail) {
      widthFailures.push({ key: 'title', widthMm: contentW / PX_PER_MM });
    }
    if (hasZh) {
      zhPlan = window.LabelLayout.planText(input.bodyTrim, colW, bodyMeasure);
      if (!zhPlan) widthFailures.push({ key: 'zh', widthMm: colW / PX_PER_MM });
    }
    if (dual && hasEn) {
      enPlan = window.LabelLayout.planText(input.enTrim, colW, bodyMeasure);
      if (!enPlan) widthFailures.push({ key: 'en', widthMm: colW / PX_PER_MM });
    }

    if (widthFailures.length) {
      return {
        ok: false, reason: 'width', bodyPx: bodyPx, widthFailures: widthFailures,
        zhLines: zhPlan ? zhPlan.totalLines : null,
        enLines: enPlan ? enPlan.totalLines : null
      };
    }

    if (!titlePlan && !zhPlan && !enPlan) {
      return {
        ok: true, dual: dual, titlePlan: null, zhPlan: null, enPlan: null,
        bodyPx: bodyPx, titlePx: titlePx, contentH: 0, colWMm: colW / PX_PER_MM,
        zhLines: 0, enLines: 0
      };
    }

    // 高度核算：标题（横跨整签）+ 标题间距 + 较高一栏
    var titleH = 0, titleGap = 0;
    if (titlePlan) {
      titleH = titlePlan.totalLines * titlePx * TITLE_LINE_HEIGHT;
      if (zhPlan || enPlan) titleGap = bodyPx * TITLE_GAP_PX_FACTOR;
    }
    var zhH = columnHeight(zhPlan, bodyPx);
    var enH = columnHeight(enPlan, bodyPx);
    var bodyH = Math.max(zhH, enH);
    var totalH = titleH + titleGap + bodyH;

    if (totalH > contentH + 0.75) {
      return {
        ok: false, reason: 'height', bodyPx: bodyPx,
        totalH: totalH, contentH: contentH,
        zhH: zhH, enH: enH, titleH: titleH + titleGap,
        zhLines: zhPlan ? zhPlan.totalLines : 0,
        enLines: enPlan ? enPlan.totalLines : 0
      };
    }

    return {
      ok: true, dual: dual, titlePlan: titlePlan, zhPlan: zhPlan, enPlan: enPlan,
      bodyPx: bodyPx, titlePx: titlePx, contentH: totalH,
      zhH: zhH, enH: enH, colWMm: colW / PX_PER_MM,
      zhLines: zhPlan ? zhPlan.totalLines : 0,
      enLines: enPlan ? enPlan.totalLines : 0
    };
  }

  // ---------- 12→24 中选最大可行字号 ----------
  function computeLayout(input) {
    var lastHeightFailure = null;
    for (var px = MAX_BODY; px >= MIN_BODY; px--) {
      var r = tryLayout(input, input.widthMm, input.heightMm, px);
      if (r.ok) return r;
      if (r.reason === 'config') return r;     // 尺寸配置错误，与字号无关
      if (r.reason === 'width') {
        if (px === MIN_BODY) return r;         // 最小字号仍超宽，无法挽救
        continue;
      }
      if (r.reason === 'height') lastHeightFailure = r;
    }
    // 12px 仍超高
    return lastHeightFailure || {
      ok: false, reason: 'height', bodyPx: MIN_BODY, totalH: 0, contentH: 0
    };
  }

  // ---------- 错误文案 ----------
  var COL_NAMES = { title: '标题', zh: '中文原文栏', en: '英文译文栏' };

  function widthFailureMessage(result, dual) {
    var parts = result.widthFailures.map(function (f) {
      if (f.key === 'title') {
        return '标题存在即使 ' + result.bodyPx + 'px（最小字号）也无法放入整签宽度的连续内容';
      }
      var colLabel = dual ? COL_NAMES[f.key] : '正文';
      return colLabel + '存在即使 ' + result.bodyPx +
        'px（最小字号）也无法放入' + (dual ? '栏' : '行') + '宽（约 ' +
        Math.max(0, Math.round(f.widthMm)) +
        'mm）的连续内容（如过长的英文单词）';
    });
    var head = dual ? '排不下（双栏）：' : '排不下：';
    return head + parts.join('；') + '。请加宽标签' +
      (dual ? '（加宽后两栏栏宽同步增加）' : '') + '或修改文案——不会截断显示。';
  }

  function heightFailureMessage(result, dual) {
    var where = '';
    if (dual) {
      // 较高一栏（计入标题时以正文两栏比较）
      if (result.enH > result.zhH) where = '（英文译文栏较高）';
      else if (result.zhH > 0) where = '（中文原文栏较高）';
    }
    return '内容在 12–24px 任何字号下都超出标签高度' + where + '（需要约 ' +
      Math.round(result.totalH / PX_PER_MM) + 'mm，可用 ' +
      Math.round(result.contentH / PX_PER_MM) + 'mm）。\n' +
      '请加高标签或精简文案——不会截断显示。';
  }

  // ---------- 渲染 ----------
  function buildLines(container, plan) {
    container.innerHTML = '';
    plan.paragraphs.forEach(function (para) {
      var p = document.createElement('div');
      p.className = 't-paragraph';
      para.lines.forEach(function (lineText) {
        var div = document.createElement('div');
        div.className = 't-line';
        div.textContent = lineText;
        p.appendChild(div);
      });
      container.appendChild(p);
    });
  }

  function setDualMode(dual) {
    el.labelContent.classList.toggle('dual', !!dual);
    el.labelBodyEn.hidden = !dual;
  }

  var lastGood = null;

  // 把一次成功的排版结果写入展签 DOM 与 CSS 变量（预览与打印共用此结果）
  function applyResult(input, result) {
    var s = el.label.style;
    s.setProperty('--label-w', input.widthMm + 'mm');
    s.setProperty('--label-h', input.heightMm + 'mm');
    s.setProperty('--body-size', result.bodyPx + 'px');
    s.setProperty('--title-size', result.titlePx + 'px');
    s.setProperty('--title-gap',
      result.titlePlan && (result.zhPlan || result.enPlan)
        ? (result.bodyPx * TITLE_GAP_PX_FACTOR) + 'px'
        : '0px');
    s.setProperty('--para-gap', result.bodyPx * PARA_GAP_PX_FACTOR + 'px');

    el.labelError.hidden = true;

    el.labelTitle.innerHTML = '';
    if (result.titlePlan) {
      buildLines(el.labelTitle, result.titlePlan);
    }

    el.labelBody.innerHTML = '';
    if (result.zhPlan) {
      buildLines(el.labelBody, result.zhPlan);
    }

    el.labelBodyEn.innerHTML = '';
    if (result.enPlan) {
      buildLines(el.labelBodyEn, result.enPlan);
    }
  }

  // 成功状态行文案
  function successInfo(input, result) {
    var usedH = Math.round(result.contentH / PX_PER_MM);
    var info = '正文字号 ' + result.bodyPx + 'px（标题 ' +
      Math.round(result.titlePx * 10) / 10 + 'px）';
    if (result.dual) {
      info += '，双栏栏宽约 ' + Math.round(result.colWMm) + 'mm';
      if (result.zhPlan) info += '，中文 ' + result.zhPlan.totalLines + ' 行';
      if (result.enPlan) info += '，英文 ' + result.enPlan.totalLines + ' 行';
    } else if (result.zhPlan) {
      info += '，正文 ' + result.zhPlan.totalLines + ' 行';
    }
    if (result.titlePlan) info += '，标题 ' + result.titlePlan.totalLines + ' 行';
    info += '，内容高约 ' + usedH + 'mm / ' +
      Math.round(input.heightMm - PADDING_MM * 2) + 'mm';
    return info;
  }

  // 排版成功：预览与打印只呈现被选中的一版
  function showSuccess(input, result, versionName) {
    lastGood = { input: input, result: result };
    applyResult(input, result);
    setStatus((versionName ? '成品：' + versionName + '　' : '') +
      successInfo(input, result), 'ok');
    el.printBtn.disabled = false;
    fitScale();
  }

  // 排版失败：说明超宽/超高并禁用打印；对照区在面板中保留，不受影响
  function showFailure(input, result, versionName) {
    var msg, tag = '';
    if (result.reason === 'config') {
      msg = result.message;
    } else if (result.reason === 'width') {
      msg = widthFailureMessage(result, input.dual);
      tag = '超宽';
    } else {
      msg = heightFailureMessage(result, input.dual);
      tag = '超高';
    }
    var prefix = versionName
      ? '【' + versionName + (tag ? ' · ' + tag : '') + '】'
      : '';
    setStatus(prefix + msg, 'err');
    showError(prefix + (result.reason === 'config' ? '标签尺寸过小\n' + msg : msg));
    el.printBtn.disabled = true;
    fitScale();
  }

  // ---------- 修订对照 ----------
  // 对照基于排版实际使用的文本（去首尾空白后的原稿与修订稿），
  // 换行统一为 \n 后按 Unicode 字符求最短增删对齐。
  function renderDiff(a, b) {
    var norm = function (s) { return String(s).replace(/\r\n?/g, '\n'); };
    var res = window.LabelDiff.align(norm(a), norm(b));
    el.diffView.innerHTML = '';
    if (!res.inserted && !res.deleted) {
      el.diffView.textContent = '修订稿与原稿完全一致，无差异。';
      el.diffStats.textContent = '';
      return;
    }
    res.segments.forEach(function (seg) {
      var node;
      if (seg.type === 'del') node = document.createElement('del');
      else if (seg.type === 'ins') node = document.createElement('ins');
      else node = document.createElement('span');
      appendSegText(node, seg.text, seg.type);
      el.diffView.appendChild(node);
    });
    el.diffStats.textContent =
      '新增 ' + res.inserted + ' 字 · 删除 ' + res.deleted + ' 字 · 相同 ' + res.kept + ' 字';
  }

  // 片段文本写入节点；换行在新增/删除片段中以 ↵ 标记显式标出
  function appendSegText(node, text, type) {
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (type !== 'keep') {
          var mark = document.createElement('i');
          mark.className = 'nl';
          mark.textContent = '↵';
          node.appendChild(mark);
        }
        node.appendChild(document.createElement('br'));
      }
      if (parts[i]) node.appendChild(document.createTextNode(parts[i]));
    }
  }

  // 单版能否容纳的对照表文案
  function fitNote(r) {
    if (r.ok) return { text: '✓ 可容纳', bad: false };
    if (r.reason === 'width') return { text: '✗ 超宽：12px 仍放不进行宽', bad: true };
    if (r.reason === 'height') {
      return {
        text: '✗ 超高：12px 需约 ' + Math.round(r.totalH / PX_PER_MM) +
          'mm / 可用 ' + Math.round(r.contentH / PX_PER_MM) + 'mm',
        bad: true
      };
    }
    return { text: '✗ 尺寸无效', bad: true };
  }

  function verBrief(r) {
    if (r.ok) return r.bodyPx + 'px 可容纳';
    if (r.reason === 'width') return '超宽排不下';
    if (r.reason === 'height') return '超高排不下';
    return '尺寸无效';
  }

  // 两版对比表 + 变化摘要
  function renderFit(resOrig, resRev) {
    el.fitBody.innerHTML = '';
    [['原稿', resOrig], ['修订稿', resRev]].forEach(function (row) {
      var name = row[0], r = row[1];
      var note = fitNote(r);
      var tr = document.createElement('tr');
      [name,
       r.ok ? r.bodyPx + 'px' : '—',
       r.zhLines == null ? '—' : r.zhLines + ' 行',
       note.text].forEach(function (txt, idx) {
        var td = document.createElement('td');
        td.textContent = txt;
        if (idx === 3) td.className = note.bad ? 'bad' : 'good';
        tr.appendChild(td);
      });
      el.fitBody.appendChild(tr);
    });

    var delta;
    if (resOrig.ok && resRev.ok) {
      var fs = resOrig.bodyPx === resRev.bodyPx
        ? '字号同为 ' + resOrig.bodyPx + 'px'
        : '字号 ' + resOrig.bodyPx + 'px → ' + resRev.bodyPx + 'px';
      var ln = resOrig.zhLines === resRev.zhLines
        ? '中文行数同为 ' + resOrig.zhLines + ' 行'
        : '中文行数 ' + resOrig.zhLines + ' → ' + resRev.zhLines + ' 行';
      delta = '变化：' + fs + '，' + ln + '；两版均可容纳。';
    } else {
      delta = '变化：原稿 ' + verBrief(resOrig) +
        ' → 修订稿 ' + verBrief(resRev) + '。';
    }
    el.fitDelta.textContent = delta;
  }

  function render() {
    var input = {
      title: el.title.value,
      body: el.body.value,
      bodyEn: el.bodyEn.value,
      widthMm: parseFloat(el.widthMm.value),
      heightMm: parseFloat(el.heightMm.value)
    };
    input.titleTrim = input.title.trim();
    input.bodyTrim = input.body.trim();
    input.enTrim = input.bodyEn.trim();
    input.dual = input.enTrim.length > 0;

    // 修订稿非空白即进入对照模式；新填写修订稿时默认以修订稿为成品
    var revTrim = el.bodyRev.value.trim();
    var revActive = revTrim.length > 0;
    if (revActive && !revWasActive) selectedVersion = 'rev';
    if (!revActive) selectedVersion = 'orig';
    revWasActive = revActive;
    el.finalOrig.checked = selectedVersion === 'orig';
    el.finalRev.checked = selectedVersion === 'rev';
    el.compare.hidden = !revActive;

    setDualMode(input.dual);

    // 差异对照与尺寸无关，先行渲染（尺寸非法期间对照仍保持更新）
    if (revActive) renderDiff(input.bodyTrim, revTrim);

    if (!(input.widthMm >= 30 && input.widthMm <= 999 &&
          input.heightMm >= 20 && input.heightMm <= 999)) {
      setStatus('请输入有效的标签尺寸：宽 30–999mm，高 20–999mm。', 'err');
      showError('标签尺寸无效\n（宽 30–999mm，高 20–999mm）');
      el.printBtn.disabled = true;
      return;
    }

    if (!revActive) {
      var single = computeLayout(input);
      if (!single.ok) showFailure(input, single, null);
      else showSuccess(input, single, null);
      return;
    }

    // 对照模式：原稿与修订稿沿用当前尺寸与英文译文，分别运行现有排版
    var revInput = {
      title: input.title,
      body: el.bodyRev.value,
      bodyEn: input.bodyEn,
      widthMm: input.widthMm,
      heightMm: input.heightMm
    };
    revInput.titleTrim = input.titleTrim;
    revInput.bodyTrim = revTrim;
    revInput.enTrim = input.enTrim;
    revInput.dual = input.dual;

    var resOrig = computeLayout(input);
    var resRev = computeLayout(revInput);
    renderFit(resOrig, resRev);

    if (selectedVersion === 'rev') {
      if (!resRev.ok) showFailure(revInput, resRev, '修订稿');
      else showSuccess(revInput, resRev, '修订稿');
    } else {
      if (!resOrig.ok) showFailure(input, resOrig, '原稿');
      else showSuccess(input, resOrig, '原稿');
    }
  }

  function showError(message) {
    el.labelError.textContent = message;
    el.labelError.hidden = false;
    el.labelTitle.innerHTML = '';
    el.labelBody.innerHTML = '';
    el.labelBodyEn.innerHTML = '';
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 屏幕预览缩放（仅显示用，不影响打印的毫米尺寸） ----------
  function fitScale() {
    var wMm = parseFloat(el.widthMm.value) || 120;
    var hMm = parseFloat(el.heightMm.value) || 80;
    var availW = el.stage.clientWidth - 24;
    var availH = el.stage.clientHeight - 24;
    var labelW = wMm * PX_PER_MM;
    var labelH = hMm * PX_PER_MM;
    var scale = Math.min(1, availW / labelW, availH / labelH);
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    el.label.style.transform = 'scale(' + scale + ')';
  }

  // ---------- 打印前把 @page 尺寸设为标签物理尺寸 ----------
  var pageStyle = null;
  function beforePrint() {
    if (el.printBtn.disabled || !lastGood) return;
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = '@page { size: ' +
      lastGood.input.widthMm + 'mm ' + lastGood.input.heightMm + 'mm; margin: 0; }';
  }

  // ---------- 初始化 ----------
  el.body.value =
    '新石器时代·仰韶文化，约公元前 5000–前 3000 年。\n' +
    '泥质红陶，器表刻划有几何纹（geometric patterns），是研究黄河中游早期制陶工艺（pottery craftsmanship）的重要实物。出土于河南省渑池县仰韶村，1951 年入藏。';
  // 英文译文默认留空：页面初次打开保持原有单栏呈现。
  // 修订稿默认留空：不进入对照模式。

  var selectedVersion = 'orig'; // 成品版本：'orig' 原稿 / 'rev' 修订稿
  var revWasActive = false;     // 上一轮渲染时修订稿是否非空（用于新填写时默认选中修订稿）

  var schedule = (function () {
    var timer = null;
    return function () { clearTimeout(timer); timer = setTimeout(render, 120); };
  })();

  ['input', 'change'].forEach(function (evt) {
    el.title.addEventListener(evt, schedule);
    el.body.addEventListener(evt, schedule);
    el.bodyEn.addEventListener(evt, schedule);
    el.widthMm.addEventListener(evt, schedule);
    el.heightMm.addEventListener(evt, schedule);
  });

  // 修订稿：按 Unicode 字符计 300 字上限，超出部分截断
  function updateRevCount(truncated) {
    var n = Array.from(el.bodyRev.value).length;
    el.revCount.textContent = n + ' / ' + REV_LIMIT + (truncated ? '（已按上限截断）' : '');
    el.revCount.classList.toggle('over', n >= REV_LIMIT);
  }

  el.bodyRev.addEventListener('input', function () {
    var cps = Array.from(el.bodyRev.value);
    var truncated = cps.length > REV_LIMIT;
    if (truncated) {
      el.bodyRev.value = cps.slice(0, REV_LIMIT).join('');
    }
    updateRevCount(truncated);
    schedule();
  });
  el.bodyRev.addEventListener('change', schedule);

  // 成品版本选择：预览与打印随之切换
  [el.finalOrig, el.finalRev].forEach(function (radio) {
    radio.addEventListener('change', function () {
      selectedVersion = el.finalRev.checked ? 'rev' : 'orig';
      render();
    });
  });

  updateRevCount(false);

  el.printBtn.addEventListener('click', function () { window.print(); });
  window.addEventListener('beforeprint', beforePrint);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitScale, 80);
  });

  // 字体加载完成后重排，确保测量字宽与渲染一致
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(render);
  }
  render();
})();

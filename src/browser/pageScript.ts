// Runs inside the page (Runtime.evaluate) and describes what a person would notice: layout bugs,
// unreadable text, broken images, unlabeled controls, design consistency and what is on screen.
// Text-only models depend on this report because they cannot look at the screenshot.
// Plain ES5-style JavaScript in a string: it is not compiled, and it must not use template literals.

export const PAGE_REPORT_SCRIPT = String.raw`(function () {
  var vw = window.innerWidth, vh = window.innerHeight;
  var root = document.documentElement, body = document.body;
  var out = {
    title: document.title || '',
    url: location.href,
    viewport: [vw, vh],
    page: [Math.max(root.scrollWidth, body ? body.scrollWidth : 0), Math.max(root.scrollHeight, body ? body.scrollHeight : 0)],
    overflow: [], clipped: [], spill: [], overlaps: [], lowContrast: [], smallTargets: [], smallTargetCount: 0, smallFields: [],
    viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    brokenImages: [], imagesWithoutAlt: 0, unlabeled: [], unlabeledCount: 0, emptyButtons: [], emptyButtonCount: 0,
    headings: { h1: 0, skipped: [] }, canvases: [], design: {}, outline: [], text: '', empty: false
  };
  if (!body) { out.empty = true; return out; }

  var canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var colorCache = {};
  // The browser converts any CSS color (rgb, hsl, oklch, color()) to sRGB for us.
  function rgba(str) {
    if (!str) return null;
    if (colorCache[str]) return colorCache[str];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = str;
    ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    var c = [d[0], d[1], d[2], d[3] / 255];
    colorCache[str] = c;
    return c;
  }
  function hex(c) { return '#' + [c[0], c[1], c[2]].map(function (v) { var s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; }).join(''); }
  function lum(c) {
    var a = [c[0], c[1], c[2]].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function blend(fg, bg) { var a = fg[3]; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]; }
  function styleOf(el) { return getComputedStyle(el); }
  function shown(el, cs) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    cs = cs || styleOf(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return null;
    return r;
  }
  function short(t, n) { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; }
  function label(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    var t = short(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || '', 40);
    return t ? s + ' "' + t + '"' : s;
  }
  function ownText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  // Effective background behind an element, or null when an image or gradient is behind it.
  function background(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) {
      var cs = styleOf(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      var c = rgba(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    var base = [255, 255, 255, 1];
    for (var i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  }
  function scrollsX(el) { var o = styleOf(el).overflowX; return o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip'; }

  var all = body.getElementsByTagName('*');
  var limit = Math.min(all.length, 6000);
  var interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL)$/;
  var fonts = {}, sizes = {}, colors = {}, radii = {}, shadows = 0, textEls = 0;
  var contrastSeen = {};
  var overlapCandidates = [];
  var lastHeading = 0;

  for (var i = 0; i < limit; i++) {
    var el = all[i];
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|path|g|defs|META|LINK|BR|HEAD)$/.test(el.tagName)) continue;
    var cs = styleOf(el);
    var r = shown(el, cs);
    if (!r) continue;
    var tag = el.tagName;
    var isInteractive = interactive.test(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link';

    // Sticks out past the right edge of the window (causes sideways scrolling).
    if (r.right > vw + 1 && cs.position !== 'fixed' && out.overflow.length < 12) {
      var parent = el.parentElement, contained = false;
      for (var p = parent; p && p !== body && p !== root; p = p.parentElement) if (scrollsX(p)) { contained = true; break; }
      var parentOut = parent && parent !== body && parent.getBoundingClientRect().right > vw + 1;
      if (!contained && !parentOut) out.overflow.push({ el: label(el), right: Math.round(r.right) });
    }

    var hasText = ownText(el);
    if (hasText) {
      textEls++;
      var fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
      fonts[fam] = (fonts[fam] || 0) + 1;
      var fs = Math.round(parseFloat(cs.fontSize));
      sizes[fs] = (sizes[fs] || 0) + 1;
      var fg = rgba(cs.color);
      if (fg) {
        colors[hex(fg)] = (colors[hex(fg)] || 0) + 1;
        var bg = background(el);
        if (bg) {
          var c = blend(fg, bg);
          var l1 = lum(c), l2 = lum(bg);
          var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          var large = fs >= 24 || (fs >= 18.5 && Number(cs.fontWeight) >= 700);
          var need = large ? 3 : 4.5;
          var key = hex(c) + hex(bg);
          if (ratio < need && !contrastSeen[key] && !(el.disabled || el.closest('[disabled],[aria-disabled="true"]'))) {
            contrastSeen[key] = 1;
            out.lowContrast.push({ el: label(el), ratio: Math.round(ratio * 10) / 10, need: need, fg: hex(c), bg: hex(bg) });
          }
        }
      }
      // Text cut off by its own box (unless it is meant to be: ellipsis or line clamp).
      if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
          (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) &&
          cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none' && out.clipped.length < 8) {
        out.clipped.push(label(el));
      } else if (cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0 && (isInteractive || /^(P|SPAN|DIV|LI|TD|TH|H[1-6])$/.test(tag)) && out.spill.length < 8) {
        out.spill.push(label(el));
      }
    }
    if (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== '0px') radii[cs.borderTopLeftRadius] = (radii[cs.borderTopLeftRadius] || 0) + 1;
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows++;

    if ((isInteractive || (hasText && el.children.length === 0)) && r.top < vh * 3 && overlapCandidates.length < 400) overlapCandidates.push({ el: el, r: r, fixed: cs.position === 'fixed' || cs.position === 'sticky' });

    var field = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) && !/^(hidden|checkbox|radio|submit|button|reset|image|range|color|file)$/.test(el.type);
    if (field && r.height < 28 && out.smallFields.length < 4) out.smallFields.push(label(el) + ' ' + Math.round(r.height) + 'px tall');
    if (isInteractive && tag !== 'LABEL' && !field) {
      var inlineLink = tag === 'A' && cs.display === 'inline' && el.parentElement && /^(P|LI|SPAN|TD|DD|SMALL)$/.test(el.parentElement.tagName);
      if (!inlineLink && (r.width < 24 || r.height < 24) && !(tag === 'INPUT' && /^(checkbox|radio)$/.test(el.type))) {
        out.smallTargetCount++;
        if (out.smallTargets.length < 5) out.smallTargets.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) && !/^(hidden|submit|button|reset|image)$/.test(el.type)) {
      var named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
      if (!named) { out.unlabeledCount++; if (out.unlabeled.length < 4) out.unlabeled.push(label(el)); }
    }
    if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
      if (!(el.innerText || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('aria-labelledby')) {
        out.emptyButtonCount++;
        if (out.emptyButtons.length < 4) out.emptyButtons.push(label(el));
      }
    }
    if (tag === 'IMG') {
      if (el.complete && el.naturalWidth === 0) out.brokenImages.push(short(el.getAttribute('src'), 80));
      if (!el.hasAttribute('alt')) out.imagesWithoutAlt++;
    }
    if (tag === 'CANVAS') out.canvases.push(Math.round(r.width) + 'x' + Math.round(r.height));
    var hm = /^H([1-6])$/.exec(tag);
    if (hm) {
      var level = Number(hm[1]);
      if (level === 1) out.headings.h1++;
      if (lastHeading && level > lastHeading + 1 && out.headings.skipped.length < 3) out.headings.skipped.push('h' + lastHeading + ' to h' + level);
      lastHeading = level;
    }

    // What is on screen, in reading order.
    if (out.outline.length < 45) {
      if (hm) out.outline.push('h' + hm[1] + ': ' + short(el.innerText, 80));
      else if (tag === 'BUTTON' || el.getAttribute('role') === 'button') out.outline.push('button: ' + (short(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'), 50) || '(no text)'));
      else if (tag === 'A' && el.getAttribute('href') && out.outline.filter(function (x) { return x.indexOf('link:') === 0; }).length < 15) out.outline.push('link: ' + (short(el.innerText || el.getAttribute('aria-label'), 50) || '(no text)') + ' -> ' + short(el.getAttribute('href'), 50));
      else if (tag === 'INPUT' && el.type !== 'hidden') out.outline.push('input[' + el.type + ']: ' + short(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || el.value, 50));
      else if (tag === 'SELECT' || tag === 'TEXTAREA') out.outline.push(tag.toLowerCase() + ': ' + short(el.getAttribute('aria-label') || el.name || el.getAttribute('placeholder'), 50));
      else if (tag === 'IMG') out.outline.push('img: ' + (short(el.getAttribute('alt'), 50) || '(no alt) ' + short(el.getAttribute('src'), 40)) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      else if (tag === 'CANVAS') out.outline.push('canvas ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }

  // Elements drawn on top of each other (not nested), in the first screens of the page.
  for (var a = 0; a < overlapCandidates.length && out.overlaps.length < 6; a++) {
    for (var b = a + 1; b < overlapCandidates.length && out.overlaps.length < 6; b++) {
      var A = overlapCandidates[a], B = overlapCandidates[b];
      if (A.fixed !== B.fixed) continue;
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      var w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      var h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w <= 2 || h <= 2) continue;
      var smaller = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (w * h > 0.25 * smaller && w * h > 16) out.overlaps.push(label(A.el) + ' and ' + label(B.el));
    }
  }

  function top(map, n) { return Object.keys(map).sort(function (x, y) { return map[y] - map[x]; }).slice(0, n); }
  out.design = {
    fonts: top(fonts, 4),
    sizes: Object.keys(sizes).map(Number).sort(function (x, y) { return x - y; }),
    colors: Object.keys(colors).length,
    topColors: top(colors, 5),
    radii: top(radii, 5),
    shadows: shadows,
    textEls: textEls
  };
  out.lowContrast.sort(function (x, y) { return x.ratio - y.ratio; });
  out.lowContrast = out.lowContrast.slice(0, 6);
  out.text = short(body.innerText, 700);
  out.empty = !out.text && !document.querySelector('img, canvas, svg, video, iframe');
  return out;
})()`;

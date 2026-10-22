// Markdown -> safe HTML (HTML in the source is escaped, never executed).
import { escapeHtml, iconHtml } from './dom.js';
import { highlight } from './highlight.js';

function inline(text) {
  // Protect code spans first.
  const codes = [];
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#|\/|\.)[^)\s]*)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, t, u) => `<a href="${u}" data-ext="1">${t}</a>`);
  // autolinks
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_m, pre, u) => `${pre}<a href="${u}" data-ext="1">${u}</a>`);
  s = s.replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w])__(?!\s)(.+?)(?<!\s)__(?![\w])/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '<em>$1</em>');
  s = s.replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '<em>$1</em>');
  s = s.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

function splitRow(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function codeBlock(code, lang) {
  const label = lang || 'code';
  return `<div class="codeblock"><div class="cb-head"><span>${escapeHtml(label)}</span><button class="copy-btn" data-copy="1">${iconHtml('copy', 'svg-sm')}Copy</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*).*$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2];
      const lang = fence[3] || '';
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].slice(Math.min(fence[1].length, lines[i].length - lines[i].trimStart().length)));
        i++;
      }
      i++; // closing fence (or end)
      out.push(codeBlock(body.join('\n'), lang));
      continue;
    }
    // table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c, j) => `<th style="text-align:${aligns[j] || 'left'}">${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => `<td style="text-align:${aligns[j] || 'left'}">${inline(r[j] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) {
      flushPara();
      const level = Math.min(4, hm[1].length);
      out.push(`<h${level}>${inline(hm[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(q.join('\n'))}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      out.push(renderList(lines, i, (next) => (i = next)));
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('\n');
}

function renderList(lines, start, setIndex) {
  const first = /^(\s*)([-*+]|\d{1,3}[.)])\s+/.exec(lines[start]);
  const baseIndent = first[1].replace(/\t/g, '    ').length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
    if (!m) {
      // continuation line for the previous item
      if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
        items[items.length - 1].body.push(lines[i].trim());
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].replace(/\t/g, '    ').length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // nested list
      if (items.length) {
        let nestedHtml = '';
        nestedHtml = renderList(lines, i, (n) => (i = n));
        items[items.length - 1].nested.push(nestedHtml);
        continue;
      }
    }
    items.push({ text: m[3], body: [], nested: [] });
    i++;
  }
  setIndex(i);
  const isTasks = items.some((it) => /^\[[ xX]\]\s/.test(it.text));
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered ? ` start="${parseInt(first[2], 10) || 1}"` : '';
  return `<${tag}${startAttr}${isTasks ? ' class="tasks"' : ''}>${items
    .map((it) => {
      let text = it.text;
      let prefix = '';
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) {
        prefix = task[1] === ' ' ? '☐ ' : '☑ ';
        text = task[2];
      }
      const body = it.body.length ? `<br>${it.body.map(inline).join('<br>')}` : '';
      return `<li>${prefix}${inline(text)}${body}${it.nested.join('')}</li>`;
    })
    .join('')}</${tag}>`;
}

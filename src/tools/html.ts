// Dependency-free HTML -> Markdown-ish text conversion for WebFetch.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  check: '✓',
  zwj: '',
  zwnj: '',
  shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined;
}

function resolveUrl(href: string, base?: string): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!.replace(/\s+/g, ' ').trim()) : undefined;
}

/** Converts HTML to readable markdown. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html;
  // Drop non-content blocks.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|object|head|select|button)\b[\s\S]*?<\/\1\s*>/gi, '');
  // Prefer main content regions when present.
  const main = /<main\b[\s\S]*?<\/main\s*>/i.exec(s) || /<article\b[\s\S]*?<\/article\s*>/i.exec(s);
  if (main && main[0].length > 500) s = main[0];
  s = s.replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, '');

  const out: string[] = [];
  let inPre = 0;
  let listDepth = 0;
  const olCounters: number[] = [];
  let linkStack: { href?: string; start: number }[] = [];
  let pendingCell = false;

  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(s))) {
    const tok = m[0];
    if (!m[1]) {
      // text
      let text = decodeEntities(tok);
      if (!inPre) text = text.replace(/\s+/g, ' ');
      out.push(text);
      continue;
    }
    const name = m[1].toLowerCase();
    const closing = tok.startsWith('</');
    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `);
        break;
      case 'p':
      case 'div':
      case 'section':
      case 'header':
      case 'figure':
      case 'figcaption':
      case 'dl':
      case 'details':
      case 'summary':
        out.push('\n\n');
        break;
      case 'br':
        out.push(inPre ? '\n' : '  \n');
        break;
      case 'hr':
        out.push('\n\n---\n\n');
        break;
      case 'ul':
        listDepth += closing ? -1 : 1;
        listDepth = Math.max(0, listDepth);
        out.push('\n');
        break;
      case 'ol':
        if (closing) olCounters.pop();
        else olCounters.push(0);
        listDepth += closing ? -1 : 1;
        listDepth = Math.max(0, listDepth);
        out.push('\n');
        break;
      case 'li':
        if (!closing) {
          const indent = '  '.repeat(Math.max(0, listDepth - 1));
          if (olCounters.length) {
            olCounters[olCounters.length - 1]!++;
            out.push(`\n${indent}${olCounters[olCounters.length - 1]}. `);
          } else out.push(`\n${indent}- `);
        }
        break;
      case 'dt':
        out.push(closing ? '' : '\n**');
        if (closing) out.push('**');
        break;
      case 'dd':
        if (!closing) out.push('\n: ');
        break;
      case 'blockquote':
        out.push(closing ? '\n\n' : '\n\n> ');
        break;
      case 'pre':
        if (closing) {
          inPre = Math.max(0, inPre - 1);
          out.push('\n```\n\n');
        } else {
          inPre++;
          const lang = /class="[^"]*(?:language|lang)-([\w+-]+)/i.exec(tok)?.[1] ?? '';
          out.push(`\n\n\`\`\`${lang}\n`);
        }
        break;
      case 'code':
        if (!inPre) out.push('`');
        break;
      case 'strong':
      case 'b':
        out.push('**');
        break;
      case 'em':
      case 'i':
        out.push('*');
        break;
      case 'a':
        if (!closing) {
          linkStack.push({ href: attr(tok, 'href'), start: out.length });
        } else {
          const l = linkStack.pop();
          if (l?.href && !l.href.startsWith('javascript:') && !l.href.startsWith('#')) {
            const text = out.splice(l.start).join('').trim();
            if (text) out.push(`[${text}](${resolveUrl(l.href, baseUrl)})`);
          }
        }
        break;
      case 'img': {
        const alt = attr(tok, 'alt');
        if (alt) out.push(`[image: ${alt}]`);
        break;
      }
      case 'tr':
        out.push(closing ? ' |' : '\n|');
        pendingCell = false;
        break;
      case 'td':
      case 'th':
        if (!closing) {
          out.push(pendingCell ? ' | ' : ' ');
          pendingCell = true;
        }
        break;
      case 'table':
        out.push('\n\n');
        linkStack = linkStack.filter(Boolean);
        break;
      default:
        break;
    }
  }
  let text = out.join('');
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
  return text;
}

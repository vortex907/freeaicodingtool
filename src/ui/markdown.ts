// Streaming Markdown -> ANSI renderer for the terminal.
import { c, padEndWidth, stringWidth, theme, truncateToWidth, wrapAnsi } from '../util/ansi.js';
import { highlightLine } from './highlight.js';

/** Inline formatting: code spans, bold, italic, strikethrough, links. */
export function renderInline(text: string): string {
  const parts = text.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += formatPlain(parts[i] ?? '');
    else if (i % 3 === 2) out += theme.code(parts[i]!);
  }
  return out;
}

function formatPlain(s: string): string {
  if (!s) return s;
  return s
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, t: string, u: string) => (t === u ? theme.link(u) : `${theme.link(t)}${c.dim(` (${u})`)}`))
    .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, (_m, t: string) => c.bold(c.italic(t)))
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, (_m, t: string) => c.bold(t))
    .replace(/(?<![\w])__(?!\s)(.+?)(?<!\s)__(?![\w])/g, (_m, t: string) => c.bold(t))
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, (_m, t: string) => c.italic(t))
    .replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, (_m, t: string) => c.italic(t))
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, (_m, t: string) => c.strike(t))
    .replace(/(?<![(\w/])(https?:\/\/[^\s)>\]]+)/g, (u: string) => theme.link(u));
}

interface Fence {
  marker: string;
  lang: string;
  indent: number;
}

export class MarkdownStream {
  private buf = '';
  private fence: Fence | null = null;
  private table: string[] = [];
  private lastBlank = true;
  private emittedAny = false;

  constructor(
    private width: () => number,
    private emit: (lines: string[]) => void,
  ) {}

  push(delta: string): void {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.processLine(line);
    }
  }

  /** Rendered preview of the incomplete last line (for the live region). */
  pending(): string {
    if (this.table.length) return c.dim(`(table, ${this.table.length} rows…)`);
    if (!this.buf) return '';
    if (this.fence) return '  ' + highlightLine(this.buf, this.fence.lang);
    return renderInline(this.buf);
  }

  end(): void {
    if (this.buf) {
      const line = this.buf;
      this.buf = '';
      this.processLine(line);
    }
    this.flushTable();
    this.fence = null;
  }

  get hasOutput(): boolean {
    return this.emittedAny;
  }

  private out(lines: string[]): void {
    if (!lines.length) return;
    this.emittedAny = true;
    this.emit(lines);
  }

  private processLine(line: string): void {
    const w = Math.max(20, this.width());
    if (this.fence) {
      const close = new RegExp(`^\\s*${this.fence.marker[0] === '`' ? '`' : '~'}{${this.fence.marker.length},}\\s*$`);
      if (close.test(line)) {
        this.fence = null;
        this.lastBlank = false;
        return;
      }
      const code = line.slice(Math.min(this.fence.indent, line.length - line.trimStart().length));
      this.out([c.dim('│ ') + truncateToWidth(highlightLine(code, this.fence.lang), w - 2)]);
      return;
    }
    const fm = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fm) {
      this.flushTable();
      this.fence = { marker: fm[2]!, lang: fm[3] ?? '', indent: fm[1]!.length };
      if (this.fence.lang) this.out([c.dim(`│ ${this.fence.lang}`)]);
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(line) || (this.table.length && /^\s*\|/.test(line))) {
      this.table.push(line);
      return;
    }
    this.flushTable();

    if (!line.trim()) {
      if (!this.lastBlank && this.emittedAny) this.out(['']);
      this.lastBlank = true;
      return;
    }
    this.lastBlank = false;

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = renderInline(h[2]!);
      const styled = level <= 2 ? c.bold(c.underline(text)) : c.bold(text);
      this.out(wrapAnsi(styled, w, { hard: false }));
      return;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      this.out([c.dim('─'.repeat(Math.min(w, 60)))]);
      return;
    }
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      const lines = wrapAnsi(c.italic(renderInline(bq[1]!)), w - 2, { hard: false });
      this.out(lines.map((l) => c.dim('│ ') + l));
      return;
    }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor(li[1]!.replace(/\t/g, '  ').length / 2);
      let bullet = /\d/.test(li[2]!) ? li[2]! : depth % 2 ? '◦' : '•';
      let text = li[3]!;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) {
        bullet = task[1] === ' ' ? '☐' : theme.success('☒');
        text = task[2]!;
      }
      const indent = '  '.repeat(depth);
      const head = `${indent}${bullet} `;
      const hang = ' '.repeat(stringWidth(head));
      const wrapped = wrapAnsi(renderInline(text), Math.max(10, w - stringWidth(head)), { hard: false });
      this.out(wrapped.map((l, i) => (i === 0 ? head : hang) + l));
      return;
    }
    this.out(wrapAnsi(renderInline(line), w, { hard: false }));
  }

  private flushTable(): void {
    if (!this.table.length) return;
    const rows = this.table;
    this.table = [];
    this.out(renderTable(rows, Math.max(20, this.width())));
    this.lastBlank = false;
  }
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i]!;
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && r[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function renderTable(rows: string[], width: number): string[] {
  const parsed = rows.map(splitRow);
  const sepIdx = parsed.findIndex((r) => r.length && r.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, ''))));
  const aligns: ('left' | 'center' | 'right')[] = [];
  if (sepIdx >= 0) {
    for (const cell of parsed[sepIdx]!) {
      const t = cell.trim();
      aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : 'left');
    }
  }
  const body = parsed.filter((_, i) => i !== sepIdx);
  if (!body.length) return [];
  const cols = Math.max(...body.map((r) => r.length));
  const rendered = body.map((r) => Array.from({ length: cols }, (_, i) => renderInline(r[i] ?? '')));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...rendered.map((r) => stringWidth(r[i]!))));
  const overhead = cols * 3 + 1;
  // Shrink the widest columns until the table fits.
  while (widths.reduce((a, b) => a + b, 0) + overhead > width) {
    const max = Math.max(...widths);
    if (max <= 6) break;
    widths[widths.indexOf(max)] = max - 1;
  }
  const line = (l: string, m: string, r: string) => c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const cellText = (s: string, i: number) => {
    const w = widths[i]!;
    const t = stringWidth(s) > w ? truncateToWidth(s, w) : s;
    const pad = w - stringWidth(t);
    const a = aligns[i] ?? 'left';
    if (a === 'right') return ' '.repeat(pad) + t;
    if (a === 'center') return ' '.repeat(Math.floor(pad / 2)) + t + ' '.repeat(Math.ceil(pad / 2));
    return padEndWidth(t, w);
  };
  const out: string[] = [line('┌', '┬', '┐')];
  rendered.forEach((r, ri) => {
    out.push(c.dim('│ ') + r.map((cell, i) => (ri === 0 && sepIdx === 1 ? c.bold(cellText(cell, i)) : cellText(cell, i))).join(c.dim(' │ ')) + c.dim(' │'));
    if (ri === 0 && sepIdx === 1 && rendered.length > 1) out.push(line('├', '┼', '┤'));
  });
  out.push(line('└', '┴', '┘'));
  return out;
}

/** Renders a complete markdown string to lines. */
export function renderMarkdown(text: string, width: number): string[] {
  const lines: string[] = [];
  const md = new MarkdownStream(() => width, (l) => lines.push(...l));
  md.push(text);
  md.end();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

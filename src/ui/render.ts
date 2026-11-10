// Formatting of tool calls, results, diffs, todo lists and banners.
import { c, padEndWidth, stringWidth, theme, truncateToWidth, wrapAnsi } from '../util/ansi.js';
import type { DiffHunk, Todo, ToolDisplay, ToolResult } from '../tools/types.js';
import { highlightLine, guessLangFromPath } from './highlight.js';
import { renderMarkdown } from './markdown.js';

export const BULLET = '⏺';
export const RESULT_PREFIX = '  ⎿  ';
export const INDENT = '     ';

export function indentLines(lines: string[], first: string, rest: string): string[] {
  return lines.map((l, i) => (i === 0 ? first : rest) + l);
}

/** Styles "Tool(args)" with a bold tool name. */
export function formatToolLabel(label: string): string {
  const m = /^([\w:.-]+)\(([\s\S]*)\)$/.exec(label);
  if (m) return `${c.bold(m[1]!)}${c.dim('(')}${m[2]}${c.dim(')')}`;
  return c.bold(label);
}

export function formatToolHeader(label: string, status: 'ok' | 'error' | 'denied' | 'running'): string {
  const dot = status === 'error' ? theme.error(BULLET) : status === 'denied' ? theme.warn(BULLET) : status === 'running' ? theme.muted(BULLET) : theme.success(BULLET);
  return `${dot} ${formatToolLabel(label)}`;
}

export function renderDiff(hunks: DiffHunk[], path: string, width: number, maxLines = 40): string[] {
  const out: string[] = [];
  const lang = guessLangFromPath(path);
  const numW = Math.max(3, String(Math.max(...hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)))).length);
  let count = 0;
  let truncated = 0;
  hunks.forEach((h, hi) => {
    if (hi > 0) {
      if (count < maxLines) out.push(c.dim(' '.repeat(numW) + ' ...'));
    }
    for (const l of h.lines) {
      if (count >= maxLines) {
        truncated++;
        continue;
      }
      const no = l.type === 'del' ? l.oldNo : l.newNo;
      const num = c.dim(String(no ?? '').padStart(numW));
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      const avail = width - numW - 3;
      const text = truncateToWidth(l.text.replace(/\t/g, '  '), avail);
      if (l.type === 'add') out.push(`${num} ${theme.diffAdd(padEndWidth(`${sign} ${text}`, avail + 2))}`);
      else if (l.type === 'del') out.push(`${num} ${theme.diffDel(padEndWidth(`${sign} ${text}`, avail + 2))}`);
      else out.push(`${num}   ${highlightLine(text, lang)}`);
      count++;
    }
  });
  if (truncated) out.push(c.dim(`${' '.repeat(numW)} … ${truncated} more diff lines`));
  return out;
}

export function renderTodos(todos: Todo[], width: number): string[] {
  if (!todos.length) return [c.dim('(no tasks)')];
  return todos.flatMap((t) => {
    const box = t.status === 'completed' ? theme.success('☒') : t.status === 'in_progress' ? theme.accent('◼') : '☐';
    let text = t.content;
    if (t.status === 'completed') text = c.dim(c.strike(text));
    else if (t.status === 'in_progress') text = c.bold(text);
    return wrapAnsi(`${box} ${text}`, width, { hard: false }).map((l, i) => (i === 0 ? l : '  ' + l));
  });
}

function summarizeOutputLines(text: string, maxLines: number, width: number, dim: boolean): string[] {
  const all = text.replace(/\s+$/, '').split('\n');
  const shown = all.slice(0, maxLines).map((l) => truncateToWidth(l.replace(/\t/g, '  '), width));
  const out = shown.map((l) => (dim ? c.dim(l) : l));
  if (all.length > maxLines) out.push(c.dim(`… +${all.length - maxLines} lines`));
  return out;
}

/** Lines shown under a finished tool call. */
export function renderToolResult(result: ToolResult, width: number): string[] {
  const w = Math.max(20, width - INDENT.length);
  const d: ToolDisplay | undefined = result.display;
  let body: string[];
  if (result.isError && (!d || d.kind === 'summary' || d.kind === 'text')) {
    const msg = d?.kind === 'summary' ? d.text : result.content;
    body = summarizeOutputLines(msg, 4, w, false).map((l) => theme.error(l));
  } else if (!d) {
    body = summarizeOutputLines(result.content, 3, w, true);
  } else {
    switch (d.kind) {
      case 'summary':
        body = [c.dim(truncateToWidth(d.text, w))];
        break;
      case 'text':
        body = summarizeOutputLines(d.text, d.maxLines ?? 6, w, d.dim ?? true);
        break;
      case 'diff': {
        const verb = d.created ? 'Created' : 'Updated';
        const stats = d.created ? `${d.added} line${d.added === 1 ? '' : 's'}` : `${d.added} addition${d.added === 1 ? '' : 's'} and ${d.removed} removal${d.removed === 1 ? '' : 's'}`;
        body = [`${verb} ${c.bold(d.path)} with ${stats}`, ...renderDiff(d.hunks, d.path, w, d.created ? 12 : 40)];
        break;
      }
      case 'todos':
        body = renderTodos(d.todos, w);
        break;
      case 'markdown':
        body = renderMarkdown(d.text, w);
        break;
      case 'image':
        // Screenshots come with a page report; images the agent read do not.
        body = d.text === undefined ? [c.dim(`Image: ${d.summary ?? ''}`)] : [c.dim(`Screenshot: ${d.summary ?? 'taken'}`), ...summarizeOutputLines(d.text, 6, w, true)];
        break;
      case 'none':
        body = [];
        break;
    }
  }
  if (!body.length) return [];
  return indentLines(body, RESULT_PREFIX, INDENT);
}

export function boxLines(lines: string[], width: number, color: (s: string) => string = theme.border): string[] {
  const inner = width - 4;
  const out = [color('╭' + '─'.repeat(width - 2) + '╮')];
  for (const l of lines) {
    for (const wl of wrapAnsi(l, inner, { hard: true })) out.push(color('│') + ' ' + padEndWidth(wl, inner) + ' ' + color('│'));
  }
  out.push(color('╰' + '─'.repeat(width - 2) + '╯'));
  return out;
}

export const LOGO = [
  '███████╗██████╗ ███████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '█████╗  ██████╔╝█████╗  █████╗  ██║     ██║   ██║██║  ██║█████╗  ',
  '██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝  ',
  '██║     ██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

export function logoLines(width: number): string[] {
  if (width < stringWidth(LOGO[0]!) + 4) return [theme.brand('✻ FreeCode')];
  return LOGO.map((l) => theme.accent(l));
}

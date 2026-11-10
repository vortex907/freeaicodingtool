// Turns language server answers into short text for the model.
import type { Diagnostic, DocumentSymbol, Hover, MarkedString, SymbolInformation } from './protocol.js';
import { splitLines } from './protocol.js';
import { truncate } from '../util/strings.js';

/** Most diagnostics listed after an edit. */
export const EDIT_REPORT_LINES = 15;
/** Warnings are mentioned after an edit only when there are no errors and at most this many. */
export const EDIT_REPORT_WARNINGS = 5;

export const isError = (d: Diagnostic) => d.severity === undefined || d.severity === 1;
export const isWarning = (d: Diagnostic) => d.severity === 2;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function codeOf(d: Diagnostic): string {
  if (d.code === undefined || d.code === null || d.code === '') return '';
  const code = typeof d.code === 'number' && /typescript|^ts$/i.test(d.source ?? '') ? `TS${d.code}` : String(d.code);
  return ` [${code}]`;
}

/** "12:5 Type 'string' is not assignable to type 'number'. [TS2322]" (1-based line and column). */
export function diagnosticLine(d: Diagnostic): string {
  const msg = truncate(d.message.split(/\r?\n/)[0]!.trim(), 220);
  return `${d.range.start.line + 1}:${d.range.start.character + 1} ${msg}${codeOf(d)}`;
}

function byPosition(a: Diagnostic, b: Diagnostic): number {
  return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}

/** Identity of a diagnostic that survives lines moving: severity, message and the text of its line. */
function identity(d: Diagnostic, lines: string[]): string {
  return `${d.severity ?? 1}|${d.message}|${(lines[d.range.start.line] ?? '').trim()}`;
}

export interface EditReportInput {
  /** Path as shown to the model. */
  rel: string;
  /** Server name, e.g. "pyright". */
  label: string;
  items: Diagnostic[];
  text: string;
  /** Diagnostics and text from before the edit, when the server had the file open already. */
  before?: { items: Diagnostic[]; text: string };
}

/**
 * What the model sees after an edit: the file's errors (new ones first, at most EDIT_REPORT_LINES),
 * or a few warnings when there are no errors, or that the errors it had are gone. Null when there is
 * nothing worth saying.
 */
export function editReport(r: EditReportInput): string | null {
  const errors = r.items.filter(isError);
  const warnings = r.items.filter(isWarning);
  const lines = splitLines(r.text);
  let isNew: (d: Diagnostic) => boolean = () => true;
  if (r.before) {
    const oldLines = splitLines(r.before.text);
    const known = new Map<string, number>();
    for (const d of r.before.items) {
      const k = identity(d, oldLines);
      known.set(k, (known.get(k) ?? 0) + 1);
    }
    isNew = (d) => {
      const k = identity(d, lines);
      const n = known.get(k) ?? 0;
      if (n > 0) known.set(k, n - 1);
      return n === 0;
    };
  }
  if (errors.length) {
    const tagged = errors.sort(byPosition).map((d) => ({ d, fresh: isNew(d) }));
    const freshCount = tagged.filter((t) => t.fresh).length;
    tagged.sort((a, b) => Number(b.fresh) - Number(a.fresh));
    const note = !r.before ? '' : freshCount === 0 ? ' (all of them were there before this edit)' : freshCount < errors.length ? ` (${freshCount} new)` : '';
    const shown = tagged.slice(0, EDIT_REPORT_LINES).map((t) => `  ${diagnosticLine(t.d)}`);
    if (errors.length > shown.length) shown.push(`  and ${errors.length - shown.length} more`);
    const out = [`${r.label} found ${plural(errors.length, 'error')} in ${r.rel} after this edit${note}:`, ...shown];
    if (freshCount) out.push(r.before ? 'Fix the errors this edit caused before moving on.' : 'Fix the errors this edit caused before moving on (some may have been there before).');
    return out.join('\n');
  }
  if (r.before && r.before.items.some(isError)) return `${r.label}: no errors left in ${r.rel}.`;
  if (warnings.length && warnings.length <= EDIT_REPORT_WARNINGS) {
    const fresh = warnings.sort(byPosition).filter((d) => isNew(d));
    if (!fresh.length) return null;
    return [`${r.label} found ${plural(warnings.length, 'warning')} in ${r.rel}:`, ...warnings.map((d) => `  ${diagnosticLine(d)}`)].join('\n');
  }
  return null;
}

/** New errors in other files after an edit (a changed signature breaks its callers). */
export function otherFilesReport(entries: { rel: string; items: Diagnostic[] }[], max = 5): string | null {
  const lines: string[] = [];
  let total = 0;
  for (const e of entries) {
    for (const d of e.items.sort(byPosition)) {
      total++;
      if (lines.length < max) lines.push(`  ${e.rel}:${diagnosticLine(d)}`);
    }
  }
  if (!total) return null;
  if (total > lines.length) lines.push(`  and ${total - lines.length} more`);
  return [`New errors in other files:`, ...lines].join('\n');
}

/** All errors and warnings of one file for the LSP tool (information and hints left out). */
export function fileDiagnosticsReport(rel: string, label: string, items: Diagnostic[], max = 60): string {
  const errors = items.filter(isError).sort(byPosition);
  const warnings = items.filter(isWarning).sort(byPosition);
  if (!errors.length && !warnings.length) return `${label} reports no errors or warnings in ${rel}.`;
  const out = [`${label}: ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')} in ${rel}`];
  const list = [...errors.map((d) => `  ${diagnosticLine(d)}`), ...warnings.map((d) => `  warning ${diagnosticLine(d)}`)];
  out.push(...list.slice(0, max));
  if (list.length > max) out.push(`  and ${list.length - max} more`);
  return out.join('\n');
}

/** Errors (then warnings while there is room) across files, for the workspace diagnostics. */
export function projectDiagnosticsReport(files: { rel: string; items: Diagnostic[] }[], max = 60): { text: string; errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  const withErrors = files.map((f) => ({ ...f, errors: f.items.filter(isError).sort(byPosition), warnings: f.items.filter(isWarning).sort(byPosition) })).filter((f) => f.errors.length || f.warnings.length);
  for (const f of withErrors) {
    errors += f.errors.length;
    warnings += f.warnings.length;
  }
  withErrors.sort((a, b) => b.errors.length - a.errors.length || a.rel.localeCompare(b.rel));
  const out: string[] = [];
  let shown = 0;
  for (const kind of ['errors', 'warnings'] as const) {
    for (const f of withErrors) {
      for (const d of f[kind]) {
        if (shown >= max) break;
        out.push(`${f.rel}:${kind === 'warnings' ? diagnosticLine(d).replace(/^(\d+:\d+) /, '$1 warning: ') : diagnosticLine(d)}`);
        shown++;
      }
    }
  }
  if (errors + warnings > shown) out.push(`and ${errors + warnings - shown} more`);
  return { text: out.join('\n'), errors, warnings };
}

// ------------------------------------------------------------------ hover and symbols

function markedToText(m: MarkedString): string {
  return typeof m === 'string' ? m : `\`\`\`${m.language}\n${m.value}\n\`\`\``;
}

export function hoverText(h: Hover | null): string {
  if (!h || !h.contents) return '';
  const c = h.contents;
  const text = Array.isArray(c) ? c.map(markedToText).join('\n\n') : typeof c === 'object' && 'kind' in c ? c.value : markedToText(c as MarkedString);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

export function symbolKind(kind: number): string {
  return KINDS[kind] ?? 'symbol';
}

/** Kinds that make an outline long without helping to find one's way. */
const NOISE = new Set([13, 14, 15, 16, 17, 18, 20, 21]);

/** An indented outline of a file. Variables inside functions are left out. */
export function outline(symbols: (DocumentSymbol | SymbolInformation)[], max = 150): { text: string; count: number } {
  const out: string[] = [];
  let count = 0;
  const walk = (list: DocumentSymbol[], depth: number, parentKind: number) => {
    for (const s of [...list].sort((a, b) => a.range.start.line - b.range.start.line)) {
      // Locals of functions and methods are noise in an outline.
      if (depth > 0 && NOISE.has(s.kind) && (parentKind === 6 || parentKind === 9 || parentKind === 12)) continue;
      count++;
      if (out.length < max) out.push(`${'  '.repeat(depth)}${symbolKind(s.kind)} ${s.name}${s.detail ? ` ${truncate(s.detail.replace(/\s+/g, ' '), 80)}` : ''} (line ${s.selectionRange.start.line + 1})`);
      if (s.children?.length) walk(s.children, depth + 1, s.kind);
    }
  };
  if (symbols.length && 'location' in symbols[0]!) {
    // Flat SymbolInformation list (older servers).
    for (const s of symbols as SymbolInformation[]) {
      count++;
      const line = 'range' in s.location ? ` (line ${s.location.range.start.line + 1})` : '';
      if (out.length < max) out.push(`${s.containerName ? '  ' : ''}${symbolKind(s.kind)} ${s.name}${line}`);
    }
  } else walk(symbols as DocumentSymbol[], 0, 0);
  if (count > out.length) out.push(`and ${count - out.length} more`);
  return { text: out.join('\n'), count };
}

/** The source line at a location, trimmed for display. */
export function sourceLine(text: string | undefined, line: number): string {
  if (text === undefined) return '';
  return truncate((splitLines(text)[line] ?? '').trim(), 160);
}

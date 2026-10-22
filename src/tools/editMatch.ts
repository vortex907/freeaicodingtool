// Robust search/replace used by Edit and MultiEdit. Free models are often slightly off with
// whitespace, indentation, line endings or copy the line-number prefixes from Read output, so after
// an exact match fails we try progressively looser (but still unambiguous) strategies.
import { similarity } from '../util/strings.js';

export type MatchStrategy = 'exact' | 'line-endings' | 'line-numbers' | 'trailing-whitespace' | 'indentation' | 'unicode' | 'blank-lines';

export type EditOutcome =
  | { ok: true; content: string; count: number; strategy: MatchStrategy; firstLine: number; lastLine: number }
  | { ok: false; error: string };

function countOccurrences(hay: string, needle: string): number[] {
  const idx: number[] = [];
  if (!needle) return idx;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    idx.push(i);
    from = i + needle.length;
  }
  return idx;
}

function lineOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

const LINE_NO_RE = /^\s*\d+(\t|→| \| |\| |: | {2})/;

/** Removes "   12\t" style prefixes copied from Read output. */
export function stripLineNumbers(s: string): string | null {
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length);
  if (!nonEmpty.length || !nonEmpty.every((l) => LINE_NO_RE.test(l))) return null;
  return lines.map((l) => l.replace(LINE_NO_RE, '')).join('\n');
}

function normalizeUnicode(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[       ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '');
}

function replaceAt(content: string, positions: number[], oldLen: number, replacement: string): string {
  let out = '';
  let last = 0;
  for (const p of positions) {
    out += content.slice(last, p) + replacement;
    last = p + oldLen;
  }
  return out + content.slice(last);
}

function leadingWs(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** Re-indents `newLines` so that their base indentation matches the file. */
function reindent(newLines: string[], oldFirstIndent: string, fileFirstIndent: string): string[] {
  if (oldFirstIndent === fileFirstIndent) return newLines;
  return newLines.map((l) => {
    if (!l.trim()) return l;
    if (oldFirstIndent && l.startsWith(oldFirstIndent)) return fileFirstIndent + l.slice(oldFirstIndent.length);
    if (!oldFirstIndent) return fileFirstIndent + l;
    // Line indented less than the reference: keep relative structure as best we can.
    const lw = leadingWs(l);
    if (fileFirstIndent.length > oldFirstIndent.length) return fileFirstIndent.slice(0, fileFirstIndent.length - oldFirstIndent.length) + l;
    return l.slice(Math.min(lw.length, oldFirstIndent.length - fileFirstIndent.length));
  });
}

interface LineMatch {
  start: number; // line index
  end: number; // exclusive
}

function findLineWindows(fileLines: string[], oldLines: string[], norm: (s: string) => string): LineMatch[] {
  const target = oldLines.map(norm);
  const normFile = fileLines.map(norm);
  const out: LineMatch[] = [];
  const n = target.length;
  if (!n) return out;
  for (let i = 0; i + n <= normFile.length; i++) {
    let okm = true;
    for (let j = 0; j < n; j++) {
      if (normFile[i + j] !== target[j]) {
        okm = false;
        break;
      }
    }
    if (okm) out.push({ start: i, end: i + n });
  }
  return out;
}

/** Matching that ignores blank lines on both sides. Returns original line ranges. */
function findIgnoringBlankLines(fileLines: string[], oldLines: string[], norm: (s: string) => string): LineMatch[] {
  const target = oldLines.filter((l) => l.trim()).map(norm);
  if (target.length < 2) return [];
  const idx: number[] = [];
  const nf: string[] = [];
  fileLines.forEach((l, i) => {
    if (l.trim()) {
      idx.push(i);
      nf.push(norm(l));
    }
  });
  const out: LineMatch[] = [];
  for (let i = 0; i + target.length <= nf.length; i++) {
    let okm = true;
    for (let j = 0; j < target.length; j++) {
      if (nf[i + j] !== target[j]) {
        okm = false;
        break;
      }
    }
    if (okm) out.push({ start: idx[i]!, end: idx[i + target.length - 1]! + 1 });
  }
  return out;
}

function tryExact(content: string, oldStr: string, newStr: string, replaceAll: boolean, strategy: MatchStrategy): EditOutcome | 'none' {
  const pos = countOccurrences(content, oldStr);
  if (!pos.length) return 'none';
  if (pos.length > 1 && !replaceAll) {
    const lines = pos.slice(0, 10).map((p) => lineOf(content, p));
    return {
      ok: false,
      error: `Found ${pos.length} matches of old_string (at lines ${lines.join(', ')}${pos.length > 10 ? ', ...' : ''}). Include more surrounding lines in old_string so it matches exactly one place, or set replace_all to true to change every occurrence.`,
    };
  }
  const first = lineOf(content, pos[0]!);
  return {
    ok: true,
    content: replaceAt(content, pos, oldStr.length, newStr),
    count: pos.length,
    strategy,
    firstLine: first,
    lastLine: first + newStr.split('\n').length - 1,
  };
}

/** Applies one search/replace edit to `content`. */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll = false): EditOutcome {
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };
  if (oldStr === '') {
    if (content.trim() === '') return { ok: true, content: newStr, count: 1, strategy: 'exact', firstLine: 1, lastLine: newStr.split('\n').length };
    return { ok: false, error: 'old_string is empty but the file is not. To replace the whole file use the Write tool; otherwise put the exact text to replace in old_string.' };
  }

  // 1. exact
  let r = tryExact(content, oldStr, newStr, replaceAll, 'exact');
  if (r !== 'none') return r;

  const crlf = content.includes('\r\n');
  const toFileEol = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

  // 2. line endings
  r = tryExact(content, toFileEol(oldStr), toFileEol(newStr), replaceAll, 'line-endings');
  if (r !== 'none') return r;

  // 3. line-number prefixes copied from Read output
  const strippedOld = stripLineNumbers(oldStr);
  let o = oldStr;
  let nw = newStr;
  if (strippedOld !== null) {
    o = strippedOld;
    nw = stripLineNumbers(newStr) ?? newStr;
    r = tryExact(content, toFileEol(o), toFileEol(nw), replaceAll, 'line-numbers');
    if (r !== 'none') return r;
  }

  // 4. unicode punctuation normalization on the model side (smart quotes, nbsp...)
  const uo = normalizeUnicode(o);
  if (uo !== o) {
    r = tryExact(content, toFileEol(uo), toFileEol(normalizeUnicode(nw)), replaceAll, 'unicode');
    if (r !== 'none') return r;
  }

  // Line-based strategies (whole lines only)
  const eol = crlf ? '\r\n' : '\n';
  const fileLines = content.split(/\r?\n/);
  const oldLines = o.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const newLinesRaw = nw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const strategies: { name: MatchStrategy; norm: (s: string) => string; blank?: boolean }[] = [
    { name: 'trailing-whitespace', norm: (s) => s.trimEnd() },
    { name: 'indentation', norm: (s) => normalizeUnicode(s).trim().replace(/\s+/g, ' ') },
    { name: 'blank-lines', norm: (s) => normalizeUnicode(s).trim().replace(/\s+/g, ' '), blank: true },
  ];
  for (const st of strategies) {
    const matches = st.blank ? findIgnoringBlankLines(fileLines, oldLines, st.norm) : findLineWindows(fileLines, oldLines, st.norm);
    if (!matches.length) continue;
    if (matches.length > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${matches.length} places when ignoring whitespace differences (lines ${matches.slice(0, 10).map((m) => m.start + 1).join(', ')}). Add more context so it is unique, or set replace_all to true.`,
      };
    }
    // Apply from the bottom so earlier indices stay valid.
    const lines = [...fileLines];
    let first = Infinity;
    let last = 0;
    for (const m of [...matches].reverse()) {
      const fileIndent = leadingWs(lines[m.start]!);
      const oldFirst = oldLines.find((l) => l.trim()) ?? '';
      const repl = st.name === 'trailing-whitespace' ? newLinesRaw : reindent(newLinesRaw, leadingWs(oldFirst), fileIndent);
      const replacement = nw === '' ? [] : repl;
      lines.splice(m.start, m.end - m.start, ...replacement);
      first = Math.min(first, m.start + 1);
      last = Math.max(last, m.start + replacement.length);
    }
    return { ok: true, content: lines.join(eol), count: matches.length, strategy: st.name, firstLine: first, lastLine: Math.max(first, last) };
  }

  return { ok: false, error: notFoundMessage(fileLines, oldLines) };
}

/** Builds a helpful error showing the most similar region of the file. */
function notFoundMessage(fileLines: string[], oldLines: string[]): string {
  const n = Math.max(1, oldLines.length);
  const target = oldLines.map((l) => l.trim()).join('\n');
  let best = -1;
  let bestScore = 0;
  if (fileLines.length * n < 2_000_000) {
    // Anchor on lines similar to the first non-empty old line, then score windows.
    const firstOld = oldLines.find((l) => l.trim())?.trim() ?? '';
    for (let i = 0; i < fileLines.length; i++) {
      const fl = fileLines[i]!.trim();
      if (!fl) continue;
      if (firstOld && similarity(fl.slice(0, 200), firstOld.slice(0, 200)) < 0.5 && n > 1) continue;
      const window = fileLines.slice(i, i + n).map((l) => l.trim()).join('\n');
      const sc = similarity(window.slice(0, 3000), target.slice(0, 3000));
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
  }
  let msg = 'old_string was not found in the file. It must match the file content exactly, including whitespace and indentation (do not include line-number prefixes from Read output).';
  if (best >= 0 && bestScore > 0.45) {
    const from = Math.max(0, best - 1);
    const to = Math.min(fileLines.length, best + n + 1);
    const snippet = fileLines
      .slice(from, to)
      .map((l, i) => `${String(from + i + 1).padStart(6)}\t${l}`)
      .join('\n');
    msg += `\nThe most similar part of the file (${Math.round(bestScore * 100)}% similar, lines ${from + 1}-${to}) is:\n${snippet}\nCopy the exact text from there into old_string, or Read the file again.`;
  } else {
    msg += ' Read the file again to see its current content.';
  }
  return msg;
}

// Line diff (Myers algorithm) and hunk construction for edit previews.
import type { DiffHunk, DiffLine } from './types.js';

type Op = { t: 'eq' | 'del' | 'add'; a?: number; b?: number };

/** Myers O(ND) diff over arrays of lines. */
export function diffLines(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const middle = myers(A, B);
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'eq', a: i, b: i });
  for (const op of middle) ops.push({ t: op.t, a: op.a !== undefined ? op.a + pre : undefined, b: op.b !== undefined ? op.b + pre : undefined });
  for (let i = 0; i < suf; i++) ops.push({ t: 'eq', a: a.length - suf + i, b: b.length - suf + i });
  return ops;
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ t: 'add' as const, b: j }));
  if (m === 0) return a.map((_, i) => ({ t: 'del' as const, a: i }));
  const max = n + m;
  const maxD = Math.min(max, 3000);
  if ((n + m) * Math.min(maxD, n + m) > 60_000_000) return naive(a, b);
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return naive(a, b);
  // Backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: 'eq', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ t: 'add', b: y - 1 });
    else ops.push({ t: 'del', a: x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: 'eq', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

function naive(a: string[], b: string[]): Op[] {
  return [...a.map((_, i) => ({ t: 'del' as const, a: i })), ...b.map((_, j) => ({ t: 'add' as const, b: j }))];
}

export function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Builds unified-diff hunks with `context` lines around changes. */
export function buildHunks(oldText: string, newText: string, context = 3): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  const lines: DiffLine[] = ops.map((op) => {
    if (op.t === 'eq') return { type: 'ctx', text: a[op.a!]!, oldNo: op.a! + 1, newNo: op.b! + 1 };
    if (op.t === 'del') return { type: 'del', text: a[op.a!]!, oldNo: op.a! + 1 };
    return { type: 'add', text: b[op.b!]!, newNo: op.b! + 1 };
  });
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    // find next change
    while (i < lines.length && lines[i]!.type === 'ctx') i++;
    if (i >= lines.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    // extend while changes are within 2*context of each other
    let lastChange = i;
    while (end < lines.length) {
      if (lines[end]!.type !== 'ctx') lastChange = end;
      if (end - lastChange > context * 2) break;
      end++;
    }
    const stop = Math.min(lines.length, lastChange + context + 1);
    const hunkLines = lines.slice(start, stop);
    const firstOld = hunkLines.find((l) => l.oldNo !== undefined)?.oldNo ?? 1;
    const firstNew = hunkLines.find((l) => l.newNo !== undefined)?.newNo ?? 1;
    hunks.push({
      oldStart: firstOld,
      oldLines: hunkLines.filter((l) => l.type !== 'add').length,
      newStart: firstNew,
      newLines: hunkLines.filter((l) => l.type !== 'del').length,
      lines: hunkLines,
    });
    i = stop;
  }
  return hunks;
}

export function diffStats(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Plain unified diff text (used for /diff of session changes and tests). */
export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  const hunks = buildHunks(oldText, newText, context);
  if (!hunks.length) return '';
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) out.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
  }
  return out.join('\n');
}

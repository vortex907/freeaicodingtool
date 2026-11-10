// Small string helpers shared across modules.
import { createHash, randomBytes } from 'node:crypto';

export function truncate(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Keeps the head and tail of a long text, eliding the middle. */
export function truncateMiddle(s: string, max: number, headRatio = 0.4): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * headRatio);
  const tail = max - head;
  const omitted = s.length - head - tail;
  const headPart = s.slice(0, head);
  const tailPart = s.slice(s.length - tail);
  const omittedLines = s.slice(head, s.length - tail).split('\n').length - 1;
  const note = omittedLines > 0 ? `${omittedLines} lines, ${omitted} chars` : `${omitted} chars`;
  return `${headPart}\n\n[... ${note} truncated ...]\n\n${tailPart}`;
}

export function firstLine(s: string, max = 120): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncate(line.trim(), max);
}

export function pluralize(n: number, word: string, plural = word + 's'): string {
  return `${n} ${n === 1 ? word : plural}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => (l.length ? prefix + l : l))
    .join('\n');
}

export function shortHash(s: string, len = 8): string {
  return createHash('sha256').update(s).digest('hex').slice(0, len);
}

export function randomId(len = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity based on edit distance. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  // Avoid quadratic blowups on huge strings.
  if (a.length * b.length > 4_000_000) {
    const sa = new Set(a.split(/\s+/));
    const sb = new Set(b.split(/\s+/));
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    return inter / Math.max(sa.size, sb.size, 1);
  }
  return 1 - levenshtein(a, b) / max;
}

/** Simple subsequence fuzzy match score (higher is better), or -1 when not matching. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    // Substring matches rank highest; prefer matches at basename / start.
    const base = t.lastIndexOf('/') + 1;
    let score = 1000 - t.length;
    if (idx === base) score += 500;
    else if (idx === 0) score += 300;
    return score;
  }
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score - t.length;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export function isBlank(s: string | undefined | null): boolean {
  return !s || !s.trim();
}

/** Title-cases a short identifier like "rate_limit" -> "Rate limit". */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function safeJsonStringify(v: unknown, space?: number): string {
  const seen = new WeakSet();
  return JSON.stringify(
    v,
    (_k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    },
    space,
  );
}

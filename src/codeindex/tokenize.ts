// Search tokens: identifiers split into words (camelCase, PascalCase, snake_case), lowercased,
// lightly stemmed and without stopwords. Multi-word identifiers are also kept whole, so an exact
// identifier in a query ("computeDamage") scores above the same words scattered around.

/** Identifier-like runs. Non-ASCII letters count, so comments in any language are searchable. */
export const IDENT_RE = /[A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*/g;

const STOP = new Set(
  (
    // English function words
    'a about above after again against all also am an and any are as at be because been before being below between both but by can could ' +
    'did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself ' +
    'just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them ' +
    'then there these they this those through to too under until up very was we were what when where which while who whom why will with ' +
    'would you your ' +
    // keywords that appear everywhere and say nothing about what code does
    'const let var function return import export from public private protected static void new self def func fn end elif else null nil none ' +
    'true false undefined lambda pass break continue case switch try catch finally throw throws raise except package namespace using include ' +
    'require extends implements typeof instanceof sizeof override virtual abstract final readonly extern inline typename pub mut crate super val'
  ).split(' '),
);

function undouble(s: string): string {
  const n = s.length;
  if (n >= 3 && s[n - 1] === s[n - 2] && !'aeiouls'.includes(s[n - 1]!)) return s.slice(0, -1);
  return s;
}

/**
 * A small suffix stripper (in the spirit of Porter, much simpler). It only has to be consistent:
 * calculate, calculated, calculates and calculation all become "calcul".
 */
export function stem(w: string): string {
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (/(?:ch|sh|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = undouble(s.slice(0, -3));
  else if (s.length > 4 && s.endsWith('ed')) s = undouble(s.slice(0, -2));
  if (s.length > 6 && s.endsWith('ment')) s = s.slice(0, -4);
  if (s.length > 7 && s.endsWith('ation')) s = s.slice(0, -5) + 'at';
  for (let k = 0; k < 2 && s.length > 5 && s.endsWith('er'); k++) s = undouble(s.slice(0, -2));
  if (s.length > 5 && s.endsWith('ly')) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 6 && s.endsWith('at')) s = s.slice(0, -2);
  return s;
}

const HUMPS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g;

/** Splits an identifier into lowercase words: getHTTPResponse2 -> get, http, response2. */
export function splitWords(id: string): string[] {
  const out: string[] = [];
  for (const seg of id.split(/[_$]+/)) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) {
      out.push(seg);
      continue;
    }
    if (/^[A-Z0-9]+$/.test(seg) || /[^\x00-\x7F]/.test(seg)) {
      out.push(seg.toLowerCase());
      continue;
    }
    const m = seg.match(HUMPS);
    if (m) for (const w of m) out.push(w.toLowerCase());
  }
  return out;
}

const termCache = new Map<string, string[]>();

/** Search terms for one identifier (cached: identifiers repeat a lot). */
export function identTerms(id: string): string[] {
  const hit = termCache.get(id);
  if (hit) return hit;
  const words = splitWords(id);
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || w.length > 40 || STOP.has(w) || /^[0-9]+$/.test(w)) continue;
    out.push(stem(w));
  }
  if (words.length > 1) {
    const whole = words.join('');
    if (whole.length >= 4 && whole.length <= 64) out.push(whole);
  }
  if (termCache.size > 250_000) termCache.clear();
  termCache.set(id, out);
  return out;
}

/** Terms of a free text (query, path, heading). */
export function textTerms(s: string): string[] {
  const out: string[] = [];
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(s))) for (const t of identTerms(m[0])) out.push(t);
  return out;
}

/** Words in a file path: file name terms (without extension) and the nearest directory names. */
export function pathTerms(rel: string): { file: string[]; dir: string[] } {
  const parts = rel.split('/');
  const base = parts.pop() ?? '';
  const dot = base.lastIndexOf('.');
  const file = textTerms(dot > 0 ? base.slice(0, dot) : base);
  const dir = textTerms(parts.slice(-4).join(' '));
  return { file, dir };
}

const SYNONYM_GROUPS = [
  ['calculate', 'compute', 'evaluate', 'formula'],
  ['delete', 'remove', 'destroy', 'erase'],
  ['create', 'make', 'build', 'spawn', 'instantiate', 'construct'],
  ['initialize', 'init', 'setup', 'bootstrap'],
  ['config', 'configuration', 'settings', 'options', 'preferences'],
  ['error', 'exception', 'failure', 'fault'],
  ['auth', 'authentication', 'login', 'signin', 'credentials'],
  ['send', 'emit', 'dispatch', 'publish'],
  ['listen', 'subscribe', 'observer', 'callback'],
  ['render', 'draw', 'paint'],
  ['load', 'read', 'fetch', 'retrieve'],
  ['save', 'write', 'store', 'persist'],
  ['parse', 'decode', 'deserialize'],
  ['serialize', 'encode'],
  ['check', 'validate', 'verify'],
  ['test', 'spec'],
  ['database', 'db', 'sql', 'query'],
  ['damage', 'hurt', 'hit'],
  ['health', 'hp'],
  ['move', 'movement', 'velocity', 'motion'],
  ['start', 'begin', 'launch'],
  ['stop', 'halt', 'terminate', 'shutdown'],
  ['user', 'account', 'profile'],
  ['route', 'endpoint', 'url'],
  ['log', 'logger', 'trace'],
  ['cache', 'memoize'],
  ['find', 'search', 'lookup'],
  ['input', 'keyboard', 'mouse'],
  ['audio', 'sound', 'music', 'sfx'],
  ['texture', 'image', 'sprite'],
  ['enemy', 'monster', 'mob'],
  ['player', 'character', 'hero'],
  ['weapon', 'gun', 'sword'],
  ['ui', 'gui', 'hud', 'menu'],
  ['network', 'socket', 'http'],
  ['schedule', 'timer', 'cron'],
  ['permission', 'role', 'access'],
  ['email', 'mail'],
  ['payment', 'billing', 'invoice', 'checkout'],
];

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const stems = [...new Set(group.flatMap((w) => identTerms(w)))];
  for (const s of stems) SYNONYMS.set(s, [...new Set([...(SYNONYMS.get(s) ?? []), ...stems.filter((x) => x !== s)])]);
}

export interface QueryTerm {
  term: string;
  /** 1 for words of the query, less for synonyms. */
  weight: number;
}

/** Terms of a search query, with a few programming synonyms at a lower weight. */
export function queryTerms(q: string): QueryTerm[] {
  const weights = new Map<string, number>();
  for (const t of textTerms(q)) weights.set(t, 1);
  for (const [t] of [...weights]) for (const s of SYNONYMS.get(t) ?? []) if (!weights.has(s)) weights.set(s, 0.35);
  return [...weights].map(([term, weight]) => ({ term, weight }));
}

/** Cached facts about one identifier: its term ids, and how often the file being analyzed uses it. */
export interface IdentEntry {
  ids: number[];
  /** File (see TermDict.beginFile) the count belongs to. */
  epoch: number;
  count: number;
}

/** Maps terms to small integer ids (shared by every root so postings can live in typed arrays). */
export class TermDict {
  private ids = new Map<string, number>();
  private identCache = new Map<string, IdentEntry>();
  private epoch = 0;
  readonly terms: string[] = [];

  id(t: string): number {
    let v = this.ids.get(t);
    if (v === undefined) {
      v = this.terms.length;
      this.terms.push(t);
      this.ids.set(t, v);
    }
    return v;
  }

  /** Starts counting identifiers for a new file; returns its epoch. */
  beginFile(): number {
    if (this.identCache.size > 250_000) this.identCache.clear();
    return ++this.epoch;
  }

  /** The cache entry of an identifier (the hot path of indexing: one lookup per occurrence). */
  ident(ident: string): IdentEntry {
    let v = this.identCache.get(ident);
    if (!v) {
      v = { ids: identTerms(ident).map((t) => this.id(t)), epoch: 0, count: 0 };
      this.identCache.set(ident, v);
    }
    return v;
  }

  identIds(ident: string): number[] {
    return this.ident(ident).ids;
  }

  get(t: string): number | undefined {
    return this.ids.get(t);
  }

  get size(): number {
    return this.terms.length;
  }
}

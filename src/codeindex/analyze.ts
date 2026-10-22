// Turns one file's text into what the index keeps: definitions, imports, chunks with their search
// terms, and the identifiers the file mentions (for references and the unused report).
import { extract, isTopLevel, type Lang, type RawSym } from './lang.js';
import { pathTerms, textTerms, type TermDict } from './tokenize.js';
import { isBinaryBuffer } from '../util/fs.js';

export const SYM_EXPORTED = 1;
export const SYM_TOP = 2;

/** Field flags inside a posting: the term is in a symbol name, the file name or a folder name. */
export const F_SYM = 1;
export const F_FILE = 2;
export const F_DIR = 4;

export interface SymbolDef {
  name: string;
  kind: string;
  /** 1-based line */
  line: number;
  /** SYM_EXPORTED | SYM_TOP */
  flags: number;
  parent?: string;
  /** Other mentions of the name in the same file (beyond its definitions). */
  uses: number;
}

export interface ImportRef {
  spec: string;
  line: number;
}

export interface ChunkInfo {
  /** 1-based first and last line */
  start: number;
  end: number;
  /** Definition(s) the chunk is about, e.g. "Player.takeDamage". */
  sym?: string;
  kind?: string;
  /** Number of content terms (BM25 document length). */
  len: number;
}

export interface FileData {
  lang: string;
  lines: number;
  syms: SymbolDef[];
  imps: ImportRef[];
  ns: string[];
  chunks: ChunkInfo[];
  /** Postings of all chunks, each termId * 256 + (min(tf, 31) << 3 | field flags). */
  post: Uint32Array;
  /** post[off[i] .. off[i + 1]) belongs to chunk i. */
  off: Uint32Array;
  /** Distinct identifiers, space separated, with a leading and a trailing space. */
  idents: string;
}

const SMALL_FILE = 12;
const MAX_CHUNK = 100;
const WINDOW = 60;
const OVERLAP = 10;
const MIN_CHUNK = 6;
const MERGE_MAX = 40;
const MAX_LINE_SCAN = 4000;

// Lines that belong to the definition below them: comments, decorators, attributes.
const LEAD = /^(?:\/\/|\/\*|\*|#(?!\s*(?:include|import|define|if|ifdef|ifndef|else|elif|endif|pragma|region|endregion|undef)\b)|--|@|\[|"""|''')/;

function leadStart(lines: string[], i: number, min: number): number {
  let s = i;
  while (s - 1 >= min && i - s < 40) {
    const t = lines[s - 1]!.trim();
    if (!t || !LEAD.test(t)) break;
    s--;
  }
  return s;
}

interface Span {
  s: number;
  e: number;
  def?: RawSym;
}

function windows(a: number, b: number, def: RawSym | undefined, out: Span[]): void {
  if (b - a + 1 <= MAX_CHUNK) {
    out.push({ s: a, e: b, def });
    return;
  }
  for (let s = a; s <= b; s += WINDOW - OVERLAP) {
    const e = Math.min(b, s + WINDOW - 1);
    out.push({ s, e, def });
    if (e === b) break;
  }
}

/**
 * Splits [a, b] at the outermost definitions inside it. A whole file is always split; a single
 * definition only when it is too long (then at its own members, or into windows).
 */
function split(lines: string[], a: number, b: number, defs: RawSym[], encl: RawSym | undefined, out: Span[], force = false): void {
  if (!force && b - a + 1 <= MAX_CHUNK) {
    out.push({ s: a, e: b, def: encl });
    return;
  }
  if (!defs.length) {
    windows(a, b, encl, out);
    return;
  }
  let minIndent = Infinity;
  for (const d of defs) if (d.indent < minIndent) minIndent = d.indent;
  const tops = defs.filter((d) => d.indent === minIndent);
  let cursor = a;
  for (let i = 0; i < tops.length; i++) {
    const d = tops[i]!;
    const start = Math.max(cursor, leadStart(lines, d.line - 1, cursor));
    const next = tops[i + 1];
    const end = next ? Math.max(start, leadStart(lines, next.line - 1, start + 1) - 1) : b;
    if (start > cursor) windows(cursor, start - 1, encl, out);
    const inner = defs.filter((x) => x.line > d.line && x.line - 1 <= end);
    split(lines, start, end, inner, d, out);
    cursor = end + 1;
  }
  if (cursor <= b) windows(cursor, b, encl, out);
}

function isBlank(lines: string[], s: number, e: number): boolean {
  for (let i = s; i <= e; i++) if (lines[i]!.trim()) return false;
  return true;
}

function buildSpans(lines: string[], defs: RawSym[]): Span[] {
  const n = lines.length;
  if (!n) return [];
  const raw: Span[] = [];
  if (n <= SMALL_FILE) raw.push({ s: 0, e: n - 1 });
  else split(lines, 0, n - 1, defs, undefined, raw, true);
  // Merge runs of tiny pieces (one-line constants, imports before the first definition), but never
  // fold a small definition into a full-size one: the chunk would carry the wrong name.
  const out: Span[] = [];
  for (const sp of raw) {
    if (isBlank(lines, sp.s, sp.e)) continue;
    const prev = out[out.length - 1];
    const small = sp.e - sp.s + 1 < MIN_CHUNK;
    const prevSmall = prev ? prev.e - prev.s + 1 < MIN_CHUNK : false;
    const mergeable = (small && prevSmall) || (prevSmall && !prev!.def) || (small && !sp.def);
    if (prev && prev.e + 1 >= sp.s && mergeable && sp.e - prev.s + 1 <= MERGE_MAX) {
      prev.e = Math.max(prev.e, sp.e);
      prev.def = prev.def ?? sp.def;
      continue;
    }
    out.push({ ...sp });
  }
  return out;
}

// Per-chunk term counters indexed by term id, shared by all analyses: they are all zero again at
// the end of every chunk, and analysis only pauses between chunks.
let counts = new Uint32Array(1 << 16);
let fields = new Uint8Array(1 << 16);
let touched = new Int32Array(4096);

function grow(min: number): void {
  const size = Math.max(min, counts.length * 2);
  const c = new Uint32Array(size);
  c.set(counts);
  counts = c;
  const f = new Uint8Array(size);
  f.set(fields);
  fields = f;
}

function growTouched(): void {
  const t = new Int32Array(touched.length * 2);
  t.set(touched);
  touched = t;
}

function label(d: RawSym): string {
  return d.parent ? `${d.parent}.${d.name}` : d.name;
}

/**
 * Analyzes a file. `text` must already be decoded (no BOM). `pause` is awaited between chunks so a
 * large file does not hold the event loop (the shared counters are clean at that point). Analyses
 * that share a dictionary must not run interleaved.
 */
export async function analyzeText(rel: string, text: string, lang: Lang, dict: TermDict, pause?: () => Promise<void>): Promise<FileData> {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const ex = extract(lang.family, lines);
  const allDefs = ex.syms; // sorted by line (extraction is sequential)
  // Namespaces wrap whole files; chunks follow the classes and functions inside them.
  const chunkDefs = allDefs.filter((d) => d.kind !== 'namespace');
  const spans = buildSpans(lines, chunkDefs);

  // Field flags shared by every chunk of the file.
  const pt = pathTerms(rel);
  const fileIds = pt.file.map((t) => dict.id(t));
  const dirIds = pt.dir.map((t) => dict.id(t));

  // Distinct identifiers of the file and their counts live in the dictionary's cache entries.
  const epoch = dict.beginFile();
  const distinct: string[] = [];
  const re = /[A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*/g;
  const chunks: ChunkInfo[] = [];
  const postings: number[] = [];
  const off: number[] = [0];
  let counted = -1;
  let defIdx = 0;
  for (const sp of spans) {
    // Term frequencies in dense typed arrays indexed by term id (no Map per chunk).
    let nt = 0;
    const touch = (t: number, flag: number) => {
      if (t >= counts.length) grow(t + 1);
      if (counts[t] === 0 && fields[t] === 0) {
        if (nt >= touched.length) growTouched();
        touched[nt++] = t;
      }
      if (flag) fields[t]! |= flag;
      else counts[t]!++;
    };
    let len = 0;
    for (let i = sp.s; i <= sp.e; i++) {
      let line = lines[i]!;
      if (line.length > MAX_LINE_SCAN) line = line.slice(0, MAX_LINE_SCAN);
      const fresh = i > counted;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const id = m[0];
        const entry = dict.ident(id);
        if (fresh) {
          if (entry.epoch !== epoch) {
            entry.epoch = epoch;
            entry.count = 0;
            if (id.length >= 2 && id.length <= 80) distinct.push(id);
          }
          entry.count++;
        }
        const ids = entry.ids;
        for (let k = 0; k < ids.length; k++) touch(ids[k]!, 0);
        len += ids.length;
      }
      if (fresh) counted = i;
    }
    for (const t of dirIds) touch(t, F_DIR);
    for (const t of fileIds) touch(t, F_FILE);
    // Definitions that start inside this chunk name it and boost its symbol terms.
    while (defIdx < chunkDefs.length && chunkDefs[defIdx]!.line - 1 < sp.s) defIdx++;
    const inside: RawSym[] = [];
    for (let k = defIdx; k < chunkDefs.length && chunkDefs[k]!.line - 1 <= sp.e; k++) inside.push(chunkDefs[k]!);
    for (const d of inside) {
      const ids = d.boundaryOnly ? textTerms(d.name).map((t) => dict.id(t)) : dict.identIds(d.name);
      for (const t of ids) touch(t, F_SYM);
    }
    let named: RawSym[] = [];
    if (inside.length) {
      let minIndent = Infinity;
      for (const d of inside) if (d.indent < minIndent) minIndent = d.indent;
      named = inside.filter((d) => d.indent === minIndent).slice(0, 3);
    } else if (sp.def) named = [sp.def];
    const chunk: ChunkInfo = { start: sp.s + 1, end: sp.e + 1, len };
    if (named.length) {
      chunk.sym = named.map(label).join(', ');
      chunk.kind = named[0]!.kind;
    }
    chunks.push(chunk);
    for (let k = 0; k < nt; k++) {
      const t = touched[k]!;
      const n = counts[t]!;
      postings.push(t * 256 + (((n > 31 ? 31 : n) << 3) | fields[t]!));
      counts[t] = 0;
      fields[t] = 0;
    }
    off.push(postings.length);
    if (pause) await pause();
  }

  // Symbols (markdown headings only shape chunks).
  const countOf = (name: string) => {
    const e = dict.ident(name);
    return e.epoch === epoch ? e.count : 0;
  };
  const syms: SymbolDef[] = [];
  const defCount = new Map<string, number>();
  for (const d of allDefs) if (!d.boundaryOnly) defCount.set(d.name, (defCount.get(d.name) ?? 0) + 1);
  for (let i = 0; i < allDefs.length; i++) {
    const d = allDefs[i]!;
    if (d.boundaryOnly) continue;
    const top = isTopLevel(allDefs, i);
    const s: SymbolDef = {
      name: d.name,
      kind: d.kind,
      line: d.line,
      flags: (d.exported ? SYM_EXPORTED : 0) | (top ? SYM_TOP : 0),
      uses: Math.max(0, countOf(d.name) - (defCount.get(d.name) ?? 1)),
    };
    if (d.parent) s.parent = d.parent;
    syms.push(s);
  }

  const seenImp = new Set<string>();
  const imps: ImportRef[] = [];
  for (const im of ex.imports) {
    const key = `${im.spec}\0${im.line}`;
    if (seenImp.has(key)) continue;
    seenImp.add(key);
    imps.push(im);
  }

  return {
    lang: lang.id,
    lines: lines.length,
    syms,
    imps,
    ns: [...new Set(ex.ns)],
    chunks,
    post: Uint32Array.from(postings),
    off: Uint32Array.from(off),
    idents: distinct.length ? ` ${distinct.join(' ')} ` : ' ',
  };
}

/** Decodes file bytes: UTF-8 (BOM stripped) or UTF-16 with a BOM (Visual Studio writes those). Null for binary data. */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (isBinaryBuffer(buf)) return null;
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

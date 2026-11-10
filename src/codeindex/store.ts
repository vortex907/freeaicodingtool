// Persistence: one gzip file of JSON lines per root (a header line, then one line per file).
// Lines can be parsed one at a time, so loading a large index never blocks the event loop.
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { freecodeHome } from '../config/paths.js';
import type { SymbolDef } from './analyze.js';
import type { ProjectRec } from './projects.js';
import { Slicer } from './slicer.js';
import type { TermDict } from './tokenize.js';
import type { FileEntry } from './types.js';

/** Bump when the stored format or the tokenizer changes; older files are rebuilt. */
export const INDEX_VERSION = 1;

export function indexDir(): string {
  return path.join(freecodeHome(), 'index');
}

/** File that stores the index of a root folder. */
export function indexFileFor(root: string, dir = indexDir()): string {
  const norm = process.platform === 'win32' ? root.toLowerCase() : root;
  const slug = path.basename(root).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'root';
  return path.join(dir, `${slug}-${createHash('sha1').update(norm).digest('hex').slice(0, 12)}.jsonl.gz`);
}

/** Writes lines (each already ending in a newline) through gzip into a temp file, then renames it into place. */
export async function writeLines(file: string, lines: AsyncIterable<string>): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await pipeline(Readable.from(lines), createGzip({ level: 4 }), createWriteStream(tmp));
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Reads a gzip JSON-lines file one parsed line at a time. Throws on a missing or corrupt file. */
export async function* readLines(file: string): AsyncGenerator<unknown> {
  const src = createReadStream(file);
  const gunzip = createGunzip();
  src.on('error', (e) => gunzip.destroy(e));
  src.pipe(gunzip);
  gunzip.setEncoding('utf8');
  let rest = '';
  for await (const chunk of gunzip as AsyncIterable<string>) {
    rest += chunk;
    let start = 0;
    let nl: number;
    while ((nl = rest.indexOf('\n', start)) >= 0) {
      const line = rest.slice(start, nl);
      start = nl + 1;
      if (line) yield JSON.parse(line);
    }
    rest = rest.slice(start);
  }
  if (rest.trim()) yield JSON.parse(rest);
}

// One line per file. Postings are stored as base64 of their Uint32Array with term ids local to the
// root (the header holds the term table), so loading needs one dictionary lookup per distinct term,
// not one per posting.
export type FileLine = {
  p: string;
  s: number;
  m: number;
  l: string;
  n: number;
  k?: 1;
  y?: [string, string, number, number, number, string?][];
  i?: [string, number][];
  ns?: string[];
  /** Chunks: start, end, length, symbol, kind */
  c?: [number, number, number, string, string][];
  /** Chunk offsets into q (base64 Uint32Array) */
  o?: string;
  /** Postings with root-local term ids (base64 Uint32Array) */
  q?: string;
  d?: string;
};

export interface SavedHeader {
  v?: number;
  root?: string;
  endian?: string;
  truncated?: boolean;
  projects?: ProjectRec[];
  terms?: string[];
}

function toBase64(a: Uint32Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

function fromBase64(s: string | undefined): Uint32Array {
  if (!s) return new Uint32Array(0);
  const buf = Buffer.from(s, 'base64');
  const out = new Uint32Array(buf.length >>> 2);
  new Uint8Array(out.buffer).set(buf.subarray(0, out.length * 4));
  return out;
}

/** Root-local term table for a set of files: global id -> local id, plus the terms in local order. */
export async function localTerms(entries: FileEntry[], dict: TermDict): Promise<{ localOf: Int32Array; terms: string[] }> {
  const localOf = new Int32Array(dict.size).fill(-1);
  const terms: string[] = [];
  const slicer = new Slicer();
  for (const e of entries) {
    const post = e.post;
    for (let k = 0; k < post.length; k++) {
      const g = post[k]! >>> 8;
      if (localOf[g] === -1) {
        localOf[g] = terms.length;
        terms.push(dict.terms[g]!);
      }
    }
    await slicer.tick();
  }
  return { localOf, terms };
}

export function encodeFile(e: FileEntry, localOf: Int32Array): FileLine {
  const out: FileLine = { p: e.rel, s: e.size, m: e.mtime, l: e.lang, n: e.lines };
  if (e.skipped) {
    out.k = 1;
    return out;
  }
  if (e.syms.length) out.y = e.syms.map((s) => (s.parent ? [s.name, s.kind, s.line, s.flags, s.uses, s.parent] : [s.name, s.kind, s.line, s.flags, s.uses]));
  if (e.imps.length) out.i = e.imps.map((i) => [i.spec, i.line]);
  if (e.ns.length) out.ns = e.ns;
  out.c = e.chunks.map((c) => [c.start, c.end, c.len, c.sym ?? '', c.kind ?? '']);
  const local = new Uint32Array(e.post.length);
  for (let k = 0; k < local.length; k++) {
    const p = e.post[k]!;
    local[k] = localOf[p >>> 8]! * 256 + (p & 255);
  }
  out.o = toBase64(e.off);
  out.q = toBase64(local);
  out.d = e.idents.trim();
  return out;
}

export function decodeFile(o: FileLine, remap: Int32Array): FileEntry | null {
  if (typeof o.p !== 'string' || typeof o.s !== 'number' || typeof o.m !== 'number') return null;
  const base = { rel: o.p, size: o.s, mtime: o.m, lang: o.l ?? 'other', lines: o.n ?? 0 };
  if (o.k) return { ...base, skipped: true, syms: [], imps: [], ns: [], chunks: [], post: new Uint32Array(0), off: new Uint32Array(1), idents: ' ' };
  const post = fromBase64(o.q);
  for (let k = 0; k < post.length; k++) {
    const p = post[k]!;
    const g = remap[p >>> 8];
    if (g === undefined) return null; // corrupt line: the file is indexed again
    post[k] = g * 256 + (p & 255);
  }
  const off = fromBase64(o.o);
  const chunks = (o.c ?? []).map((c) => {
    const chunk: FileEntry['chunks'][number] = { start: c[0], end: c[1], len: c[2] };
    if (c[3]) chunk.sym = c[3];
    if (c[4]) chunk.kind = c[4];
    return chunk;
  });
  if (off.length !== chunks.length + 1 || off[chunks.length] !== post.length) return null;
  const syms: SymbolDef[] = (o.y ?? []).map((s) => {
    const d: SymbolDef = { name: s[0], kind: s[1], line: s[2], flags: s[3], uses: s[4] };
    if (s[5]) d.parent = s[5];
    return d;
  });
  return {
    ...base,
    syms,
    imps: (o.i ?? []).map(([spec, line]) => ({ spec, line })),
    ns: o.ns ?? [],
    chunks,
    post,
    off,
    idents: ` ${o.d ?? ''} `,
  };
}

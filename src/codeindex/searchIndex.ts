// BM25 over code chunks. Every file keeps its chunks' postings; this builds one inverted index over
// all roots (typed arrays, rebuilt lazily after changes) so a query only touches the postings of its
// own terms. Matches in symbol names, file names and folder names count as extra term frequency.
import { F_DIR, F_FILE, F_SYM } from './analyze.js';
import { Slicer } from './slicer.js';
import type { FileEntry, RootState } from './types.js';

const K1 = 1.2;
const B = 0.75;
const W_SYM = 2.0;
const W_FILE = 2.5;
const W_DIR = 0.4;

export interface ScoredChunk {
  chunk: number;
  score: number;
  /** Share of the query weight the chunk matched (0..1). */
  coverage: number;
}

interface RootSlice {
  root: RootState;
  /** Files with chunks, sorted by path. */
  rels: string[];
  /** first[i] is the first chunk id of rels[i]; first[rels.length] ends the slice. */
  first: Int32Array;
}

export class SearchIndex {
  n = 0;
  avgLen = 1;
  chunkFile: FileEntry[] = [];
  chunkIdx = new Int32Array(0);
  docLen = new Float32Array(0);
  termOff = new Uint32Array(1);
  pChunk = new Uint32Array(0);
  pVal = new Uint8Array(0);
  slices: RootSlice[] = [];
  private scores: Float32Array | null = null;
  private cover: Float32Array | null = null;
  private touched: Int32Array | null = null;

  constructor(readonly gen: number) {}

  /** Builds the index over the current files of the roots (a snapshot; later changes need a rebuild). */
  static async build(roots: RootState[], dictSize: number, gen: number): Promise<SearchIndex> {
    const idx = new SearchIndex(gen);
    const slicer = new Slicer();
    const files: FileEntry[] = [];
    let n = 0;
    let total = 0;
    for (const root of roots) {
      const list = [...root.files.values()].filter((f) => !f.skipped && f.chunks.length).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const first = new Int32Array(list.length + 1);
      for (let i = 0; i < list.length; i++) {
        first[i] = n;
        n += list[i]!.chunks.length;
        total += list[i]!.post.length;
        files.push(list[i]!);
      }
      first[list.length] = n;
      idx.slices.push({ root, rels: list.map((f) => f.rel), first });
      await slicer.tick();
    }
    idx.n = n;
    idx.chunkFile = new Array<FileEntry>(n);
    idx.chunkIdx = new Int32Array(n);
    idx.docLen = new Float32Array(n);
    const df = new Uint32Array(dictSize + 1);
    let c = 0;
    let lenSum = 0;
    for (const f of files) {
      for (let i = 0; i < f.chunks.length; i++, c++) {
        idx.chunkFile[c] = f;
        idx.chunkIdx[c] = i;
        const len = f.chunks[i]!.len;
        idx.docLen[c] = len;
        lenSum += len;
      }
      const post = f.post;
      for (let k = 0; k < post.length; k++) df[post[k]! >>> 8]!++;
      await slicer.tick();
    }
    idx.avgLen = n ? Math.max(1, lenSum / n) : 1;
    const off = new Uint32Array(dictSize + 2);
    for (let t = 0; t <= dictSize; t++) off[t + 1] = off[t]! + df[t]!;
    idx.termOff = off;
    const cursor = off.slice(0, dictSize + 1);
    idx.pChunk = new Uint32Array(total);
    idx.pVal = new Uint8Array(total);
    c = 0;
    for (const f of files) {
      const post = f.post;
      const offs = f.off;
      for (let i = 0; i < f.chunks.length; i++, c++) {
        for (let k = offs[i]!; k < offs[i + 1]!; k++) {
          const p = post[k]!;
          const pos = cursor[p >>> 8]!++;
          idx.pChunk[pos] = c;
          idx.pVal[pos] = p & 255;
        }
      }
      await slicer.tick();
    }
    return idx;
  }

  /** Chunk id range of the files under `relPrefix` ('' for the whole root). Null when the root is unknown. */
  rangeFor(root: RootState, relPrefix: string): [number, number] | null {
    const s = this.slices.find((x) => x.root === root);
    if (!s) return null;
    if (!relPrefix) return [s.first[0]!, s.first[s.rels.length]!];
    const lo = lowerBound(s.rels, `${relPrefix}/`);
    const hi = lowerBound(s.rels, `${relPrefix}/\uFFFF`);
    return [s.first[lo]!, s.first[hi]!];
  }

  /** Root that holds a chunk. */
  rootOf(chunk: number): RootState | undefined {
    for (const s of this.slices) if (chunk >= s.first[0]! && chunk < s.first[s.rels.length]!) return s.root;
    return undefined;
  }

  /**
   * BM25F-style scores for chunks in [lo, hi). Each term carries a weight (1 for query words,
   * less for synonyms). Returns the best `keep` chunks by score times coverage.
   */
  score(terms: { id: number; weight: number }[], lo: number, hi: number, keep: number): ScoredChunk[] {
    if (!this.n || !terms.length || keep <= 0) return [];
    if (!this.scores || this.scores.length !== this.n) {
      this.scores = new Float32Array(this.n);
      this.cover = new Float32Array(this.n);
      this.touched = new Int32Array(this.n);
    }
    const scores = this.scores;
    const cover = this.cover!;
    const touched = this.touched!;
    let nTouched = 0;
    let totalW = 0;
    for (const { id, weight } of terms) {
      if (id + 1 >= this.termOff.length) continue;
      const a = this.termOff[id]!;
      const b = this.termOff[id + 1]!;
      const df = b - a;
      if (!df) continue;
      const w = Math.log(1 + (this.n - df + 0.5) / (df + 0.5)) * weight;
      totalW += w;
      for (let k = a; k < b; k++) {
        const c = this.pChunk[k]!;
        if (c < lo || c >= hi) continue;
        const v = this.pVal[k]!;
        const tf = v >> 3;
        let x = tf ? tf / (1 - B + (B * this.docLen[c]!) / this.avgLen) : 0;
        if (v & F_SYM) x += W_SYM;
        if (v & F_FILE) x += W_FILE;
        if (v & F_DIR) x += W_DIR;
        if (scores[c] === 0) touched[nTouched++] = c;
        scores[c]! += (w * x * (K1 + 1)) / (x + K1);
        cover[c]! += w;
      }
    }
    // Keep the best in a min-heap of typed arrays: no object per candidate.
    const hc = new Int32Array(keep);
    const hs = new Float64Array(keep);
    let size = 0;
    for (let i = 0; i < nTouched; i++) {
      const c = touched[i]!;
      const s = scores[c]! * (0.4 + (0.6 * cover[c]!) / totalW);
      scores[c] = 0;
      cover[c] = 0;
      if (size < keep) {
        let j = size++;
        while (j > 0) {
          const p = (j - 1) >> 1;
          if (hs[p]! <= s) break;
          hs[j] = hs[p]!;
          hc[j] = hc[p]!;
          j = p;
        }
        hs[j] = s;
        hc[j] = c;
      } else if (s > hs[0]!) {
        let j = 0;
        for (;;) {
          const l = 2 * j + 1;
          if (l >= size) break;
          const r = l + 1;
          const m = r < size && hs[r]! < hs[l]! ? r : l;
          if (hs[m]! >= s) break;
          hs[j] = hs[m]!;
          hc[j] = hc[m]!;
          j = m;
        }
        hs[j] = s;
        hc[j] = c;
      }
    }
    const out: ScoredChunk[] = [];
    for (let i = 0; i < size; i++) out.push({ chunk: hc[i]!, score: hs[i]!, coverage: 0 });
    for (const o of out) o.coverage = this.lastCoverage(o.chunk, terms, totalW);
    return out.sort((x, y) => y.score - x.score);
  }

  /** Share of the query weight a chunk matched (computed again only for the few kept chunks). */
  private lastCoverage(chunk: number, terms: { id: number; weight: number }[], totalW: number): number {
    if (!totalW) return 0;
    let w = 0;
    for (const { id, weight } of terms) {
      if (id + 1 >= this.termOff.length) continue;
      const a = this.termOff[id]!;
      const b = this.termOff[id + 1]!;
      if (a === b) continue;
      // Postings of a term are sorted by chunk id.
      let lo = a;
      let hi = b;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.pChunk[mid]! < chunk) lo = mid + 1;
        else hi = mid;
      }
      if (lo < b && this.pChunk[lo] === chunk) w += Math.log(1 + (this.n - (b - a) + 0.5) / (b - a + 0.5)) * weight;
    }
    return w / totalW;
  }
}

function lowerBound(arr: string[], key: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

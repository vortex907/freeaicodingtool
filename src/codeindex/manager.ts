// The code index: keeps every root folder indexed (incrementally, in the background, without long
// pauses of the event loop) and answers search, symbol, project, history and unused queries.
import { promises as fsp, watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeText, decodeText, SYM_EXPORTED, SYM_TOP, type SymbolDef } from './analyze.js';
import { headStamp, readHistory, searchCommits, type Commit } from './history.js';
import { indexableName, langById, langOf } from './lang.js';
import { detectProjects, readManifest, type Manifest, type ProjectRec } from './projects.js';
import { computeLinks, projectOf, type Links } from './resolve.js';
import { SearchIndex } from './searchIndex.js';
import { decodeFile, encodeFile, indexDir, indexFileFor, INDEX_VERSION, localTerms, readLines, writeLines, type FileLine, type SavedHeader } from './store.js';
import { Slicer } from './slicer.js';
import { identTerms, queryTerms, TermDict } from './tokenize.js';
import type {
  CommitResult,
  FileEntry,
  IndexProgress,
  IndexStatus,
  ProjectLinkInfo,
  ProjectProfile,
  ProjectSummary,
  ReferenceHit,
  RootState,
  SearchHit,
  SearchOptions,
  SearchResult,
  SymbolHit,
  UnusedReport,
  UnusedSymbol,
} from './types.js';
import { isIgnoredDir, MAX_FILE_BYTES, walkRoot, type WalkFile } from './walker.js';
import { currentProjectSection, otherProjectsSection } from './prompt.js';
import { isInside } from '../util/fs.js';
import { escapeRegExp } from '../util/strings.js';

export const MAX_FILES_PER_ROOT = 60_000;
/** A root walked this recently is not walked again (several searches in a row stay instant). */
const MIN_WALK_INTERVAL_MS = 1500;
/** Save progress at least this often while a large root is being indexed. */
const CHECKPOINT_MS = 60_000;
/** Without a file watcher, walks of a big root are spaced out to this many times their duration. */
const WALK_BACKOFF = 4;
/** With a file watcher, a full walk is only a safety net for missed events. */
const WATCHED_WALK_MS = 10 * 60_000;
/** More changed paths than this between refreshes: walk instead. */
const MAX_PENDING = 5000;
/** Recursive fs.watch is cheap on Windows and macOS; on Linux it would add an inotify watch per folder. */
const CAN_WATCH = process.platform === 'win32' || process.platform === 'darwin';

interface Root extends RootState {
  file: string;
  loaded: boolean;
  loading: Promise<void> | null;
  /** When the last complete walk finished. */
  lastWalk: number;
  dirty: boolean;
  lastSave: number;
  saving: Promise<void>;
  /** Project folders (relative) that count as projects even without a manifest (the opened project). */
  explicit: Set<string>;
  /** How long the last complete walk took. */
  walkMs: number;
  /** Paths reported changed (file watcher, touchPaths) since the last refresh. */
  pending: Set<string>;
  /** A change the pending paths cannot describe (a new folder, too many events): walk everything. */
  needsWalk: boolean;
  watcher: FSWatcher | null;
  watchFailed: boolean;
}

export class ScopeError extends Error {}

function normKey(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Bounded async queue between the file readers and the (single) analyzer. */
class Pipe<T> {
  private items: T[] = [];
  private takers: (() => void)[] = [];
  private givers: (() => void)[] = [];
  private closed = false;
  constructor(private cap: number) {}
  async push(x: T): Promise<void> {
    while (this.items.length >= this.cap) await new Promise<void>((r) => this.givers.push(r));
    this.items.push(x);
    this.takers.shift()?.();
  }
  async pop(): Promise<T | undefined> {
    while (!this.items.length) {
      if (this.closed) return undefined;
      await new Promise<void>((r) => this.takers.push(r));
    }
    const x = this.items.shift();
    this.givers.shift()?.();
    return x;
  }
  close(): void {
    this.closed = true;
    for (const t of this.takers.splice(0)) t();
  }
}

function skippedEntry(w: WalkFile, lang: string): FileEntry {
  return { rel: w.rel, size: w.size, mtime: w.mtime, lang, lines: 0, skipped: true, syms: [], imps: [], ns: [], chunks: [], post: new Uint32Array(0), off: new Uint32Array(1), idents: ' ' };
}

// ------------------------------------------------------------------ the manager

const KIND_ORDER = ['class', 'struct', 'interface', 'trait', 'enum', 'record', 'type', 'function', 'method', 'impl', 'property', 'constant', 'field', 'variable', 'macro', 'namespace'];

/** Names called by frameworks and engines, not by the project's own code. */
const ENTRY_POINTS = new Set(
  (
    'main Main init setup teardown constructor default index handler app App render toString equals hashCode compareTo Dispose ' +
    'Awake Start Update FixedUpdate LateUpdate OnEnable OnDisable OnDestroy OnValidate Reset OnGUI OnDrawGizmos OnDrawGizmosSelected ' +
    'OnTriggerEnter OnTriggerExit OnTriggerStay OnCollisionEnter OnCollisionExit OnCollisionStay OnTriggerEnter2D OnTriggerExit2D ' +
    'OnCollisionEnter2D OnCollisionExit2D OnMouseDown OnMouseUp OnApplicationQuit OnApplicationPause OnBecameVisible OnBecameInvisible ' +
    'BeginPlay Tick EndPlay Construct NativeConstruct WinMain wWinMain DllMain ' +
    '_ready _process _physics_process _input _unhandled_input _init _enter_tree _exit_tree _draw _notification _gui_input _get_configuration_warnings'
  ).split(' '),
);

const UNUSED_KINDS = new Set(['function', 'method', 'class', 'struct', 'interface', 'trait', 'enum', 'record', 'type', 'typedef', 'constant', 'variable', 'property', 'macro', 'delegate', 'object', 'union', 'protocol', 'actor', 'mixin', 'signal']);

function isTestPath(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)s?\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.cs$/i.test(rel);
}

export interface ManagerOptions {
  /** Where index files go (default: <FREECODE_HOME>/index). */
  dir?: string;
  /** Skip walking a root that was walked this recently (default 1500 ms). */
  minWalkIntervalMs?: number;
  /** Watch roots for changes in interactive sessions (default: on Windows and macOS). */
  watch?: boolean;
}

export class IndexManager {
  private storeDir: string | undefined;
  private minWalkMs: number;
  private canWatch: boolean;
  private enabledFlag = true;
  private configured: string[] = [];
  /** The project the user has open (always indexed). */
  private current: string | undefined;
  private roots = new Map<string, Root>();
  private dict = new TermDict();
  /** Bumped on every change to indexed content; caches compare against it. */
  private gen = 0;
  private searchIdx: SearchIndex | null = null;
  private searchBuild: { gen: number; promise: Promise<SearchIndex> } | null = null;
  private links: { gen: number; promise: Promise<Links> } | null = null;
  private identCounts: { gen: number; promise: Promise<Map<string, number>> } | null = null;
  private symbolMap: { gen: number; promise: Promise<Map<string, { root: Root; file: FileEntry; sym: SymbolDef }[]>> } | null = null;
  private statsCache: { gen: number; map: Map<ProjectRec, { langs: Map<string, number>; files: number; last: number }> } | null = null;
  private counts: { gen: number; files: number; chunks: number; symbols: number; perRoot: Map<Root, number> } | null = null;
  private refreshing: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private suspended = false;
  private progress: IndexProgress = { phase: 'idle', done: 0, total: 0 };
  private lastUpdate: number | null = null;
  private errors: string[] = [];
  private listeners = new Set<(s: IndexStatus) => void>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  /** File watchers are on (interactive sessions on Windows and macOS). */
  private watching = false;
  private sections = new Map<string, { gen: number; text: string }>();
  private sectionJob: Promise<void> | null = null;
  /** Counters of the last refresh (tests and status). */
  lastRefresh = { analyzed: 0, removed: 0, walked: 0 };

  constructor(opts: ManagerOptions = {}) {
    this.storeDir = opts.dir;
    this.minWalkMs = opts.minWalkIntervalMs ?? MIN_WALK_INTERVAL_MS;
    this.canWatch = opts.watch ?? CAN_WATCH;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  private get dir(): string {
    return this.storeDir ?? indexDir();
  }

  // ------------------------------------------------------------------ configuration

  setEnabled(on: boolean): void {
    if (on === this.enabledFlag) return;
    this.enabledFlag = on;
    if (!on) {
      // Stop and forget; what was indexed stays saved for when it is turned on again.
      this.abort?.abort();
      for (const r of this.roots.values()) {
        this.unwatch(r);
        void this.save(r);
      }
      this.roots.clear();
      this.invalidate();
    } else if (this.current) {
      this.syncRoots();
      if (!this.suspended) void this.refresh();
    }
    this.notify();
  }

  /** Extra root folders from the settings (the current project is always indexed as well). */
  setRoots(roots: string[]): void {
    const next = [...new Set(roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => path.resolve(r.trim())))];
    if (next.length === this.configured.length && next.every((r, i) => normKey(r) === normKey(this.configured[i]!))) return;
    this.configured = next;
    if (this.syncRoots() && this.current && !this.suspended) void this.refresh();
  }

  /** Makes sure the project is indexed (it becomes the current project). Resolves after a refresh. */
  async ensureProject(projectRoot: string): Promise<void> {
    this.current = path.resolve(projectRoot);
    this.suspended = false;
    if (!this.enabledFlag) return;
    this.syncRoots();
    await this.refresh();
  }

  /**
   * Keeps the index fresh while the app runs: a file watcher (Windows, macOS) re-indexes changed
   * files within a second, and a timer refreshes every minute. Neither keeps the process alive.
   */
  startAutoRefresh(intervalMs = 60_000): void {
    this.watching = this.canWatch;
    for (const r of this.roots.values()) {
      if (!r.lastWalk || r.watcher) continue;
      this.watch(r);
      // Changes made before the watcher started are only found by walking once more.
      if (r.watcher) r.needsWalk = true;
    }
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => {
      if (!this.suspended) void this.refresh();
    }, intervalMs);
    this.autoTimer.unref();
  }

  /** Marks files or folders as changed (an editor saved them, a tool wrote them); the next refresh re-reads them. */
  touchPaths(paths: string[]): void {
    for (const p of paths) {
      const abs = path.resolve(p);
      const root = this.findRootFor(abs);
      const rel = root ? toPosix(path.relative(root.dir, abs)) : '';
      if (!root || !rel) continue;
      if (root.pending.size >= MAX_PENDING) root.needsWalk = true;
      else root.pending.add(rel);
    }
  }

  private watch(root: Root): void {
    if (!this.watching || root.watcher || root.watchFailed) return;
    try {
      const w = watch(root.dir, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) root.needsWalk = true;
        else {
          const rel = toPosix(String(filename));
          const parts = rel.split('/');
          // Build output, vendor folders and .git churn constantly and are never indexed.
          for (let i = 0; i < parts.length - 1; i++) if (isIgnoredDir(parts[i]!)) return;
          if (root.pending.size >= MAX_PENDING) root.needsWalk = true;
          else root.pending.add(rel);
        }
        this.soon();
      });
      w.on('error', () => {
        // e.g. the folder was deleted or is on a drive that does not support it: walk instead
        this.unwatch(root);
        root.watchFailed = true;
      });
      root.watcher = w;
    } catch {
      root.watchFailed = true;
    }
  }

  private unwatch(root: Root): void {
    try {
      root.watcher?.close();
    } catch {
      // already closed
    }
    root.watcher = null;
  }

  /** Refresh shortly after a burst of file events (one refresh per burst). */
  private soon(): void {
    if (this.soonTimer || this.suspended) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      if (!this.suspended) void this.refresh();
    }, 400);
    this.soonTimer.unref();
  }

  /** Stops background work and saves what was indexed (call on shutdown; ensureProject resumes). */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.watching = false;
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
    for (const r of this.roots.values()) this.unwatch(r);
    this.abort?.abort();
    const roots = [...this.roots.values()];
    await this.refreshing?.catch(() => undefined);
    await Promise.all(roots.map((r) => this.save(r)));
  }

  /** Suspends and forgets all in-memory data. */
  async close(): Promise<void> {
    await this.suspend();
    this.roots.clear();
    this.invalidate();
  }

  /** Effective roots: the current project and the configured folders, without folders nested in another. */
  private syncRoots(): boolean {
    const wanted: string[] = [];
    const cur = this.current && this.indexable(this.current) ? [this.current] : [];
    for (const p of [...cur, ...this.configured]) {
      if (wanted.some((w) => isInside(p, w))) continue;
      for (let i = wanted.length - 1; i >= 0; i--) if (isInside(wanted[i]!, p)) wanted.splice(i, 1);
      wanted.push(p);
    }
    let changed = false;
    const keys = new Set(wanted.map(normKey));
    for (const [k, r] of this.roots) {
      if (keys.has(k)) continue;
      this.unwatch(r);
      void this.save(r);
      this.roots.delete(k);
      changed = true;
    }
    for (const p of wanted) {
      const k = normKey(p);
      if (this.roots.has(k)) continue;
      this.roots.set(k, {
        key: k,
        dir: p,
        file: indexFileFor(p, this.dir),
        files: new Map(),
        projects: [],
        history: new Map(),
        truncated: false,
        loaded: false,
        loading: null,
        lastWalk: 0,
        dirty: false,
        lastSave: Date.now(),
        saving: Promise.resolve(),
        explicit: new Set(),
        walkMs: 0,
        pending: new Set(),
        needsWalk: false,
        watcher: null,
        watchFailed: false,
      });
      changed = true;
    }
    // The opened project counts as a project inside whichever root holds it.
    for (const r of this.roots.values()) {
      const before = [...r.explicit].join('|');
      r.explicit.clear();
      if (this.current && isInside(this.current, r.dir)) r.explicit.add(toPosix(path.relative(r.dir, this.current)));
      if ([...r.explicit].join('|') !== before) r.lastWalk = 0;
    }
    if (changed) this.invalidate();
    return changed;
  }

  /** The home folder or a drive root opened as a "project" is not indexed automatically. */
  private indexable(p: string): boolean {
    const r = path.resolve(p);
    return normKey(r) !== normKey(os.homedir()) && path.parse(r).root !== r;
  }

  private invalidate(): void {
    this.gen++;
  }

  private orderedRoots(): Root[] {
    const all = [...this.roots.values()];
    const cur = this.current;
    return cur ? [...all.filter((r) => isInside(cur, r.dir)), ...all.filter((r) => !isInside(cur, r.dir))] : all;
  }

  // ------------------------------------------------------------------ status

  status(): IndexStatus {
    if (!this.counts || this.counts.gen !== this.gen) {
      const c = { gen: this.gen, files: 0, chunks: 0, symbols: 0, perRoot: new Map<Root, number>() };
      for (const r of this.roots.values()) {
        let rf = 0;
        for (const f of r.files.values()) {
          if (f.skipped) continue;
          rf++;
          c.chunks += f.chunks.length;
          c.symbols += f.syms.length;
        }
        c.files += rf;
        c.perRoot.set(r, rf);
      }
      this.counts = c;
    }
    const counts = this.counts;
    const roots = [...this.roots.values()].map((r) => ({ path: r.dir, files: counts.perRoot.get(r) ?? 0, projects: r.projects.length, truncated: r.truncated, lastIndexed: r.lastWalk || null }));
    return {
      enabled: this.enabledFlag,
      roots,
      files: counts.files,
      chunks: counts.chunks,
      symbols: counts.symbols,
      projects: roots.reduce((n, r) => n + r.projects, 0),
      indexing: !!this.refreshing,
      progress: { ...this.progress },
      lastUpdate: this.lastUpdate,
      errors: [...this.errors],
    };
  }

  /** Status updates for the UI (at most a few per second). Returns an unsubscribe function. */
  subscribe(fn: (s: IndexStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    if (!this.listeners.size || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const s = this.status();
      for (const fn of this.listeners) {
        try {
          fn(s);
        } catch {
          // a broken listener must not stop indexing
        }
      }
    }, 400);
    this.notifyTimer.unref();
  }

  private setProgress(p: IndexProgress): void {
    this.progress = p;
    this.notify();
  }

  private addError(msg: string): void {
    this.errors.push(msg);
    if (this.errors.length > 10) this.errors.shift();
  }

  // ------------------------------------------------------------------ refresh

  /**
   * Brings every root up to date: loads the saved index once, then re-reads only new and changed
   * files (by size and mtime) and drops deleted ones. Concurrent calls share one run.
   */
  refresh(): Promise<void> {
    if (!this.enabledFlag || this.suspended || !this.roots.size) return Promise.resolve();
    // A cancelled run (project switch) is still winding down: start a fresh one right after it.
    if (this.refreshing) return this.abort?.signal.aborted ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    const ac = new AbortController();
    this.abort = ac;
    this.refreshing = this.runRefresh(ac.signal)
      .catch((e) => this.addError(`Indexing failed: ${(e as Error).message}`))
      .finally(() => {
        this.refreshing = null;
        this.abort = null;
        this.setProgress({ phase: 'idle', done: 0, total: 0 });
      });
    this.notify();
    return this.refreshing;
  }

  private async runRefresh(signal: AbortSignal): Promise<void> {
    const done = new Set<Root>();
    const genBefore = this.gen;
    this.lastRefresh = { analyzed: 0, removed: 0, walked: 0 };
    for (;;) {
      // Roots can be added while this runs; the current project's root always goes first.
      const root = this.orderedRoots().find((r) => !done.has(r));
      if (!root || signal.aborted) break;
      done.add(root);
      await this.load(root);
      if (signal.aborted) break;
      try {
        await this.refreshRoot(root, signal);
      } catch (e) {
        this.addError(`${root.dir}: ${(e as Error).message}`);
      }
      // Saving runs behind (serialized per root); suspend() waits for it.
      if (root.dirty && !signal.aborted) void this.save(root);
    }
    if (!signal.aborted) this.lastUpdate = Date.now();
    if (this.gen !== genBefore && !signal.aborted) {
      // Warm the caches so the next query and the next prompt do not wait.
      void this.searchIndex().catch(() => undefined);
      this.scheduleSections();
    }
  }

  private async load(root: Root): Promise<void> {
    if (root.loaded) return;
    if (!root.loading) {
      root.loading = (async () => {
        this.setProgress({ phase: 'loading', root: root.dir, done: 0, total: 0 });
        const slicer = new Slicer();
        let n = 0;
        try {
          let header: SavedHeader | null = null;
          let remap = new Int32Array(0);
          for await (const obj of readLines(root.file)) {
            if (!header) {
              header = obj as SavedHeader;
              if (header.v !== INDEX_VERSION || normKey(header.root ?? '') !== root.key || header.endian !== os.endianness()) break;
              remap = Int32Array.from((header.terms ?? []).map((t) => this.dict.id(t)));
              root.truncated = !!header.truncated;
              root.projects = (header.projects ?? []).filter((p) => p && typeof p.rel === 'string').map((p) => ({ ...p, dir: path.join(root.dir, p.rel) }));
              continue;
            }
            const o = obj as Record<string, unknown>;
            if (typeof o.h === 'string') {
              const commits = (o.c as [string, number, string, string, string][] | undefined) ?? [];
              root.history.set(o.h, { stamp: String(o.stamp ?? ''), at: Number(o.at) || 0, commits: commits.map(([hash, time, author, subject, files]) => ({ hash, time, author, subject, files: files ? files.split('\n') : [] })) });
              continue;
            }
            const e = decodeFile(o as FileLine, remap);
            if (e && !root.files.has(e.rel)) root.files.set(e.rel, e);
            if (++n % 1000 === 0) this.setProgress({ phase: 'loading', root: root.dir, done: n, total: 0 });
            await slicer.tick();
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.addError(`Could not read the saved index of ${root.dir} (rebuilding it): ${(e as Error).message}`);
        }
        root.loaded = true;
        if (n) this.invalidate();
      })();
    }
    await root.loading;
  }

  /**
   * A full walk when one is due (first time, a folder appeared, or the last walk is old enough given
   * how long walks of this root take); otherwise only the paths reported as changed.
   */
  private async refreshRoot(root: Root, signal: AbortSignal): Promise<void> {
    const age = Date.now() - root.lastWalk;
    const interval = root.watcher ? WATCHED_WALK_MS : this.minWalkMs && Math.max(this.minWalkMs, root.walkMs * WALK_BACKOFF);
    if (!root.lastWalk || root.needsWalk || age >= interval) await this.walkAndIndex(root, signal);
    else if (root.pending.size) await this.indexPending(root, signal);
  }

  /** Re-reads the paths a watcher or touchPaths reported, without walking the whole root. */
  private async indexPending(root: Root, signal: AbortSignal): Promise<void> {
    const rels = [...root.pending];
    root.pending.clear();
    const todo: WalkFile[] = [];
    const gone = new Set<string>();
    let dirs: Set<string> | null = null;
    let removed = 0;
    for (const rel of rels) {
      if (signal.aborted) return;
      const st = await fsp.stat(path.join(root.dir, rel)).catch(() => null);
      if (!st) {
        if (root.files.delete(rel)) removed++;
        else gone.add(rel); // maybe a folder (or just an editor's temp file)
        continue;
      }
      if (st.isDirectory()) {
        root.needsWalk = true; // a new or renamed folder: the next walk finds its files
        continue;
      }
      if (!st.isFile()) continue;
      const old = root.files.get(rel);
      if (st.size > MAX_FILE_BYTES || !indexableName(rel.slice(rel.lastIndexOf('/') + 1))) {
        if (old && root.files.delete(rel)) removed++;
        continue;
      }
      if (!old) {
        // A new file counts only in a folder that is already indexed (others may be ignored).
        dirs ??= new Set([...root.files.keys()].map((k) => k.slice(0, Math.max(0, k.lastIndexOf('/')))));
        if (!dirs.has(rel.slice(0, Math.max(0, rel.lastIndexOf('/'))))) continue;
      }
      if (!old || old.size !== st.size || old.mtime !== st.mtimeMs) todo.push({ rel, size: st.size, mtime: st.mtimeMs });
    }
    if (gone.size) {
      // Files under a deleted folder: one pass, checking each file's parent folders.
      for (const k of [...root.files.keys()]) {
        for (let i = k.indexOf('/'); i > 0; i = k.indexOf('/', i + 1)) {
          if (gone.has(k.slice(0, i))) {
            root.files.delete(k);
            removed++;
            break;
          }
        }
      }
    }
    if (removed) {
      root.dirty = true;
      this.lastRefresh.removed += removed;
      this.invalidate();
    }
    await this.indexFiles(root, todo, signal);
    if (signal.aborted) return;
    if (removed || todo.length) await this.updateProjects(root);
    await this.updateHistory(root, signal);
    if (root.needsWalk) this.soon();
  }

  private async walkAndIndex(root: Root, signal: AbortSignal): Promise<void> {
    this.setProgress({ phase: 'scanning', root: root.dir, done: 0, total: 0 });
    const started = Date.now();
    // Changes reported from now on are seen by this walk or kept for the next refresh.
    root.pending.clear();
    root.needsWalk = false;
    const walk = await walkRoot(root.dir, {
      maxFiles: MAX_FILES_PER_ROOT,
      signal,
      onProgress: (n) => this.setProgress({ phase: 'scanning', root: root.dir, done: n, total: 0 }),
    });
    for (const e of walk.errors.slice(0, 3)) if (!walk.complete) this.addError(`Cannot read ${e}`);
    if (!walk.complete && !walk.files.length) return; // unreadable (or aborted): keep what we have
    root.truncated = walk.truncated;
    this.lastRefresh.walked += walk.files.length;
    const seen = new Set<string>();
    const todo: WalkFile[] = [];
    for (const w of walk.files) {
      seen.add(w.rel);
      const old = root.files.get(w.rel);
      if (!old || old.size !== w.size || old.mtime !== w.mtime) todo.push(w);
    }
    if (walk.complete) {
      let unseen = [...root.files.keys()].filter((rel) => !seen.has(rel));
      // A capped walk can see a slightly different set of files each time: keep the ones that still exist.
      if (walk.truncated && unseen.length) {
        const exists = await Promise.all(unseen.map((rel) => fsp.stat(path.join(root.dir, rel)).then(() => true, () => false)));
        unseen = unseen.filter((_, i) => !exists[i]);
      }
      for (const rel of unseen) {
        root.files.delete(rel);
        this.lastRefresh.removed++;
      }
      if (unseen.length) {
        root.dirty = true;
        this.invalidate();
      }
    }
    // The opened project first, so its answers improve soonest.
    const cur = this.current && isInside(this.current, root.dir) ? toPosix(path.relative(root.dir, this.current)) : null;
    if (cur) todo.sort((a, b) => Number(!(cur === '' || a.rel.startsWith(`${cur}/`))) - Number(!(cur === '' || b.rel.startsWith(`${cur}/`))));
    await this.indexFiles(root, todo, signal);
    if (signal.aborted) return;
    await this.updateProjects(root);
    await this.updateHistory(root, signal);
    if (walk.complete && !signal.aborted) {
      root.lastWalk = Date.now();
      root.walkMs = root.lastWalk - started;
      this.watch(root);
    }
  }

  private async indexFiles(root: Root, todo: WalkFile[], signal: AbortSignal): Promise<void> {
    if (!todo.length) return;
    this.setProgress({ phase: 'indexing', root: root.dir, done: 0, total: todo.length });
    const pipe = new Pipe<{ w: WalkFile; buf: Buffer | null }>(64);
    let next = 0;
    const readers = Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length && !signal.aborted) {
        const w = todo[next++]!;
        let buf: Buffer | null = null;
        try {
          buf = await fsp.readFile(path.join(root.dir, w.rel));
        } catch {
          buf = null;
        }
        await pipe.push({ w, buf });
      }
    });
    void Promise.all(readers).then(() => pipe.close());
    const slicer = new Slicer();
    let done = 0;
    for (;;) {
      const item = await pipe.pop();
      if (!item) break;
      if (signal.aborted) continue; // drain so readers can finish
      const { w, buf } = item;
      if (!buf) {
        if (root.files.delete(w.rel)) {
          root.dirty = true;
          this.invalidate();
        }
        continue;
      }
      const lang = langOf(w.rel);
      const text = decodeText(buf);
      let entry: FileEntry;
      try {
        entry = text === null ? skippedEntry(w, lang.id) : { ...(await analyzeText(w.rel, text, lang, this.dict, () => slicer.tick())), rel: w.rel, size: w.size, mtime: w.mtime };
      } catch (e) {
        this.addError(`Could not index ${w.rel}: ${(e as Error).message}`);
        entry = skippedEntry(w, lang.id);
      }
      root.files.set(w.rel, entry);
      root.dirty = true;
      this.invalidate();
      this.lastRefresh.analyzed++;
      if (++done % 200 === 0) this.setProgress({ phase: 'indexing', root: root.dir, done, total: todo.length });
      if (Date.now() - root.lastSave > CHECKPOINT_MS) {
        root.lastSave = Date.now();
        void this.save(root);
      }
      await slicer.tick();
    }
  }

  /**
   * Detects projects and re-reads manifests whose files changed. Unchanged projects keep their
   * objects, so caches keyed by project stay valid.
   */
  private async updateProjects(root: Root): Promise<void> {
    let changed = false;
    const detected = (await detectProjects(root.dir, [...root.explicit])).map((p) => {
      const old = root.projects.find((o) => o.rel === p.rel);
      if (old && old.git === p.git && old.markers.join('|') === p.markers.join('|')) return old;
      changed = true;
      return p;
    });
    if (detected.length !== root.projects.length) changed = true;
    const byProject = new Map<ProjectRec, string[]>();
    for (const p of detected) byProject.set(p, []);
    const slicer = new Slicer();
    const view = { ...root, projects: detected };
    for (const rel of root.files.keys()) {
      const p = projectOf(view, rel);
      if (p) byProject.get(p)!.push(p.rel ? rel.slice(p.rel.length + 1) : rel);
      await slicer.tick();
    }
    for (const p of detected) {
      const files = byProject.get(p)!;
      const relevant = files.filter((f) => !f.includes('/') || /(^|\/)(package\.json|cargo\.toml|[^/]+\.(cs|fs|vb)proj)$/i.test(f) || f.startsWith('.github/workflows/') || f === 'Packages/manifest.json' || f.startsWith('ProjectSettings/ProjectVersion'));
      const stampParts = relevant.sort().map((f) => {
        const e = root.files.get(p.rel ? `${p.rel}/${f}` : f);
        return `${f}:${e?.size}:${e?.mtime}`;
      });
      for (const env of ['.env', '.env.local']) {
        const st = await fsp.stat(path.join(p.dir, env)).catch(() => null);
        if (st) stampParts.push(`${env}:${st.size}:${st.mtimeMs}`);
      }
      const stamp = `${p.markers.join(',')}|${stampParts.join('|')}`;
      if (p.manifest?.stamp !== stamp) {
        p.manifest = await readManifest({ dir: p.dir, files, markers: p.markers, stamp });
        changed = true;
      }
    }
    root.projects = detected;
    if (changed) {
      root.dirty = true;
      this.invalidate();
    }
  }

  private async updateHistory(root: Root, signal: AbortSignal): Promise<void> {
    for (const rel of [...root.history.keys()]) {
      if (!root.projects.some((p) => p.git && p.rel === rel)) {
        root.history.delete(rel);
        root.dirty = true;
      }
    }
    for (const p of root.projects) {
      if (!p.git || signal.aborted) continue;
      const stamp = await headStamp(p.dir);
      if (!stamp) continue;
      const old = root.history.get(p.rel);
      if (old && old.stamp === stamp) continue;
      this.setProgress({ phase: 'history', root: p.dir, done: 0, total: 0 });
      const commits = await readHistory(p.dir);
      root.history.set(p.rel, { stamp, at: Date.now(), commits: commits ?? [] });
      root.dirty = true;
      this.invalidate();
    }
  }

  private save(root: Root): Promise<void> {
    const run = async () => {
      if (!root.dirty || !root.loaded) return;
      root.dirty = false;
      root.lastSave = Date.now();
      const entries = [...root.files.values()];
      const history = [...root.history];
      const { localOf, terms } = await localTerms(entries, this.dict);
      const header = {
        v: INDEX_VERSION,
        root: root.dir,
        endian: os.endianness(),
        savedAt: Date.now(),
        truncated: root.truncated,
        projects: root.projects.map((p) => ({ rel: p.rel, markers: p.markers, git: p.git, manifest: p.manifest })),
        terms,
      };
      const progress = (done: number) => this.setProgress({ phase: 'saving', root: root.dir, done, total: entries.length });
      async function* lines(): AsyncGenerator<string> {
        yield `${JSON.stringify(header)}\n`;
        const slicer = new Slicer(10);
        let n = 0;
        for (const e of entries) {
          yield `${JSON.stringify(encodeFile(e, localOf))}\n`;
          if (++n % 2000 === 0) progress(n);
          await slicer.tick();
        }
        for (const [rel, h] of history) {
          yield `${JSON.stringify({ h: rel, stamp: h.stamp, at: h.at, c: h.commits.map((c) => [c.hash, c.time, c.author, c.subject, c.files.join('\n')]) })}\n`;
        }
      }
      try {
        await writeLines(root.file, lines());
      } catch (e) {
        root.dirty = true;
        this.addError(`Could not save the index of ${root.dir}: ${(e as Error).message}`);
      }
    };
    root.saving = root.saving.then(run, run);
    return root.saving;
  }

  // ------------------------------------------------------------------ shared caches

  private searchIndex(): Promise<SearchIndex> {
    if (this.searchIdx && this.searchIdx.gen === this.gen) return Promise.resolve(this.searchIdx);
    if (this.searchBuild && this.searchBuild.gen === this.gen) return this.searchBuild.promise;
    const gen = this.gen;
    const promise = SearchIndex.build([...this.roots.values()], this.dict.size, gen).then((idx) => {
      if (!this.searchIdx || this.searchIdx.gen <= gen) this.searchIdx = idx;
      return idx;
    });
    this.searchBuild = { gen, promise };
    return promise;
  }

  private linkGraph(): Promise<Links> {
    if (this.links && this.links.gen === this.gen) return this.links.promise;
    const promise = computeLinks([...this.roots.values()]);
    this.links = { gen: this.gen, promise };
    return promise;
  }

  /** Definitions by name (built in slices after each change). */
  private symbols(): Promise<Map<string, { root: Root; file: FileEntry; sym: SymbolDef }[]>> {
    if (this.symbolMap && this.symbolMap.gen === this.gen) return this.symbolMap.promise;
    const roots = [...this.roots.values()];
    const promise = (async () => {
      const map = new Map<string, { root: Root; file: FileEntry; sym: SymbolDef }[]>();
      const slicer = new Slicer();
      for (const root of roots) {
        for (const file of [...root.files.values()]) {
          for (const sym of file.syms) {
            const list = map.get(sym.name);
            if (list) list.push({ root, file, sym });
            else map.set(sym.name, [{ root, file, sym }]);
          }
          await slicer.tick();
        }
      }
      return map;
    })();
    this.symbolMap = { gen: this.gen, promise };
    return promise;
  }

  /** How many files mention each identifier (for the unused report). */
  private identFileCounts(): Promise<Map<string, number>> {
    if (this.identCounts && this.identCounts.gen === this.gen) return this.identCounts.promise;
    const roots = [...this.roots.values()];
    const promise = (async () => {
      const counts = new Map<string, number>();
      const slicer = new Slicer();
      for (const root of roots) {
        for (const f of [...root.files.values()]) {
          if (f.skipped) continue;
          for (const id of f.idents.split(' ')) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
          await slicer.tick();
        }
      }
      return counts;
    })();
    this.identCounts = { gen: this.gen, promise };
    return promise;
  }

  // ------------------------------------------------------------------ scopes and projects

  private findRootFor(abs: string): Root | undefined {
    let best: Root | undefined;
    for (const r of this.roots.values()) if (isInside(abs, r.dir) && (!best || r.dir.length > best.dir.length)) best = r;
    return best;
  }

  private projectName(p: ProjectRec, root: RootState): string {
    return p.manifest?.name ?? (path.basename(p.dir) || root.dir);
  }

  private allProjects(): { root: Root; project: ProjectRec }[] {
    const out: { root: Root; project: ProjectRec }[] = [];
    for (const root of this.roots.values()) for (const project of root.projects) out.push({ root, project });
    return out;
  }

  /** A project by name, folder name or path (case-insensitive). */
  findProject(nameOrPath: string): { root: Root; project: ProjectRec } | undefined {
    const q = nameOrPath.trim();
    if (!q) return undefined;
    const all = this.allProjects();
    if (/[\\/]/.test(q) || path.isAbsolute(q)) {
      const abs = path.resolve(this.current ?? process.cwd(), q);
      const exact = all.find((x) => normKey(x.project.dir) === normKey(abs));
      if (exact) return exact;
    }
    const lower = q.toLowerCase();
    return (
      all.find((x) => this.projectName(x.project, x.root).toLowerCase() === lower) ??
      all.find((x) => path.basename(x.project.dir).toLowerCase() === lower) ??
      all.find((x) => x.project.manifest?.aliases.some((a) => a.toLowerCase() === lower))
    );
  }

  /** Folder of the scope: [root, path relative to it] or null for everything. */
  private scopeTarget(scope: string | undefined, projectRoot: string | undefined): { root: Root; rel: string } | null {
    const s = (scope ?? 'project').trim();
    if (!s || s.toLowerCase() === 'all') return null;
    if (s.toLowerCase() === 'project') {
      const cur = projectRoot ? path.resolve(projectRoot) : this.current;
      if (!cur) return null;
      const root = this.findRootFor(cur);
      if (!root) return null;
      return { root, rel: toPosix(path.relative(root.dir, cur)) };
    }
    const hit = this.findProject(s);
    if (hit) return { root: hit.root, rel: hit.project.rel };
    // A folder inside a root works too.
    const abs = path.resolve(this.current ?? process.cwd(), s);
    const root = this.findRootFor(abs);
    if (root && (/[\\/]/.test(s) || path.isAbsolute(s))) return { root, rel: toPosix(path.relative(root.dir, abs)) };
    const names = this.allProjects().map((x) => this.projectName(x.project, x.root));
    throw new ScopeError(`Unknown scope "${s}". Use "project", "all" or one of: ${names.slice(0, 30).join(', ') || '(no projects indexed)'}.`);
  }

  private inScope(target: { root: Root; rel: string } | null, root: Root, rel: string): boolean {
    if (!target) return true;
    if (target.root !== root) return false;
    return !target.rel || rel === target.rel || rel.startsWith(`${target.rel}/`);
  }

  /** Display path: relative to the current project when inside it, absolute otherwise. */
  displayPath(abs: string): string {
    if (this.current && isInside(abs, this.current)) return toPosix(path.relative(this.current, abs)) || '.';
    return abs;
  }

  private projectNameOf(root: Root, rel: string): string | undefined {
    const p = projectOf(root, rel);
    return p ? this.projectName(p, root) : undefined;
  }

  /** Indexed projects that are neither the given project nor around or inside it. */
  otherProjectCount(projectRoot: string): number {
    const cur = path.resolve(projectRoot);
    return this.allProjects().filter((x) => !isInside(x.project.dir, cur) && !isInside(cur, x.project.dir)).length;
  }

  // ------------------------------------------------------------------ queries

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.max(1, Math.min(30, opts.limit ?? 8));
    const target = this.scopeTarget(opts.scope, opts.projectRoot);
    const idx = await this.searchIndex();
    const ids: { id: number; weight: number }[] = [];
    for (const t of queryTerms(query)) {
      const id = this.dict.get(t.term);
      if (id !== undefined) ids.push({ id, weight: t.weight });
    }
    // Query words the index has never seen (for the hint).
    const unknownWords: string[] = [];
    for (const m of query.matchAll(/[A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*/g)) {
      const ts = identTerms(m[0]);
      if (ts.length && ts.every((t) => this.dict.get(t) === undefined) && !unknownWords.includes(m[0])) unknownWords.push(m[0]);
    }
    let lo = 0;
    let hi = idx.n;
    if (target) {
      const r = idx.rangeFor(target.root, target.rel);
      if (!r) return { hits: [], unknownWords, weak: true, searched: 0 };
      [lo, hi] = r;
    }
    const scored = idx.score(ids, lo, hi, limit * 8 + 20);
    // Priors: tests and docs are rarely what a code question is after.
    const wantsTests = /\btests?\b|\bspecs?\b/i.test(query);
    for (const s of scored) {
      const f = idx.chunkFile[s.chunk]!;
      if (!wantsTests && isTestPath(f.rel)) s.score *= 0.8;
      if (!langById(f.lang).code) s.score *= 0.85;
    }
    scored.sort((a, b) => b.score - a.score);
    const perFile = new Map<FileEntry, number>();
    const hits: SearchHit[] = [];
    let weak = !scored.length;
    for (const s of scored) {
      if (hits.length >= limit) break;
      const f = idx.chunkFile[s.chunk]!;
      const n = perFile.get(f) ?? 0;
      if (n >= 2) continue;
      perFile.set(f, n + 1);
      const root = idx.rootOf(s.chunk) as Root | undefined;
      if (!root) continue;
      const c = f.chunks[idx.chunkIdx[s.chunk]!]!;
      if (!hits.length && s.coverage < 0.5) weak = true;
      hits.push({ file: path.join(root.dir, f.rel), rel: f.rel, project: this.projectNameOf(root, f.rel), start: c.start, end: c.end, symbol: c.sym, kind: c.kind, score: Math.round(s.score * 100) / 100 });
    }
    return { hits, unknownWords, weak, searched: hi - lo };
  }

  async definitions(name: string, opts: SearchOptions = {}): Promise<SymbolHit[]> {
    const target = this.scopeTarget(opts.scope, opts.projectRoot);
    const q = name.trim().replace(/\(\)$/, '');
    const parts = q.split(/::|\.|#/);
    const base = parts.pop()!;
    const parent = parts.pop();
    const map = await this.symbols();
    let list = map.get(base) ?? [];
    if (!list.length) {
      const lower = base.toLowerCase();
      for (const [k, v] of map) if (k.toLowerCase() === lower) list = list.concat(v);
    }
    if (parent) {
      const withParent = list.filter((x) => x.sym.parent === parent);
      if (withParent.length) list = withParent;
    }
    const hits = list
      .filter((x) => this.inScope(target, x.root, x.file.rel))
      .sort((a, b) => {
        const ka = KIND_ORDER.indexOf(a.sym.kind);
        const kb = KIND_ORDER.indexOf(b.sym.kind);
        return Number(b.sym.name === base) - Number(a.sym.name === base) || (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb) || Number(isTestPath(a.file.rel)) - Number(isTestPath(b.file.rel)) || a.file.rel.localeCompare(b.file.rel);
      });
    return hits.slice(0, Math.max(1, Math.min(50, opts.limit ?? 30))).map((x) => ({
      name: x.sym.name,
      kind: x.sym.kind,
      file: path.join(x.root.dir, x.file.rel),
      rel: x.file.rel,
      project: this.projectNameOf(x.root, x.file.rel),
      line: x.sym.line,
      parent: x.sym.parent,
      exported: !!(x.sym.flags & SYM_EXPORTED),
    }));
  }

  /**
   * Lines that mention the identifier, excluding the lines that define it. Files are found through
   * the index and read now, so line numbers are current.
   */
  async references(name: string, opts: SearchOptions & { maxLines?: number } = {}): Promise<{ hits: ReferenceHit[]; files: number; outOfScope: number }> {
    const target = this.scopeTarget(opts.scope, opts.projectRoot);
    const id = name.trim().replace(/\(\)$/, '').split(/::|\.|#/).pop() ?? '';
    if (!/^[\w$\u00C0-\uFFFF]+$/.test(id)) return { hits: [], files: 0, outOfScope: 0 };
    const needle = ` ${id} `;
    const candidates: { root: Root; file: FileEntry }[] = [];
    let outOfScope = 0;
    for (const root of this.roots.values()) {
      for (const file of root.files.values()) {
        if (file.skipped || !file.idents.includes(needle)) continue;
        if (this.inScope(target, root, file.rel)) candidates.push({ root, file });
        else outOfScope++;
      }
    }
    candidates.sort((a, b) => Number(isTestPath(a.file.rel)) - Number(isTestPath(b.file.rel)) || a.file.rel.localeCompare(b.file.rel));
    const re = new RegExp(`(?<![\\w$])${escapeRegExp(id)}(?![\\w$])`);
    const maxLines = opts.maxLines ?? 200;
    const hits: ReferenceHit[] = [];
    let files = 0;
    for (const { root, file } of candidates.slice(0, 400)) {
      if (hits.length >= maxLines) break;
      const abs = path.join(root.dir, file.rel);
      let text: string;
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const defLines = new Set(file.syms.filter((s) => s.name === id).map((s) => s.line));
      const lines = text.split(/\r?\n/);
      let found = false;
      for (let i = 0; i < lines.length && hits.length < maxLines; i++) {
        if (defLines.has(i + 1) || !re.test(lines[i]!)) continue;
        found = true;
        hits.push({ file: abs, rel: file.rel, project: this.projectNameOf(root, file.rel), line: i + 1, text: lines[i]!.trim().slice(0, 200) });
      }
      if (found) files++;
    }
    return { hits, files, outOfScope };
  }

  /** Every indexed project with its languages and a one-line summary. */
  projects(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const { root, project } of this.allProjects()) out.push(this.summary(root, project, this.languages(project).list));
    return out;
  }

  /** Files, languages and last change per project (one pass over all files, cached until the index changes). */
  private projectStats(): Map<ProjectRec, { langs: Map<string, number>; files: number; last: number }> {
    if (this.statsCache && this.statsCache.gen === this.gen) return this.statsCache.map;
    const map = new Map<ProjectRec, { langs: Map<string, number>; files: number; last: number }>();
    for (const root of this.roots.values()) {
      for (const f of root.files.values()) {
        if (f.skipped) continue;
        const p = projectOf(root, f.rel);
        if (!p) continue;
        let st = map.get(p);
        if (!st) map.set(p, (st = { langs: new Map(), files: 0, last: 0 }));
        st.files++;
        if (f.mtime > st.last) st.last = f.mtime;
        if (langById(f.lang).code) st.langs.set(f.lang, (st.langs.get(f.lang) ?? 0) + 1);
      }
    }
    this.statsCache = { gen: this.gen, map };
    return map;
  }

  private languages(project: ProjectRec): { list: { name: string; files: number }[]; files: number; lastModified: number | null } {
    const st = this.projectStats().get(project);
    if (!st) return { list: [], files: 0, lastModified: null };
    const list = [...st.langs].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ name: langById(id).name, files: n }));
    return { list, files: st.files, lastModified: st.last || null };
  }

  private summary(root: Root, project: ProjectRec, languages: { name: string; files: number }[]): ProjectSummary {
    const m = project.manifest;
    return {
      name: this.projectName(project, root),
      path: project.dir,
      folder: path.basename(project.dir),
      languages,
      summary: m?.description || m?.readme,
      git: project.git,
    };
  }

  async projectProfile(nameOrPath?: string): Promise<ProjectProfile | null> {
    const hit = nameOrPath ? this.findProject(nameOrPath) : this.current ? this.projectAt(this.current) : undefined;
    if (!hit) return null;
    const { root, project } = hit;
    const m: Manifest = project.manifest ?? { deps: [], platform: [], aliases: [], refs: [], configs: [], envMissing: [], stamp: '' };
    const langs = this.languages(project);
    const links = await this.linkGraph();
    const info = (p: { root: RootState; project: ProjectRec }, e: { imports: number; files: string[]; declared: boolean }): ProjectLinkInfo => ({
      name: this.projectName(p.project, p.root),
      path: p.project.dir,
      files: e.files,
      imports: e.imports,
      declared: e.declared,
    });
    const uses = links.edges.filter((e) => e.from.project === project).map((e) => info(e.to, e));
    const usedBy = links.edges.filter((e) => e.to.project === project).map((e) => info(e.from, e));
    const byImports = (a: ProjectLinkInfo, b: ProjectLinkInfo) => b.imports - a.imports || a.name.localeCompare(b.name);
    return {
      ...this.summary(root, project, langs.list),
      root: root.dir,
      markers: project.markers,
      lastModified: langs.lastModified,
      description: m.description,
      version: m.version,
      platform: m.platform,
      scripts: m.scripts ?? {},
      dependencies: m.deps,
      configs: m.configs,
      envExample: m.envExample,
      envMissing: m.envMissing,
      readme: m.readme,
      uses: uses.sort(byImports),
      usedBy: usedBy.sort(byImports),
      files: langs.files,
      commits: root.history.get(project.rel)?.commits.length ?? 0,
    };
  }

  /** The project that holds a folder (the opened project itself when it is one). */
  private projectAt(abs: string): { root: Root; project: ProjectRec } | undefined {
    const root = this.findRootFor(abs);
    if (!root) return undefined;
    const rel = toPosix(path.relative(root.dir, abs));
    const exact = root.projects.find((p) => p.rel === rel);
    if (exact) return { root, project: exact };
    const p = projectOf(root, rel);
    return p ? { root, project: p } : undefined;
  }

  async history(query: string, opts: SearchOptions = {}): Promise<{ commits: CommitResult[]; repos: number; total: number }> {
    const limit = Math.max(1, Math.min(30, opts.limit ?? 8));
    const target = this.scopeTarget(opts.scope, opts.projectRoot);
    const pools: { name: string; dir: string; commits: Commit[]; prefix: string }[] = [];
    for (const root of this.roots.values()) {
      if (target && target.root !== root) continue;
      for (const [rel, h] of root.history) {
        const project = root.projects.find((p) => p.rel === rel);
        if (!project) continue;
        // A repository is in scope when it lies inside the scope folder, or holds it (then only
        // commits that touched the folder count).
        let prefix = '';
        if (target) {
          const t = target.rel;
          const repoInScope = !t || rel === t || rel.startsWith(`${t}/`);
          const scopeInRepo = !rel || t.startsWith(`${rel}/`);
          if (!repoInScope && !scopeInRepo) continue;
          if (!repoInScope) prefix = rel ? t.slice(rel.length + 1) : t;
        }
        pools.push({ name: this.projectName(project, root), dir: project.dir, commits: h.commits, prefix });
      }
    }
    const merged: { hit: ReturnType<typeof searchCommits>[number]; pool: (typeof pools)[number] }[] = [];
    let total = 0;
    for (const pool of pools) {
      const commits = pool.prefix ? pool.commits.filter((c) => c.files.some((f) => f.startsWith(`${pool.prefix}/`))) : pool.commits;
      total += commits.length;
      for (const hit of searchCommits(commits, query, limit)) merged.push({ hit, pool });
    }
    merged.sort((a, b) => b.hit.score - a.hit.score || b.hit.commit.time - a.hit.commit.time);
    return {
      repos: pools.length,
      total,
      commits: merged.slice(0, limit).map(({ hit, pool }) => ({
        project: pool.name,
        projectPath: pool.dir,
        hash: hit.commit.hash,
        date: new Date(hit.commit.time * 1000).toISOString().slice(0, 10),
        author: hit.commit.author,
        subject: hit.commit.subject,
        files: hit.files,
      })),
    };
  }

  /**
   * Exported or top-level definitions whose name appears nowhere else in the indexed roots.
   * Name based, so dynamic calls, reflection and engine callbacks look unused: approximate.
   */
  async unused(projectPath?: string, opts: { limit?: number } = {}): Promise<UnusedReport | null> {
    const hit = projectPath ? this.findProject(projectPath) ?? this.projectAt(path.resolve(this.current ?? process.cwd(), projectPath)) : this.current ? this.projectAt(this.current) : undefined;
    if (!hit) return null;
    const { root, project } = hit;
    const counts = await this.identFileCounts();
    const out: UnusedSymbol[] = [];
    let checked = 0;
    for (const f of root.files.values()) {
      if (f.skipped || !f.syms.length || isTestPath(f.rel) || projectOf(root, f.rel) !== project) continue;
      for (const s of f.syms) {
        // One-letter names are not tracked as identifiers, so they cannot be checked.
        if (s.name.length < 2 || !(s.flags & (SYM_EXPORTED | SYM_TOP)) || !UNUSED_KINDS.has(s.kind) || ENTRY_POINTS.has(s.name) || /^__\w+__$/.test(s.name) || /^(test|Test|benchmark|Benchmark)/.test(s.name)) continue;
        checked++;
        // Mentioned in another file, or elsewhere in its own file: used.
        if ((counts.get(s.name) ?? 0) > 1 || s.uses > 0) continue;
        out.push({ name: s.name, kind: s.kind, file: path.join(root.dir, f.rel), rel: project.rel ? f.rel.slice(project.rel.length + 1) : f.rel, line: s.line });
      }
    }
    // Functions and types first: unused variables are more often false alarms (framework globals).
    const rank = (k: string) => (k === 'variable' || k === 'field' || k === 'constant' ? 1 : 0);
    out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.rel.localeCompare(b.rel) || a.line - b.line);
    return {
      project: this.projectName(project, root),
      path: project.dir,
      checked,
      symbols: out.slice(0, Math.max(1, opts.limit ?? 200)),
      approximate: true,
      note: 'Approximate: a definition counts as used when its name appears anywhere else in the indexed folders. Dynamic calls, reflection, string lookups, engine callbacks and code outside the indexed folders are not seen.',
    };
  }

  // ------------------------------------------------------------------ prompt sections

  /**
   * Short system prompt sections built from the index (profile of the current project and the
   * other projects next to it). Never waits: returns '' until the index is ready, then the cached text.
   */
  promptSection(projectRoot: string): string {
    if (!this.enabledFlag) return '';
    const key = normKey(projectRoot);
    const hit = this.sections.get(key);
    if (!hit || hit.gen !== this.gen) this.scheduleSections();
    return hit?.text ?? '';
  }

  /** Builds (and caches) the prompt section for a project now. */
  async preparePromptSection(projectRoot: string): Promise<string> {
    const gen = this.gen;
    const text = [await currentProjectSection(this, projectRoot), otherProjectsSection(this, projectRoot)].filter(Boolean).join('\n\n');
    this.sections.set(normKey(projectRoot), { gen, text });
    return text;
  }

  private scheduleSections(): void {
    if (this.sectionJob || !this.current) return;
    this.sectionJob = this.preparePromptSection(this.current)
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.sectionJob = null;
      });
  }
}

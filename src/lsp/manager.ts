// Starts language servers when they are first needed (one per language and project folder), restarts
// them after a crash, stops idle ones, and turns their diagnostics into short reports for the agent.
import * as path from 'node:path';
import { LspClient, type Doc } from './client.js';
import { defForFile, findRoot, languageIdFor, resolveServer, serverDefs, canonicalServerId, type Resolved, type ServerDef, type ServerOverride } from './servers.js';
import { editReport, isError, otherFilesReport } from './format.js';
import { pathKey, uriKey, uriToPath, type Diagnostic } from './protocol.js';
import { listFiles, sortByMtime } from '../tools/listFiles.js';
import { displayPath, isInside } from '../util/fs.js';
import { mapLimit } from '../util/async.js';
import { debug } from '../util/log.js';

export interface LspSettings {
  /** Language servers on (default true). */
  enabled?: boolean;
  /** Per language: command, args, initializationOptions, disabled; custom languages add "extensions". */
  servers?: Record<string, ServerOverride>;
  /** How long an edit waits for diagnostics, in ms (default 4000). */
  diagnosticsTimeoutMs?: number;
}

export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 4000;
const IDLE_MS = 15 * 60_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES = 3;
/** A server that failed to start is not tried again for this long. */
const RETRY_FAILED_START_MS = 60_000;
/** "Not installed" is checked again after this long (the user may have installed it meanwhile). */
const RECHECK_MISSING_MS = 30_000;
/** Files per language opened for the workspace diagnostics. */
const PROJECT_FILES_PER_LANGUAGE = 30;

interface Entry {
  key: string;
  def: ServerDef;
  root: string;
  client: LspClient;
  ready: Promise<void>;
  wasReady: boolean;
  idle?: NodeJS.Timeout;
}

interface Failure {
  until: number;
  message: string;
  crashes: number[];
}

export type Acquired =
  | { ok: true; client: LspClient; def: ServerDef; root: string }
  | { ok: false; reason: 'disabled' | 'unsupported' | 'missing' | 'bad-override' | 'failed' | 'starting'; message: string };

export interface ProjectDiagnostics {
  files: { file: string; items: Diagnostic[] }[];
  /** Languages that could not be checked, and why. */
  notes: string[];
  checked: number;
  servers: string[];
}

/** Resolves to how a promise settled within `ms`: 'ok', 'failed' or still 'pending'. */
function settle(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<'ok' | 'failed' | 'pending'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('pending'), Math.max(0, ms));
    const onAbort = () => done('pending');
    function done(v: 'ok' | 'failed' | 'pending') {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => done('ok'),
      () => done('failed'),
    );
  });
}

function normalizeOverrides(raw: unknown): Record<string, ServerOverride> {
  const out: Record<string, ServerOverride> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[canonicalServerId(k)] = v as ServerOverride;
  }
  return out;
}

export class LspManager {
  enabled = true;
  diagnosticsTimeoutMs = DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
  private overrides: Record<string, ServerOverride> = {};
  private defs: ServerDef[] = serverDefs({});
  private entries = new Map<string, Entry>();
  private failures = new Map<string, Failure>();
  private missing = new Map<string, { at: number; resolved: Resolved }>();

  /** Applies the "lsp" settings. Running servers stop when turned off or when their setup changed. */
  configure(cfg: LspSettings | undefined): void {
    const overrides = normalizeOverrides(cfg?.servers);
    const changed = JSON.stringify(overrides) !== JSON.stringify(this.overrides);
    this.enabled = cfg?.enabled !== false;
    const t = Number(cfg?.diagnosticsTimeoutMs);
    this.diagnosticsTimeoutMs = Number.isFinite(t) && t > 0 ? Math.min(30_000, Math.max(250, t)) : DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
    if (changed) {
      this.overrides = overrides;
      this.defs = serverDefs(overrides);
      this.failures.clear();
      this.missing.clear();
    }
    if (!this.enabled || changed) void this.stopAll();
  }

  defFor(file: string): ServerDef | null {
    return defForFile(file, this.defs);
  }

  /**
   * The running server for `file`, started if needed. Waits at most `waitMs` for it to come up; a
   * server that is still starting keeps starting in the background.
   */
  async acquire(file: string, projectRoot: string, opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<Acquired> {
    if (!this.enabled) return { ok: false, reason: 'disabled', message: 'Language servers are turned off in the settings (lsp.enabled).' };
    const def = defForFile(file, this.defs);
    if (!def) return { ok: false, reason: 'unsupported', message: `FreeCode knows no language server for ${path.extname(file) || 'these'} files.` };
    const root = findRoot(def, file, projectRoot);
    const key = `${def.id}|${pathKey(root)}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const failed = this.failures.get(key);
      if (failed && Date.now() < failed.until) return { ok: false, reason: 'failed', message: failed.message };
      const resolved = this.resolve(def, root, key);
      if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };
      entry = this.start(key, def, root, resolved.launch);
    }
    this.touch(entry);
    const state = await settle(entry.ready, opts.waitMs ?? 60_000, opts.signal);
    if (state === 'ok' && entry.client.status === 'ready') return { ok: true, client: entry.client, def, root };
    if (state === 'pending') return { ok: false, reason: 'starting', message: `${entry.client.label} is still starting. Try again in a moment.` };
    return { ok: false, reason: 'failed', message: this.failures.get(key)?.message ?? entry.client.describeExit() };
  }

  private resolve(def: ServerDef, root: string, key: string): Resolved {
    const m = this.missing.get(key);
    if (m && Date.now() - m.at < RECHECK_MISSING_MS) return m.resolved;
    // A second look skips cached PATH lookups: the user may have installed the server meanwhile.
    const r = resolveServer(def, root, this.overrides[def.id], !!m);
    if (r.ok) this.missing.delete(key);
    else this.missing.set(key, { at: Date.now(), resolved: r });
    return r;
  }

  private start(key: string, def: ServerDef, root: string, launch: Extract<Resolved, { ok: true }>['launch']): Entry {
    const client = new LspClient({ serverId: def.id, root, launch, languageId: (f) => languageIdFor(def, f), quietMs: def.quietMs, dedupes: def.dedupes });
    const entry: Entry = { key, def, root, client, ready: client.start(), wasReady: false };
    entry.ready.then(
      () => (entry.wasReady = true),
      () => undefined,
    );
    client.onExit = () => this.onExit(entry);
    this.entries.set(key, entry);
    return entry;
  }

  private onExit(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.idle) clearTimeout(entry.idle);
    const c = entry.client;
    // No error means it was stopped on purpose (idle, settings, shutdown).
    if (!c.error) return;
    const now = Date.now();
    const f = this.failures.get(entry.key) ?? { until: 0, message: '', crashes: [] };
    if (!entry.wasReady) {
      // It never got going: a broken install or a bad setting fails the same way when retried at once.
      const install = this.overrides[entry.def.id]?.command ? '' : entry.def.install();
      f.until = now + RETRY_FAILED_START_MS;
      f.message = `${c.describeExit()}${install ? `\nIf it is not installed correctly, reinstall it with: ${install}` : ''}`;
    } else {
      f.crashes = [...f.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (f.crashes.length >= MAX_CRASHES) {
        f.until = now + CRASH_WINDOW_MS;
        f.message = `${c.label} crashed ${f.crashes.length} times in a few minutes, so it is not restarted for now. Last error: ${c.describeExit()}`;
      }
    }
    this.failures.set(entry.key, f);
  }

  private touch(entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      if (Date.now() - entry.client.lastUsed < IDLE_MS) return this.touch(entry);
      debug('lsp', `stopping idle ${entry.client.label} (${entry.root})`);
      void this.stop(entry);
    }, IDLE_MS);
    entry.idle.unref();
  }

  private async stop(entry: Entry): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.idle) clearTimeout(entry.idle);
    await entry.client.shutdown().catch(() => undefined);
  }

  /** Stops every server (FreeCode exits, a project is closed, or the settings turned them off). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.stop(e)));
  }

  /** Servers running for this project. */
  running(projectRoot: string): { client: LspClient; def: ServerDef; root: string }[] {
    return [...this.entries.values()]
      .filter((e) => e.client.status === 'ready' && (isInside(e.root, projectRoot) || isInside(projectRoot, e.root)))
      .map((e) => ({ client: e.client, def: e.def, root: e.root }));
  }

  // ------------------------------------------------------------------ the agent's hooks

  /**
   * Starts the server for a file the agent read and opens the file in it, so the server is warm and
   * knows the file's errors before the first edit. Never waits and never fails.
   */
  warmUp(file: string, projectRoot: string): void {
    if (!this.enabled || !defForFile(file, this.defs)) return;
    void (async () => {
      const acq = await this.acquire(file, projectRoot, { waitMs: 120_000 });
      if (!acq.ok) return;
      const since = acq.client.diagnosticsSeq;
      const r = await acq.client.sync(file);
      // Pushed diagnostics arrive by themselves; pulled ones are fetched now as the "before" state.
      if (r?.changed && acq.client.pullsDiagnostics) await acq.client.diagnosticsFor(r.doc, since, 15_000);
    })().catch((e) => debug('lsp', 'warm-up failed', e));
  }

  /**
   * Diagnostics reports for files the agent just changed (aligned with `files`; null = nothing to
   * say). A file changed by several calls gets one report, on its last call. Waits at most
   * diagnosticsTimeoutMs in total and never throws.
   */
  async afterEdit(files: string[], projectRoot: string, signal?: AbortSignal): Promise<(string | null)[]> {
    const out: (string | null)[] = files.map(() => null);
    if (!this.enabled) return out;
    const deadline = Date.now() + this.diagnosticsTimeoutMs;
    const last = new Map<string, number>();
    files.forEach((f, i) => {
      if (f && defForFile(f, this.defs)) last.set(pathKey(f), i);
    });
    const edited = new Set(last.keys());
    await Promise.all(
      [...last.values()].map(async (i) => {
        try {
          out[i] = await this.editReport(files[i]!, projectRoot, deadline, edited, signal);
        } catch (e) {
          debug('lsp', 'diagnostics after edit failed', e);
        }
      }),
    );
    return out;
  }

  private async editReport(file: string, projectRoot: string, deadline: number, edited: Set<string>, signal?: AbortSignal): Promise<string | null> {
    const acq = await this.acquire(file, projectRoot, { waitMs: deadline - Date.now(), signal });
    if (!acq.ok) return null;
    const { client, def, root } = acq;
    const prev = client.doc(file);
    const prevItems = prev ? client.lastDiagnostics(file) : undefined;
    const before = prev && prevItems ? { items: prevItems, text: prev.text } : undefined;
    const othersBefore = new Map(client.allDiagnostics().map((e) => [uriKey(e.uri), e.items]));
    const since = client.diagnosticsSeq;
    const synced = await client.sync(file, { save: true });
    if (!synced) return null;
    const items = await client.diagnosticsFor(synced.doc, since, Math.max(0, deadline - Date.now()), signal);
    if (!items || def.unreliable?.(items, root)) return null;
    const own = editReport({ rel: displayPath(file, projectRoot), label: client.label, items, text: synced.doc.text, before });
    const others = await this.newErrorsElsewhere(client, since, othersBefore, edited, projectRoot, deadline, signal);
    return [own, others].filter(Boolean).join('\n') || null;
  }

  /** Errors that appeared in other open files during the wait (callers of a changed function). */
  private async newErrorsElsewhere(client: LspClient, since: number, before: Map<string, Diagnostic[]>, edited: Set<string>, projectRoot: string, deadline: number, signal?: AbortSignal): Promise<string | null> {
    if (client.pullsDiagnostics) {
      const provider = client.capabilities.diagnosticProvider as { interFileDependencies?: boolean } | undefined;
      const remaining = deadline - Date.now();
      if (!provider?.interFileDependencies || remaining < 300) return null;
      const docs = client
        .openDocs()
        .filter((d) => !edited.has(pathKey(d.file)) && before.has(pathKey(d.file)))
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, 3);
      await Promise.all(docs.map((d) => client.diagnosticsFor(d, client.diagnosticsSeq, remaining, signal).catch(() => null)));
    }
    const entries: { rel: string; items: Diagnostic[] }[] = [];
    for (const e of client.diagnosticsSince(since)) {
      const key = uriKey(e.uri);
      const file = uriToPath(e.uri);
      // Only files whose earlier state is known: otherwise old errors would look new.
      if (!file || edited.has(key) || !before.has(key)) continue;
      const old = new Set(before.get(key)!.filter(isError).map((d) => `${d.range.start.line}|${d.message}`));
      const fresh = e.items.filter((d) => isError(d) && !old.has(`${d.range.start.line}|${d.message}`));
      if (fresh.length) entries.push({ rel: displayPath(file, projectRoot), items: fresh });
    }
    return otherFilesReport(entries);
  }

  // ------------------------------------------------------------------ the LSP tool

  /**
   * Diagnostics for the whole project: files of each language with an installed server are opened
   * (the ones changed in this session first, then the most recently modified), and everything the
   * servers report inside the project is collected.
   */
  async projectDiagnostics(projectRoot: string, opts: { signal?: AbortSignal; timeoutMs?: number; prefer?: string[] } = {}): Promise<ProjectDiagnostics> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const result: ProjectDiagnostics = { files: [], notes: [], checked: 0, servers: [] };
    if (!this.enabled) {
      result.notes.push('Language servers are turned off in the settings (lsp.enabled).');
      return result;
    }
    let rels: string[] = [];
    try {
      rels = await listFiles(projectRoot);
    } catch {
      rels = [];
    }
    const byDef = new Map<ServerDef, string[]>();
    for (const rel of rels) {
      const def = defForFile(rel, this.defs);
      if (def) byDef.set(def, [...(byDef.get(def) ?? []), rel]);
    }
    const collected = new Map<string, { file: string; items: Diagnostic[] }>();
    await Promise.all(
      [...byDef].map(async ([def, list]) => {
        const recent = (await sortByMtime(projectRoot, list)).map((r) => path.join(projectRoot, r));
        const preferred = (opts.prefer ?? []).filter((f) => defForFile(f, this.defs) === def && isInside(f, projectRoot));
        const pick = [...new Map([...preferred, ...recent].map((f) => [pathKey(f), f])).values()].slice(0, PROJECT_FILES_PER_LANGUAGE);
        const byRoot = new Map<string, string[]>();
        for (const f of pick) {
          const root = findRoot(def, f, projectRoot);
          byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
        }
        for (const group of byRoot.values()) {
          const acq = await this.acquire(group[0]!, projectRoot, { waitMs: Math.max(0, deadline - Date.now()), signal: opts.signal });
          if (!acq.ok) {
            if (acq.reason !== 'unsupported' && !result.notes.includes(acq.message)) result.notes.push(acq.message);
            continue;
          }
          const found = await this.checkFiles(acq.client, group, deadline, opts.signal);
          result.checked += found.checked;
          if (!result.servers.includes(acq.client.label)) result.servers.push(acq.client.label);
          const items: Diagnostic[] = [];
          for (const e of found.diagnostics) {
            const file = uriToPath(e.uri);
            if (!file || !isInside(file, projectRoot)) continue;
            collected.set(uriKey(e.uri), { file, items: e.items });
            items.push(...e.items);
          }
          const note = acq.def.unreliable?.(items, acq.root);
          if (note && !result.notes.includes(note)) result.notes.push(note);
        }
      }),
    );
    result.files = [...collected.values()];
    return result;
  }

  /**
   * Opens files in a server, waits for their diagnostics and returns everything the server reported.
   * Files opened only for this are closed again afterwards.
   */
  private async checkFiles(client: LspClient, files: string[], deadline: number, signal?: AbortSignal): Promise<{ checked: number; diagnostics: { uri: string; items: Diagnostic[] }[] }> {
    const wasOpen = new Set(client.openDocs().map((d) => pathKey(d.file)));
    const since = client.diagnosticsSeq;
    const docs: { doc: Doc; changed: boolean }[] = [];
    for (const f of files) {
      const r = await client.sync(f);
      if (r) docs.push(r);
    }
    const wide = (client.capabilities.diagnosticProvider as { workspaceDiagnostics?: boolean } | undefined)?.workspaceDiagnostics;
    if (wide) {
      try {
        const r = await client.request<{ items?: { uri: string; kind?: string; items?: Diagnostic[] }[] }>('workspace/diagnostic', { previousResultIds: [] }, Math.max(1000, deadline - Date.now()), signal);
        client.storeDiagnostics((r?.items ?? []).filter((i) => i.kind !== 'unchanged').map((i) => ({ uri: i.uri, items: i.items ?? [] })));
      } catch (e) {
        debug('lsp', 'workspace/diagnostic failed', e);
      }
    }
    await mapLimit(docs, 4, async ({ doc, changed }) => {
      if (wide && client.lastDiagnostics(doc.file)) return;
      // A file the server already had, unchanged: its pushed diagnostics are current.
      if (!changed && !client.pullsDiagnostics && client.lastDiagnostics(doc.file)) return;
      await client.diagnosticsFor(doc, changed ? since : -1, Math.max(0, deadline - Date.now()), signal).catch(() => null);
    });
    // Servers clear the diagnostics of closed files, so take them before closing.
    const diagnostics = client.allDiagnostics();
    for (const { doc } of docs) if (!wasOpen.has(pathKey(doc.file))) client.close(doc.file);
    return { checked: docs.length, diagnostics };
  }
}

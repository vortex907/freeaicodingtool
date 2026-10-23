// One language server process and the JSON-RPC connection to it: requests with ids, timeouts and
// cancellation, notifications, the requests servers send back, document sync, and the diagnostics
// the server pushes (or hands out when asked).
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { VERSION } from '../version.js';
import { isWindows } from '../util/platform.js';
import { killTree } from '../tools/bash.js';
import { trackChild } from '../tools/repl.js';
import { AbortError } from '../util/async.js';
import { debug } from '../util/log.js';
import { ErrorCodes, MessageReader, encodeMessage, fileUri, pathKey, uriKey, type Diagnostic, type Message, type ResponseError } from './protocol.js';

/** Files larger than this are not sent to a server (generated bundles, data). */
export const MAX_SYNC_BYTES = 2 * 1024 * 1024;
/** Documents kept open per server; the least recently used are closed beyond this. */
export const MAX_OPEN_DOCS = 40;
/** A server that skips unchanged diagnostics has nothing new once it was quiet this long. */
const SETTLE_MS = 1000;

export interface ServerLaunch {
  /** Program to start (a full path when it was found on PATH). */
  command: string;
  args: string[];
  /** Name shown to the user and the model, e.g. "typescript-language-server". */
  label: string;
  initializationOptions?: unknown;
}

export interface ClientOptions {
  /** Server definition id, e.g. "typescript". */
  serverId: string;
  root: string;
  launch: ServerLaunch;
  languageId: (file: string) => string;
  /** After diagnostics are pushed for a file, wait this long for more before using them. */
  quietMs?: number;
  /** The server does not push diagnostics again when they did not change. */
  dedupes?: boolean;
}

export interface Doc {
  uri: string;
  file: string;
  version: number;
  text: string;
  languageId: string;
  mtimeMs: number;
  size: number;
  lastUsed: number;
}

interface Published {
  uri: string;
  items: Diagnostic[];
  version?: number;
  seq: number;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

export class LspError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'LspError';
  }
}

/** The server process ended (crashed or failed to start) while a request was waiting. */
export class ServerExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerExitedError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/** How to start `command`: npm-installed servers on Windows are .cmd shims that only run through cmd.exe. */
export function spawnCommand(command: string, args: string[], windows = isWindows): { file: string; args: string[]; verbatim: boolean } {
  if (windows && /\.(cmd|bat)$/i.test(command)) {
    const line = [`"${command}"`, ...args.map(quoteForCmd)].join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: command, args, verbatim: false };
}

/** Quotes an argument for cmd.exe: spaces and shell characters need double quotes. */
export function quoteForCmd(arg: string): string {
  if (arg && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

const SYMBOL_KINDS = Array.from({ length: 26 }, (_, i) => i + 1);

/** What FreeCode understands. Everything is registered statically; edits are applied by FreeCode itself. */
export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
  workspace: {
    applyEdit: false,
    workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: 'abort' },
    configuration: true,
    workspaceFolders: true,
    symbol: { dynamicRegistration: false, symbolKind: { valueSet: SYMBOL_KINDS } },
    diagnostics: { refreshSupport: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
    publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] } },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: SYMBOL_KINDS } },
    rename: { dynamicRegistration: false, prepareSupport: true },
  },
  // rust-analyzer reports when it is done with background work.
  experimental: { serverStatusNotification: true },
};

export class LspClient {
  status: 'starting' | 'ready' | 'stopping' | 'exited' = 'starting';
  capabilities: Record<string, unknown> = {};
  serverName?: string;
  exitCode: number | null = null;
  /** Why the process ended when nobody asked it to. */
  error?: string;
  stderrTail = '';
  lastUsed = Date.now();
  /** Called once when the process is gone (crash, failed start or shutdown). */
  onExit?: (client: LspClient) => void;

  private child: ChildProcess | null = null;
  private reader = new MessageReader();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private docs = new Map<string, Doc>();
  private published = new Map<string, Published>();
  private seq = 0;
  private listeners = new Set<() => void>();
  private progress = new Set<string>();
  private quiescent = true;
  private lastMessageAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<void> | null = null;
  private exited: Promise<void>;
  private markExited!: () => void;

  constructor(readonly opts: ClientOptions) {
    this.exited = new Promise((r) => (this.markExited = r));
  }

  get label(): string {
    return this.opts.launch.label;
  }

  get root(): string {
    return this.opts.root;
  }

  /** Background work in progress (indexing, loading the project, a build). */
  get busy(): boolean {
    return this.progress.size > 0 || !this.quiescent;
  }

  /** Starts the process and runs the initialize handshake (once). */
  start(timeoutMs = 90_000): Promise<void> {
    this.started ??= this.doStart(timeoutMs);
    return this.started;
  }

  private async doStart(timeoutMs: number): Promise<void> {
    const { command, args, label } = this.opts.launch;
    const inv = spawnCommand(command, args);
    let child: ChildProcess;
    try {
      child = spawn(inv.file, inv.args, {
        cwd: this.opts.root,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows,
        windowsHide: true,
        windowsVerbatimArguments: inv.verbatim,
      });
    } catch (e) {
      this.gone(null, `could not be started: ${(e as Error).message}`);
      throw new ServerExitedError(this.describeExit());
    }
    this.child = child;
    child.stdout!.on('data', (b: Buffer) => this.onData(b));
    child.stderr!.on('data', (b: Buffer) => (this.stderrTail = (this.stderrTail + b.toString('utf8')).slice(-4000)));
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => this.gone(null, (e as NodeJS.ErrnoException).code === 'ENOENT' ? `was not found (${command})` : `could not be started: ${e.message}`));
    // Output written just before exiting may still be in the pipe.
    child.on('exit', (code, signal) => setTimeout(() => this.gone(code, signal ? `was stopped by ${signal}` : undefined), 30));
    trackChild(child);
    debug('lsp', `starting ${label} in ${this.opts.root}: ${command} ${args.join(' ')}`);
    const root = this.opts.root;
    type InitializeResult = { capabilities?: Record<string, unknown>; serverInfo?: { name?: string } } | null;
    let init: InitializeResult;
    try {
      init = await this.request<InitializeResult>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'FreeCode', version: VERSION },
          locale: 'en',
          rootPath: root,
          rootUri: fileUri(root),
          workspaceFolders: [{ uri: fileUri(root), name: path.basename(root) || root }],
          initializationOptions: this.opts.launch.initializationOptions,
          capabilities: CLIENT_CAPABILITIES,
          trace: 'off',
        },
        timeoutMs,
      );
    } catch (e) {
      // A server that refused or never answered initialize is of no use: stop it and keep the reason.
      if (this.status !== 'exited') {
        this.error = e instanceof RequestTimeoutError ? `did not finish starting within ${Math.round(timeoutMs / 1000)}s` : `failed to start: ${(e as Error).message.replace(`${label}: `, '')}`;
        this.kill();
      }
      throw e;
    }
    this.capabilities = init?.capabilities ?? {};
    this.serverName = init?.serverInfo?.name;
    this.notify('initialized', {});
    if (this.status !== 'starting') throw new ServerExitedError(this.describeExit());
    this.status = 'ready';
    debug('lsp', `${label} ready`);
  }

  // ------------------------------------------------------------------ messages

  private onData(chunk: Buffer): void {
    for (const msg of this.reader.push(chunk)) {
      this.lastMessageAt = Date.now();
      try {
        this.handle(msg);
      } catch (e) {
        debug('lsp', `${this.label}: error handling ${msg.method ?? `response ${msg.id}`}`, e);
      }
    }
  }

  private handle(msg: Message): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (msg.method && hasId) return this.answer(msg.id!, msg.method, msg.params);
    if (msg.method) return this.onNotification(msg.method, msg.params);
    if (!hasId) return;
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    p.cleanup();
    if (msg.error) p.reject(new LspError(`${this.label}: ${msg.error.message || `error ${msg.error.code}`}`, msg.error.code, msg.error.data));
    else p.resolve(msg.result ?? null);
  }

  /** Requests from the server. FreeCode has no editor UI, so most get a neutral answer. */
  private answer(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    let error: ResponseError | undefined;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'workspace/configuration':
        // null means "no settings": servers use their defaults.
        result = Array.isArray(p.items) ? p.items.map(() => null) : [];
        break;
      case 'workspace/workspaceFolders':
        result = [{ uri: fileUri(this.opts.root), name: path.basename(this.opts.root) || this.opts.root }];
        break;
      case 'client/registerCapability':
        for (const r of (p.registrations as { method?: string; registerOptions?: unknown }[] | undefined) ?? []) {
          if (r.method === 'textDocument/diagnostic') this.capabilities.diagnosticProvider = r.registerOptions ?? {};
        }
        break;
      case 'window/showDocument':
        result = { success: false };
        break;
      case 'workspace/applyEdit':
        result = { applied: false, failureReason: 'FreeCode applies edits itself' };
        break;
      case 'window/workDoneProgress/create':
      case 'client/unregisterCapability':
      case 'window/showMessageRequest':
        break;
      default:
        if (!/^workspace\/\w+\/refresh$/.test(method)) error = { code: ErrorCodes.MethodNotFound, message: `FreeCode does not support ${method}` };
    }
    this.write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'textDocument/publishDiagnostics') {
      if (typeof p.uri !== 'string' || !Array.isArray(p.diagnostics)) return;
      this.published.set(uriKey(p.uri), { uri: p.uri, items: p.diagnostics as Diagnostic[], version: typeof p.version === 'number' ? p.version : undefined, seq: ++this.seq });
    } else if (method === '$/progress') {
      const kind = (p.value as { kind?: string } | undefined)?.kind;
      const token = String(p.token);
      if (kind === 'begin') this.progress.add(token);
      else if (kind === 'end') this.progress.delete(token);
      else return;
    } else if (method === 'experimental/serverStatus') {
      this.quiescent = p.quiescent !== false;
    } else return;
    for (const l of [...this.listeners]) l();
  }

  private write(msg: Message): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable || this.status === 'exited') return false;
    try {
      stdin.write(encodeMessage(msg));
      return true;
    } catch {
      return false;
    }
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    if (this.status === 'exited') return Promise.reject(new ServerExitedError(this.describeExit()));
    if (signal?.aborted) return Promise.reject(new AbortError());
    this.lastUsed = Date.now();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        this.notify('$/cancelRequest', { id });
        reject(new AbortError());
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      timer = setTimeout(() => {
        cleanup();
        this.notify('$/cancelRequest', { id });
        reject(new RequestTimeoutError(`${this.label} did not answer ${method} within ${Math.round(timeoutMs / 100) / 10}s`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, cleanup });
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        cleanup();
        reject(new ServerExitedError(this.describeExit()));
      }
    });
  }

  // ------------------------------------------------------------------ lifecycle

  private gone(code: number | null, reason?: string): void {
    if (this.status === 'exited') return;
    const expected = this.status === 'stopping';
    this.status = 'exited';
    this.exitCode = code;
    if (!expected) this.error = reason ?? `exited with code ${code}`;
    debug('lsp', `${this.label} ${expected ? 'stopped' : this.error}`);
    const err = new ServerExitedError(this.describeExit());
    for (const p of [...this.pending.values()]) {
      p.cleanup();
      p.reject(err);
    }
    for (const l of [...this.listeners]) l();
    this.markExited();
    this.onExit?.(this);
  }

  /** "rust-analyzer exited with code 1:" and the telling lines of its error output. */
  describeExit(): string {
    const lines = this.stderrTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Error lines say more than the stack trace that usually follows them.
    const errors = lines.filter((l) => /\b(error|fatal|panic|not found|not installed|cannot|could not|failed|unknown|missing|no such)\b/i.test(l));
    const shown = (errors.length ? errors.slice(0, 4) : lines.slice(-4)).map((l) => (l.length > 240 ? `${l.slice(0, 240)}...` : l));
    return `${this.label} ${this.error ?? 'is not running'}${shown.length ? `:\n${shown.join('\n')}` : ''}`;
  }

  /** Polite shutdown (shutdown request, exit notification), then a kill if it lingers. */
  async shutdown(graceMs = 1500): Promise<void> {
    if (this.status === 'exited') return;
    if (this.status === 'ready') {
      this.status = 'stopping';
      await this.request('shutdown', null, graceMs).catch(() => undefined);
      this.notify('exit');
    } else this.status = 'stopping';
    try {
      this.child?.stdin?.end();
    } catch {
      // already closed
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
    if (timer) clearTimeout(timer);
    if (this.alive) this.kill();
  }

  private get alive(): boolean {
    return this.status !== 'exited';
  }

  kill(): void {
    if (this.child && this.status !== 'exited') killTree(this.child, 'SIGKILL');
    if (this.status !== 'exited') {
      this.status = 'stopping';
      this.gone(null);
    }
  }

  // ------------------------------------------------------------------ documents

  /** Runs document operations one at a time so versions stay in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  doc(file: string): Doc | undefined {
    return this.docs.get(pathKey(file));
  }

  openDocs(): Doc[] {
    return [...this.docs.values()];
  }

  /**
   * Sends the file's current content: didOpen the first time, didChange when it differs from what the
   * server has, then didSave when `save` is set. Returns the document (null when the file cannot be read).
   */
  sync(file: string, opts: { save?: boolean } = {}): Promise<{ doc: Doc; changed: boolean } | null> {
    return this.serial(() => this.doSync(file, opts.save ?? false));
  }

  private async doSync(file: string, save: boolean): Promise<{ doc: Doc; changed: boolean } | null> {
    const key = pathKey(file);
    let text: string;
    let st;
    try {
      st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_SYNC_BYTES) throw new Error('not syncable');
      text = await fsp.readFile(file, 'utf8');
    } catch {
      this.closeKey(key);
      return null;
    }
    this.lastUsed = Date.now();
    let doc = this.docs.get(key);
    let changed = false;
    if (!doc) {
      doc = { uri: fileUri(file), file, version: 1, text, languageId: this.opts.languageId(file), mtimeMs: st.mtimeMs, size: st.size, lastUsed: Date.now() };
      this.docs.set(key, doc);
      this.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text } });
      changed = true;
      this.trimDocs(key);
    } else if (doc.text !== text) {
      doc.version++;
      doc.text = text;
      // A full-content change is valid for both full and incremental sync.
      this.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text }] });
      changed = true;
    }
    doc.mtimeMs = st.mtimeMs;
    doc.size = st.size;
    doc.lastUsed = Date.now();
    if (save && changed && this.wantsSave()) {
      this.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(this.saveIncludesText() ? { text } : {}) });
    }
    return { doc, changed };
  }

  /** Re-sends open documents that changed on disk since they were synced (edited outside FreeCode). */
  async refreshOpenDocs(): Promise<void> {
    const stale: string[] = [];
    await Promise.all(
      [...this.docs.values()].map(async (d) => {
        try {
          const st = await fsp.stat(d.file);
          if (st.mtimeMs !== d.mtimeMs || st.size !== d.size) stale.push(d.file);
        } catch {
          stale.push(d.file);
        }
      }),
    );
    for (const f of stale) await this.sync(f, { save: true });
  }

  close(file: string): void {
    this.closeKey(pathKey(file));
  }

  private closeKey(key: string): void {
    const doc = this.docs.get(key);
    if (!doc) return;
    this.docs.delete(key);
    this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  private trimDocs(keep: string): void {
    if (this.docs.size <= MAX_OPEN_DOCS) return;
    const old = [...this.docs.entries()].filter(([k]) => k !== keep).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k] of old.slice(0, this.docs.size - MAX_OPEN_DOCS)) this.closeKey(k);
  }

  private syncOptions(): { save?: boolean | { includeText?: boolean } } {
    const s = this.capabilities.textDocumentSync;
    return s && typeof s === 'object' ? (s as { save?: boolean | { includeText?: boolean } }) : {};
  }

  private wantsSave(): boolean {
    return !!this.syncOptions().save;
  }

  private saveIncludesText(): boolean {
    const save = this.syncOptions().save;
    return typeof save === 'object' && !!save.includeText;
  }

  // ------------------------------------------------------------------ diagnostics

  /** Counter of diagnostics received; pass it to diagnosticsFor to only accept newer ones. */
  get diagnosticsSeq(): number {
    return this.seq;
  }

  /** The diagnostics the server last reported for a file (undefined when it never did). */
  lastDiagnostics(file: string): Diagnostic[] | undefined {
    return this.published.get(pathKey(file))?.items;
  }

  /** Every file the server reported diagnostics for. */
  allDiagnostics(): { uri: string; items: Diagnostic[] }[] {
    return [...this.published.values()].map((p) => ({ uri: p.uri, items: p.items }));
  }

  /** Keeps diagnostics the server returned for a whole-workspace request. */
  storeDiagnostics(list: { uri: string; items: Diagnostic[] }[]): void {
    for (const e of list) this.published.set(uriKey(e.uri), { uri: e.uri, items: e.items, seq: ++this.seq });
  }

  /** Files whose diagnostics arrived after `seq` (a diagnosticsSeq value). */
  diagnosticsSince(seq: number): { uri: string; items: Diagnostic[] }[] {
    return [...this.published.values()].filter((p) => p.seq > seq).map((p) => ({ uri: p.uri, items: p.items }));
  }

  get pullsDiagnostics(): boolean {
    return !!this.capabilities.diagnosticProvider;
  }

  /**
   * Diagnostics for the content of `doc` synced after `since` (diagnosticsSeq before the sync). Asks
   * for them when the server supports pull diagnostics; otherwise waits for the push and a quiet
   * moment after it. Null when the server had no answer in time.
   */
  async diagnosticsFor(doc: Doc, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | null> {
    const deadline = Date.now() + timeoutMs;
    if (this.pullsDiagnostics) {
      for (let attempt = 0; attempt < 4 && deadline - Date.now() > 50; attempt++) {
        try {
          const r = await this.request<{ kind?: string; items?: Diagnostic[] } | null>('textDocument/diagnostic', { textDocument: { uri: doc.uri } }, deadline - Date.now(), signal);
          const key = uriKey(doc.uri);
          const items = r?.kind === 'unchanged' ? this.published.get(key)?.items ?? [] : Array.isArray(r?.items) ? r!.items : [];
          this.published.set(key, { uri: doc.uri, items, version: doc.version, seq: ++this.seq });
          return items;
        } catch (e) {
          // The server cancelled because the content changed or it was not ready yet: ask again.
          const data = e instanceof LspError ? (e.data as { retriggerRequest?: boolean } | undefined) : undefined;
          const retry = e instanceof LspError && (e.code === ErrorCodes.ServerCancelled || e.code === ErrorCodes.ContentModified) && data?.retriggerRequest !== false;
          if (!retry) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (this.status === 'exited' || signal?.aborted) return null;
    }
    return this.waitForPush(doc, since, Math.max(0, deadline - Date.now()), signal);
  }

  private waitForPush(doc: Doc, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | null> {
    const key = uriKey(doc.uri);
    const quietMs = this.opts.quietMs ?? 300;
    const started = Date.now();
    // Without a version, any push for the file after the sync counts as fresh.
    const fresh = (p: Published) => p.seq > since && (p.version === undefined || p.version >= doc.version);
    return new Promise((resolve) => {
      let seen: Published | undefined;
      let quiet: NodeJS.Timeout | undefined;
      let settle: NodeJS.Timeout | undefined;
      let cap: NodeJS.Timeout | undefined;
      const finish = (v: Diagnostic[] | null) => {
        clearTimeout(quiet);
        clearTimeout(cap);
        clearInterval(settle);
        this.listeners.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const check = () => {
        if (this.status === 'exited') return finish(seen?.items ?? null);
        const p = this.published.get(key);
        if (!p || p === seen || !fresh(p)) return;
        seen = p;
        // Some servers push syntax errors first and type errors a moment later.
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(p.items), quietMs);
      };
      const onAbort = () => finish(seen?.items ?? null);
      cap = setTimeout(() => finish(seen?.items ?? null), timeoutMs);
      if (this.opts.dedupes) {
        // Unchanged diagnostics are not pushed again: once the server is idle, the last ones stand.
        settle = setInterval(() => {
          const now = Date.now();
          if (!seen && !this.busy && now - started >= SETTLE_MS && now - this.lastMessageAt >= SETTLE_MS) finish(this.published.get(key)?.items ?? []);
        }, 100);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.listeners.add(check);
      check();
    });
  }
}

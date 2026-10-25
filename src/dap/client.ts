// Debug Adapter Protocol client: starts an adapter and exchanges messages with it over stdio, or over
// TCP for adapters that only listen on a port (dlv dap prints the address it listens on), or connects
// to an adapter that is already listening. No dependencies.
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { encodeMessage, MessageReader, type Capabilities, type DapEvent, type DapMessage, type DapRequest, type DapResponse } from './protocol.js';
import { killTree } from '../tools/bash.js';
import { keepTail, trackChild } from '../tools/repl.js';
import { isWindows } from '../util/platform.js';
import { formatDuration } from '../util/strings.js';

export interface AdapterProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  transport: 'stdio' | 'tcp';
}

export class DapError extends Error {}

interface Pending {
  resolve: (body: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const START_TIMEOUT_MS = 20_000;
const LISTENING = /listening (?:at|on):?\s*\[?([\w.:-]+?)\]?:(\d+)/i;

/** cmd.exe runs .cmd and .bat shims (Node refuses to spawn them directly). */
function spawnArgs(command: string, args: string[]): { file: string; argv: string[]; verbatim: boolean } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(command)) return { file: command, argv: args, verbatim: false };
  const quote = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`], verbatim: true };
}

export class DapClient {
  capabilities: Capabilities = {};
  closed = false;
  /** Why the connection ended, for error messages. */
  closeReason = '';
  /** What the adapter printed outside the protocol (its stderr), for error reports. */
  log = '';
  /** Output of the adapter process that is not protocol traffic: stderr, and stdout too for TCP adapters. */
  onStdio: ((text: string) => void) | null = null;
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: DapEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly reader = new MessageReader();
  private readonly launched = new Set<ChildProcess>();
  private socket: net.Socket | null = null;

  /** Set while a TCP adapter has not printed its address yet. */
  private portScan: ((text: string) => void) | null = null;

  /** Null for an adapter that was already running (connect). */
  private constructor(private readonly child: ChildProcess | null) {}

  /** Connects to an adapter that is already listening: `python -m debugpy --listen`, `dlv --headless`. */
  static connect(host: string, port: number, signal?: AbortSignal, timeoutMs = START_TIMEOUT_MS): Promise<DapClient> {
    const client = new DapClient(null);
    const socket = net.connect(port, host);
    return new Promise<DapClient>((resolve, reject) => {
      const done = (e?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!e) return resolve(client);
        socket.destroy();
        client.markClosed(e.message);
        reject(e);
      };
      const timer = setTimeout(() => done(new DapError(`Could not connect to ${host}:${port} within ${formatDuration(timeoutMs)}.`)), timeoutMs);
      const onAbort = () => done(new DapError('Interrupted by the user.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('error', (e) => done(new DapError(`Could not connect to ${host}:${port} (${e.message}). Is the program listening there?`)));
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        client.useSocket(socket);
        socket.unref();
        done();
      });
    });
  }

  /** Starts the adapter and connects to it. */
  static async start(p: AdapterProcess, signal?: AbortSignal, timeoutMs = START_TIMEOUT_MS): Promise<DapClient> {
    const { file, argv, verbatim } = spawnArgs(p.command, p.args);
    const child = spawn(file, argv, { cwd: p.cwd, env: p.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true, windowsVerbatimArguments: verbatim });
    const client = new DapClient(child);
    trackChild(child);
    try {
      await client.connectTo(p, signal, timeoutMs);
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  private connectTo(p: AdapterProcess, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    const child = this.child!;
    const name = p.command.split(/[\\/]/).pop();
    child.stdin!.on('error', () => undefined);
    // The program of a TCP adapter (dlv) reads the adapter's stdin: give it end of file, not a pipe that never delivers.
    if (p.transport === 'tcp') child.stdin!.end();
    child.stderr!.on('data', (b: Buffer) => this.stdio(b.toString('utf8')));
    if (p.transport === 'stdio') child.stdout!.on('data', (b: Buffer) => this.receive(b));
    else child.stdout!.on('data', (b: Buffer) => this.stdio(b.toString('utf8')));
    child.on('exit', (code, sig) => {
      // Let the last messages in the pipe arrive first.
      setTimeout(() => this.markClosed(`The debug adapter exited${code != null ? ` with code ${code}` : sig ? ` (${sig})` : ''}.`), 30);
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (e?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.closeListeners.delete(onClose);
        this.portScan = null;
        if (e) reject(e);
        else resolve();
      };
      const timer = setTimeout(() => finish(new DapError(`${name} did not ${p.transport === 'tcp' ? 'report a port' : 'start'} within ${formatDuration(timeoutMs)}.${this.logTail()}`)), timeoutMs);
      const onAbort = () => finish(new DapError('Interrupted by the user.'));
      const onClose = () => finish(new DapError(`${this.closeReason}${this.logTail()}`));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.closeListeners.add(onClose);
      child.on('error', (e) => {
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        this.markClosed(missing ? `${p.command} was not found.` : `Could not start ${p.command}: ${e.message}`);
      });
      if (p.transport === 'stdio') {
        child.once('spawn', () => finish());
        return;
      }
      // The adapter prints the address it listens on; connect to it.
      let printed = '';
      this.portScan = (text) => {
        printed += text;
        const m = LISTENING.exec(printed);
        if (!m || this.socket) return;
        const socket = net.connect(Number(m[2]), m[1]!);
        this.useSocket(socket);
        socket.once('connect', () => {
          // Like the adapter process itself, the connection must not keep FreeCode running.
          socket.unref();
          finish();
        });
      };
    });
  }

  private useSocket(socket: net.Socket): void {
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.receive(d));
    socket.on('error', (e) => this.markClosed(`Lost the connection to the debug adapter: ${e.message}`));
    // When the adapter exits, its exit code makes the better message.
    socket.on('close', () => setTimeout(() => this.markClosed('The debug adapter closed the connection.'), this.child ? 60 : 0));
  }

  private stdio(text: string): void {
    this.log = keepTail(this.log + text, 8000);
    if (this.portScan) this.portScan(text);
    else this.onStdio?.(text);
  }

  private logTail(): string {
    const t = [this.log, this.reader.junk].join('\n').trim();
    return t ? `\n${t.split('\n').slice(-15).join('\n')}` : '';
  }

  /** Adapter output for an error report (last lines). */
  get diagnostics(): string {
    return this.logTail().trim();
  }

  private receive(chunk: Buffer): void {
    for (const msg of this.reader.push(chunk)) this.dispatch(msg);
  }

  private dispatch(msg: DapMessage): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new DapError(errorText(msg)));
      return;
    }
    if (msg.type === 'event') {
      if (msg.event === 'capabilities') Object.assign(this.capabilities, (msg.body as { capabilities?: Capabilities })?.capabilities);
      this.emit(msg);
      return;
    }
    if (msg.type === 'request') void this.answer(msg);
  }

  private emit(e: DapEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a listener bug must not break the connection
      }
    }
  }

  /** Requests from the adapter. FreeCode has no terminal: runInTerminal starts the program with its output captured. */
  private async answer(req: DapRequest): Promise<void> {
    if (req.command === 'runInTerminal') {
      try {
        const processId = await this.runWithoutTerminal(req.arguments as { cwd?: string; args?: string[]; env?: Record<string, string | null> });
        this.send({ seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success: true, body: { processId } });
      } catch (e) {
        this.send({ seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success: false, message: `FreeCode has no terminal and could not start the program itself: ${(e as Error).message}` });
      }
      return;
    }
    this.send({ seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success: false, message: `FreeCode does not support the ${req.command} request.` });
  }

  private runWithoutTerminal(a: { cwd?: string; args?: string[]; env?: Record<string, string | null> }): Promise<number> {
    const [command, ...args] = a?.args ?? [];
    if (!command) return Promise.reject(new Error('no command given'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(a.env ?? {})) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    const { file, argv, verbatim } = spawnArgs(command, args);
    const child = spawn(file, argv, { cwd: a.cwd || undefined, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true, windowsVerbatimArguments: verbatim });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        this.launched.add(child);
        trackChild(child);
        child.once('exit', () => this.launched.delete(child));
        // The program's output reaches the session like output the adapter reports.
        const forward = (category: string) => (b: Buffer) => this.emit({ seq: 0, type: 'event', event: 'output', body: { category, output: b.toString('utf8') } });
        child.stdout!.on('data', forward('stdout'));
        child.stderr!.on('data', forward('stderr'));
        resolve(child.pid!);
      });
    });
  }

  private send(msg: DapMessage): void {
    const data = encodeMessage(msg);
    if (this.socket) this.socket.write(data);
    else this.child?.stdin!.write(data);
  }

  /** Sends a request and resolves with the response body (rejects with the adapter's error message). */
  request<T = Record<string, unknown>>(command: string, args: unknown = {}, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new DapError(this.closeReason || 'The debug adapter is not running.'));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(`The debug adapter did not answer ${command} within ${formatDuration(timeoutMs)}.`));
      }, timeoutMs);
      this.pending.set(seq, { resolve: resolve as (body: unknown) => void, reject, timer });
      this.send({ seq, type: 'request', command, arguments: args });
    });
  }

  /** Subscribes to events; returns the unsubscribe function. */
  on(listener: (e: DapEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Resolves with the body of the next `event` (rejects on timeout or when the adapter goes away). */
  waitForEvent<T = unknown>(event: string, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new DapError(this.closeReason || 'The debug adapter is not running.'));
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        off();
        offClose();
      };
      const timer = setTimeout(() => {
        done();
        reject(new DapError(`The debug adapter did not send ${event} within ${formatDuration(timeoutMs)}.`));
      }, timeoutMs);
      const off = this.on((e) => {
        if (e.event !== event) return;
        done();
        resolve(e.body as T);
      });
      const offClose = this.onClose(() => {
        done();
        reject(new DapError(this.closeReason));
      });
    });
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DapError(reason));
    }
    this.pending.clear();
    for (const l of [...this.closeListeners]) l();
  }

  /** Stops the adapter (one FreeCode started) and anything it had FreeCode start. */
  close(): void {
    this.markClosed('The debug session was closed.');
    this.socket?.destroy();
    if (this.child) killTree(this.child, 'SIGKILL');
    for (const c of this.launched) killTree(c, 'SIGKILL');
    this.launched.clear();
  }
}

/** The adapter's error message; some (dlv) put the details in body.error.format. */
function errorText(r: DapResponse): string {
  const err = (r.body as { error?: { format?: string; variables?: Record<string, string> } } | undefined)?.error;
  const formatted = err?.format?.replace(/\{(\w+)\}/g, (all, key: string) => err.variables?.[key] ?? all);
  return (formatted || r.message || `${r.command} failed`).trim();
}

// A Debug Adapter Protocol session for the Debugger tool: launch with breakpoints, stepping and
// inspection, each answered with a compact text report (location, source around it, top frames).
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { DapClient, DapError } from './client.js';
import type { AdapterSpec, LaunchTarget } from './adapters.js';
import type {
  Breakpoint,
  Capabilities,
  DapEvent,
  EvaluateResponseBody,
  ExceptionInfoResponseBody,
  OutputEventBody,
  Scope,
  Source,
  StackFrame,
  StoppedEventBody,
  Thread,
  Variable,
} from './protocol.js';
import { cleanOutput } from '../tools/bash.js';
import { keepTail } from '../tools/repl.js';
import { sleep } from '../util/async.js';
import { formatDuration, truncate, truncateMiddle } from '../util/strings.js';

export type ResumeKind = 'continue' | 'next' | 'stepIn' | 'stepOut';

/** How a call waits for the program to stop. */
export interface Waiting {
  timeoutMs: number;
  signal: AbortSignal;
  progress: (text: string) => void;
}

/** A line breakpoint (file and line) or a function breakpoint (name). */
export interface BreakpointSpec {
  file?: string;
  line?: number;
  name?: string;
  condition?: string;
}

export interface Report {
  text: string;
  isError?: boolean;
}

const IDLE_MS = 15 * 60_000;
const REQUEST_MS = 15_000;
// dlv compiles the program while it handles launch.
const LAUNCH_MS = 180_000;
// An attached program runs on: report it soon, so breakpoints can be set while it runs.
const ATTACH_WAIT_MS = 1000;
const ATTACHED_RUNNING = 'The program is running. Set breakpoints with break, then use continue to wait for one to hit, or pause to break in.';
const STOP_FRAMES = 5;
const STACK_FRAMES = 30;
const CONTEXT_LINES = 2;
const TOP_VARIABLES = 60;
const CHILD_VARIABLES = 12;
const MAX_EXPANSIONS = 40;
// debugpy files some members under these pseudo variables.
const GROUPS = /^(special|function|class|protected) variables$/;

type WaitResult = 'stopped' | 'ended' | 'running' | 'aborted';

interface Entry {
  id?: number;
  /** The entry function has a location with source (Rust also has a generated main without). */
  hasSource: boolean;
  skips: number;
  done: boolean;
}

const valueText = (v: string) => truncate(v.replace(/\r?\n/g, '\\n'), 200);
const typeText = (t: string | undefined) => (t && t !== '<no-type>' ? ` (${truncate(t, 60)})` : '');

export class DapSession {
  /** The program ended or the session was closed. */
  ended = false;
  /** Attached to a process that was already running: it is left running when the session ends. */
  attached = false;
  private running = false;
  private stopSeq = 0;
  private lastStop: StoppedEventBody | null = null;
  private stoppedByPause = false;
  private pauseRequested = false;
  private entryStopSeq = -1;
  private entry: Entry | null = null;
  private threadId: number | null = null;
  /** Frames of threadId at the current stop. */
  private frames: StackFrame[] | null = null;
  private totalFrames: number | undefined;
  private output = '';
  /** Output before configurationDone is adapter chatter (shown only when the launch fails). */
  private configured = false;
  private launchOutput = '';
  private readonly notes: string[] = [];
  private exitCode: number | null = null;
  private crash = '';
  /** The program is over and the adapter is being disconnected. */
  private ending = false;
  /** Disconnected: later events (lldb-dap 18 crashes on exit) are ignored. */
  private closed = false;
  private disposed = false;
  private idleClosed = false;
  private readonly lineBreakpoints = new Map<string, BreakpointSpec[]>();
  private functionBreakpoints: BreakpointSpec[] = [];
  private readonly waiters = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly sources = new Map<string, { mtime: number; lines: string[] }>();

  private constructor(
    readonly spec: AdapterSpec,
    private readonly client: DapClient,
    private readonly baseDir: string,
  ) {
    client.on((e) => this.onEvent(e));
    client.onClose(() => this.onAdapterGone());
    // TCP adapters (dlv) pass the program's own stdout and stderr through theirs.
    if (spec.transport === 'tcp') client.onStdio = (text) => this.addOutput(text);
  }

  /** Starts the adapter, launches the program (or attaches to it) and waits for the first stop. */
  static async start(o: { spec: AdapterSpec; target: LaunchTarget; breakpoints: BreakpointSpec[]; env: NodeJS.ProcessEnv; baseDir: string; wait: Waiting }): Promise<{ session: DapSession | null; report: Report }> {
    const { spec, target, wait } = o;
    const attach = target.attach;
    let client: DapClient;
    try {
      // On a port the program already runs its own adapter (debugpy --listen, dlv --headless).
      client =
        attach?.port !== undefined
          ? await DapClient.connect(attach.host || '127.0.0.1', attach.port, wait.signal)
          : await DapClient.start({ command: spec.command, args: spec.args, cwd: target.cwd, env: { ...o.env, ...spec.env }, transport: spec.transport }, wait.signal);
    } catch (e) {
      return { session: null, report: { text: attach?.port !== undefined ? (e as Error).message : `Could not start ${spec.name}: ${(e as Error).message}`, isError: true } };
    }
    const s = new DapSession(spec, client, o.baseDir);
    s.attached = !!attach;
    for (const bp of o.breakpoints) s.remember(bp);
    const header = attach
      ? `Attached ${spec.name} to ${attach.port !== undefined ? `${attach.host || '127.0.0.1'}:${attach.port}` : `process ${attach.pid}`}.`
      : `Started ${s.shownPath({ path: target.program })} with ${spec.name}.`;
    try {
      const mark = await s.launch(target, wait.signal);
      const report = attach ? await s.settle(mark, { ...wait, timeoutMs: Math.min(wait.timeoutMs, ATTACH_WAIT_MS) }, ATTACHED_RUNNING) : await s.settle(mark, wait);
      const missed = s.ended && !attach && o.breakpoints.length ? 'No breakpoint was hit.' : '';
      s.armIdle();
      return { session: s.ended ? null : s, report: { ...report, text: [header, ...s.notes, report.text, missed].filter(Boolean).join('\n') } };
    } catch (e) {
      const text = s.failure(e as Error);
      await s.dispose();
      return { session: null, report: { text, isError: true } };
    }
  }

  // ------------------------------------------------------------------ events

  private onEvent(e: DapEvent): void {
    if (this.closed) return;
    switch (e.event) {
      case 'output':
        this.onOutput(e.body as OutputEventBody | undefined);
        break;
      case 'stopped': {
        const body = (e.body ?? { reason: 'unknown' }) as StoppedEventBody;
        this.lastStop = body;
        if (body.threadId != null) this.threadId = body.threadId;
        this.stoppedByPause = this.pauseRequested;
        this.pauseRequested = false;
        this.frames = null;
        this.running = false;
        this.stopSeq++;
        break;
      }
      case 'continued':
        this.running = true;
        this.frames = null;
        break;
      case 'exited':
        this.exitCode = (e.body as { exitCode?: number } | undefined)?.exitCode ?? this.exitCode;
        break;
      case 'terminated':
        void this.programEnded();
        break;
    }
    this.notify();
  }

  private onOutput(b: OutputEventBody | undefined): void {
    if (!b || typeof b.output !== 'string') return;
    const category = b.category ?? 'console';
    if (category === 'telemetry') return;
    let text = b.output;
    if (category === 'console' || category === 'important') {
      const status = this.spec.exitStatus?.exec(text);
      if (status) this.exitCode = Number(status[1]);
      const noise = this.spec.noise;
      if (noise) text = text.split(/(?<=\n)/).filter((l) => !noise.test(l.trim())).join('');
    }
    this.addOutput(text);
  }

  private addOutput(text: string): void {
    if (!text || this.closed) return;
    if (this.configured) this.output = keepTail(this.output + text);
    else this.launchOutput = keepTail(this.launchOutput + text, 20_000);
    this.notify();
  }

  private notify(): void {
    for (const fn of [...this.waiters]) fn();
  }

  /** The program ended: disconnect (dlv reports the exit code only then) and close the adapter. */
  private async programEnded(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    await this.client.request('disconnect', { terminateDebuggee: !this.attached }, 3000).catch(() => undefined);
    this.finish();
  }

  private onAdapterGone(): void {
    if (this.closed) return;
    if (!this.ending && !this.disposed) {
      const diag = this.client.diagnostics;
      this.crash = `${this.client.closeReason}${diag ? `\n${truncateMiddle(diag, 2000)}` : ''}`;
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    this.running = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.client.close();
    this.notify();
  }

  /** Ends the session: the program is terminated (or detached from, when attached) and the adapter stopped. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.closed && !this.ending) {
      this.ending = true;
      await this.client.request('disconnect', { terminateDebuggee: !this.attached, restart: false }, 2000).catch(() => undefined);
    }
    this.finish();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.ended) return;
    this.idleTimer = setTimeout(() => {
      this.idleClosed = true;
      void this.dispose();
    }, IDLE_MS);
    this.idleTimer.unref();
  }

  /** Calls run one at a time; a session left alone for a long time closes itself. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      try {
        return await fn();
      } finally {
        this.armIdle();
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  // ------------------------------------------------------------------ launch

  private failure(e: Error): string {
    const parts = [`${this.spec.name} could not ${this.attached ? 'attach' : 'run the program'}: ${e.message}`];
    const out = cleanOutput(this.launchOutput + this.output).trim();
    if (out) parts.push(truncateMiddle(out, 4000, 0.3));
    const diag = this.client.diagnostics;
    if (diag) parts.push(`Adapter log:\n${truncateMiddle(diag, 2000, 0.3)}`);
    return parts.join('\n');
  }

  private abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new DapError('Interrupted by the user.'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DapError('Interrupted by the user.'));
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** initialize, launch or attach, the configuration requests and configurationDone. Returns the stop count to wait after. */
  private async launch(t: LaunchTarget, signal: AbortSignal): Promise<number> {
    const attachArgs = t.attach && this.spec.attachArgs?.(t.attach);
    if (t.attach && !attachArgs) throw new DapError(`${this.spec.name} cannot attach to a process.`);
    const initialized = this.client.waitForEvent('initialized', LAUNCH_MS);
    initialized.catch(() => undefined);
    const caps = await this.abortable(
      this.client.request<Capabilities>(
        'initialize',
        {
          clientID: 'freecode',
          clientName: 'FreeCode',
          adapterID: this.spec.adapterID,
          locale: 'en',
          pathFormat: 'path',
          linesStartAt1: true,
          columnsStartAt1: true,
          supportsVariableType: true,
          supportsVariablePaging: true,
          // FreeCode has no terminal; a runInTerminal request is still answered by starting the program itself.
          supportsRunInTerminalRequest: false,
        },
        30_000,
      ),
      signal,
    );
    Object.assign(this.client.capabilities, caps);
    const useEntry = !attachArgs && t.stopOnEntry && !!this.spec.entryFunction && caps.supportsFunctionBreakpoints !== false;
    const launched = attachArgs
      ? this.client.request('attach', attachArgs, LAUNCH_MS)
      : this.client.request('launch', this.spec.launchArgs({ ...t, stopOnEntry: t.stopOnEntry && !useEntry }), LAUNCH_MS);
    launched.catch(() => undefined);
    // Most adapters send initialized after launch; debugpy answers launch (and attach) only after configurationDone.
    await this.abortable(Promise.race([initialized, launched.then(() => initialized)]), signal);
    if (!caps.supportsConditionalBreakpoints && [...this.lineBreakpoints.values()].flat().some((b) => b.condition)) this.notes.push(`${this.spec.name} ignores breakpoint conditions.`);
    for (const [file, list] of this.lineBreakpoints) {
      const res = await this.sendLineBreakpoints(file);
      list.forEach((bp, i) => this.noteBreakpoint(bp, res[i]));
    }
    if (useEntry) this.entry = { hasSource: false, skips: 0, done: false };
    if (this.functionBreakpoints.length || useEntry) {
      const res = await this.sendFunctionBreakpoints();
      this.functionBreakpoints.forEach((bp, i) => this.noteBreakpoint(bp, res[i]));
      const entryBp = useEntry ? res[this.functionBreakpoints.length] : undefined;
      if (this.entry) Object.assign(this.entry, { id: entryBp?.id, hasSource: !!(entryBp?.source?.path || entryBp?.line) });
    }
    const filters = caps.exceptionBreakpointFilters;
    if (filters?.length) {
      // The filters an IDE enables by default: uncaught exceptions and panics, not every throw.
      await this.client.request('setExceptionBreakpoints', { filters: filters.filter((f) => f.default).map((f) => f.filter) }, REQUEST_MS).catch(() => undefined);
    }
    const mark = this.stopSeq;
    this.running = true;
    this.configured = true;
    if (caps.supportsConfigurationDoneRequest) await this.abortable(this.client.request('configurationDone', {}, REQUEST_MS), signal);
    await this.abortable(launched, signal);
    return mark;
  }

  private noteBreakpoint(spec: BreakpointSpec, bp: Breakpoint | undefined): void {
    // Verified breakpoints need no word at start; the rest might never hit.
    if (bp && bp.verified && !(spec.line && bp.line && bp.line !== spec.line)) return;
    this.notes.push(this.breakpointText(spec, bp));
  }

  /** After the entry function breakpoint stopped in code without source, run on to the next location. */
  private async passEntry(): Promise<number | null> {
    const entry = this.entry;
    if (!entry || entry.done) return null;
    const hit = entry.id !== undefined && !!this.lastStop?.hitBreakpointIds?.includes(entry.id);
    if (hit) {
      const top = (await this.loadFrames(await this.currentThread()))[0];
      if (top && !top.source?.path && entry.hasSource && entry.skips++ < 3) {
        const mark = this.stopSeq;
        this.running = true;
        await this.client.request('continue', { threadId: this.threadId }, REQUEST_MS);
        return mark;
      }
      this.entryStopSeq = this.stopSeq;
    }
    entry.done = true;
    await this.sendFunctionBreakpoints().catch(() => undefined);
    return null;
  }

  // ------------------------------------------------------------------ waiting

  private waitForStop(mark: number, w: Waiting): Promise<WaitResult> {
    return new Promise((resolve) => {
      let shown = 0;
      const finish = (r: WaitResult) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        w.signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const check = () => {
        if (this.ended) return finish('ended');
        if (this.stopSeq > mark) return finish('stopped');
        if (Date.now() - shown > 150) {
          const tail = cleanOutput(this.output).split('\n').filter((l) => l.trim());
          if (tail.length) {
            shown = Date.now();
            w.progress(tail.slice(-3).join('\n'));
          }
        }
      };
      const timer = setTimeout(() => finish(this.ended ? 'ended' : 'running'), w.timeoutMs);
      const onAbort = () => finish('aborted');
      if (w.signal.aborted) return finish('aborted');
      w.signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(check);
      check();
    });
  }

  /** Waits for the program to stop or end after `mark` and reports what happened. */
  private async settle(mark: number, w: Waiting, runningText?: string): Promise<Report> {
    let state = await this.waitForStop(mark, w);
    while (state === 'stopped') {
      const again = await this.passEntry();
      if (again === null) break;
      state = await this.waitForStop(again, w);
    }
    const stop = state === 'stopped' ? await this.describeStop() : '';
    const parts = [this.takeOutput()];
    let isError = false;
    if (state === 'stopped') parts.push(stop);
    else if (state === 'ended') {
      parts.push(this.endText());
      isError = !!this.crash || (this.exitCode !== null && this.exitCode !== 0);
    } else if (state === 'running') {
      parts.push(runningText ?? `[The program is still running after ${formatDuration(w.timeoutMs)}. Use action "pause" to break in, or "send" with no command to keep waiting (with a larger timeout if needed).]`);
    } else parts.push('[Stopped waiting because the user interrupted. The debug session is still open.]');
    return { text: parts.filter(Boolean).join('\n'), isError };
  }

  /** Program output not reported yet, under a heading ('' when there is none). */
  takeOutput(): string {
    const clean = cleanOutput(this.output);
    const out = (this.spec.filterOutput ? this.spec.filterOutput(clean) : clean).replace(/\s+$/, '');
    this.output = '';
    return out ? `Program output:\n${out}` : '';
  }

  private endText(): string {
    if (this.crash) return `The debug adapter stopped unexpectedly: ${this.crash}`;
    if (this.idleClosed) return `The debug session was closed after ${formatDuration(IDLE_MS)} without use. Start it again.`;
    return `${this.exitCode !== null ? `The program exited with code ${this.exitCode}.` : 'The program ended.'} The debug session is over.`;
  }

  /** What a call on a session that already ended gets: the last output and how it ended. */
  finalReport(): Report {
    return { text: [this.takeOutput(), this.endText()].filter(Boolean).join('\n'), isError: !!this.crash || (this.exitCode !== null && this.exitCode !== 0) };
  }

  // ------------------------------------------------------------------ describing a stop

  private async currentThread(): Promise<number> {
    if (this.threadId != null) return this.threadId;
    const { threads } = await this.client.request<{ threads?: Thread[] }>('threads', {}, REQUEST_MS);
    if (!threads?.length) throw new DapError('The program has no threads.');
    return (this.threadId = threads[0]!.id);
  }

  private async loadFrames(threadId: number, levels = 20): Promise<StackFrame[]> {
    if (threadId === this.threadId && this.frames && (this.frames.length >= levels || this.frames.length === this.totalFrames)) return this.frames;
    const r = await this.client.request<{ stackFrames?: StackFrame[]; totalFrames?: number }>('stackTrace', { threadId, startFrame: 0, levels }, REQUEST_MS);
    const frames = r.stackFrames ?? [];
    if (threadId === this.threadId) {
      this.frames = frames;
      this.totalFrames = r.totalFrames ?? (frames.length < levels ? frames.length : undefined);
    }
    return frames;
  }

  private ensureAlive(): void {
    if (this.ended) throw new DapError('The debug session has ended. Start it again.');
  }

  private ensurePaused(): void {
    this.ensureAlive();
    if (this.running) throw new DapError('The program is running. Use action "pause" to break in, or "send" with no command to wait for it to stop.');
  }

  private async frameAt(index: number, thread?: number): Promise<StackFrame> {
    this.ensurePaused();
    const threadId = thread ?? (await this.currentThread());
    const frames = await this.loadFrames(threadId, Math.max(20, index + 1));
    const f = frames[index];
    if (!f) throw new DapError(`There is no frame ${index}: the stack has ${frames.length} frame${frames.length === 1 ? '' : 's'}.`);
    return f;
  }

  /** A path as the user knows it: relative to the project when inside it. */
  private shownPath(src: Source | undefined): string {
    const p = src?.path;
    if (!p) return src?.name ?? '?';
    if (!path.isAbsolute(p)) return p;
    const rel = path.relative(this.baseDir, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
  }

  private location(f: StackFrame): string | null {
    return f.source && (f.source.path || f.source.name) && f.line > 0 ? `${this.shownPath(f.source)}:${f.line}` : null;
  }

  private frameText(f: StackFrame): string {
    const loc = this.location(f);
    // Rust and C++ frame names can be whole generic signatures.
    const name = truncate(f.name, 100);
    return loc ? `${name} at ${loc}` : `${name} (no source)`;
  }

  private frameLines(frames: StackFrame[], max: number, total: number | undefined): string[] {
    const lines = frames.slice(0, max).map((f, i) => `  #${i} ${this.frameText(f)}`);
    const more = (total ?? frames.length) - Math.min(max, frames.length);
    if (more > 0) lines.push(`  ... ${more} more frame${more === 1 ? '' : 's'}`);
    return lines;
  }

  private sourceLines(f: StackFrame): string[] | null {
    const p = f.source?.path;
    if (!p || !path.isAbsolute(p) || !(f.line > 0)) return null;
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > 5_000_000) return null;
      let cached = this.sources.get(p);
      if (!cached || cached.mtime !== st.mtimeMs) {
        cached = { mtime: st.mtimeMs, lines: readFileSync(p, 'utf8').split(/\r?\n/) };
        this.sources.set(p, cached);
      }
      return f.line <= cached.lines.length ? cached.lines : null;
    } catch {
      return null;
    }
  }

  private excerpt(f: StackFrame, lines: string[]): string {
    const from = Math.max(1, f.line - CONTEXT_LINES);
    const to = Math.min(lines.length, f.line + CONTEXT_LINES);
    const width = String(to).length;
    const out: string[] = [];
    for (let n = from; n <= to; n++) out.push(`${n === f.line ? '>' : ' '} ${String(n).padStart(width)}  ${truncate((lines[n - 1] ?? '').replace(/\s+$/, ''), 200)}`);
    return out.join('\n');
  }

  private async exceptionText(stop: StoppedEventBody, threadId: number): Promise<string> {
    const description = stop.description ?? '';
    // lldb reports signals: "signal SIGSEGV: address not mapped to object (fault address: 0x0)".
    if (/^signal /i.test(description)) return description;
    let id = stop.text ?? '';
    let message = description;
    if (this.client.capabilities.supportsExceptionInfoRequest) {
      const info = await this.client.request<ExceptionInfoResponseBody>('exceptionInfo', { threadId }, REQUEST_MS).catch(() => null);
      if (info) {
        id = info.exceptionId || id;
        message = info.description || info.details?.message || message;
      }
    }
    const detail = [...new Set([id, message].filter((s) => s && s !== 'exception'))].join(': ');
    return detail ? `exception (${detail})` : 'exception';
  }

  private async describeStop(): Promise<string> {
    const stop = this.lastStop ?? { reason: 'unknown' };
    const threadId = await this.currentThread();
    const frames = await this.loadFrames(threadId);
    const top = frames[0];
    const at = top ? (this.location(top) ? `${this.location(top)} in ${top.name}` : `${top.name} (no source)`) : 'an unknown location';
    let title: string;
    if (this.stopSeq === this.entryStopSeq || stop.reason === 'entry') title = `Paused on entry at ${at}`;
    else if (this.stoppedByPause || stop.reason === 'pause') title = `Paused at ${at}`;
    else if (/breakpoint/.test(stop.reason)) title = `Hit breakpoint at ${at}`;
    else if (stop.reason === 'step') title = `Stepped to ${at}`;
    else if (stop.reason === 'exception') title = `Stopped on ${await this.exceptionText(stop, threadId)} at ${at}`;
    else if (stop.reason === 'goto') title = `Moved to ${at}`;
    else title = `Stopped (${stop.reason}) at ${at}`;
    const lines = [title];
    // After a pause or a crash in a library the innermost frames often have no source to show.
    const near = frames.slice(0, 8).findIndex((f) => this.sourceLines(f) !== null);
    if (near > 0) lines.push(`Nearest frame with source: #${near} ${this.frameText(frames[near]!)}`);
    if (near >= 0) lines.push(this.excerpt(frames[near]!, this.sourceLines(frames[near]!)!));
    if (frames.length) lines.push('Stack:', ...this.frameLines(frames, STOP_FRAMES, this.totalFrames));
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ breakpoints

  private remember(bp: BreakpointSpec): void {
    if (bp.name) {
      this.functionBreakpoints = [...this.functionBreakpoints.filter((b) => b.name !== bp.name), bp];
      return;
    }
    const list = (this.lineBreakpoints.get(bp.file!) ?? []).filter((b) => b.line !== bp.line);
    list.push(bp);
    this.lineBreakpoints.set(bp.file!, list);
  }

  private async sendLineBreakpoints(file: string): Promise<Breakpoint[]> {
    const list = this.lineBreakpoints.get(file) ?? [];
    const r = await this.client.request<{ breakpoints?: Breakpoint[] }>(
      'setBreakpoints',
      { source: { path: file, name: path.basename(file) }, breakpoints: list.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })) },
      REQUEST_MS,
    );
    return r.breakpoints ?? [];
  }

  /** Sends the function breakpoints (plus the entry function while the program has not reached it). */
  private async sendFunctionBreakpoints(): Promise<Breakpoint[]> {
    const list = this.functionBreakpoints.map((b) => ({ name: b.name, ...(b.condition ? { condition: b.condition } : {}) }));
    if (this.entry && !this.entry.done) list.push({ name: this.spec.entryFunction! });
    const r = await this.client.request<{ breakpoints?: Breakpoint[] }>('setFunctionBreakpoints', { breakpoints: list }, REQUEST_MS);
    return r.breakpoints ?? [];
  }

  private breakpointText(spec: BreakpointSpec, bp: Breakpoint | undefined): string {
    const where = spec.name ?? `${this.shownPath({ path: spec.file })}:${spec.line}`;
    const cond = spec.condition ? ` when ${spec.condition}` : '';
    if (!bp) return `Breakpoint at ${where}${cond} was sent, but ${this.spec.name} did not confirm it.`;
    if (!bp.verified) return `Breakpoint at ${where}${cond} is not active yet${bp.message?.trim() ? ` (${bp.message.trim().replace(/\.$/, '')})` : ''}. It may bind once that code is loaded.`;
    if (spec.name) return `Breakpoint set on ${where}${cond}${bp.source?.path && bp.line ? ` (${this.shownPath(bp.source)}:${bp.line})` : ''}.`;
    const moved = spec.line && bp.line && bp.line !== spec.line ? ` (moved to line ${bp.line}, the nearest line with code)` : '';
    return `Breakpoint set at ${where}${cond}${moved}.`;
  }

  setBreakpoint(bp: BreakpointSpec): Promise<string> {
    return this.enqueue(async () => {
      this.ensureAlive();
      if (bp.name && this.client.capabilities.supportsFunctionBreakpoints === false) throw new DapError(`${this.spec.name} cannot break on function names. Use file:line.`);
      this.remember(bp);
      if (bp.name) {
        const res = await this.sendFunctionBreakpoints();
        return this.breakpointText(bp, res[this.functionBreakpoints.findIndex((b) => b.name === bp.name)]);
      }
      const res = await this.sendLineBreakpoints(bp.file!);
      return this.breakpointText(bp, res[(this.lineBreakpoints.get(bp.file!) ?? []).findIndex((b) => b.line === bp.line)]);
    });
  }

  /** Removes one breakpoint, all in a file (no line), or all (null). */
  clearBreakpoints(bp: BreakpointSpec | null): Promise<string> {
    return this.enqueue(async () => {
      this.ensureAlive();
      let removed = 0;
      if (!bp || bp.name) {
        const keep = bp ? this.functionBreakpoints.filter((b) => b.name !== bp.name) : [];
        removed += this.functionBreakpoints.length - keep.length;
        if (keep.length !== this.functionBreakpoints.length) {
          this.functionBreakpoints = keep;
          await this.sendFunctionBreakpoints();
        }
      }
      for (const [file, list] of [...this.lineBreakpoints]) {
        if (bp && (bp.name || file !== bp.file)) continue;
        const keep = bp?.line ? list.filter((b) => b.line !== bp.line) : [];
        if (keep.length === list.length) continue;
        removed += list.length - keep.length;
        this.lineBreakpoints.set(file, keep);
        await this.sendLineBreakpoints(file);
        if (!keep.length) this.lineBreakpoints.delete(file);
      }
      const where = bp ? (bp.name ?? `${this.shownPath({ path: bp.file })}${bp.line ? `:${bp.line}` : ''}`) : '';
      if (!removed) return bp ? `There is no breakpoint at ${where}.` : 'There are no breakpoints.';
      return `Removed ${removed} breakpoint${removed === 1 ? '' : 's'}${where ? ` at ${where}` : ''}.`;
    });
  }

  // ------------------------------------------------------------------ running

  /** continue, next, stepIn or stepOut, then waits for the next stop. */
  resume(kind: ResumeKind, w: Waiting, thread?: number): Promise<Report> {
    return this.enqueue(async () => {
      this.ensureAlive();
      if (this.running) {
        if (kind === 'continue') return this.settle(this.stopSeq, w);
        throw new DapError('The program is running. Use action "pause" to break in first.');
      }
      if (thread !== undefined && thread !== this.threadId) {
        this.threadId = thread;
        this.frames = null;
      }
      const threadId = await this.currentThread();
      const mark = this.stopSeq;
      this.running = true;
      try {
        await this.client.request(kind, { threadId }, REQUEST_MS);
      } catch (e) {
        if (this.stopSeq === mark) this.running = false;
        throw e;
      }
      return this.settle(mark, w);
    });
  }

  pause(w: Waiting): Promise<Report> {
    return this.enqueue(async () => {
      this.ensureAlive();
      if (!this.running) return { text: `The program is already paused.\n${await this.describeStop()}` };
      const mark = this.stopSeq;
      this.pauseRequested = true;
      try {
        await this.client.request('pause', { threadId: await this.currentThread() }, REQUEST_MS);
      } catch {
        // The thread may be gone: pause the first one there is.
        this.threadId = null;
        await this.client.request('pause', { threadId: await this.currentThread() }, REQUEST_MS);
      }
      return this.settle(mark, w);
    });
  }

  /** Waits for a running program to stop, or reports where it is paused. */
  wait(w: Waiting): Promise<Report> {
    return this.enqueue(async () => {
      this.ensureAlive();
      if (this.running) return this.settle(this.stopSeq, w);
      return { text: [this.takeOutput(), await this.describeStop()].filter(Boolean).join('\n') };
    });
  }

  // ------------------------------------------------------------------ inspecting

  stack(thread?: number): Promise<string> {
    return this.enqueue(async () => {
      this.ensurePaused();
      const threadId = thread ?? (await this.currentThread());
      const r = await this.client.request<{ stackFrames?: StackFrame[]; totalFrames?: number }>('stackTrace', { threadId, startFrame: 0, levels: STACK_FRAMES }, REQUEST_MS);
      const frames = r.stackFrames ?? [];
      return [`Thread ${threadId}:`, ...(frames.length ? this.frameLines(frames, STACK_FRAMES, r.totalFrames) : ['  (no frames)'])].join('\n');
    });
  }

  threads(): Promise<string> {
    return this.enqueue(async () => {
      this.ensureAlive();
      const { threads } = await this.client.request<{ threads?: Thread[] }>('threads', {}, REQUEST_MS);
      if (!threads?.length) return 'The program has no threads.';
      const lines = threads.slice(0, 50).map((t) => `${t.id === this.threadId ? '*' : ' '} ${t.id}  ${t.name}`);
      if (threads.length > 50) lines.push(`  ... ${threads.length - 50} more`);
      return `${this.running ? 'Threads (the program is running):' : 'Threads (* stopped):'}\n${lines.join('\n')}`;
    });
  }

  private async fetchVariables(ref: number, count: number): Promise<Variable[]> {
    const r = await this.client.request<{ variables?: Variable[] }>('variables', { variablesReference: ref, start: 0, count }, REQUEST_MS);
    return r.variables ?? [];
  }

  /** Lines for `vars`, expanding structured values `depth` levels (children of one level are fetched together). */
  private async renderVariables(vars: Variable[], limit: number, total: number, depth: number, indent: string, budget: { left: number }): Promise<string[]> {
    const shown = vars.slice(0, limit).filter((v) => !GROUPS.test(v.name));
    const children = await Promise.all(
      shown.map((v) => {
        if (depth <= 0 || v.variablesReference <= 0 || budget.left <= 0) return null;
        budget.left--;
        return this.fetchVariables(v.variablesReference, CHILD_VARIABLES + 1).catch(() => null);
      }),
    );
    const out: string[] = [];
    for (let i = 0; i < shown.length; i++) {
      const v = shown[i]!;
      out.push(`${indent}${v.name}${v.value ? ` = ${valueText(v.value)}` : ''}${typeText(v.type)}`);
      const kids = children[i];
      if (kids) out.push(...(await this.renderVariables(kids, CHILD_VARIABLES, (v.namedVariables ?? 0) + (v.indexedVariables ?? 0), depth - 1, `${indent}  `, budget)));
    }
    const more = total > Math.min(limit, vars.length) ? total - Math.min(limit, vars.length) : vars.length > limit ? -1 : 0;
    if (more) out.push(`${indent}... ${more > 0 ? `${more} more` : 'more'}`);
    return out;
  }

  variables(o: { frame: number; thread?: number; scope?: string; depth: number }): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.frameAt(o.frame, o.thread);
      const { scopes = [] } = await this.client.request<{ scopes?: Scope[] }>('scopes', { frameId: frame.id }, REQUEST_MS);
      const want = o.scope?.trim().toLowerCase();
      let picked = want === 'all' ? scopes : want ? scopes.filter((s) => s.name.toLowerCase().includes(want)) : scopes.filter((s) => !s.expensive && !/global|register/i.test(s.name));
      if (!picked.length && !want) picked = scopes.slice(0, 1);
      if (!picked.length) return `No scope matches "${o.scope}". Scopes here: ${scopes.map((s) => s.name).join(', ') || 'none'}.`;
      const budget = { left: MAX_EXPANSIONS };
      const lines = [`#${o.frame} ${this.frameText(frame)}`];
      for (const scope of picked) {
        const vars = await this.fetchVariables(scope.variablesReference, TOP_VARIABLES + 1);
        const body = await this.renderVariables(vars, TOP_VARIABLES, (scope.namedVariables ?? 0) + (scope.indexedVariables ?? 0), o.depth, '  ', budget);
        lines.push(`${scope.name}:`, ...(body.length ? body : ['  (none)']));
      }
      const others = scopes.filter((s) => !picked.includes(s)).map((s) => s.name);
      if (others.length) lines.push(`Other scopes: ${others.join(', ')} (pass scope to list them).`);
      return lines.join('\n');
    });
  }

  evaluate(expression: string, o: { frame: number; thread?: number; depth: number }): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.frameAt(o.frame, o.thread);
      const r = await this.client.request<EvaluateResponseBody>('evaluate', { expression, frameId: frame.id, context: 'watch' }, REQUEST_MS);
      const value = (r.result ?? '').replace(/\s+$/, '');
      const head = expression.includes('\n') || expression.length > 80 ? '' : `${expression} = `;
      const lines = [`${head}${value || '(no value)'}${typeText(r.type)}`];
      if (r.variablesReference > 0 && o.depth > 0) {
        const kids = await this.fetchVariables(r.variablesReference, CHILD_VARIABLES + 1);
        lines.push(...(await this.renderVariables(kids, CHILD_VARIABLES, (r.namedVariables ?? 0) + (r.indexedVariables ?? 0), o.depth - 1, '  ', { left: MAX_EXPANSIONS })));
      }
      const out = this.takeOutput();
      return [...lines, out].filter(Boolean).join('\n');
    });
  }

  /** Runs a command in the adapter's debug console (Python code with debugpy, lldb commands with lldb-dap). */
  console(command: string, w: Waiting): Promise<Report> {
    return this.enqueue(async () => {
      this.ensureAlive();
      const mark = this.stopSeq;
      const wasRunning = this.running;
      const frameId = wasRunning ? undefined : (await this.frameAt(0).catch(() => null))?.id;
      const r = await this.client.request<EvaluateResponseBody>('evaluate', { expression: command, ...(frameId !== undefined ? { frameId } : {}), context: 'repl' }, Math.max(REQUEST_MS, w.timeoutMs));
      // lldb-dap repeats the command first ("(lldb) bt").
      const text = cleanOutput(r.result ?? '').replace(/^\(lldb\) [^\n]*\n/, '').replace(/\s+$/, '') || '(no output)';
      // A console command can resume the program (lldb: "continue", "thread step-over").
      await sleep(100);
      if (!wasRunning && (this.running || this.stopSeq > mark)) {
        const rep = await this.settle(mark, w);
        return { text: `${text}\n${rep.text}`, isError: rep.isError };
      }
      return { text: [text, this.takeOutput()].filter(Boolean).join('\n') };
    });
  }
}

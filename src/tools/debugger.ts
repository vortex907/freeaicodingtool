// Debugger tool: Debug Adapter Protocol sessions (debugpy, lldb-dap, netcoredbg, dlv), with pdb and
// node inspect driven through their prompts as before. One session per conversation.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { PermissionRequest, PreparedCall, SessionState, Tool, ToolContext, ToolResult } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { cleanOutput, killTree, MAX_OUTPUT_FOR_MODEL } from './bash.js';
import { findPython, keepTail, PYTHON_MISSING, trackChild } from './repl.js';
import { attachBackend, chooseBackend, parseAdapter, type AdapterSpec, type AttachTarget, type LaunchTarget } from '../dap/adapters.js';
import { DapSession, type BreakpointSpec, type Report, type ResumeKind, type Waiting } from '../dap/session.js';
import { isWindows } from '../util/platform.js';
import { formatDuration, truncate, truncateMiddle } from '../util/strings.js';

type DebugLanguage = 'python' | 'node';
type State = 'paused' | 'running' | 'exited' | 'aborted';
type Action = 'start' | 'send' | 'stop' | 'break' | 'clear' | 'continue' | 'next' | 'step_in' | 'step_out' | 'pause' | 'stack' | 'vars' | 'eval' | 'threads';

const IDLE_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 600_000;
// Output must pause this long at a prompt before a call returns: node inspect prints in bursts.
const SETTLE_MS = 120;
const PROMPT: Record<DebugLanguage, string> = { python: '(Pdb) ', node: 'debug> ' };
// node inspect shows its prompt again right after a resume command and announces the stop later.
const NODE_RESUME = /^(c|cont|n|next|s|step|o|out|r|run|restart|pause)$/;
const NODE_STOPPED = /(^|\n)[A-Za-z][\w ]* in \S[^\n]*:\d+\n|Waiting for the debugger to disconnect/;
const NODE_CHATTER = /^(< ?|< Debugger listening on .*|< For help, see: .*|< Debugger attached\.|connecting to \S+ \.\.\. ok)$/;

/** Output with ANSI codes and node inspect's backspaces removed (prompts kept). */
function plain(raw: string): string {
  return cleanOutput(raw).replace(/\x08/g, '');
}

const withoutPrompts = (text: string, lang: DebugLanguage) => text.split(PROMPT[lang]).join('');

/** What the model sees: no prompts and no connection chatter. */
function forModel(raw: string, lang: DebugLanguage): string {
  let lines = withoutPrompts(plain(raw), lang).split('\n');
  if (lang === 'node') lines = lines.filter((l) => !NODE_CHATTER.test(l));
  // Keep the first line's indentation: node inspect's source listings line up by it.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

class DebugSession {
  exited = false;
  exitCode: number | null = null;
  /** The program has not stopped at a prompt since it was last resumed (true while it starts). */
  running = true;
  private pending = '';
  private readonly listeners = new Set<() => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lang: DebugLanguage,
    private readonly child: ChildProcess,
    private readonly onGone: (s: DebugSession) => void,
  ) {
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const onData = (s: string) => {
      this.pending = keepTail(this.pending + s);
      this.notify();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => {
      this.pending += `\n${e.message}\n`;
      this.gone(null);
    });
    // Let the last output arrive before reporting the exit.
    child.on('exit', (code) => setTimeout(() => this.gone(code), 30));
    trackChild(child);
    this.armIdle();
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private gone(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.onGone(this);
    this.notify();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS);
    this.idleTimer.unref();
  }

  dispose(): void {
    if (!this.exited) killTree(this.child, 'SIGKILL');
    this.gone(null);
  }

  /** Breaks into pdb like Ctrl+C: pdb catches SIGINT while the program runs after `continue`. */
  interrupt(): boolean {
    if (isWindows || this.exited || !this.child.pid) return false;
    try {
      process.kill(this.child.pid, 'SIGINT');
      return true;
    } catch {
      return false;
    }
  }

  /** Output not returned yet. */
  take(): string {
    const t = this.pending;
    this.pending = '';
    return t;
  }

  /** Types `command` (null: only wait) and collects the output until the debugger waits at its prompt again. */
  interact(command: string | null, timeoutMs: number, signal: AbortSignal, progress: (text: string) => void): Promise<{ output: string; state: State }> {
    const job = this.queue.then(() => this.interactNow(command, timeoutMs, signal, progress));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async interactNow(command: string | null, timeoutMs: number, signal: AbortSignal, progress: (text: string) => void): Promise<{ output: string; state: State }> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const lines = command === null ? [] : command.split(/\r?\n/);
    // Output from before the command (e.g. a program that kept running) is returned too, but only
    // what comes after the command counts when looking for its prompt.
    const earlier = command === null ? '' : this.take();
    if (lines.length && !this.exited) this.child.stdin!.write(lines.join('\n') + '\n');
    const last = lines[lines.length - 1]?.trim() ?? '';
    const needStop = this.lang === 'node' && (command === null ? this.running : NODE_RESUME.test(last));
    const state = await this.waitForPrompt(lines.length, needStop, timeoutMs, signal, progress);
    if (state === 'paused') this.running = false;
    else if (state === 'running') this.running = true;
    if (!this.exited) this.armIdle();
    return { output: earlier + this.take(), state };
  }

  private waitForPrompt(prompts: number, needStop: boolean, timeoutMs: number, signal: AbortSignal, progress: (text: string) => void): Promise<State> {
    return new Promise((resolve) => {
      const prompt = PROMPT[this.lang].trimEnd();
      let settle: NodeJS.Timeout | null = null;
      let shown = 0;
      const finish = (state: State) => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        this.listeners.delete(check);
        signal.removeEventListener('abort', onAbort);
        resolve(state);
      };
      const check = () => {
        if (settle) clearTimeout(settle);
        settle = null;
        if (this.exited) return finish('exited');
        const text = plain(this.pending);
        if (Date.now() - shown > 150) {
          const tail = forModel(text, this.lang).split('\n').filter((l) => l.trim());
          if (tail.length) {
            shown = Date.now();
            progress(tail.slice(-3).join('\n'));
          }
        }
        if (!text.trimEnd().endsWith(prompt)) return;
        if (text.split(prompt).length - 1 < prompts) return;
        // The stop message can follow a prompt on the same line once the backspaces are gone.
        if (needStop && !NODE_STOPPED.test(withoutPrompts(text, this.lang))) return;
        settle = setTimeout(() => finish('paused'), SETTLE_MS);
      };
      const timer = setTimeout(() => finish(this.exited ? 'exited' : 'running'), timeoutMs);
      const onAbort = () => finish('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      this.listeners.add(check);
      check();
    });
  }
}

const sessions = new WeakMap<SessionState, DebugSession | DapSession>();

/** Ends the session's debugger (when the app closes the session). */
export function stopDebugSession(session: SessionState): void {
  const s = sessions.get(session);
  sessions.delete(session);
  void s?.dispose();
}

function formatInteraction(s: DebugSession, r: { output: string; state: State }, timeoutMs: number): ToolResult {
  const parts = [forModel(r.output, s.lang) || '(no output)'];
  if (r.state === 'running') parts.push(`[The program is still running after ${formatDuration(timeoutMs)} (no debugger prompt yet). Call send with no command to keep waiting, with a larger timeout if needed.]`);
  else if (r.state === 'aborted') parts.push('[Stopped waiting because the user interrupted. The debug session is still open.]');
  else if (r.state === 'exited') parts.push(`[The debugger exited${s.exitCode != null ? ` with code ${s.exitCode}` : ''}. Use action "start" to debug again.]`);
  const content = truncateMiddle(parts.join('\n'), MAX_OUTPUT_FOR_MODEL, 0.3);
  return { content, isError: r.state === 'exited' && s.exitCode !== 0, display: { kind: 'text', text: content } };
}

function withNote(r: ToolResult, note: string | undefined): ToolResult {
  if (!note) return r;
  const content = `${note}\n${r.content}`;
  return { ...r, content, display: { kind: 'text', text: content } };
}

/** The pdb or node inspect command that sets a breakpoint. */
function breakCommand(lang: DebugLanguage, bp: BreakpointSpec): string {
  if (lang === 'python') return `b ${bp.name ?? `${bp.file}:${bp.line}`}${bp.condition ? `, ${bp.condition}` : ''}`;
  // node inspect matches the script by the end of its URL, which has forward slashes.
  const target = bp.name ? `${bp.name}()` : bp.file!.replace(/\\/g, '/');
  return `sb(${JSON.stringify(target)}${bp.line ? `, ${bp.line}` : ''}${bp.condition ? `, ${JSON.stringify(bp.condition)}` : ''})`;
}

async function startPrompt(lang: DebugLanguage, file: string, args: string[], cwd: string, breakpoints: BreakpointSpec[], note: string | undefined, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  await disposeSession(ctx.session);
  const env: NodeJS.ProcessEnv = { ...process.env, ...ctx.settings.env, FREECODE: '1' };
  let command: string;
  let commandArgs: string[];
  if (lang === 'python') {
    const py = await findPython();
    if (!py) return fail(PYTHON_MISSING);
    command = py.file;
    commandArgs = [...py.args, '-u', '-m', 'pdb', file, ...args];
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUNBUFFERED = '1';
  } else {
    command = process.execPath;
    // --port=0 picks a free port, so another debugger on 9229 does not get in the way.
    commandArgs = ['inspect', '--port=0', file, ...args];
    Object.assign(env, { NODE_DISABLE_COLORS: '1', NO_COLOR: '1', FORCE_COLOR: '0' });
  }
  const child = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true });
  const s = new DebugSession(lang, child, (gone) => {
    if (sessions.get(ctx.session) === gone) sessions.delete(ctx.session);
  });
  sessions.set(ctx.session, s);
  const run = (cmd: string | null) => s.interact(cmd, timeoutMs, ctx.signal, ctx.services.progress);
  let r = await run(null);
  // Breakpoints given with start: set them at the first prompt, then run to the first one.
  if (breakpoints.length && r.state === 'paused') {
    const set = await run(breakpoints.map((bp) => breakCommand(lang, bp)).join('\n'));
    const cont = set.state === 'paused' ? await run('c') : null;
    r = { output: r.output + set.output + (cont?.output ?? ''), state: cont?.state ?? set.state };
  }
  return withNote(formatInteraction(s, r, timeoutMs), note);
}

async function disposeSession(session: SessionState): Promise<void> {
  const s = sessions.get(session);
  sessions.delete(session);
  await s?.dispose();
}

// ------------------------------------------------------------------ parameters

const ACTIONS: Record<string, Action> = {
  start: 'start',
  launch: 'start',
  restart: 'start',
  debug: 'start',
  send: 'send',
  command: 'send',
  wait: 'send',
  console: 'send',
  stop: 'stop',
  quit: 'stop',
  exit: 'stop',
  kill: 'stop',
  terminate: 'stop',
  disconnect: 'stop',
  break: 'break',
  breakpoint: 'break',
  set_breakpoint: 'break',
  b: 'break',
  clear: 'clear',
  clear_breakpoint: 'clear',
  remove_breakpoint: 'clear',
  delete_breakpoint: 'clear',
  continue: 'continue',
  cont: 'continue',
  c: 'continue',
  resume: 'continue',
  next: 'next',
  n: 'next',
  over: 'next',
  step_over: 'next',
  stepover: 'next',
  step: 'step_in',
  s: 'step_in',
  step_in: 'step_in',
  stepin: 'step_in',
  into: 'step_in',
  step_into: 'step_in',
  step_out: 'step_out',
  stepout: 'step_out',
  out: 'step_out',
  finish: 'step_out',
  pause: 'pause',
  interrupt: 'pause',
  stack: 'stack',
  bt: 'stack',
  backtrace: 'stack',
  where: 'stack',
  stacktrace: 'stack',
  frames: 'stack',
  vars: 'vars',
  variables: 'vars',
  locals: 'vars',
  scopes: 'vars',
  eval: 'eval',
  evaluate: 'eval',
  print: 'eval',
  p: 'eval',
  inspect: 'eval',
  threads: 'threads',
};

const ACTION_LIST = 'start, break, clear, continue, next, step_in, step_out, pause, stack, vars, eval, threads, send or stop';

function actionOf(input: Record<string, unknown>): Action | null {
  const a = strParam(input, 'action', 'op')?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (a) return ACTIONS[a] ?? null;
  if (programParam(input) || pidParam(input) !== undefined) return 'start';
  if (strParam(input, 'expression', 'expr') !== undefined) return 'eval';
  return strParam(input, 'command', 'cmd') !== undefined ? 'send' : null;
}

const programParam = (input: Record<string, unknown>) => strParam(input, 'program', 'file', 'file_path', 'path', 'script');
const pidParam = (input: Record<string, unknown>) => numParam(input, 'pid', 'process_id', 'processId');

/** A running process to attach to: `pid`, or `port` (a number or host:port) for debugpy. Null when neither is given. */
function attachParam(input: Record<string, unknown>): AttachTarget | { error: string } | null {
  const pid = pidParam(input);
  const port = strParam(input, 'port')?.trim();
  if (port) {
    const m = /^(?:\[?([^\]]*?)\]?:)?(\d+)$/.exec(port);
    if (!m) return { error: 'port must be a port number or host:port.' };
    return { port: Number(m[2]), host: m[1] || strParam(input, 'host') };
  }
  if (pid === undefined) return null;
  return Number.isInteger(pid) && pid > 0 ? { pid } : { error: 'pid must be the id of a running process.' };
}

const commandParam = (input: Record<string, unknown>) => strParam(input, 'command', 'cmd', 'input') ?? '';
const expressionParam = (input: Record<string, unknown>) => strParam(input, 'expression', 'expr', 'command', 'code') ?? '';
const conditionParam = (input: Record<string, unknown>) => strParam(input, 'condition', 'cond', 'if', 'when')?.trim() || undefined;

function argsParam(input: Record<string, unknown>): string[] {
  const v = input.args ?? input.argv ?? input.arguments;
  if (Array.isArray(v)) return v.map(String);
  return typeof v === 'string' && v.trim() ? v.trim().split(/\s+/) : [];
}

/** file:line (a breakpoint), a file without a line (clear: all of its breakpoints) or a function name. */
function parseLocation(loc: string, cwd: string): BreakpointSpec | { error: string } {
  if (/[\r\n]/.test(loc)) return { error: 'A breakpoint location is one line: file:line or a function name.' };
  const m = /^(.*\S):(\d+)$/.exec(loc);
  if (m) {
    const file = path.resolve(cwd, m[1]!);
    if (!existsSync(file)) return { error: `File not found: ${file}` };
    return { file, line: Number(m[2]) };
  }
  const asFile = path.resolve(cwd, loc);
  if (/[\\/.]/.test(loc) && existsSync(asFile) && statSync(asFile).isFile()) return { file: asFile };
  if (!/^[\w$.:<>~*&, ]+$/.test(loc)) return { error: `"${loc}" is neither file:line nor a function name.` };
  return { name: loc };
}

/** The location of break and clear, from location (or file and line). */
function locationParam(input: Record<string, unknown>, cwd: string): BreakpointSpec | { error: string } | null {
  const line = numParam(input, 'line', 'lineno', 'line_number');
  let loc = strParam(input, 'location', 'breakpoint', 'at', 'function', 'func')?.trim();
  const file = strParam(input, 'file', 'path', 'file_path', 'source')?.trim();
  if (!loc && file) loc = file;
  if (!loc) return null;
  if (line !== undefined && !/:\d+$/.test(loc)) loc = `${loc}:${line}`;
  return parseLocation(loc, cwd);
}

const shownLocation = (bp: BreakpointSpec, cwd: string) => bp.name ?? `${path.relative(cwd, bp.file!) || bp.file}:${bp.line}`;

/** Breakpoints given with start: "file:line" strings or {file, line, condition} objects. */
function breakpointsParam(input: Record<string, unknown>, cwd: string): BreakpointSpec[] | { error: string } {
  let v = input.breakpoints ?? input.breakpoint ?? input.break;
  if (typeof v === 'string') v = v.split(/[,;]\s*|\s+(?=\S+:\d+)/).filter(Boolean);
  if (!Array.isArray(v)) return [];
  const out: BreakpointSpec[] = [];
  for (const item of v) {
    let spec: BreakpointSpec | { error: string };
    if (typeof item === 'string') spec = parseLocation(item.trim(), cwd);
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const loc = locationParam(o, cwd);
      spec = loc ?? { error: 'Each breakpoint needs a file and line (or a function name).' };
      if (!('error' in spec)) spec.condition = conditionParam(o);
    } else continue;
    if ('error' in spec) return spec;
    if (!spec.name && !spec.line) return { error: `Give a line for the breakpoint in ${spec.file} (file:line).` };
    out.push(spec);
  }
  return out;
}

// ------------------------------------------------------------------ permissions

const KIND_NAME: Record<string, string> = { python: 'Python', node: 'Node', native: 'Native code', go: 'Go', csharp: 'C#' };

function permission(kind: string, title: string, subject: string): PermissionRequest {
  return { tool: 'Debugger', category: 'execute', title, subject, specifier: kind, ruleSuggestion: `Debugger(${kind})`, ruleLabel: `${KIND_NAME[kind] ?? kind} debugging` };
}

// ------------------------------------------------------------------ actions

async function prepareStart(input: Record<string, unknown>, ctx: ToolContext, timeout: number): Promise<PreparedCall> {
  const attach = attachParam(input);
  if (attach && 'error' in attach) return errorResult(attach.error);
  const raw = programParam(input);
  if (!raw && !attach) return errorResult('Missing required parameter: program');
  const adapter = parseAdapter(strParam(input, 'adapter', 'debugger', 'engine'));
  if (!adapter) return errorResult('adapter must be auto, debugpy, pdb, node, lldb-dap, netcoredbg or dlv.');
  const cwdRaw = strParam(input, 'cwd', 'working_directory', 'workdir');
  const cwd = cwdRaw ? path.resolve(ctx.session.cwd, cwdRaw) : existsSync(ctx.session.cwd) ? ctx.session.cwd : ctx.projectRoot;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return errorResult(`Working directory not found: ${cwd}`);
  const breakpoints = breakpointsParam(input, ctx.session.cwd);
  if ('error' in breakpoints) return errorResult(breakpoints.error);
  if (attach) return prepareAttach(attach, raw ? path.resolve(ctx.session.cwd, raw) : undefined, adapter, cwd, breakpoints, ctx, timeout);
  // A relative program is looked up in the current folder, then in cwd.
  let abs = path.resolve(ctx.session.cwd, raw!);
  if (!existsSync(abs) && cwdRaw && existsSync(path.resolve(cwd, raw!))) abs = path.resolve(cwd, raw!);
  const backend = await chooseBackend(abs, adapter);
  if ('error' in backend) return errorResult(backend.error);
  const args = argsParam(input);
  const shown = path.relative(ctx.session.cwd, abs) || abs;
  if (backend.type !== 'dap') {
    const lang: DebugLanguage = backend.type === 'pdb' ? 'python' : 'node';
    if (!existsSync(abs) || !statSync(abs).isFile()) return errorResult(`File not found: ${abs}`);
    const note = backend.type === 'pdb' ? backend.note : undefined;
    return {
      permission: permission(lang, `Debug ${KIND_NAME[lang]} script`, `${lang === 'python' ? 'python -m pdb' : 'node inspect'} ${[shown, ...args].join(' ')}`),
      execute: () => startPrompt(lang, abs, args, cwd, breakpoints, note, timeout, ctx),
    };
  }
  const spec: AdapterSpec = backend.spec;
  const program = backend.program;
  return {
    permission: permission(spec.kind, `Debug ${KIND_NAME[spec.kind]} program`, `${spec.name} ${[path.relative(ctx.session.cwd, program) || program, ...args].join(' ')}`),
    execute: () => startDap(spec, { program, args, cwd, stopOnEntry: breakpoints.length === 0 }, breakpoints, ctx, timeout),
  };
}

async function prepareAttach(attach: AttachTarget, program: string | undefined, adapter: string, cwd: string, breakpoints: BreakpointSpec[], ctx: ToolContext, timeout: number): Promise<PreparedCall> {
  if (program && !existsSync(program)) return errorResult(`File not found: ${program}`);
  const backend = await attachBackend(adapter === 'auto' && attach.port !== undefined ? 'debugpy' : adapter, program);
  if ('error' in backend) return errorResult(backend.error);
  const { spec } = backend;
  if (attach.port !== undefined && !spec.attachByPort) {
    return errorResult(`port works with debugpy (python -m debugpy --listen <port>) and dlv (dlv --headless --listen=:<port>). Attach ${spec.name} with pid.`);
  }
  const where = attach.port !== undefined ? `${attach.host || '127.0.0.1'}:${attach.port}` : `process ${attach.pid}`;
  return {
    permission: permission(spec.kind, 'Attach debugger', `${spec.name} attach to ${where}`),
    execute: () => startDap(spec, { program: program ?? '', args: [], cwd, stopOnEntry: false, attach: { ...attach, program } }, breakpoints, ctx, timeout),
  };
}

async function startDap(spec: AdapterSpec, target: LaunchTarget, breakpoints: BreakpointSpec[], ctx: ToolContext, timeout: number): Promise<ToolResult> {
  await disposeSession(ctx.session);
  const { session, report } = await DapSession.start({
    spec,
    target,
    breakpoints,
    env: { ...process.env, ...ctx.settings.env, FREECODE: '1' },
    baseDir: ctx.session.cwd,
    wait: waiting(ctx, timeout),
  });
  if (session) sessions.set(ctx.session, session);
  return dapResult(report);
}

const waiting = (ctx: ToolContext, timeoutMs: number): Waiting => ({ timeoutMs, signal: ctx.signal, progress: ctx.services.progress });

function dapResult(r: Report): ToolResult {
  const content = truncateMiddle(r.text || '(no output)', MAX_OUTPUT_FOR_MODEL, 0.3);
  return { content, isError: !!r.isError, display: { kind: 'text', text: content } };
}

const RESUME: Partial<Record<Action, ResumeKind>> = { continue: 'continue', next: 'next', step_in: 'stepIn', step_out: 'stepOut' };

function prepareDap(s: DapSession, action: Action, input: Record<string, unknown>, ctx: ToolContext, timeout: number): PreparedCall {
  const w = waiting(ctx, timeout);
  const frame = Math.max(0, Math.floor(numParam(input, 'frame', 'frame_index', 'frameIndex') ?? 0));
  const thread = numParam(input, 'thread', 'thread_id', 'threadId');
  const depth = Math.min(3, Math.max(0, Math.floor(numParam(input, 'depth', 'expand') ?? 1)));
  const run =
    (fn: () => Promise<string | Report>) =>
    async (): Promise<ToolResult> => {
      try {
        // The program ended since the last call: report how, once.
        if (s.ended) return dapResult(s.finalReport());
        const r = await fn();
        return dapResult(typeof r === 'string' ? { text: r } : r);
      } catch (e) {
        // The adapter or the program went away during the call: say how it ended.
        if (s.ended) return dapResult({ ...s.finalReport(), isError: true });
        return fail((e as Error).message);
      } finally {
        if (s.ended && sessions.get(ctx.session) === s) sessions.delete(ctx.session);
      }
    };
  const kind = s.spec.kind;
  const resume = RESUME[action];
  if (resume) return { execute: run(() => s.resume(resume, w, thread)) };
  switch (action) {
    case 'pause':
      return { execute: run(() => s.pause(w)) };
    case 'stack':
      return { execute: run(() => s.stack(thread)) };
    case 'threads':
      return { execute: run(() => s.threads()) };
    case 'vars':
      return { execute: run(() => s.variables({ frame, thread, depth, scope: strParam(input, 'scope') })) };
    case 'eval': {
      const expression = expressionParam(input);
      if (!expression.trim()) return errorResult('Missing required parameter: expression');
      return { permission: permission(kind, 'Debugger expression', expression), execute: run(() => s.evaluate(expression, { frame, thread, depth })) };
    }
    case 'break': {
      const loc = locationParam(input, ctx.session.cwd);
      if (!loc) return errorResult('Missing required parameter: location (file:line or a function name)');
      if ('error' in loc) return errorResult(loc.error);
      if (!loc.name && !loc.line) return errorResult(`Give a line: ${path.relative(ctx.session.cwd, loc.file!) || loc.file}:<line>.`);
      const condition = conditionParam(input);
      const execute = run(() => s.setBreakpoint({ ...loc, condition }));
      // A condition is code that runs in the program.
      return condition ? { permission: permission(kind, 'Conditional breakpoint', `${shownLocation(loc, ctx.session.cwd)} if ${condition}`), execute } : { execute };
    }
    case 'clear': {
      const loc = locationParam(input, ctx.session.cwd);
      if (loc && 'error' in loc) return errorResult(loc.error);
      return { execute: run(() => s.clearBreakpoints(loc)) };
    }
    default: {
      const command = commandParam(input);
      if (!command.trim()) return { execute: run(() => s.wait(w)) };
      return { permission: permission(kind, 'Debugger command', command), execute: run(() => s.console(command, w)) };
    }
  }
}

/** Structured actions on a pdb or node inspect session become their commands. */
function preparePrompt(s: DebugSession, action: Action, input: Record<string, unknown>, ctx: ToolContext, timeout: number): PreparedCall {
  const lang = s.lang;
  const name = lang === 'python' ? 'pdb' : 'node inspect';
  const send = (command: string | null) => async () => formatInteraction(s, await s.interact(command, timeout, ctx.signal, ctx.services.progress), timeout);
  if ((action === 'vars' || action === 'eval') && (numParam(input, 'frame') ?? 0) > 0) {
    return errorResult(lang === 'python' ? 'With pdb, move to an outer frame with send command "u" (and back with "d"), then use eval or vars.' : 'node inspect only looks at the innermost frame. Use stack to see the others.');
  }
  switch (action) {
    case 'send': {
      const command = commandParam(input);
      // Waiting runs nothing new.
      if (!command.trim()) return { execute: send(null) };
      return { permission: permission(lang, 'Debugger command', command), execute: send(command) };
    }
    case 'continue':
      return { execute: send('c') };
    case 'next':
      return { execute: send('n') };
    case 'step_in':
      return { execute: send('s') };
    case 'step_out':
      return { execute: send(lang === 'python' ? 'r' : 'o') };
    case 'stack':
      return { execute: send(lang === 'python' ? 'w' : 'bt') };
    case 'threads':
      return errorResult(`${name} shows no threads. Use stack for the call stack.`);
    case 'pause':
      if (lang === 'node') return { execute: send('pause') };
      if (!s.running) return { execute: async () => ok('The program is already paused at the pdb prompt.') };
      if (isWindows) return errorResult('pdb cannot be paused on Windows. Wait with send (no command), or stop and start again with a breakpoint.');
      return { execute: async () => (s.interrupt() ? send(null)() : fail('Could not interrupt the program.')) };
    case 'vars':
      if (lang === 'node') return errorResult('node inspect cannot list variables. Use eval with the names you need (or an object literal like {a, b}).');
      return { execute: send("pp {k: v for k, v in locals().items() if not k.startswith('__') and type(v).__name__ not in ('module', 'function', 'type')}") };
    case 'eval': {
      const expression = expressionParam(input).trim();
      if (!expression) return errorResult('Missing required parameter: expression');
      if (expression.includes('\n')) return errorResult(`${name} evaluates one line at a time.`);
      return { permission: permission(lang, 'Debugger expression', expression), execute: send(lang === 'python' ? `p ${expression}` : `exec ${expression}`) };
    }
    case 'break': {
      const loc = locationParam(input, ctx.session.cwd);
      if (!loc) return errorResult('Missing required parameter: location (file:line or a function name)');
      if ('error' in loc) return errorResult(loc.error);
      if (!loc.name && !loc.line) return errorResult('Give a line: file:<line>.');
      const condition = conditionParam(input);
      if (condition?.includes('\n')) return errorResult('A condition is one line.');
      const execute = send(breakCommand(lang, { ...loc, condition }));
      return condition ? { permission: permission(lang, 'Conditional breakpoint', `${shownLocation(loc, ctx.session.cwd)} if ${condition}`), execute } : { execute };
    }
    case 'clear': {
      const loc = locationParam(input, ctx.session.cwd);
      if (loc && 'error' in loc) return errorResult(loc.error);
      if (!loc?.file || !loc.line) return errorResult(`With ${name}, clear takes one breakpoint as file:line.`);
      return { execute: send(lang === 'python' ? `cl ${loc.file}:${loc.line}` : `cb(${JSON.stringify(loc.file.replace(/\\/g, '/'))}, ${loc.line})`) };
    }
    default:
      return errorResult(`action must be ${ACTION_LIST}.`);
  }
}

async function stopAction(ctx: ToolContext): Promise<ToolResult> {
  const s = sessions.get(ctx.session);
  if (!s) return ok('No debug session is running.');
  let output: string;
  if (s instanceof DapSession) output = s.ended ? s.finalReport().text : s.takeOutput();
  else output = forModel(s.take(), s.lang);
  const detached = s instanceof DapSession && s.attached && !s.ended;
  await disposeSession(ctx.session);
  return ok(`${output ? `${output}\n` : ''}${detached ? 'Debugger detached. The program keeps running.' : 'Debug session stopped.'}`);
}

export const DebuggerTool: Tool = {
  name: 'Debugger',
  category: 'execute',
  description:
    'Debug a program: pause it at breakpoints, step through it and read variables to see where it goes wrong. ' +
    'Python runs under debugpy (pdb when debugpy is missing), JavaScript under node inspect, C, C++, Rust and Swift executables under lldb-dap, C# under netcoredbg (start the built .dll) and Go under Delve (start a .go file or package folder). ' +
    'action=start runs `program` (with `args`, `cwd`) and pauses at its start, or runs to the first of `breakpoints` (file:line) when given. ' +
    'start with `pid` attaches to a process that is already running, `port` to a program started with python -m debugpy --listen or dlv --headless; stop then detaches and leaves it running. ' +
    'Then: break (`location` file:line or a function name, optional `condition`), clear, continue, next (step over), step_in, step_out, pause, stack, vars (variables of `frame`, nested values `depth` levels deep), eval (`expression`), threads and stop. ' +
    'Each stop shows the location, the source around it and the top frames. send types a raw debugger `command` (pdb or node inspect syntax, or the debug console of the adapter); send with no command waits for a running program to stop. ' +
    'One session at a time: start again to restart. Build native programs with debug info first (cc -g, cargo build, dotnet build); compile TypeScript and debug the .js output.\n' +
    "pdb: b file:line, c, n, s, r, p expr, pp locals(), w, l, q. node inspect: sb('file.js', 10), c, n, s, o, exec expr, bt, list(5).",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'break', 'clear', 'continue', 'next', 'step_in', 'step_out', 'pause', 'stack', 'vars', 'eval', 'threads', 'send', 'stop'], description: 'What to do' },
      program: { type: 'string', description: 'For start: a .py, .js, .go or .dll file, a Go package folder or a native executable' },
      args: { type: 'array', items: { type: 'string' }, description: 'Program arguments, for start' },
      cwd: { type: 'string', description: 'Working directory of the program, for start (default: the current folder)' },
      pid: { type: 'number', description: 'For start: attach to this running process instead of starting a program (give adapter, or program for the language)' },
      port: { type: 'string', description: 'For start: attach to a program started with python -m debugpy --listen <port>, or dlv --headless --listen=:<port> with adapter dlv (a port or host:port)' },
      adapter: { type: 'string', enum: ['auto', 'debugpy', 'pdb', 'node', 'lldb-dap', 'netcoredbg', 'dlv'], description: 'Debugger to use, for start (default: picked from the program)' },
      breakpoints: { type: 'array', items: { type: 'string' }, description: 'file:line breakpoints to set before the program runs, for start' },
      location: { type: 'string', description: 'file:line or a function name, for break and clear (clear without it removes all)' },
      condition: { type: 'string', description: 'For break: stop only when this expression is true' },
      expression: { type: 'string', description: 'Expression to evaluate, for eval' },
      frame: { type: 'number', description: 'Stack frame for vars and eval (0 = innermost, the default)' },
      depth: { type: 'number', description: 'Levels of nested values vars and eval expand (default 1, max 3)' },
      scope: { type: 'string', description: 'For vars: a scope other than the locals, e.g. globals, registers or all' },
      thread: { type: 'number', description: 'Thread for stack, vars, eval and stepping (default: the one that stopped)' },
      command: { type: 'string', description: 'Raw debugger command, for send. Leave out to wait for a running program to stop' },
      timeout: { type: 'number', description: `How long to wait for the program to stop, in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ['action'],
  },
  label: (input) => {
    const action = actionOf(input);
    const attachTo = pidParam(input) ?? strParam(input, 'port');
    if (action === 'start' && attachTo !== undefined) return `Debugger(attach ${truncate(String(attachTo), 60)})`;
    if (action === 'start') return `Debugger(start ${truncate(programParam(input) ?? '?', 60)})`;
    if (action === 'stop') return 'Debugger(stop)';
    if (action === 'eval') return `Debugger(eval ${truncate(expressionParam(input).trim().replace(/\s+/g, ' '), 60)})`;
    if (action === 'break' || action === 'clear') {
      const loc = strParam(input, 'location', 'breakpoint', 'at', 'function', 'func') ?? strParam(input, 'file', 'path');
      const line = numParam(input, 'line');
      return `Debugger(${action}${loc ? ` ${truncate(loc, 60)}${line !== undefined && !/:\d+$/.test(loc) ? `:${line}` : ''}` : ''})`;
    }
    if (action && action !== 'send') return `Debugger(${action})`;
    const command = commandParam(input).trim().replace(/\s+/g, ' ');
    return `Debugger(${command ? truncate(command, 60) : 'wait'})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const action = actionOf(input);
    if (!action) return errorResult(`action must be ${ACTION_LIST}.`);
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, numParam(input, 'timeout', 'timeout_ms') ?? DEFAULT_TIMEOUT_MS));
    if (action === 'start') return prepareStart(input, ctx, timeout);
    if (action === 'stop') return { execute: () => stopAction(ctx) };
    const s = sessions.get(ctx.session);
    if (!s) return errorResult('No debug session is running. Start one with action "start" and a program.');
    if (s instanceof DapSession) return prepareDap(s, action, input, ctx, timeout);
    return preparePrompt(s, action, input, ctx, timeout);
  },
};

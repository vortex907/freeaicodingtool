// Debugger tool: drives pdb (Python) or node inspect (JavaScript), one command per call.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { PreparedCall, SessionState, Tool, ToolContext, ToolResult } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { cleanOutput, killTree, MAX_OUTPUT_FOR_MODEL } from './bash.js';
import { findPython, keepTail, PYTHON_MISSING, trackChild } from './repl.js';
import { isWindows } from '../util/platform.js';
import { formatDuration, truncate, truncateMiddle } from '../util/strings.js';

type DebugLanguage = 'python' | 'node';
type State = 'paused' | 'running' | 'exited' | 'aborted';
type Action = 'start' | 'send' | 'stop';

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

const sessions = new WeakMap<SessionState, DebugSession>();

/** Ends the session's debugger (when the app closes the session). */
export function stopDebugSession(session: SessionState): void {
  sessions.get(session)?.dispose();
  sessions.delete(session);
}

function formatInteraction(s: DebugSession, r: { output: string; state: State }, timeoutMs: number): ToolResult {
  const parts = [forModel(r.output, s.lang) || '(no output)'];
  if (r.state === 'running') parts.push(`[The program is still running after ${formatDuration(timeoutMs)} (no debugger prompt yet). Call send with no command to keep waiting, with a larger timeout if needed.]`);
  else if (r.state === 'aborted') parts.push('[Stopped waiting because the user interrupted. The debug session is still open.]');
  else if (r.state === 'exited') parts.push(`[The debugger exited${s.exitCode != null ? ` with code ${s.exitCode}` : ''}. Use action "start" to debug again.]`);
  const content = truncateMiddle(parts.join('\n'), MAX_OUTPUT_FOR_MODEL, 0.3);
  return { content, isError: r.state === 'exited' && s.exitCode !== 0, display: { kind: 'text', text: content } };
}

async function start(lang: DebugLanguage, file: string, args: string[], timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  stopDebugSession(ctx.session);
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
  const cwd = existsSync(ctx.session.cwd) ? ctx.session.cwd : ctx.projectRoot;
  const child = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true });
  const s = new DebugSession(lang, child, (gone) => {
    if (sessions.get(ctx.session) === gone) sessions.delete(ctx.session);
  });
  sessions.set(ctx.session, s);
  return formatInteraction(s, await s.interact(null, timeoutMs, ctx.signal, ctx.services.progress), timeoutMs);
}

function languageOf(file: string): DebugLanguage | 'typescript' | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return 'python';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  return null;
}

function actionOf(input: Record<string, unknown>): Action | null {
  const a = strParam(input, 'action', 'op')?.trim().toLowerCase();
  if (a === 'start' || a === 'launch' || a === 'restart') return 'start';
  if (a === 'send' || a === 'command' || a === 'wait') return 'send';
  if (a === 'stop' || a === 'quit' || a === 'exit' || a === 'kill') return 'stop';
  if (a) return null;
  if (fileParam(input)) return 'start';
  return strParam(input, 'command', 'cmd') !== undefined ? 'send' : null;
}

const fileParam = (input: Record<string, unknown>) => strParam(input, 'file', 'file_path', 'path', 'script', 'program');
const commandParam = (input: Record<string, unknown>) => strParam(input, 'command', 'cmd', 'input') ?? '';

function argsParam(input: Record<string, unknown>): string[] {
  const v = input.args ?? input.argv ?? input.arguments;
  if (Array.isArray(v)) return v.map(String);
  return typeof v === 'string' && v.trim() ? v.trim().split(/\s+/) : [];
}

const DEBUG_NAME: Record<DebugLanguage, string> = { python: 'Python', node: 'Node' };

export const DebuggerTool: Tool = {
  name: 'Debugger',
  category: 'execute',
  description:
    'Step through a Python or Node.js program with a line debugger (pdb or node inspect) to find where it goes wrong and what the variables hold. ' +
    'action=start runs `file` (with optional `args`) paused at its first line; action=send types a debugger `command` (several lines run in order) and returns the output up to the next prompt; action=stop ends the session. ' +
    'One session at a time: start again to restart. If the program is still running when the timeout ends, the result says so; send with no command to keep waiting. ' +
    'For TypeScript, compile first and debug the .js output.\n' +
    'pdb: b file:line (breakpoint), c (continue), n (next line), s (step into), r (run to return), p expr, pp locals(), w (stack), l (list), q (quit).\n' +
    "node inspect: sb('file.js', 10) (breakpoint), c, n, s, o (step out), exec expr, bt (stack), list(5), watch('expr'), .exit.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'send', 'stop'], description: 'start a session, send a command, or stop' },
      file: { type: 'string', description: 'Script to debug (.py, .js, .mjs, .cjs), for start' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the script, for start' },
      command: { type: 'string', description: 'Debugger command, for send. Leave out to wait for a running program to stop' },
      timeout: { type: 'number', description: `How long to wait for the debugger prompt in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ['action'],
  },
  label: (input) => {
    const action = actionOf(input);
    if (action === 'start') return `Debugger(start ${truncate(fileParam(input) ?? '?', 60)})`;
    if (action === 'stop') return 'Debugger(stop)';
    const command = commandParam(input).trim().replace(/\s+/g, ' ');
    return `Debugger(${command ? truncate(command, 60) : 'wait'})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const action = actionOf(input);
    if (!action) return errorResult('action must be "start", "send" or "stop".');
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, numParam(input, 'timeout', 'timeout_ms') ?? DEFAULT_TIMEOUT_MS));
    if (action === 'stop') {
      return {
        execute: async () => {
          const s = sessions.get(ctx.session);
          if (!s) return ok('No debug session is running.');
          const output = forModel(s.take(), s.lang);
          stopDebugSession(ctx.session);
          return ok(`${output ? `${output}\n` : ''}Debug session stopped.`);
        },
      };
    }
    if (action === 'send') {
      const s = sessions.get(ctx.session);
      if (!s) return errorResult('No debug session is running. Start one with action "start" and a file.');
      const command = commandParam(input);
      const execute = async () => formatInteraction(s, await s.interact(command.trim() ? command : null, timeout, ctx.signal, ctx.services.progress), timeout);
      // Waiting runs nothing new.
      if (!command.trim()) return { execute };
      return {
        permission: {
          tool: 'Debugger',
          category: 'execute',
          title: 'Debugger command',
          subject: command,
          specifier: s.lang,
          ruleSuggestion: `Debugger(${s.lang})`,
          ruleLabel: `${DEBUG_NAME[s.lang]} debugging`,
        },
        execute,
      };
    }
    const file = fileParam(input);
    if (!file) return errorResult('Missing required parameter: file');
    const abs = path.resolve(ctx.session.cwd, file);
    const lang = languageOf(abs);
    if (lang === 'typescript') {
      return errorResult('TypeScript cannot be debugged directly. Compile it first (for example `npx tsc`) and start the debugger on the generated .js file; line numbers then follow the .js file.');
    }
    if (!lang) return errorResult('The debugger supports Python (.py) and JavaScript (.js, .mjs, .cjs) files.');
    if (!existsSync(abs) || !statSync(abs).isFile()) return errorResult(`File not found: ${abs}`);
    const args = argsParam(input);
    const shown = path.relative(ctx.session.cwd, abs) || abs;
    return {
      permission: {
        tool: 'Debugger',
        category: 'execute',
        title: `Debug ${DEBUG_NAME[lang]} script`,
        subject: `${lang === 'python' ? 'python -m pdb' : 'node inspect'} ${[shown, ...args].join(' ')}`,
        specifier: lang,
        ruleSuggestion: `Debugger(${lang})`,
        ruleLabel: `${DEBUG_NAME[lang]} debugging`,
      },
      execute: () => start(lang, abs, args, timeout, ctx),
    };
  },
};

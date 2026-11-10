// REPL tool: persistent Python and Node.js runtimes, one per language per agent session.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Socket } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreparedCall, SessionState, Tool, ToolContext, ToolResult } from './types.js';
import { boolParam, errorResult, fail, numParam, ok, strParam } from './types.js';
import { cleanOutput, killTree, MAX_OUTPUT_FOR_MODEL } from './bash.js';
import { isWindows, which } from '../util/platform.js';
import { formatDuration, randomId, truncate, truncateMiddle } from '../util/strings.js';

export type ReplLanguage = 'python' | 'node';

const IDLE_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_STRAY = 200_000;
const NODE_DRIVER = fileURLToPath(new URL('./nodeReplDriver.js', import.meta.url));

export const PYTHON_MISSING =
  'Python 3 was not found. Install it from https://www.python.org (on Windows, tick "Add python.exe to PATH"), then try again. JavaScript code can run with language "node".';

// Python side of the REPL protocol: one JSON request per line in, one framed JSON reply per request out.
const PYTHON_DRIVER = String.raw`
import ast, builtins, contextlib, inspect, io, json, linecache, os, sys, threading, traceback, types

MARK = sys.argv[1]
START, END = '<<' + MARK + '>>', '<</' + MARK + '>>'
sys.argv = ['']
FLAGS = getattr(ast, 'PyCF_ALLOW_TOP_LEVEL_AWAIT', 0)
KEEP = 50000
VALUE_LIMIT = 10000


class Sink(io.TextIOBase):
    # Collects output. With a lot of it, keeps the start and the end. Threads may write too.
    def __init__(self):
        self.lock = threading.Lock()
        self.clear()

    def clear(self):
        self.head, self.tail, self.head_len, self.tail_len, self.dropped = [], [], 0, 0, 0

    @property
    def encoding(self):
        return 'utf-8'

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError('write() argument must be str, not ' + type(s).__name__)
        n = len(s)
        with self.lock:
            room = KEEP - self.head_len
            if room > 0:
                self.head.append(s[:room])
                self.head_len += min(n, room)
                s = s[room:]
            if s:
                self.tail.append(s)
                self.tail_len += len(s)
                if self.tail_len > 2 * KEEP:
                    kept = ''.join(self.tail)[-KEEP:]
                    self.dropped += self.tail_len - len(kept)
                    self.tail, self.tail_len = [kept], len(kept)
        return n

    def take(self):
        with self.lock:
            text = ''.join(self.head)
            if self.dropped:
                text += '\n[... %d characters dropped ...]\n' % self.dropped
            text += ''.join(self.tail)
            self.clear()
        return text


OUT, ERR = Sink(), Sink()
REAL_OUT = sys.stdout
loop = None


def open_requests():
    # Child processes inherit stdin: give them an empty one so they cannot block on, or eat, requests.
    try:
        fd = os.dup(0)
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        if os.name == 'nt':
            try:
                import ctypes, msvcrt
                ctypes.windll.kernel32.SetStdHandle(ctypes.c_uint32(0xFFFFFFF6), ctypes.c_void_p(msvcrt.get_osfhandle(0)))
            except Exception:
                pass
        return open(fd, 'r', encoding='utf-8')
    except Exception:
        return sys.stdin


def run_code(code, ns):
    global loop
    if code.co_flags & inspect.CO_COROUTINE:
        if loop is None:
            import asyncio
            loop = asyncio.new_event_loop()
        return loop.run_until_complete(eval(code, ns))
    return eval(code, ns)


def run_cell(source, filename, ns):
    # Like IPython: when the last statement is an expression, its value is the result.
    tree = compile(source, filename, 'exec', ast.PyCF_ONLY_AST | FLAGS)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    if tree.body:
        run_code(compile(tree, filename, 'exec', FLAGS), ns)
    if last is not None:
        return run_code(compile(last, filename, 'eval', FLAGS), ns)
    return None


def format_error(e):
    tb = e.__traceback__
    while tb is not None and not tb.tb_frame.f_code.co_filename.startswith('<cell '):
        tb = tb.tb_next
    return ''.join(traceback.format_exception(type(e), e, tb))


def handle(source, filename, ns):
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    value = error = None
    stdin = sys.stdin
    sys.stdin = io.StringIO()
    try:
        with contextlib.redirect_stdout(OUT), contextlib.redirect_stderr(ERR):
            try:
                result = run_cell(source, filename, ns)
                if result is not None:
                    builtins._ = result
                    value = repr(result)
                    if len(value) > VALUE_LIMIT:
                        value = value[:VALUE_LIMIT] + '... [%d more characters]' % (len(value) - VALUE_LIMIT)
            except BaseException as e:
                error = format_error(e)
    finally:
        sys.stdin = stdin
    return {'stdout': OUT.take(), 'stderr': ERR.take(), 'value': value, 'error': error}


def main():
    requests = open_requests()
    module = types.ModuleType('__main__')
    module.__builtins__ = builtins
    sys.modules['__main__'] = module
    last_cwd = os.getcwd()
    count = 0
    while True:
        try:
            line = requests.readline()
        except KeyboardInterrupt:
            continue
        if not line:
            return
        try:
            req = json.loads(line)
        except ValueError:
            continue
        cwd = req.get('cwd')
        if cwd and cwd != last_cwd:
            try:
                os.chdir(cwd)
                last_cwd = cwd
            except OSError:
                pass
        count += 1
        reply = handle(req.get('code') or '', '<cell %d>' % count, module.__dict__)
        reply['id'] = req.get('id')
        REAL_OUT.write(START + json.dumps(reply) + END)
        REAL_OUT.flush()


main()
`;

// ------------------------------------------------------------------ helper processes

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Runtimes and debug sessions outlive single tool calls. They must never keep FreeCode running,
 * and they die with it.
 */
export function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  child.unref();
  for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as Socket | null)?.unref?.();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const c of liveChildren) killTree(c, 'SIGKILL');
    });
  }
}

/** Keeps the end of a growing buffer. */
export function keepTail(s: string, max = MAX_STRAY): string {
  return s.length > max ? `[... earlier output dropped ...]\n${s.slice(-max)}` : s;
}

export interface PythonCommand {
  file: string;
  args: string[];
  version: string;
}

function probePython(file: string, args: string[]): Promise<{ version: string; executable: string } | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Node's folder as cwd: on Windows a bare program name is also looked up in the current folder.
      child = spawn(file, [...args, '-c', 'import sys; print(sys.version); print(sys.executable)'], {
        cwd: path.dirname(process.execPath),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (s: string) => (out += s));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const [version, executable] = out.trim().split(/\r?\n/);
      // The Windows Store stub (WindowsApps\python.exe) prints an install hint and fails instead.
      resolve(code === 0 && version && /^3\.\d/.test(version) ? { version: version.split(' ')[0]!, executable: executable?.trim() ?? '' } : null);
    });
  });
}

let pythonLookup: Promise<PythonCommand | null> | null = null;

/** A working Python 3: on Windows `python`, then `py -3`; elsewhere `python3`, then `python`. */
export function findPython(): Promise<PythonCommand | null> {
  pythonLookup ??= (async () => {
    const candidates: [string, string[]][] = isWindows ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
    for (const [name, args] of candidates) {
      const found = which(name);
      // .bat/.cmd shims (pyenv-win) only run through a shell.
      if (found && /\.(bat|cmd)$/i.test(found)) continue;
      const probe = await probePython(found ?? name, args);
      if (!probe) continue;
      // Without a path from which() (Windows app aliases), run the interpreter by its own full path.
      if (!found && probe.executable) return { file: probe.executable, args: [], version: probe.version };
      return { file: found ?? name, args, version: probe.version };
    }
    return null;
  })();
  return pythonLookup;
}

// ------------------------------------------------------------------ runtimes

interface CellReply {
  id: number;
  stdout: string;
  stderr: string;
  value: string | null;
  error: string | null;
}

interface Outcome {
  status: 'ok' | 'timeout' | 'aborted' | 'exited';
  reply?: CellReply;
  /** Output that reached the process's own stdout/stderr (subprocesses, background threads). */
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}

class Runtime {
  exited = false;
  exitCode: number | null = null;
  private readonly start: string;
  private readonly end: string;
  private buf = '';
  private strayOut = '';
  private strayErr = '';
  private waiting: ((reply: CellReply | null) => void) | null = null;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly lang: ReplLanguage,
    private readonly child: ChildProcess,
    marker: string,
    private readonly onGone: (rt: Runtime) => void,
  ) {
    this.start = `<<${marker}>>`;
    this.end = `<</${marker}>>`;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (s: string) => this.onStdout(s));
    child.stderr!.on('data', (s: string) => (this.strayErr = keepTail(this.strayErr + s)));
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => {
      this.strayErr += `\n${e.message}`;
      this.gone(null);
    });
    // A reply written just before exiting may still be in the pipe.
    child.on('exit', (code) => setTimeout(() => this.gone(code), 30));
    trackChild(child);
    this.armIdle();
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const s = this.buf.indexOf(this.start);
      if (s < 0) {
        // Everything except a possibly cut-off marker is output from somewhere else.
        const keep = Math.min(this.buf.length, this.start.length - 1);
        this.strayOut = keepTail(this.strayOut + this.buf.slice(0, this.buf.length - keep));
        this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      this.strayOut = keepTail(this.strayOut + this.buf.slice(0, s));
      this.buf = this.buf.slice(s);
      const e = this.buf.indexOf(this.end);
      if (e < 0) return;
      const json = this.buf.slice(this.start.length, e);
      this.buf = this.buf.slice(e + this.end.length);
      try {
        this.waiting?.(JSON.parse(json) as CellReply);
      } catch {
        // not a reply after all
      }
    }
  }

  private gone(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.strayOut += this.buf;
    this.buf = '';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.onGone(this);
    this.waiting?.(null);
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

  private takeStray(): { stdout: string; stderr: string } {
    const r = { stdout: this.strayOut, stderr: this.strayErr };
    this.strayOut = '';
    this.strayErr = '';
    return r;
  }

  run(code: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<Outcome> {
    const job = this.queue.then(() => this.exec(code, cwd, timeoutMs, signal));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private exec(code: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<Outcome> {
    return new Promise((resolve) => {
      if (this.exited) return resolve({ status: 'exited', exitCode: this.exitCode, ...this.takeStray() });
      if (signal.aborted) return resolve({ status: 'aborted', ...this.takeStray() });
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const id = ++this.seq;
      let done = false;
      const finish = (o: Omit<Outcome, 'stdout' | 'stderr'>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting = null;
        if (!this.exited) this.armIdle();
        resolve({ ...o, ...this.takeStray() });
      };
      // The code may never return: the only reliable way out is to kill the runtime.
      const timer = setTimeout(() => {
        finish({ status: 'timeout' });
        this.dispose();
      }, timeoutMs);
      const onAbort = () => {
        finish({ status: 'aborted' });
        this.dispose();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting = (reply) => {
        if (!reply) return finish({ status: 'exited', exitCode: this.exitCode });
        if (reply.id !== id) return;
        // stderr is a separate pipe: give output that was written before the reply a moment to arrive.
        setTimeout(() => finish({ status: 'ok', reply }), 25);
      };
      this.child.stdin!.write(JSON.stringify({ id, code, cwd }) + '\n');
    });
  }
}

const runtimes = new WeakMap<SessionState, Map<ReplLanguage, Runtime>>();

function sessionRuntimes(session: SessionState): Map<ReplLanguage, Runtime> {
  let map = runtimes.get(session);
  if (!map) runtimes.set(session, (map = new Map()));
  return map;
}

/** Kills the session's REPL runtimes (when the app closes the session). */
export function stopReplRuntimes(session: SessionState): void {
  const map = runtimes.get(session);
  if (!map) return;
  for (const rt of [...map.values()]) rt.dispose();
  map.clear();
}

function workingDir(ctx: ToolContext): string {
  return existsSync(ctx.session.cwd) ? ctx.session.cwd : ctx.projectRoot;
}

async function startRuntime(lang: ReplLanguage, ctx: ToolContext): Promise<Runtime> {
  const marker = `FCREPL${randomId(16)}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...ctx.settings.env, NO_COLOR: '1', FREECODE: '1' };
  let file: string;
  let args: string[];
  if (lang === 'python') {
    const py = await findPython();
    if (!py) throw new Error(PYTHON_MISSING);
    file = py.file;
    args = [...py.args, '-u', '-c', PYTHON_DRIVER, marker];
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUNBUFFERED = '1';
  } else {
    // process.execPath is the Node that runs FreeCode (bundled with the Windows app).
    file = process.execPath;
    const quiet = process.allowedNodeEnvironmentFlags.has('--disable-warning') ? ['--disable-warning=ExperimentalWarning'] : [];
    args = [...quiet, NODE_DRIVER, marker];
  }
  const child = spawn(file, args, { cwd: workingDir(ctx), env, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true });
  const map = sessionRuntimes(ctx.session);
  const rt = new Runtime(lang, child, marker, (r) => {
    if (map.get(lang) === r) map.delete(lang);
  });
  map.set(lang, rt);
  return rt;
}

// ------------------------------------------------------------------ tool

const LANG_NAME: Record<ReplLanguage, string> = { python: 'Python', node: 'Node' };

function parseLanguage(value: string | undefined): ReplLanguage | 'typescript' | 'unknown' | undefined {
  const v = value?.trim().toLowerCase().replace(/[\s._-]/g, '');
  if (!v) return undefined;
  if (['python', 'python3', 'py', 'py3', 'ipython'].includes(v)) return 'python';
  if (['node', 'nodejs', 'js', 'javascript', 'mjs', 'cjs'].includes(v)) return 'node';
  if (['ts', 'typescript', 'tsnode', 'tsx'].includes(v)) return 'typescript';
  return 'unknown';
}

/** For calls that leave out the language (for example through a `python` alias). */
function guessLanguage(code: string): ReplLanguage {
  const js = /\b(console\.|require\(|const |let |function\b|Math\.|JSON\.|process\.|undefined\b|null\b|true\b|false\b)|=>|===|!==|;\s*$/m.test(code);
  const py = /^\s*(def |import |from \S+ import |elif |class \w+.*:\s*$)|\b(print\(|True\b|False\b|None\b|self\.)|:\s*$/m.test(code);
  return js && !py ? 'node' : 'python';
}

function section(label: string, text: string, max: number): string {
  const t = cleanOutput(text).replace(/\s+$/, '');
  return t ? `[${label}]\n${truncateMiddle(t, max, 0.3)}` : '';
}

function formatOutcome(lang: ReplLanguage, o: Outcome, timeoutMs: number): ToolResult {
  const name = LANG_NAME[lang];
  const parts = [
    // Output from subprocesses and background threads comes first: it was printed before the reply.
    section('stdout', o.stdout + (o.reply?.stdout ?? ''), 12_000),
    section('stderr', (o.reply?.stderr ?? '') + o.stderr, 6_000),
    o.reply?.value != null ? `[value]\n${o.reply.value}` : '',
    o.reply?.error ? `[error]\n${cleanOutput(o.reply.error).replace(/\s+$/, '')}` : '',
  ].filter(Boolean);
  const lost = `The ${name} runtime was restarted and lost all its variables.`;
  if (o.status === 'timeout') parts.push(`[Timed out after ${formatDuration(timeoutMs)}. ${lost} Pass a larger timeout for slow code, or run long jobs with Bash.]`);
  else if (o.status === 'aborted') parts.push(`[Interrupted by the user. ${lost}]`);
  else if (o.status === 'exited') parts.push(`[The ${name} runtime exited${o.exitCode != null ? ` with code ${o.exitCode}` : ''} and lost all its variables. The next call starts a fresh one.]`);
  const content = truncateMiddle(parts.join('\n') || '(no output)', MAX_OUTPUT_FOR_MODEL, 0.3);
  return { content, isError: o.status !== 'ok' || !!o.reply?.error, display: { kind: 'text', text: content } };
}

async function runRepl(lang: ReplLanguage, code: string, reset: boolean, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  const name = LANG_NAME[lang];
  const map = sessionRuntimes(ctx.session);
  if (reset) map.get(lang)?.dispose();
  if (!code.trim()) return ok(`The ${name} runtime was restarted. All variables are cleared.`, { kind: 'text', text: `${name} runtime restarted` });
  let rt = map.get(lang);
  if (!rt || rt.exited) {
    try {
      rt = await startRuntime(lang, ctx);
    } catch (e) {
      return fail((e as Error).message);
    }
  }
  const outcome = await rt.run(code, workingDir(ctx), timeoutMs, ctx.signal);
  return formatOutcome(lang, outcome, timeoutMs);
}

const codeParam = (input: Record<string, unknown>) => strParam(input, 'code', 'source', 'script', 'input') ?? '';

export const ReplTool: Tool = {
  name: 'REPL',
  category: 'execute',
  description:
    'Run Python or Node.js code in a persistent REPL and get back what it printed, the value of the last expression and any error. ' +
    'Variables, imports and functions stay alive between calls (one runtime per language), so you can load data once and then inspect it step by step. ' +
    'Use it for quick experiments, checking how a library or API behaves, inspecting data files and computing values. Use Bash for project scripts, tests and builds. ' +
    'Python works like IPython. Node supports top-level await, require() of project packages and await import(); static import statements are not supported. ' +
    'input() and other prompts fail instead of waiting. A call that times out restarts the runtime and loses its variables; reset=true restarts it on purpose. ' +
    'The working directory is the current project folder.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'node'], description: 'Runtime to use' },
      code: { type: 'string', description: 'Code to run (several lines are fine)' },
      reset: { type: 'boolean', description: 'Restart the runtime before running, clearing all variables' },
      timeout: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
    },
    required: ['language', 'code'],
  },
  label: (input) => {
    const code = codeParam(input).trim();
    const lang = parseLanguage(strParam(input, 'language', 'lang', 'runtime'));
    const shown = code ? truncate(code.split('\n')[0]!, 80) + (code.includes('\n') ? ' …' : '') : 'reset';
    return `REPL(${lang === 'python' || lang === 'node' ? `${lang}: ` : ''}${shown})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const code = codeParam(input);
    const reset = boolParam(input, 'reset', 'restart') ?? false;
    const parsed = parseLanguage(strParam(input, 'language', 'lang', 'runtime'));
    if (parsed === 'typescript') return errorResult('TypeScript is not supported. Use language "node" with plain JavaScript, or compile the code and run it with Bash.');
    if (parsed === 'unknown') return errorResult('language must be "python" or "node".');
    if (!code.trim() && !reset) return errorResult('Missing required parameter: code');
    const lang = parsed ?? guessLanguage(code);
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, numParam(input, 'timeout', 'timeout_ms') ?? DEFAULT_TIMEOUT_MS));
    const name = LANG_NAME[lang];
    const execute = () => runRepl(lang, code, reset, timeout, ctx);
    // Restarting only kills our own process: nothing to approve.
    if (!code.trim()) return { execute };
    return {
      permission: {
        tool: 'REPL',
        category: 'execute',
        title: `Run ${name} code`,
        subject: code,
        specifier: lang,
        ruleSuggestion: `REPL(${lang})`,
        ruleLabel: `${name} code in the REPL`,
      },
      execute,
    };
  },
};

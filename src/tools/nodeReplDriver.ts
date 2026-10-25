// Child process behind the REPL tool's Node runtime: runs cells in one persistent vm context.
// Protocol: one JSON request per line on stdin ({ id, code, cwd }), one JSON reply per request on
// stdout between two markers, so anything else written to stdout can be told apart from replies.
import { Console } from 'node:console';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { inspect } from 'node:util';
import * as vm from 'node:vm';
import { cellVariants } from './jsCell.js';

const marker = process.argv[2] ?? 'FREECODE';
const START = `<<${marker}>>`;
const END = `<</${marker}>>`;
const KEEP = 50_000;
const VALUE_LIMIT = 10_000;

/** Collects console output. With a lot of it, keeps the start and the end. */
class Sink {
  private head = '';
  private tail: string[] = [];
  private tailLength = 0;
  private dropped = 0;

  write(s: string): void {
    if (this.head.length < KEEP) {
      const room = KEEP - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.tail.push(s);
    this.tailLength += s.length;
    if (this.tailLength > 2 * KEEP) {
      const kept = this.tail.join('').slice(-KEEP);
      this.dropped += this.tailLength - kept.length;
      this.tail = [kept];
      this.tailLength = kept.length;
    }
  }

  take(): string {
    const text = this.head + (this.dropped ? `\n[... ${this.dropped} characters dropped ...]\n` : '') + this.tail.join('');
    this.head = '';
    this.tail = [];
    this.tailLength = 0;
    this.dropped = 0;
    return text;
  }
}

const out = new Sink();
const err = new Sink();
const stream = (sink: Sink) => ({ write: (s: unknown) => (sink.write(String(s)), true) }) as unknown as NodeJS.WritableStream;
const cellConsole = new Console({ stdout: stream(out), stderr: stream(err), ignoreErrors: false, colorMode: false });

const HOST_GLOBALS = [
  'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'structuredClone', 'AbortController', 'AbortSignal', 'atob', 'btoa', 'performance',
  'crypto', 'EventTarget', 'Event',
];
const sandbox: Record<string, unknown> = { console: cellConsole };
for (const name of HOST_GLOBALS) if (name in globalThis) sandbox[name] = (globalThis as Record<string, unknown>)[name];
const context = vm.createContext(sandbox, { name: 'REPL' });
vm.runInContext('globalThis.global = globalThis;', context);

// Lets `await import('pkg')` resolve like a file in the working directory (Node 20.12+).
const dynamicImport = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

let cwd = '';
/** Follows the agent's working directory; a chdir done by the cell's own code is left alone. */
function useCwd(dir: string): void {
  if (!dir || dir === cwd) return;
  try {
    process.chdir(dir);
  } catch {
    return;
  }
  cwd = dir;
  // require() resolves from the project, so its node_modules work.
  sandbox.require = createRequire(path.join(dir, 'repl.js'));
  sandbox.__dirname = dir;
  sandbox.__filename = path.join(dir, 'repl.js');
}
useCwd(process.cwd());

// Folders that cell file names were placed in (they make `import('./x.mjs')` resolve from there).
const cellDirs = new Set<string>();

/** The error's stack without the frames of this driver and of node:vm, with cells named `<cell N>`. */
function formatError(e: unknown): string {
  let stack = e && typeof e === 'object' && typeof (e as { stack?: unknown }).stack === 'string' ? (e as { stack: string }).stack : null;
  if (!stack) return `Uncaught ${inspect(e, { depth: 2 })}`;
  for (const dir of cellDirs) stack = stack.split(path.join(dir, '<cell ')).join('<cell ');
  const lines = stack.split('\n');
  const cut = lines.findIndex((l) => /^\s+at /.test(l) && /node:vm|nodeReplDriver/.test(l));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n');
}

function show(value: unknown): string {
  const text = inspect(value, { depth: 3, maxArrayLength: 100, maxStringLength: VALUE_LIMIT, breakLength: 120 });
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}... [${text.length - VALUE_LIMIT} more characters]` : text;
}

let cellNumber = 0;

async function runCell(code: string): Promise<{ value?: string; error?: string }> {
  const dir = cwd || process.cwd();
  cellDirs.add(dir);
  const filename = path.join(dir, `<cell ${++cellNumber}>`);
  let script: vm.Script | undefined;
  let chosen: ReturnType<typeof cellVariants>[number] | undefined;
  let lastError: unknown;
  for (const v of cellVariants(code)) {
    try {
      script = new vm.Script(v.source, { filename, lineOffset: v.lineOffset, ...(dynamicImport !== undefined ? { importModuleDynamically: dynamicImport } : {}) });
      chosen = v;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!script || !chosen) return { error: formatError(lastError) };
  try {
    for (const name of chosen.declare) {
      try {
        vm.runInContext(`var ${name};`, context);
      } catch {
        // already declared with let/const/class by an earlier cell: the assignment still reaches it
      }
    }
    let result: unknown = script.runInContext(context, { displayErrors: true });
    if (chosen.isAsync) result = await result;
    return result === undefined ? {} : { value: show(result) };
  } catch (e) {
    return { error: formatError(e) };
  }
}

// A throw in a timer or an unhandled rejection would end the process and lose every variable.
process.on('uncaughtException', (e) => err.write(`Error thrown in a callback:\n${formatError(e)}\n`));
process.on('unhandledRejection', (e) => err.write(`Unhandled promise rejection:\n${formatError(e)}\n`));

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  queue = queue.then(async () => {
    let req: { id?: number; code?: string; cwd?: string };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.cwd) useCwd(req.cwd);
    const res = await runCell(String(req.code ?? ''));
    // Give callbacks the cell scheduled for "right away" a chance to print into this reply.
    await new Promise((r) => setImmediate(r));
    const reply = { id: req.id, stdout: out.take(), stderr: err.take(), value: res.value ?? null, error: res.error ?? null };
    process.stdout.write(START + JSON.stringify(reply) + END);
  });
});
rl.on('close', () => process.exit(0));

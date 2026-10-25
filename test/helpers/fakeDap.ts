// A small debug adapter for the DAP tests, started with node. It pretends to run FAKE_PROGRAM (the
// tests write it to a file and debug that file) over stdio, or over TCP with --tcp the way dlv does.
// Program arguments switch on extra behavior: --loop, --throw, --fail-launch, --run-in-terminal.
// Every message it receives is appended to the file named by FAKE_DAP_LOG, one JSON object per line.
import { appendFileSync } from 'node:fs';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';

export const FAKE_PROGRAM = [
  'function add(a, b) {',
  '  const total = a + b;',
  '  return total;',
  '}',
  '',
  'const data = { x: 1, items: [4, 5] };',
  'const result = add(2, 3);',
  "print('result', result);",
  '',
].join('\n');

interface Step {
  line: number;
  fn: 'main' | 'add';
  locals: Record<string, unknown>;
  /** Printed when the program moves past this step. */
  output?: string;
}

const data = { x: 1, items: [4, 5] };
const STEPS: Step[] = [
  { line: 6, fn: 'main', locals: {} },
  { line: 7, fn: 'main', locals: { data } },
  { line: 2, fn: 'add', locals: { a: 2, b: 3 } },
  { line: 3, fn: 'add', locals: { a: 2, b: 3, total: 5 } },
  { line: 8, fn: 'main', locals: { data, result: 5 }, output: 'result 5\n' },
];
const CODE_LINES = [...new Set(STEPS.map((s) => s.line))].sort((a, b) => a - b);
const GLOBALS = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`G${i}`, i]));

type Msg = Record<string, any>;

interface LineBp {
  id: number;
  line: number;
  condition?: string;
}

function main(): void {
  const tcp = process.argv.includes('--tcp');
  const logFile = process.env.FAKE_DAP_LOG;
  const log = (entry: object) => {
    if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n');
  };
  log({ started: process.pid, transport: tcp ? 'tcp' : 'stdio' });
  process.stderr.write(`fake adapter log: started ${process.pid}\n`);

  let write: (b: Buffer, done?: () => void) => void = (b, done) => process.stdout.write(b, done);
  let seq = 1;
  const send = (msg: Msg, done?: () => void) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...msg }), 'utf8');
    write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]), done);
  };
  const event = (name: string, body?: object) => send({ type: 'event', event: name, ...(body ? { body } : {}) });
  // A TCP adapter's program writes to the adapter's own stdout, like dlv.
  const programOutput = (text: string, category = 'stdout') => (tcp ? process.stdout.write(text) : event('output', { category, output: text }));

  let program = '';
  let flags: string[] = [];
  let stopOnEntry = false;
  let attached = false;
  let pos = -1;
  let thrown = false;
  let ended = false;
  let stops = 0;
  let spinner: NodeJS.Timeout | null = null;
  let nextBpId = 1;
  const lineBps: LineBp[] = [];
  let functionBps: { id: number; name: string; condition?: string }[] = [];
  let filters: string[] = [];
  const handles = new Map<number, unknown>();
  const reverse = new Map<number, (r: Msg) => void>();

  const handle = (v: unknown) => {
    const ref = 1000 + handles.size;
    handles.set(ref, v);
    return ref;
  };
  const describe = (name: string, v: unknown) => {
    if (Array.isArray(v)) return { name, value: `[${v.join(', ')}]`, type: 'list', variablesReference: handle(v), indexedVariables: v.length };
    if (v && typeof v === 'object') return { name, value: `{${Object.keys(v).join(', ')}}`, type: 'dict', variablesReference: handle(v), namedVariables: Object.keys(v).length };
    if (typeof v === 'string') return { name, value: JSON.stringify(v), type: 'str', variablesReference: 0 };
    return { name, value: String(v), type: Number.isInteger(v) ? 'int' : typeof v, variablesReference: 0 };
  };
  const children = (v: unknown) => (Array.isArray(v) ? v.map((x, i) => describe(`[${i}]`, x)) : Object.entries(v as object).map(([k, x]) => describe(k, x)));
  const run = (expr: string, locals: Record<string, unknown>) => new Function(...Object.keys(locals), `return (${expr});`)(...Object.values(locals)) as unknown;
  const holds = (cond: string | undefined, locals: Record<string, unknown>) => {
    if (!cond) return true;
    try {
      return !!run(cond, locals);
    } catch {
      return false;
    }
  };

  /** Frames of thread 1: add is called from line 7. */
  const frames = () => {
    const s = STEPS[pos];
    if (!s) return [];
    const source = { name: program.split(/[\\/]/).pop(), path: program };
    const list = [{ id: stops * 10, name: s.fn, source, line: s.line, column: 1, locals: s.locals }];
    if (s.fn === 'add') list.push({ id: stops * 10 + 1, name: 'main', source, line: 7, column: 1, locals: STEPS[1]!.locals });
    return list;
  };
  const depth = (i: number) => (i < 0 ? 0 : STEPS[i]!.fn === 'add' ? 2 : 1);

  const stop = (reason: string, extra: object = {}) => {
    stops++;
    handles.clear();
    event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...extra });
  };
  const exit = (code: number) => {
    ended = true;
    event('exited', { exitCode: code });
    event('terminated');
  };
  const crash = () => {
    programOutput('Traceback (most recent call last):\nValueError: bad total\n', 'stderr');
    exit(1);
  };
  const hit = (i: number) => {
    const s = STEPS[i]!;
    const line = lineBps.find((b) => b.line === s.line && holds(b.condition, s.locals));
    if (line) return line.id;
    const first = STEPS.findIndex((x) => x.fn === s.fn);
    return functionBps.find((b) => b.name === s.fn && first === i && holds(b.condition, s.locals))?.id;
  };
  const spin = () => {
    pos = 1;
    spinner = setInterval(() => {
      programOutput('tick\n');
      const id = hit(1);
      if (id !== undefined) {
        clearInterval(spinner!);
        spinner = null;
        stop('breakpoint', { hitBreakpointIds: [id] });
      }
    }, 100);
  };

  /** Runs the program from the current step: continue, next, stepIn or stepOut. */
  const resume = (kind: string) => {
    if (thrown) return crash();
    const from = depth(pos);
    if (kind === 'continue' && (attached || (flags.includes('--loop') && pos >= 1))) return spin();
    for (let i = pos + 1; ; i++) {
      const out = i > 0 ? STEPS[i - 1]!.output : undefined;
      if (out) programOutput(out);
      if (i >= STEPS.length) return exit(Number(flags.find((f) => f.startsWith('--exit='))?.slice(7) ?? 0));
      pos = i;
      if (flags.includes('--throw') && STEPS[i]!.line === 3) {
        thrown = true;
        if (filters.includes('uncaught')) return stop('exception', { description: 'Paused on exception', text: 'ValueError' });
        return crash();
      }
      const id = hit(i);
      if (id !== undefined) return stop(functionBps.some((b) => b.id === id) ? 'function breakpoint' : 'breakpoint', { hitBreakpointIds: [id] });
      if (kind === 'continue' && flags.includes('--loop') && i === 1) return spin();
      if (kind === 'stepIn' || (kind === 'next' && depth(i) <= from) || (kind === 'stepOut' && depth(i) < from)) return stop('step');
    }
  };

  const lineBreakpoint = (b: { line: number; condition?: string }) => {
    const line = CODE_LINES.find((l) => l >= b.line);
    if (line === undefined) return { verified: false, message: `Line ${b.line} has no code.` };
    const bp = { id: nextBpId++, line, condition: b.condition };
    lineBps.push(bp);
    return { id: bp.id, verified: true, line, source: { path: program } };
  };

  const answer = async (req: Msg): Promise<{ body?: object } | { error: string; body?: object } | null> => {
    const a = (req.arguments ?? {}) as Msg;
    switch (req.command) {
      case 'initialize':
        return {
          body: {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsConditionalBreakpoints: true,
            supportsExceptionInfoRequest: true,
            supportTerminateDebuggee: true,
            exceptionBreakpointFilters: [
              { filter: 'raised', label: 'Raised Exceptions', default: false },
              { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
            ],
          },
        };
      case 'launch':
      case 'attach':
        program = a.program ?? '';
        flags = (a.args as string[] | undefined) ?? [];
        stopOnEntry = !!a.stopOnEntry;
        attached = req.command === 'attach';
        if (flags.includes('--fail-launch')) {
          process.stderr.write('fake adapter log: the program could not be loaded\n');
          return { error: 'Cannot launch the program: it crashed while loading.' };
        }
        event('output', { category: 'console', output: `fake: ${req.command} ${program}\n` });
        event('output', { category: 'telemetry', output: 'launch' });
        setTimeout(() => event('initialized'), 10);
        return {};
      case 'setBreakpoints': {
        for (let i = lineBps.length - 1; i >= 0; i--) lineBps.splice(i, 1);
        return { body: { breakpoints: ((a.breakpoints as { line: number; condition?: string }[]) ?? []).map(lineBreakpoint) } };
      }
      case 'setFunctionBreakpoints': {
        const list = (a.breakpoints as { name: string; condition?: string }[]) ?? [];
        functionBps = [];
        const out = list.map((b) => {
          const first = STEPS.find((s) => s.fn === b.name);
          if (!first) return { verified: false, message: `No function named ${b.name}.` };
          const bp = { id: nextBpId++, name: b.name, condition: b.condition };
          functionBps.push(bp);
          return { id: bp.id, verified: true, line: first.line, source: { path: program } };
        });
        return { body: { breakpoints: out } };
      }
      case 'setExceptionBreakpoints':
        filters = (a.filters as string[]) ?? [];
        return {};
      case 'configurationDone':
        setTimeout(async () => {
          event('thread', { reason: 'started', threadId: 2 });
          if (flags.includes('--run-in-terminal')) {
            const r = await ask('runInTerminal', { kind: 'integrated', title: 'fake', cwd: a.cwd ?? process.cwd(), args: [process.execPath, '-e', "console.log('from the terminal program')"] });
            event('output', { category: 'console', output: `runInTerminal: ${r.success ? `processId ${r.body?.processId}` : `refused (${r.message})`}\n` });
            const d = await ask('startDebugging', { request: 'launch', configuration: {} });
            event('output', { category: 'console', output: `startDebugging: ${d.success ? 'accepted' : `refused (${d.message})`}\n` });
          }
          if (attached) spin();
          else if (stopOnEntry) {
            pos = 0;
            stop('entry');
          } else resume('continue');
        }, 10);
        return {};
      case 'threads':
        return { body: { threads: [{ id: 1, name: 'MainThread' }, { id: 2, name: 'Worker' }] } };
      case 'stackTrace': {
        if (a.threadId === 2) return { body: { stackFrames: [{ id: 999, name: 'worker_idle', line: 0, column: 0 }], totalFrames: 1 } };
        const list = frames().map(({ locals: _l, ...f }) => f);
        return { body: { stackFrames: list.slice(a.startFrame ?? 0, (a.startFrame ?? 0) + (a.levels || list.length)), totalFrames: list.length } };
      }
      case 'scopes': {
        const f = frames().find((x) => x.id === a.frameId);
        if (!f) return { error: `Unknown frame ${a.frameId}.` };
        // Like debugpy, which files dunder names under a pseudo variable.
        const locals = f.name === 'add' ? { ...f.locals, 'special variables': { __name__: 'add' } } : f.locals;
        return {
          body: {
            scopes: [
              { name: 'Locals', variablesReference: handle(locals), namedVariables: Object.keys(locals).length, expensive: false },
              { name: 'Globals', variablesReference: handle(GLOBALS), namedVariables: Object.keys(GLOBALS).length, expensive: false },
            ],
          },
        };
      }
      case 'variables': {
        const v = handles.get(a.variablesReference);
        if (v === undefined) return { error: `Unknown variablesReference ${a.variablesReference}.` };
        const all = children(v);
        const start = a.start ?? 0;
        return { body: { variables: all.slice(start, a.count ? start + a.count : undefined) } };
      }
      case 'evaluate': {
        const expr = String(a.expression);
        if (expr === 'crash') process.exit(3);
        const f = a.frameId !== undefined ? frames().find((x) => x.id === a.frameId) : frames()[0];
        const locals = f?.locals ?? {};
        if (a.context === 'repl') {
          if (expr === 'cont') {
            setTimeout(() => resume('continue'), 10);
            return { body: { result: 'continuing', variablesReference: 0 } };
          }
          const assign = /^(\w+)\s*=\s*(.+)$/.exec(expr);
          if (assign) {
            locals[assign[1]!] = run(assign[2]!, locals);
            return { body: { result: '', variablesReference: 0 } };
          }
        }
        try {
          const d = describe('', run(expr, locals));
          return { body: { result: d.value, type: d.type, variablesReference: d.variablesReference, namedVariables: d.namedVariables, indexedVariables: d.indexedVariables } };
        } catch (e) {
          return { error: `${(e as Error).name}: ${(e as Error).message}` };
        }
      }
      case 'exceptionInfo':
        return { body: { exceptionId: 'ValueError', description: 'bad total', breakMode: 'unhandled' } };
      case 'continue':
      case 'next':
      case 'stepIn':
      case 'stepOut':
        if (ended) return { error: 'The program is not running.' };
        setTimeout(() => resume(req.command), 10);
        return req.command === 'continue' ? { body: { allThreadsContinued: true } } : {};
      case 'pause':
        if (spinner) {
          clearInterval(spinner);
          spinner = null;
          setTimeout(() => stop('pause'), 10);
        }
        return {};
      case 'disconnect':
        send({ type: 'response', request_seq: req.seq, command: req.command, success: true }, () => process.exit(0));
        return null;
      case 'hang':
        return null;
      case 'slow':
        await new Promise((r) => setTimeout(r, 100));
        return { body: { n: a.n } };
      case 'fast':
        return { body: { n: a.n } };
      case 'failFormatted':
        return { error: 'generic failure', body: { error: { id: 7, format: 'Could not find {name} in {where}', variables: { name: 'x', where: 'scope' } } } };
      default:
        return { error: `Unknown request: ${req.command}` };
    }
  };

  const ask = (command: string, args: object) =>
    new Promise<Msg>((resolve) => {
      reverse.set(seq, resolve);
      send({ type: 'request', command, arguments: args });
    });

  const receive = async (msg: Msg) => {
    log(msg);
    if (msg.type === 'response') {
      reverse.get(msg.request_seq)?.(msg);
      return;
    }
    if (msg.type !== 'request') return;
    const r = await answer(msg);
    if (!r) return;
    if ('error' in r) send({ type: 'response', request_seq: msg.seq, command: msg.command, success: false, message: r.error, ...(r.body ? { body: r.body } : {}) });
    else send({ type: 'response', request_seq: msg.seq, command: msg.command, success: true, ...(r.body ? { body: r.body } : {}) });
  };

  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(buf.subarray(0, end).toString('ascii'))?.[1] ?? NaN);
      if (Number.isNaN(length) || buf.length < end + 4 + length) return;
      const msg = JSON.parse(buf.subarray(end + 4, end + 4 + length).toString('utf8')) as Msg;
      buf = buf.subarray(end + 4 + length);
      void receive(msg);
    }
  };

  if (!tcp) {
    // Text outside the protocol, which the client has to skip.
    process.stdout.write('fake adapter starting\n');
    process.stdin.on('data', onData);
    process.stdin.on('end', () => process.exit(0));
    return;
  }
  const server = net.createServer((socket) => {
    server.close();
    write = (b, done) => socket.write(b, done);
    socket.on('data', onData);
    socket.on('close', () => process.exit(0));
    socket.on('error', () => process.exit(0));
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo;
    process.stdout.write(`DAP server listening at: 127.0.0.1:${port}\n`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

// Tests for the Debug Adapter Protocol client and the Debugger tool's DAP sessions. Most run against
// test/helpers/fakeDap.ts; the last one uses the real debugpy and is skipped when it is not installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, MessageReader, type DapMessage } from '../src/dap/protocol.js';
import { DapClient } from '../src/dap/client.js';
import { chooseBackend, classifyProgram, findLldbDap, installHint, parseAdapter, registerAdapter, TYPESCRIPT_ERROR, type AdapterSpec } from '../src/dap/adapters.js';
import { DebuggerTool, stopDebugSession } from '../src/tools/debugger.js';
import { findPython } from '../src/tools/repl.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { isWindows } from '../src/util/platform.js';
import type { SessionState, ToolContext, ToolResult } from '../src/tools/types.js';
import { FAKE_PROGRAM } from './helpers/fakeDap.js';

const FAKE = fileURLToPath(new URL('./helpers/fakeDap.js', import.meta.url));
// The real path: adapters report it, and on Windows the temp folder can come as a short 8.3 name.
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'fc-dap-')));
const logFile = path.join(dir, 'requests.jsonl');
const progress: string[] = [];
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
const ctx = {
  projectRoot: dir,
  session,
  settings: { env: {} },
  files: new FileTracker(false),
  signal: new AbortController().signal,
  toolCallId: 't',
  services: { progress: (t: string) => progress.push(t) },
  depth: 0,
} as never as ToolContext;

const fakeSpec = (name: string, transport: 'stdio' | 'tcp'): AdapterSpec => ({
  name,
  kind: 'native',
  command: process.execPath,
  args: [FAKE, ...(transport === 'tcp' ? ['--tcp'] : [])],
  transport,
  adapterID: 'fake',
  env: { FAKE_DAP_LOG: logFile },
  launchArgs: (t) => ({ program: t.program, args: t.args, cwd: t.cwd, stopOnEntry: t.stopOnEntry }),
  attachArgs: (a) => ({ processId: a.pid, program: a.program, args: [] }),
});
registerAdapter('fake', fakeSpec('fake', 'stdio'));
registerAdapter('fake-tcp', { ...fakeSpec('fake-tcp', 'tcp'), attachByPort: true });
writeFileSync(path.join(dir, 'calc.fake'), FAKE_PROGRAM);

after(() => stopDebugSession(session));

async function call(input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await DebuggerTool.prepare(input, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  return prep.execute();
}

/** What the fake adapter received since the log was last cleared. */
function received(): Record<string, any>[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}
const requests = () => received().filter((m) => m.type === 'request');
const clearLog = () => writeFileSync(logFile, '');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ------------------------------------------------------------------ protocol

test('DAP framing: messages split at any byte, with text around them and multi-byte characters', () => {
  const a = { seq: 1, type: 'event', event: 'output', body: { output: 'grüße € 你好\n' } };
  const b = { seq: 2, type: 'response', request_seq: 1, success: true, command: 'threads', body: { threads: [] } };
  const wire = Buffer.concat([Buffer.from('adapter says hi\n'), encodeMessage(a), encodeMessage(b)]);
  assert.match(encodeMessage(a).toString('latin1'), new RegExp(`^Content-Length: ${Buffer.byteLength(JSON.stringify(a))}\\r\\n\\r\\n`));
  for (let cut = 0; cut <= wire.length; cut++) {
    const r = new MessageReader();
    const got = [...r.push(wire.subarray(0, cut)), ...r.push(wire.subarray(cut))];
    assert.deepEqual(got, [a, b], `split at byte ${cut}`);
    assert.equal(r.junk, 'adapter says hi\n');
  }
  const bytewise = new MessageReader();
  const got: DapMessage[] = [];
  for (const byte of wire) got.push(...bytewise.push(Buffer.from([byte])));
  assert.deepEqual(got, [a, b]);
});

test('DAP framing: other headers, a broken body and a block without Content-Length are skipped', () => {
  const r = new MessageReader();
  const ok = { seq: 3, type: 'event', event: 'initialized' };
  const json = JSON.stringify(ok);
  const text = `X-Note: none\r\n\r\ncontent-length: 5\r\n\r\n{nope` + `Content-Type: application/json\r\nContent-Length: ${json.length}\r\n\r\n${json}`;
  assert.deepEqual(r.push(Buffer.from(text)), [ok]);
  assert.match(r.junk, /X-Note: none/);
  assert.match(r.junk, /\{nope/);
});

// ------------------------------------------------------------------ client

test('DAP client: requests with seq, out of order answers, errors, timeouts, events and a crash', async () => {
  clearLog();
  const client = await DapClient.start({ command: process.execPath, args: [FAKE], cwd: dir, env: { ...process.env, FAKE_DAP_LOG: logFile }, transport: 'stdio' });
  const events: string[] = [];
  client.on((e) => events.push(e.event));
  const caps = await client.request<Record<string, unknown>>('initialize', { adapterID: 'fake', linesStartAt1: true });
  assert.equal(caps.supportsConfigurationDoneRequest, true);

  const [slow, fast] = await Promise.all([client.request('slow', { n: 1 }), client.request('fast', { n: 2 })]);
  assert.deepEqual([slow, fast], [{ n: 1 }, { n: 2 }], 'answers are matched by request_seq, not by order');
  const seqs = requests().map((m) => m.seq as number);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, seqs.length);

  await assert.rejects(client.request('nosuch'), { message: 'Unknown request: nosuch' });
  await assert.rejects(client.request('failFormatted'), { message: 'Could not find x in scope' });
  await assert.rejects(client.request('hang', {}, 200), { message: 'The debug adapter did not answer hang within 200ms.' });

  const initialized = client.waitForEvent('initialized', 5000);
  await client.request('launch', { program: path.join(dir, 'calc.fake'), args: [], stopOnEntry: true });
  await initialized;
  const stopped = client.waitForEvent<{ reason: string }>('stopped', 5000);
  await client.request('configurationDone');
  assert.equal((await stopped).reason, 'entry');
  for (const e of ['initialized', 'output', 'thread', 'stopped']) assert.ok(events.includes(e), `${e} event`);
  assert.match(client.diagnostics, /fake adapter starting/, 'text outside the protocol is kept for error reports');
  assert.match(client.diagnostics, /fake adapter log: started/, 'stderr too');

  const gone = new Promise<void>((resolve) => client.onClose(resolve));
  await assert.rejects(client.request('evaluate', { expression: 'crash' }), { message: 'The debug adapter exited with code 3.' });
  await gone;
  await assert.rejects(client.request('threads'), { message: 'The debug adapter exited with code 3.' });
  await assert.rejects(client.waitForEvent('stopped', 5000), { message: 'The debug adapter exited with code 3.' });
  client.close();

  await assert.rejects(DapClient.start({ command: path.join(dir, 'no-such-adapter'), args: [], cwd: dir, env: process.env, transport: 'stdio' }), /no-such-adapter was not found/);
});

test('DAP client: an adapter started through a .cmd shim on Windows', { skip: !isWindows && 'Windows only' }, async () => {
  const shim = path.join(dir, 'fake adapter.cmd');
  writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`);
  const client = await DapClient.start({ command: shim, args: [], cwd: dir, env: process.env, transport: 'stdio' });
  const caps = await client.request<Record<string, unknown>>('initialize', { adapterID: 'fake' });
  assert.equal(caps.supportsConfigurationDoneRequest, true);
  client.close();
});

// ------------------------------------------------------------------ Debugger tool with the fake adapter

test('Debugger over DAP: entry stop, breakpoints, variables, eval, stepping and the exit', async () => {
  clearLog();
  const start = await call({ action: 'start', program: 'calc.fake', adapter: 'fake' });
  assert.equal(start.isError, false, start.content);
  assert.equal(
    start.content,
    [
      'Started calc.fake with fake.',
      'Paused on entry at calc.fake:6 in main',
      '  4  }',
      '  5  ',
      '> 6  const data = { x: 1, items: [4, 5] };',
      '  7  const result = add(2, 3);',
      "  8  print('result', result);",
      'Stack:',
      '  #0 main at calc.fake:6',
    ].join('\n'),
  );
  const launch = requests().find((m) => m.command === 'launch')!;
  assert.equal(launch.arguments.stopOnEntry, true);
  assert.deepEqual(
    requests().map((m) => m.command).slice(0, 4),
    ['initialize', 'launch', 'setExceptionBreakpoints', 'configurationDone'],
    'the configuration requests come between launch and configurationDone',
  );
  assert.deepEqual(requests().find((m) => m.command === 'setExceptionBreakpoints')!.arguments.filters, ['uncaught'], 'only the filters the adapter enables by default');

  const cond = await DebuggerTool.prepare({ action: 'break', location: 'calc.fake:2', condition: 'a > 1' }, ctx);
  assert.equal(cond.permission?.title, 'Conditional breakpoint');
  assert.equal(cond.permission?.ruleSuggestion, 'Debugger(native)');
  assert.equal((await cond.execute()).content, 'Breakpoint set at calc.fake:2 when a > 1.');
  assert.equal((await call({ action: 'break', location: 'calc.fake:4' })).content, 'Breakpoint set at calc.fake:4 (moved to line 6, the nearest line with code).');
  assert.equal((await call({ action: 'break', file: 'calc.fake', line: 50 })).content, 'Breakpoint at calc.fake:50 is not active yet (Line 50 has no code). It may bind once that code is loaded.');
  const sent = requests().filter((m) => m.command === 'setBreakpoints').at(-1)!;
  assert.deepEqual(sent.arguments.breakpoints, [{ line: 2, condition: 'a > 1' }, { line: 4 }, { line: 50 }], 'every breakpoint of the file is sent each time');

  const hit = await call({ action: 'continue' });
  assert.equal(
    hit.content,
    [
      'Hit breakpoint at calc.fake:2 in add',
      '  1  function add(a, b) {',
      '> 2    const total = a + b;',
      '  3    return total;',
      '  4  }',
      'Stack:',
      '  #0 add at calc.fake:2',
      '  #1 main at calc.fake:7',
    ].join('\n'),
  );

  const vars = await call({ action: 'vars' });
  assert.equal(vars.content, '#0 add at calc.fake:2\nLocals:\n  a = 2 (int)\n  b = 3 (int)\nOther scopes: Globals (pass scope to list them).');
  const outer = await call({ action: 'vars', frame: 1, depth: 2 });
  assert.equal(
    outer.content,
    ['#1 main at calc.fake:7', 'Locals:', '  data = {x, items} (dict)', '    x = 1 (int)', '    items = [4, 5] (list)', '      [0] = 4 (int)', '      [1] = 5 (int)', 'Other scopes: Globals (pass scope to list them).'].join('\n'),
  );
  const globals = await call({ action: 'vars', scope: 'globals' });
  assert.match(globals.content, /^#0 add at calc\.fake:2\nGlobals:\n  G0 = 0 \(int\)\n/);
  assert.match(globals.content, /\n  G59 = 59 \(int\)\n  \.\.\. 5 more\nOther scopes: Locals/, 'long scopes are cut and say how much is left');
  const paged = requests().filter((m) => m.command === 'variables').at(-1)!;
  assert.deepEqual([paged.arguments.start, paged.arguments.count], [0, 61]);

  const ev = await DebuggerTool.prepare({ action: 'eval', expression: 'a * 10' }, ctx);
  assert.equal(ev.permission?.title, 'Debugger expression');
  assert.equal((await ev.execute()).content, 'a * 10 = 20 (int)');
  assert.equal((await call({ action: 'eval', expression: '({ k: [1, 2] })' })).content, '({ k: [1, 2] }) = {k} (dict)\n  k = [1, 2] (list)');
  const bad = await call({ action: 'eval', expression: 'nosuch' });
  assert.equal(bad.isError, true);
  assert.equal(bad.content, 'ReferenceError: nosuch is not defined');
  assert.equal(requests().filter((m) => m.command === 'evaluate').at(-1)!.arguments.context, 'watch');
  assert.equal((await call({ action: 'send', command: 'a = 7' })).content, '(no output)');
  assert.equal(requests().filter((m) => m.command === 'evaluate').at(-1)!.arguments.context, 'repl', 'send goes to the debug console');
  assert.equal((await call({ action: 'eval', expression: 'a' })).content, 'a = 7 (int)');

  assert.equal((await call({ action: 'stack' })).content, 'Thread 1:\n  #0 add at calc.fake:2\n  #1 main at calc.fake:7');
  assert.equal((await call({ action: 'stack', thread: 2 })).content, 'Thread 2:\n  #0 worker_idle (no source)');
  assert.equal((await call({ action: 'threads' })).content, 'Threads (* stopped):\n* 1  MainThread\n  2  Worker');

  assert.match((await call({ action: 'next' })).content, /^Stepped to calc\.fake:3 in add\n[\s\S]*> 3    return total;/);
  assert.match((await call({ action: 'step_out' })).content, /^Stepped to calc\.fake:8 in main\n/);
  const end = await call({ action: 'continue' });
  assert.equal(end.isError, false);
  assert.equal(end.content, 'Program output:\nresult 5\nThe program exited with code 0. The debug session is over.');
  assert.equal(requests().at(-1)!.command, 'disconnect');
  assert.equal(requests().at(-1)!.arguments.terminateDebuggee, true);
  assert.match((await DebuggerTool.prepare({ action: 'vars' }, ctx)).error?.content ?? '', /No debug session is running/);
});

test('Debugger over DAP: breakpoints given with start, function breakpoints and clear', async () => {
  clearLog();
  const start = await call({ action: 'start', program: 'calc.fake', adapter: 'fake', breakpoints: ['add'] });
  assert.match(start.content, /^Started calc\.fake with fake\.\nHit breakpoint at calc\.fake:2 in add\n/);
  const order = requests().map((m) => m.command);
  assert.ok(order.indexOf('setFunctionBreakpoints') > order.indexOf('launch') && order.indexOf('setFunctionBreakpoints') < order.indexOf('configurationDone'));
  assert.equal(requests().find((m) => m.command === 'launch')!.arguments.stopOnEntry, false, 'with breakpoints the program runs to the first one');
  assert.equal((await call({ action: 'break', location: 'calc.fake:8' })).content, 'Breakpoint set at calc.fake:8.');
  assert.equal((await call({ action: 'clear', location: 'add' })).content, 'Removed 1 breakpoint at add.');
  assert.match((await call({ action: 'continue' })).content, /^Hit breakpoint at calc\.fake:8 in main\n/);
  assert.equal((await call({ action: 'clear', location: 'calc.fake:3' })).content, 'There is no breakpoint at calc.fake:3.');
  assert.equal((await call({ action: 'clear' })).content, 'Removed 1 breakpoint.');
  assert.match((await call({ action: 'continue' })).content, /The program exited with code 0/);

  // A breakpoint the program never reaches.
  const missed = await call({ action: 'start', program: 'calc.fake', adapter: 'fake', breakpoints: [{ file: 'calc.fake', line: 2, condition: 'a > 5' }] });
  assert.equal(missed.content, 'Started calc.fake with fake.\nProgram output:\nresult 5\nThe program exited with code 0. The debug session is over.\nNo breakpoint was hit.');
});

test('Debugger over DAP: an uncaught exception stops the program, then it fails', async () => {
  await call({ action: 'start', program: 'calc.fake', adapter: 'fake', args: ['--throw'] });
  const stop = await call({ action: 'continue' });
  assert.match(stop.content, /^Stopped on exception \(ValueError: bad total\) at calc\.fake:3 in add\n/);
  const end = await call({ action: 'continue' });
  assert.equal(end.isError, true);
  assert.equal(end.content, 'Program output:\nTraceback (most recent call last):\nValueError: bad total\nThe program exited with code 1. The debug session is over.');
});

test('Debugger over DAP: pause breaks into a running program; stop ends the adapter', async () => {
  clearLog();
  await call({ action: 'start', program: 'calc.fake', adapter: 'fake', args: ['--loop'] });
  const pid = received().find((m) => m.started)!.started as number;
  progress.length = 0;
  const running = await call({ action: 'continue', timeout: 1000 });
  assert.match(running.content, /^Program output:\ntick\n/);
  assert.match(running.content, /\[The program is still running after 1\.0s\. Use action "pause" to break in/);
  assert.ok(progress.some((p) => p.includes('tick')), 'output is shown while waiting');
  const busy = await call({ action: 'vars' });
  assert.equal(busy.isError, true);
  assert.match(busy.content, /The program is running/);
  const paused = await call({ action: 'pause' });
  assert.match(paused.content, /Paused at calc\.fake:7 in main\n/);
  assert.match((await call({ action: 'pause' })).content, /^The program is already paused\.\nPaused at calc\.fake:7 in main/);
  assert.equal((await call({ action: 'stop' })).content.split('\n').at(-1), 'Debug session stopped.');
  const last = requests().at(-1)!;
  assert.equal(last.command, 'disconnect');
  assert.deepEqual(last.arguments, { terminateDebuggee: true, restart: false });
  await waitFor(() => !alive(pid));
  assert.equal((await call({ action: 'stop' })).content, 'No debug session is running.');
});

test('Debugger over DAP: runInTerminal starts the program without a terminal; other reverse requests are refused', async () => {
  clearLog();
  const start = await call({ action: 'start', program: 'calc.fake', adapter: 'fake', args: ['--run-in-terminal'], breakpoints: ['calc.fake:8'] });
  assert.match(start.content, /runInTerminal: processId \d+/);
  assert.match(start.content, /startDebugging: refused \(FreeCode does not support the startDebugging request\.\)/);
  const answer = received().find((m) => m.type === 'response' && m.command === 'runInTerminal')!;
  assert.equal(answer.success, true);
  // The program's output arrives as program output, possibly after the stop.
  let seen = start.content;
  for (let i = 0; i < 100 && !seen.includes('from the terminal program'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    seen += (await call({ action: 'send' })).content;
  }
  assert.match(seen, /from the terminal program/);
  await call({ action: 'stop' });
});

test('Debugger over DAP: an adapter on TCP is reached at the address it prints', async () => {
  clearLog();
  const start = await call({ action: 'start', program: 'calc.fake', adapter: 'fake-tcp', breakpoints: ['calc.fake:3'] });
  assert.match(start.content, /^Started calc\.fake with fake-tcp\.\nHit breakpoint at calc\.fake:3 in add\n/);
  assert.equal(received()[0]!.transport, 'tcp');
  assert.equal((await call({ action: 'eval', expression: 'total' })).content, 'total = 5 (int)');
  assert.equal((await call({ action: 'continue' })).content, 'Program output:\nresult 5\nThe program exited with code 0. The debug session is over.');
});

test('Debugger over DAP: attach to a running process, then detach', async () => {
  clearLog();
  const prep = await DebuggerTool.prepare({ action: 'start', pid: 4242, adapter: 'fake', program: 'calc.fake' }, ctx);
  assert.equal(prep.permission?.title, 'Attach debugger');
  assert.equal(prep.permission?.subject, 'fake attach to process 4242');
  assert.equal(DebuggerTool.label({ action: 'start', pid: 4242 }, { cwd: dir, projectRoot: dir }), 'Debugger(attach 4242)');
  const r = await prep.execute();
  assert.match(r.content, /^Attached fake to process 4242\.\nProgram output:\n(tick\n)+The program is running\. Set breakpoints with break/);
  const attach = requests().find((m) => m.command === 'attach')!;
  assert.equal(attach.arguments.processId, 4242);
  assert.ok(!requests().some((m) => m.command === 'launch'));
  assert.equal((await call({ action: 'break', location: 'calc.fake:7' })).content, 'Breakpoint set at calc.fake:7.');
  assert.match((await call({ action: 'continue' })).content, /Hit breakpoint at calc\.fake:7 in main/);
  assert.match((await call({ action: 'stop' })).content, /Debugger detached\. The program keeps running\.$/);
  const detach = requests().slice(-3);
  assert.deepEqual(
    detach.map((m) => m.command),
    ['setBreakpoints', 'continue', 'disconnect'],
    'the attached program is left running and without our breakpoints (dlv --headless keeps both otherwise)',
  );
  assert.deepEqual(detach[0]!.arguments.breakpoints, []);
  assert.equal(detach[2]!.arguments.terminateDebuggee, false, 'an attached process is not killed');

  assert.match((await DebuggerTool.prepare({ action: 'start', port: 5678, adapter: 'fake' }, ctx)).error?.content ?? '', /^port works with debugpy/);
  assert.match((await DebuggerTool.prepare({ action: 'start', pid: 1, adapter: 'pdb' }, ctx)).error?.content ?? '', /^Attaching works with debugpy, lldb-dap, netcoredbg and dlv/);
  assert.match((await DebuggerTool.prepare({ action: 'start', pid: -3, adapter: 'fake' }, ctx)).error?.content ?? '', /^pid must be the id of a running process/);
});

test('Debugger over DAP: attach on a port to the adapter a program started itself', async () => {
  clearLog();
  // Like python -m debugpy --listen: the adapter is already running and listening.
  const server = spawn(process.execPath, [FAKE, '--tcp'], { env: { ...process.env, FAKE_DAP_LOG: logFile }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    let printed = '';
    server.stdout!.setEncoding('utf8');
    server.stdout!.on('data', (s: string) => (printed += s));
    await waitFor(() => /listening at: 127\.0\.0\.1:\d+\n/.test(printed));
    const port = Number(/:(\d+)\n/.exec(printed)![1]);
    const prep = await DebuggerTool.prepare({ action: 'start', port: String(port), adapter: 'fake-tcp', program: 'calc.fake' }, ctx);
    assert.equal(prep.permission?.subject, `fake-tcp attach to 127.0.0.1:${port}`);
    const r = await prep.execute();
    assert.equal(r.content, `Attached fake-tcp to 127.0.0.1:${port}.\nThe program is running. Set breakpoints with break, then use continue to wait for one to hit, or pause to break in.`);
    assert.equal(received().filter((m) => m.started).length, 1, 'no second adapter was started');
    assert.ok(requests().some((m) => m.command === 'attach'));
    assert.match((await call({ action: 'pause' })).content, /^Paused at calc\.fake:7 in main\n/);
    assert.match((await call({ action: 'stop' })).content, /^Debugger detached\. The program keeps running\.$/);
    assert.equal(requests().at(-1)!.command, 'disconnect');
    assert.equal(requests().at(-1)!.arguments.terminateDebuggee, false);
  } finally {
    server.kill();
  }

  const unused = net.createServer();
  await new Promise<void>((resolve) => unused.listen(0, '127.0.0.1', resolve));
  const closedPort = (unused.address() as net.AddressInfo).port;
  await new Promise((resolve) => unused.close(resolve));
  const refused = await call({ action: 'start', port: closedPort, adapter: 'fake-tcp' });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /^Could not connect to 127\.0\.0\.1:\d+ \(.*ECONNREFUSED.*\)\. Is the program listening there\?$/);
});

test('Debugger over DAP: a launch the adapter refuses and an adapter that dies are reported', async () => {
  const failed = await call({ action: 'start', program: 'calc.fake', adapter: 'fake', args: ['--fail-launch'] });
  assert.equal(failed.isError, true);
  assert.match(failed.content, /^fake could not run the program: Cannot launch the program: it crashed while loading\.\n/);
  assert.match(failed.content, /Adapter log:\n[\s\S]*the program could not be loaded/);
  assert.match((await DebuggerTool.prepare({ action: 'threads' }, ctx)).error?.content ?? '', /No debug session is running/);

  await call({ action: 'start', program: 'calc.fake', adapter: 'fake' });
  const crash = await call({ action: 'eval', expression: 'crash' });
  assert.equal(crash.isError, true);
  assert.match(crash.content, /^The debug adapter stopped unexpectedly: The debug adapter exited with code 3\.\n[\s\S]*fake adapter log: started/);
  assert.match((await DebuggerTool.prepare({ action: 'threads' }, ctx)).error?.content ?? '', /No debug session is running/);
});

test('Debugger over DAP: a console command that resumes the program waits for the next stop', async () => {
  await call({ action: 'start', program: 'calc.fake', adapter: 'fake', breakpoints: ['calc.fake:7'] });
  await call({ action: 'break', location: 'calc.fake:3' });
  const r = await call({ action: 'send', command: 'cont' });
  assert.match(r.content, /^continuing\nHit breakpoint at calc\.fake:3 in add/);
  await call({ action: 'stop' });
});

// ------------------------------------------------------------------ choosing an adapter

test('Debugger: which debugger fits a program', () => {
  const file = (name: string, content: string | Buffer) => {
    const p = path.join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  assert.deepEqual(classifyProgram(path.join(dir, 'app.ts')), { error: TYPESCRIPT_ERROR });
  assert.match((classifyProgram(path.join(dir, 'missing.py')) as { error: string }).error, /File not found/);
  assert.deepEqual(classifyProgram(file('a.py', 'print(1)\n')), { kind: 'python', program: path.join(dir, 'a.py') });
  assert.equal((classifyProgram(file('a.mjs', '')) as { kind: string }).kind, 'node');
  assert.equal((classifyProgram(file('main.go', 'package main\n')) as { kind: string }).kind, 'go');
  assert.equal((classifyProgram(file('elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))) as { kind: string }).kind, 'native');
  assert.equal((classifyProgram(file('tool.exe', Buffer.from('MZ\x90\x00'))) as { kind: string }).kind, 'native');
  file('App.exe', Buffer.from('MZ\x90\x00'));
  file('App.dll', 'dll');
  file('App.runtimeconfig.json', '{}');
  assert.deepEqual(classifyProgram(path.join(dir, 'App.exe')), { kind: 'csharp', program: path.join(dir, 'App.dll') }, 'the apphost of a .NET program runs its .dll');
  assert.match((classifyProgram(file('Lib.dll', 'dll')) as { error: string }).error, /is a library/);
  assert.equal((classifyProgram(file('script', '#!/usr/bin/env python3\nprint(1)\n')) as { kind: string }).kind, 'python');
  assert.match((classifyProgram(file('main.c', 'int main(){}\n')) as { error: string }).error, /Compile it with debug info first, for example `cc -g -O0 main\.c -o main`/);
  assert.match((classifyProgram(file('lib.rs', '')) as { error: string }).error, /cargo build/);
  assert.match((classifyProgram(file('notes.txt', 'hello')) as { error: string }).error, /Cannot tell how to debug notes\.txt/);
  const pkg = path.join(dir, 'gopkg');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'go.mod'), 'module x\n');
  assert.equal((classifyProgram(pkg) as { kind: string }).kind, 'go');

  assert.equal(parseAdapter(undefined), 'auto');
  assert.equal(parseAdapter('LLDB'), 'lldb-dap');
  assert.equal(parseAdapter('c++'), 'lldb-dap');
  assert.equal(parseAdapter('Delve'), 'dlv');
  assert.equal(parseAdapter('C#'), 'netcoredbg');
  assert.equal(parseAdapter('node inspect'), 'node');
  assert.equal(parseAdapter('fake'), 'fake');
  assert.equal(parseAdapter('gdb'), null);
});

test('Debugger: a missing adapter is found on PATH, or the error says what to install', async () => {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    const r = await chooseBackend(path.join(dir, 'App.dll'), 'auto');
    assert.equal((r as { error: string }).error, installHint('csharp'));
    assert.match(installHint('csharp'), /https:\/\/github\.com\/Samsung\/netcoredbg\/releases/);
    assert.match(installHint('go'), /go install github\.com\/go-delve\/delve\/cmd\/dlv@latest/);
    assert.match(installHint('python'), /-m pip install debugpy/);
    assert.match(installHint('native'), /lldb-dap/);
    // A Windows .exe (or a shim on PATHEXT) and a plain executable elsewhere.
    writeFileSync(path.join(bin, isWindows ? 'lldb-dap.exe' : 'lldb-dap'), '');
    assert.equal(path.basename(findLldbDap() ?? '').toLowerCase(), isWindows ? 'lldb-dap.exe' : 'lldb-dap');
    const prep = await DebuggerTool.prepare({ action: 'start', program: 'App.dll' }, ctx);
    assert.equal(prep.error?.content, installHint('csharp'));
  } finally {
    process.env.PATH = saved;
  }
});

// ------------------------------------------------------------------ Python

const python = await findPython();
const debugpyCheck = spawnSync(isWindows ? 'python' : 'python3', ['-c', 'import debugpy'], { windowsHide: true, timeout: 60_000 });
const hasDebugpy = debugpyCheck.status === 0;

test('Debugger: Python without debugpy falls back to pdb and says how to install debugpy', { skip: !python ? 'no Python 3 interpreter found' : hasDebugpy && 'debugpy is installed' }, async () => {
  writeFileSync(path.join(dir, 'hello.py'), 'x = 1\nprint("hello", x)\n');
  const prep = await DebuggerTool.prepare({ action: 'start', program: 'hello.py' }, ctx);
  assert.equal(prep.permission?.ruleSuggestion, 'Debugger(python)');
  assert.match(prep.permission?.subject ?? '', /^python -m pdb hello\.py/);
  const r = await prep.execute();
  assert.match(r.content, /^debugpy is not installed\. Install it with: python3? -m pip install debugpy\./);
  assert.match(r.content, /hello\.py\(1\)<module>\(\)/);
  assert.match((await call({ action: 'stop' })).content, /Debug session stopped/);
});

test('Debugger with the real debugpy: breakpoints, variables, eval, stepping and an exception', { skip: !hasDebugpy && 'debugpy is not installed (python3 -m pip install debugpy)' }, async () => {
  const py = path.join(dir, 'calc.py');
  writeFileSync(
    py,
    ['def add(a, b):', '    total = a + b', '    return total', '', '', 'data = {"x": 1, "items": [4, 5]}', 'result = add(2, 3)', 'print("result", result)', 'for v in [4, 0]:', '    print(8 / v)', ''].join('\n'),
  );
  const prep = await DebuggerTool.prepare({ action: 'start', program: 'calc.py', timeout: 60_000 }, ctx);
  assert.match(prep.permission?.subject ?? '', /^debugpy calc\.py/);
  const start = await prep.execute();
  assert.equal(start.isError, false, start.content);
  assert.match(start.content, /^Started calc\.py with debugpy\.\nPaused on entry at (.*[\\/])?calc\.py:1 in <module>\n> 1  def add\(a, b\):/);

  assert.match((await call({ action: 'break', location: 'calc.py:3', condition: 'total == 5' })).content, /^Breakpoint set at calc\.py:3 when total == 5\.$/);
  const hit = await call({ action: 'continue', timeout: 60_000 });
  assert.match(hit.content, /^Hit breakpoint at (.*[\\/])?calc\.py:3 in add\n/);
  assert.match(hit.content, /^> 3      return total$/m);
  assert.match(hit.content, /#1 <module> at (.*[\\/])?calc\.py:7/);

  const vars = await call({ action: 'vars' });
  assert.match(vars.content, /^  a = 2 \(int\)$/m);
  assert.match(vars.content, /^  total = 5 \(int\)$/m);
  assert.doesNotMatch(vars.content, /special variables/);
  const outer = await call({ action: 'vars', frame: 1 });
  assert.match(outer.content, /^  data = \{'x': 1, 'items': \[4, 5\]\} \(dict\)$/m);
  assert.match(outer.content, /^    'x' = 1 \(int\)$/m);

  assert.equal((await call({ action: 'eval', expression: 'a * 10' })).content, 'a * 10 = 20 (int)');
  const bad = await call({ action: 'eval', expression: 'nosuch' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /NameError/);
  await call({ action: 'send', command: 'a = 100' });
  assert.equal((await call({ action: 'eval', expression: 'a' })).content, 'a = 100 (int)');

  assert.match((await call({ action: 'step_out', timeout: 60_000 })).content, /^Stepped to (.*[\\/])?calc\.py:7 in <module>\n/);
  assert.match((await call({ action: 'next', timeout: 60_000 })).content, /^Stepped to (.*[\\/])?calc\.py:8 in <module>\n/);
  const boom = await call({ action: 'continue', timeout: 60_000 });
  assert.match(boom.content, /^Program output:\nresult 5\n2\.0\n/);
  assert.match(boom.content, /Stopped on exception \(ZeroDivisionError: division by zero\) at (.*[\\/])?calc\.py:10 in <module>/);
  const end = await call({ action: 'continue', timeout: 60_000 });
  assert.equal(end.isError, true);
  assert.match(end.content, /ZeroDivisionError: division by zero\nThe program exited with code 1\. The debug session is over\.$/);
  assert.doesNotMatch(end.content, /debugpy[\\/]|runpy/, "debugpy's own frames are left out of the traceback");
});

// Tests for the REPL and Debugger tools. They start real Python and Node processes; the Python ones
// are skipped when no Python 3 interpreter is installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReplTool, findPython, stopReplRuntimes } from '../src/tools/repl.js';
import { DebuggerTool, stopDebugSession } from '../src/tools/debugger.js';
import { asyncCell, redeclarable } from '../src/tools/jsCell.js';
import { ruleMatches } from '../src/permissions/permissions.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import type { SessionState, Tool, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-repl-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
const ctx = { projectRoot: dir, session, settings: { env: {} }, files: new FileTracker(false), signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;

after(() => {
  stopReplRuntimes(session);
  stopDebugSession(session);
});

async function call(tool: Tool, input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await tool.prepare(input, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  return prep.execute();
}

const python = await findPython();
const noPython = python ? false : 'no Python 3 interpreter found';

test('Python REPL keeps variables between calls and captures printed output', { skip: noPython }, async () => {
  assert.equal((await call(ReplTool, { language: 'python', code: 'x = 41' })).content, '(no output)');
  const r = await call(ReplTool, { language: 'python', code: 'print("hello")\nx + 1' });
  assert.equal(r.isError, false, r.content);
  assert.match(r.content, /\[stdout\]\nhello\n/);
  assert.match(r.content, /\[value\]\n42$/);
});

test('Python REPL returns the traceback of an exception and input() fails fast', { skip: noPython }, async () => {
  const r = await call(ReplTool, { language: 'python', code: 'def f():\n    return 1 / 0\nf()' });
  assert.equal(r.isError, true);
  assert.match(r.content, /Traceback[\s\S]*"<cell \d+>", line 2, in f[\s\S]*ZeroDivisionError/);
  assert.doesNotMatch(r.content, /run_cell|run_code/, 'frames of the driver are hidden');
  const started = Date.now();
  const i = await call(ReplTool, { language: 'python', code: 'input("name? ")' });
  assert.match(i.content, /EOFError/);
  assert.ok(Date.now() - started < 10_000, 'input() does not wait for the timeout');
});

test('Python REPL: a timeout restarts the runtime and loses state; reset does too', { skip: noPython }, async () => {
  await call(ReplTool, { language: 'python', code: 'kept = 1' });
  const t = await call(ReplTool, { language: 'python', code: 'while True:\n    pass', timeout: 1500 });
  assert.equal(t.isError, true);
  assert.match(t.content, /Timed out after 1\.5s\. The Python runtime was restarted and lost all its variables/);
  assert.match((await call(ReplTool, { language: 'python', code: 'kept' })).content, /NameError/);
  await call(ReplTool, { language: 'python', code: 'again = 2' });
  const r = await call(ReplTool, { language: 'python', code: "'again' in globals()", reset: true });
  assert.match(r.content, /\[value\]\nFalse$/);
});

test('Node REPL keeps variables, lets const be declared again and captures console output', async () => {
  await call(ReplTool, { language: 'node', code: 'const n = 41' });
  assert.match((await call(ReplTool, { language: 'node', code: 'n + 1' })).content, /\[value\]\n42$/);
  const r = await call(ReplTool, { language: 'node', code: 'const n = 1\nconsole.log("hi", n)\nconsole.error("careful")' });
  assert.equal(r.isError, false, r.content);
  assert.match(r.content, /\[stdout\]\nhi 1\n\[stderr\]\ncareful/);
});

test('Node REPL supports top-level await and require()', async () => {
  const r = await call(ReplTool, { language: 'node', code: 'await new Promise(r => setTimeout(() => r(5), 10))' });
  assert.match(r.content, /\[value\]\n5$/);
  const decl = await call(ReplTool, { language: 'node', code: 'const { join } = require("path")\nconst parts = await Promise.resolve(["a", "b"])' });
  assert.equal(decl.isError, false, decl.content);
  const v = await call(ReplTool, { language: 'node', code: 'require("path").basename(join("x", ...parts))' });
  assert.match(v.content, /\[value\]\n'b'$/, 'declarations from the await cell persist');
});

test('JS cells: top-level declarations are rewritten so they persist', () => {
  assert.equal(redeclarable('const a = 1\nlet b = `\nconst c = 2`\nif (a) { const d = 3 }\nclass E {}'), 'var   a = 1\nvar b = `\nconst c = 2`\nif (a) { const d = 3 }\nvar E = class E {};');
  const cell = asyncCell('const { x, y: [z] } = await f()\nfunction g() {}\nx + z', { hoist: true, returnLast: true });
  assert.equal(cell.source, '(async () => { globalThis.g = g;\n;(    { x, y: [z] } = await f());\nfunction g() {}\nreturn (x + z)\n})()');
  assert.deepEqual(cell.declare, ['x', 'z']);
});

test('REPL and Debugger calls match their permission rules', async () => {
  const py = await ReplTool.prepare({ language: 'python', code: 'print(1)' }, ctx);
  assert.equal(py.permission?.ruleSuggestion, 'REPL(python)');
  assert.ok(ruleMatches('REPL(python)', py.permission!, dir));
  assert.ok(ruleMatches('REPL', py.permission!, dir));
  assert.ok(!ruleMatches('REPL(node)', py.permission!, dir));
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  const dbg = await DebuggerTool.prepare({ action: 'start', file: 'app.js' }, ctx);
  assert.equal(dbg.permission?.ruleSuggestion, 'Debugger(node)');
  assert.ok(ruleMatches('Debugger(node)', dbg.permission!, dir));
  assert.ok(!ruleMatches('Debugger(python)', dbg.permission!, dir));
  const ts = await DebuggerTool.prepare({ action: 'start', file: 'app.ts' }, ctx);
  assert.match(ts.error?.content ?? '', /Compile it first/);
});

test('pdb: stop at a breakpoint and print a variable', { skip: noPython }, async () => {
  writeFileSync(path.join(dir, 'calc.py'), 'def add(a, b):\n    total = a + b\n    return total\n\n\nresult = add(2, 3)\nprint("result", result)\n');
  // pdb itself: with debugpy installed, Python programs go to debugpy by default.
  const start = await call(DebuggerTool, { action: 'start', file: 'calc.py', adapter: 'pdb' });
  assert.match(start.content, /calc\.py\(1\)<module>\(\)/);
  assert.match((await call(DebuggerTool, { action: 'send', command: 'b calc.py:3' })).content, /Breakpoint 1 at .*calc\.py:3/);
  assert.match((await call(DebuggerTool, { action: 'send', command: 'c' })).content, /calc\.py\(3\)add\(\)/);
  assert.match((await call(DebuggerTool, { action: 'send', command: 'p total' })).content, /^5$/m);
  assert.match((await call(DebuggerTool, { action: 'stop' })).content, /Debug session stopped/);
});

test('node inspect: stop at a breakpoint and read a variable', async () => {
  writeFileSync(path.join(dir, 'calc.js'), 'function add(a, b) {\n  const total = a + b;\n  return total;\n}\nconst result = add(2, 3);\nconsole.log("result", result);\n');
  const start = await call(DebuggerTool, { action: 'start', file: 'calc.js' });
  assert.match(start.content, /Break on start in .*calc\.js:\d+/);
  await call(DebuggerTool, { action: 'send', command: "sb('calc.js', 3)" });
  assert.match((await call(DebuggerTool, { action: 'send', command: 'c' })).content, /break in .*calc\.js:3/);
  assert.match((await call(DebuggerTool, { action: 'send', command: 'exec total' })).content, /^5$/m);
  assert.match((await call(DebuggerTool, { action: 'stop' })).content, /Debug session stopped/);
});

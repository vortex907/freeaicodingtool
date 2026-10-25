// Tests for the language server support against the fake server in helpers/fakeLspServer.ts (run with
// node, so no real language server is needed): Content-Length framing, the client (handshake, server
// requests, timeouts, crashes), diagnostics after edits, the LSP tool (definition, references, hover,
// symbols, diagnostics, rename with undo), server detection, the settings and the agent's edit hook.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageReader, encodeMessage, fileUri, offsetAt, type Hover, type Message } from '../src/lsp/protocol.js';
import { LspClient, RequestTimeoutError, ServerExitedError, quoteForCmd, spawnCommand, type ServerLaunch } from '../src/lsp/client.js';
import { LspManager, applyLspSettings, getLsp, isLspEnabled, stopLanguageServers, type LspSettings } from '../src/lsp/index.js';
import { SERVER_DEFS, canonicalServerId, defForFile, resolveServer, serverDefs, type ServerOverride } from '../src/lsp/servers.js';
import { applyTextEdits, editsByFile } from '../src/lsp/edits.js';
import { hoverText } from '../src/lsp/format.js';
import { LspTool, locate, parseAction } from '../src/tools/lspTool.js';
import { ReadTool } from '../src/tools/fileTools.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { selectTools } from '../src/tools/index.js';
import { decide, type PermissionContext } from '../src/permissions/permissions.js';
import { LSP_RULE, buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { loadConfig, sanitizeUntrustedSettings } from '../src/config/config.js';
import { PROVIDERS } from '../src/providers/catalog.js';
import { MockServer, text, tools } from './helpers/mockServer.js';
import type { PermissionMode } from '../src/config/config.js';
import type { PermissionRequest, SessionState, ToolContext, ToolResult } from '../src/tools/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const FAKE = path.join(here, 'helpers', 'fakeLspServer.js');
const BIN = path.resolve(here, '../../bin/freecode.js');
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'fc-lsp-')));
let folders = 0;

/** A new folder with these files. */
function project(files: Record<string, string>): string {
  const dir = path.join(tmp, `p${++folders}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

/** An lsp.servers entry that runs the fake server for *.fk files. */
function fake(init: Record<string, unknown> = {}): ServerOverride {
  return { command: process.execPath, args: [FAKE], extensions: ['.fk'], initializationOptions: init };
}

const managers: LspManager[] = [];
const clients: LspClient[] = [];

function manager(settings: LspSettings): LspManager {
  const m = new LspManager();
  m.configure(settings);
  managers.push(m);
  return m;
}

function client(dir: string, launch: Partial<ServerLaunch> = {}, dedupes = false): LspClient {
  const c = new LspClient({ serverId: 'fake', root: dir, launch: { command: process.execPath, args: [FAKE], label: 'fake', ...launch }, languageId: () => 'fake', dedupes });
  clients.push(c);
  return c;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Runs `fn` with only `dir` on PATH (which() lookups made with fresh see it). */
function withPath<T>(dir: string, fn: () => T): T {
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  process.env.PATH = dir;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** What a fake server got (initialize parameters, answers to its own requests): `file` starts with the word config. */
async function serverView(c: LspClient, file: string): Promise<Record<string, any>> {
  const synced = await c.sync(file);
  let seen: Record<string, any> = {};
  for (let i = 0; i < 100 && !('unknown-1' in seen); i++) {
    seen = JSON.parse(hoverText(await c.request<Hover>('textDocument/hover', { textDocument: { uri: synced!.doc.uri }, position: { line: 0, character: 1 } })));
    if (!('unknown-1' in seen)) await new Promise((r) => setTimeout(r, 20));
  }
  return seen;
}

function permissions(dir: string, mode: PermissionMode, allow: string[] = []): PermissionContext {
  return { mode, allow, deny: [], ask: [], projectRoot: dir, additionalDirectories: [], sessionAllow: new Set(), interactive: true };
}

/** The start check the agent passes: what the permission rules and mode allow without asking. */
const allowedBy = (perm: PermissionContext) => (req: PermissionRequest) => decide(req, perm).action === 'allow';

function toolContext(dir: string) {
  const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
  const files = new FileTracker(true);
  files.beginTurn(1);
  const ctx = { projectRoot: dir, session, settings: { permissions: { additionalDirectories: [] } }, files, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;
  const run = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const prep = await LspTool.prepare(input, ctx);
    return prep.error ?? prep.execute();
  };
  return { ctx, files, run };
}

after(async () => {
  for (const c of clients) c.kill();
  await Promise.all(managers.map((m) => m.stopAll()));
  await stopLanguageServers();
});

// ------------------------------------------------------------------ protocol

test('framing: Content-Length counts bytes; split messages, stray output and broken ones are handled', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'Größe 漢字' } });
  const first = encodeMessage({ jsonrpc: '2.0', id: 1, result: { text: 'Größe 漢字' } });
  const second = encodeMessage({ jsonrpc: '2.0', method: 'note', params: [1, 2] });
  assert.notEqual(Buffer.byteLength(body), body.length, 'the body has multi-byte characters');
  assert.ok(first.toString('latin1').startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`));
  const stream = Buffer.concat([Buffer.from('server starting\n'), first, Buffer.from('Content-Type: text/plain\r\n\r\n'), Buffer.from('Content-Length: 5\r\n\r\n{bad}'), second]);
  // One byte at a time: headers, bodies and the UTF-8 sequences in them arrive in pieces.
  const reader = new MessageReader();
  const got: Message[] = [];
  for (let i = 0; i < stream.length; i++) got.push(...reader.push(stream.subarray(i, i + 1)));
  assert.deepEqual(
    got.map((m) => m.id ?? m.method),
    [1, 'note'],
  );
  assert.deepEqual(got[0]!.result, { text: 'Größe 漢字' });
  assert.equal(reader.errors, 2, 'the header without a length and the bad JSON');
  // Several messages in one chunk, and a body cut in two.
  const whole = new MessageReader();
  assert.equal(whole.push(Buffer.concat([first, second, first.subarray(0, 30)])).length, 2);
  assert.deepEqual(
    whole.push(first.subarray(30)).map((m) => m.id),
    [1],
  );
  assert.equal(whole.errors, 0);
});

test('positions and workspace edits: CRLF lines, clamping, edits per file, overlaps refused', () => {
  const r = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  const text = 'ab\r\ncd\nef';
  assert.equal(offsetAt(text, { line: 1, character: 1 }), 5);
  assert.equal(offsetAt(text, { line: 1, character: 99 }), 6, 'clamped to the end of the line');
  assert.equal(offsetAt(text, { line: 9, character: 0 }), text.length);
  assert.equal(
    applyTextEdits('let a = a + 1;', [
      { range: r(0, 8, 0, 9), newText: 'b' },
      { range: r(0, 4, 0, 5), newText: 'b' },
    ]),
    'let b = b + 1;',
  );
  assert.throws(
    () =>
      applyTextEdits('abc', [
        { range: r(0, 0, 0, 2), newText: 'x' },
        { range: r(0, 1, 0, 3), newText: 'y' },
      ]),
    /overlapping/,
  );
  const a = path.join(tmp, 'a.fk');
  const b = path.join(tmp, 'b.fk');
  const docs = editsByFile({
    documentChanges: [
      { textDocument: { uri: fileUri(a), version: 1 }, edits: [{ range: r(0, 0, 0, 1), newText: 'x' }] },
      { textDocument: { uri: fileUri(b) }, edits: [] },
    ],
  });
  assert.deepEqual(
    docs.files.map((f) => f.file),
    [a],
    'files without edits are left out',
  );
  assert.deepEqual(
    editsByFile({ changes: { [fileUri(b)]: [{ range: r(0, 0, 0, 0), newText: 'y' }] } }).files.map((f) => f.file),
    [b],
  );
  assert.match(editsByFile({ documentChanges: [{ kind: 'rename' }] }).error ?? '', /rename a file/);
  assert.match(editsByFile({ changes: { 'untitled:Untitled-1': [] } }).error ?? '', /not a local file/);
});

test('the LSP tool finds the symbol the model means and understands other names for the actions', () => {
  const src = '// greet is called below\nconst greet = 1;\ngreet();\n  greet(greet);\n';
  const at = (line: number, character: number) => ({ line, character });
  assert.deepEqual(locate(src, { symbol: 'greet' }), [at(0, 3), at(1, 6), at(2, 0), at(3, 2), at(3, 8)]);
  assert.deepEqual(locate(src, { symbol: 'greet', line: 4, column: 9 }), [at(3, 8), at(3, 2)], 'the hit nearest to the column first');
  assert.deepEqual(locate(src, { symbol: 'obj.greet()', line: 2 }), [at(1, 6)], 'a qualified name falls back to its last part');
  assert.deepEqual(locate(src, { symbol: 'Greeter::greet', line: 3 }), [at(2, 0)]);
  assert.deepEqual(locate(src, { line: 3, column: 3 }), [at(2, 2)]);
  assert.equal(locate(src, { symbol: 'missing' }), '"missing" does not appear in the file.');
  assert.equal(locate(src, { symbol: 'greet', line: 40 }), 'Line 40 is outside the file (it has 5 lines).');
  assert.equal(locate(src, { line: 2 }), 'Give column (1-based) or symbol together with line.');
  const names: [string, string | null][] = [
    ['definition', 'definition'],
    ['goto_definition', 'definition'],
    ['textDocument/definition', 'definition'],
    ['type_definition', 'definition'],
    ['find_references', 'references'],
    ['usages', 'references'],
    ['hover', 'hover'],
    ['type', 'hover'],
    ['signature', 'hover'],
    ['document_symbols', 'symbols'],
    ['workspace/symbol', 'symbols'],
    ['outline', 'symbols'],
    ['get_diagnostics', 'diagnostics'],
    ['errors', 'diagnostics'],
    ['rename_symbol', 'rename'],
    ['explode', null],
  ];
  for (const [raw, want] of names) assert.equal(parseAction(raw), want, raw);
});

// ------------------------------------------------------------------ the client

test('client: initialize handshake, answers to server requests, request timeouts and a crash', async () => {
  const dir = project({ 'a.fk': 'def config\nconfig\ncrash\n' });
  const c = client(dir);
  await c.start();
  assert.equal(c.status, 'ready');
  assert.equal(c.serverName, 'fake');
  assert.ok(c.capabilities.renameProvider);
  const synced = await c.sync(path.join(dir, 'a.fk'));
  assert.equal(synced?.changed, true);
  const at = (line: number) => ({ textDocument: { uri: synced!.doc.uri }, position: { line, character: 1 } });
  // Hovering "config" shows what the server received, including the answers to its own requests.
  let seen: Record<string, any> = {};
  for (let i = 0; i < 100 && !('unknown-1' in seen); i++) {
    seen = JSON.parse(hoverText(await c.request<Hover>('textDocument/hover', at(1))));
    if (!('unknown-1' in seen)) await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(seen.processId, process.pid);
  assert.deepEqual(seen.workspaceFolders, [{ uri: fileUri(dir), name: path.basename(dir) }]);
  assert.equal(seen.capabilities.workspace.workspaceEdit.documentChanges, true);
  assert.deepEqual(seen['cfg-1000'], [null, null, null], 'settings requests get the server defaults');
  assert.equal(seen['progress-1'], null);
  assert.equal(seen['unknown-1'].error.code, -32601, 'unknown requests are refused, not left waiting');
  // The server reported progress (indexing) right after starting; whenIdle waits for its end.
  await c.whenIdle(5000);
  assert.equal(c.busy, false);
  const started = Date.now();
  await assert.rejects(c.request('fake/hang', {}, 200), RequestTimeoutError);
  assert.ok(Date.now() - started < 2000);
  // Hovering "crash" makes the server exit with code 3.
  await assert.rejects(c.request('textDocument/hover', at(2)), ServerExitedError);
  assert.equal(c.status, 'exited');
  assert.match(c.describeExit(), /^fake exited with code 3/);
  await assert.rejects(c.request('textDocument/hover', at(1)), ServerExitedError, 'later requests fail at once');
});

test('client: a server that is missing, refuses to start or never finishes starting is stopped with a reason', async () => {
  const dir = project({});
  const missing = client(dir, { command: path.join(dir, 'no-such-server'), args: [], label: 'nothing' });
  await assert.rejects(missing.start(), ServerExitedError);
  assert.match(missing.describeExit(), /^nothing was not found/);
  const refused = client(dir, { initializationOptions: { failInit: true } });
  await assert.rejects(refused.start(), /cannot load this project/);
  assert.equal(refused.status, 'exited');
  assert.match(refused.describeExit(), /^fake failed to start: cannot load this project/);
  const slow = client(dir, { initializationOptions: { initDelayMs: 10_000 } });
  await assert.rejects(slow.start(300), RequestTimeoutError);
  assert.equal(slow.status, 'exited', 'the process is not left running');
  assert.match(slow.describeExit(), /^fake did not finish starting within 0\.3s/);
  // A polite shutdown is not an error.
  const fine = client(dir);
  await fine.start();
  await fine.shutdown();
  assert.equal(fine.status, 'exited');
  assert.equal(fine.error, undefined);
});

test('client: a server is busy while it reports work and for a moment after starting, unless it indexes in the background', async () => {
  const dir = project({});
  const c = client(dir);
  await c.start();
  assert.equal(c.busy, true, 'just started: it may not have reported its loading yet');
  await c.whenIdle(5000);
  assert.equal(c.busy, false);
  // clangd indexes for minutes and answers meanwhile, so its progress is no reason to wait.
  const background = new LspClient({ serverId: 'fake', root: dir, launch: { command: process.execPath, args: [FAKE], label: 'fake' }, languageId: () => 'fake', indexesInBackground: true });
  clients.push(background);
  await background.start();
  assert.equal(background.busy, false);
  await Promise.all([c.shutdown(), background.shutdown()]);
});

test('client: diagnostics of a server that skips unchanged ones stand once it is quiet', async () => {
  const dir = project({ 'a.fk': 'use gone\n' });
  const a = path.join(dir, 'a.fk');
  const c = client(dir, { initializationOptions: { dedupe: true } }, true);
  await c.start();
  let since = c.diagnosticsSeq;
  let synced = await c.sync(a);
  assert.equal((await c.diagnosticsFor(synced!.doc, since, 4000))?.length, 1);
  // Same diagnostics after this change, so the server says nothing.
  writeFileSync(a, 'use gone\n\n');
  since = c.diagnosticsSeq;
  synced = await c.sync(a);
  assert.equal(synced?.changed, true);
  const started = Date.now();
  const items = await c.diagnosticsFor(synced!.doc, since, 4000);
  assert.equal(items?.[0]?.message, 'Unknown name gone');
  assert.ok(Date.now() - started < 3000, 'did not wait for the timeout');
  await c.shutdown();
});

// ------------------------------------------------------------------ diagnostics after edits

test('diagnostics after an edit: errors first (new ones on top), at most 15 lines, warnings only without errors', async () => {
  const dir = project({ 'a.fk': 'def alpha\nuse alpha\n' });
  const a = path.join(dir, 'a.fk');
  const m = manager({ servers: { fake: fake() } });
  const check = async (content: string) => {
    writeFileSync(a, content);
    return (await m.afterEdit([a], dir))[0];
  };
  assert.equal(await check('def alpha\nuse alpha\n'), null, 'a clean file needs no note');
  assert.equal(await check('def alpha\nuse alpha\nERROR: old problem\nWARN: not shown while there are errors\n'), 'fakeLspServer found 1 error in a.fk after this edit:\n  3:1 old problem [E1]\nFix the errors this edit caused before moving on.');
  assert.equal(
    await check('def alpha\nuse beta\nERROR: old problem\n'),
    'fakeLspServer found 2 errors in a.fk after this edit (1 new):\n  2:5 Unknown name beta [E2]\n  3:1 old problem [E1]\nFix the errors this edit caused before moving on.',
  );
  const many = (await check(Array.from({ length: 20 }, (_, i) => `use missing${i}`).join('\n')))!.split('\n');
  assert.equal(many[0], 'fakeLspServer found 20 errors in a.fk after this edit:');
  assert.equal(many.filter((l) => /^ {2}\d+:\d+ Unknown name missing\d+ \[E2\]$/.test(l)).length, 15);
  assert.equal(many[16], '  and 5 more');
  assert.equal(await check('def alpha\nWARN: unused alpha\n'), 'fakeLspServer: no errors left in a.fk.');
  assert.equal(await check('def alpha\nWARN: unused alpha\nWARN: also unused\n'), 'fakeLspServer found 2 warnings in a.fk:\n  2:1 unused alpha\n  3:1 also unused');
  assert.equal(await check(Array.from({ length: 6 }, (_, i) => `WARN: w${i}`).join('\n')), null, 'many warnings are noise after an edit');
});

test('diagnostics after an edit: pulled and unversioned diagnostics, new errors in other files', async () => {
  for (const init of [{ pull: true }, { dedupe: true }, { noVersion: true }]) {
    const dir = project({ 'a.fk': 'def alpha\n' });
    const a = path.join(dir, 'a.fk');
    const m = manager({ servers: { fake: fake(init) } });
    assert.equal((await m.afterEdit([a], dir))[0], null, JSON.stringify(init));
    writeFileSync(a, 'def alpha\nuse gamma\n');
    assert.match((await m.afterEdit([a], dir))[0] ?? '', /^fakeLspServer found 1 error in a\.fk after this edit:\n {2}2:5 Unknown name gamma \[E2\]\n/, JSON.stringify(init));
    await m.stopAll();
  }
  const dir = project({ 'lib.fk': 'def greet\n', 'main.fk': 'use greet\n' });
  const lib = path.join(dir, 'lib.fk');
  const m = manager({ servers: { fake: fake() } });
  assert.deepEqual(await m.afterEdit([path.join(dir, 'main.fk'), lib], dir), [null, null]);
  writeFileSync(lib, 'def welcome\n');
  assert.deepEqual(await m.afterEdit([lib], dir), ['New errors in other files:\n  main.fk:1:5 Unknown name greet [E2]']);
  // Two edits in one step that break a third file: its errors are told once.
  const two = project({ 'a.fk': 'def one\n', 'b.fk': 'def two\n', 'c.fk': 'use one\nuse two\n' });
  const [a, b, c] = ['a.fk', 'b.fk', 'c.fk'].map((f) => path.join(two, f));
  assert.deepEqual(await m.afterEdit([c!], two), [null]);
  writeFileSync(a!, 'def uno\n');
  writeFileSync(b!, 'def dos\n');
  const reports = await m.afterEdit([a!, b!], two);
  assert.deepEqual(reports.filter(Boolean), ['New errors in other files:\n  c.fk:1:5 Unknown name one [E2]\n  c.fk:2:5 Unknown name two [E2]']);
});

test('diagnostics after an edit never hold up the edit: missing, silent, slow and crashing servers', async () => {
  const dir = project({ 'a.fk': 'use nothing\n' });
  const a = path.join(dir, 'a.fk');
  const timed = async (m: LspManager) => {
    const started = Date.now();
    const [report] = await m.afterEdit([a], dir);
    return { report, ms: Date.now() - started };
  };
  // Not installed: no report and no wait.
  const missing = manager({ servers: { fake: { command: path.join(dir, 'no-such-server'), extensions: ['.fk'] } } });
  let r = await timed(missing);
  assert.equal(r.report, null);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
  const acq = await missing.acquire(a, dir);
  assert.match(acq.ok ? '' : acq.message, /\(lsp\.servers\.fake\.command = ".*no-such-server"\) was not found/);
  // Never reports: the wait ends at diagnosticsTimeoutMs.
  r = await timed(manager({ servers: { fake: fake({ silent: true }) }, diagnosticsTimeoutMs: 700 }));
  assert.equal(r.report, null);
  assert.ok(r.ms >= 500 && r.ms < 3000, `${r.ms} ms`);
  // Still starting: the edit does not wait for it; it keeps starting and checks the next edit.
  const slow = manager({ servers: { fake: fake({ initDelayMs: 1500 }) }, diagnosticsTimeoutMs: 400 });
  r = await timed(slow);
  assert.equal(r.report, null);
  assert.ok(r.ms < 1400, `${r.ms} ms`);
  assert.equal((await slow.acquire(a, dir, { waitMs: 10_000 })).ok, true);
  slow.configure({ servers: { fake: fake({ initDelayMs: 1500 }) } });
  assert.match((await timed(slow)).report ?? '', /Unknown name nothing/);
  // Crashes while checking: no report, and the next edit gets a new server.
  const crashing = manager({ servers: { fake: fake({ crashOnChange: true }) } });
  assert.match((await timed(crashing)).report ?? '', /Unknown name nothing/, 'opening the file works');
  writeFileSync(a, 'use other\n');
  r = await timed(crashing);
  assert.equal(r.report, null);
  assert.ok(r.ms < 2500, `${r.ms} ms`);
  writeFileSync(a, 'use third\n');
  assert.match((await timed(crashing)).report ?? '', /Unknown name third/, 'restarted after the crash');
});

test('one server per language and project folder, started on first use and stopped when idle', async () => {
  const p1 = project({ 'a.fk': 'def a\n', 'sub/b.fk': 'def b\n' });
  const p2 = project({ 'c.fk': 'def c\n' });
  const m = manager({ servers: { fake: fake() } });
  assert.equal(m.running(p1).length, 0, 'nothing runs before it is needed');
  const x = await m.acquire(path.join(p1, 'a.fk'), p1);
  const y = await m.acquire(path.join(p1, 'sub', 'b.fk'), p1);
  const z = await m.acquire(path.join(p2, 'c.fk'), p2);
  assert.ok(x.ok && y.ok && z.ok);
  assert.equal(x.client, y.client);
  assert.notEqual(x.client, z.client);
  assert.equal(x.client.root, p1);
  assert.equal(z.client.root, p2);
  m.idleMs = 200;
  await m.acquire(path.join(p1, 'a.fk'), p1);
  await until(() => x.client.status === 'exited');
  assert.equal(x.client.error, undefined, 'stopped on purpose, not a crash');
  assert.equal(m.running(p1).length, 0);
  assert.equal(z.client.status, 'ready', 'the other project keeps its server');
  const again = await m.acquire(path.join(p1, 'a.fk'), p1);
  assert.ok(again.ok && again.client !== x.client, 'started again on the next use');
});

test('past the server limit, the least recently used server stops', async () => {
  const m = manager({ servers: { fake: fake() } });
  m.maxServers = 2;
  const [p1, p2, p3] = [project({ 'a.fk': 'def a\n' }), project({ 'b.fk': 'def b\n' }), project({ 'c.fk': 'def c\n' })];
  const first = await m.acquire(path.join(p1!, 'a.fk'), p1!);
  const second = await m.acquire(path.join(p2!, 'b.fk'), p2!);
  assert.ok(first.ok && second.ok);
  await first.client.sync(path.join(p1!, 'a.fk'));
  const third = await m.acquire(path.join(p3!, 'c.fk'), p3!);
  assert.ok(third.ok);
  await until(() => second.client.status === 'exited');
  assert.equal(first.client.status, 'ready', 'the one used last keeps running');
});

// ------------------------------------------------------------------ the LSP tool

test('LSP tool: definition, references, hover, symbols and diagnostics', async () => {
  applyLspSettings({ servers: { fake: fake() } });
  const dir = project({ 'lib.fk': 'def greet\n  def inner\ndef farewell\n', 'main.fk': 'use greet\nuse farewell\ngreet again\n', 'bad.fk': 'use nope\nWARN: hmm\n' });
  const { ctx, run } = toolContext(dir);
  // Reading a file starts its language server in the background.
  await (await ReadTool.prepare({ file_path: 'lib.fk' }, ctx)).execute();
  await until(() => getLsp().running(dir).length === 1);
  const content = async (input: Record<string, unknown>) => {
    const r = await run(input);
    assert.equal(r.isError, undefined, r.content);
    return r.content;
  };
  assert.equal(await content({ action: 'definition', file_path: 'main.fk', symbol: 'greet' }), 'Definition of greet:\nlib.fk:1:5  def greet');
  assert.equal(await content({ action: 'definition', file_path: 'main.fk', line: 3, column: 2 }), 'Definition of greet:\nlib.fk:1:5  def greet');
  assert.equal(await content({ action: 'references', file_path: 'lib.fk', symbol: 'greet' }), '3 references in 2 files to greet (the definition included):\nlib.fk:1:5  def greet\nmain.fk:1:5  use greet\nmain.fk:3:1  greet again');
  assert.equal(await content({ action: 'hover', file_path: 'main.fk', symbol: 'farewell' }), 'farewell at main.fk:2:5:\n```fake\nfarewell: symbol\n```');
  assert.equal(await content({ action: 'symbols', file_path: 'lib.fk' }), 'Symbols in lib.fk:\nfunction greet (line 1)\n  function inner (line 2)\nfunction farewell (line 3)');
  assert.equal(await content({ action: 'workspace_symbols', query: 'fare' }), '1 symbol matching "fare":\nfunction farewell  lib.fk:3');
  assert.equal(await content({ action: 'diagnostics', file_path: 'bad.fk' }), 'fakeLspServer: 1 error, 1 warning in bad.fk\n  1:5 Unknown name nope [E2]\n  warning 2:1 hmm');
  assert.equal(await content({ action: 'diagnostics' }), 'fakeLspServer checked 3 files: 1 error, 1 warning.\nbad.fk:1:5 Unknown name nope [E2]\nbad.fk:2:1 warning: hmm');
  // Mistakes come back as errors the model can act on.
  assert.deepEqual(await run({ action: 'definition', file_path: 'main.fk', symbol: 'nowhere' }), { content: '"nowhere" does not appear in the file.', isError: true, display: { kind: 'summary', text: '"nowhere" does not appear in the file.' } });
  assert.match((await run({ action: 'definition', file_path: 'gone.fk', symbol: 'x' })).content, /^File not found: /);
  assert.match((await run({ action: 'fly', file_path: 'main.fk' })).content, /^Unknown or missing action\. Use one of: definition, references, hover, rename, symbols, diagnostics\.$/);
  assert.match((await run({ action: 'references' })).content, /^Missing required parameter for references: file_path$/);
  // Files over the sync limit are not sent to servers.
  const big = project({ 'big.fk': `def huge\n${'x'.repeat(2.1 * 1024 * 1024)}\n` });
  assert.equal((await toolContext(big).run({ action: 'hover', file_path: 'big.fk', symbol: 'huge' })).content, 'big.fk cannot be read, or it is larger than 2 MB (language servers do not get files that big).');
  // An answer that only points at the import of the name is followed to the definition.
  const other = project({ 'lib.fk': 'def greet\n', 'imp.fk': 'import greet\ngreet here\n' });
  const followed = await toolContext(other).run({ action: 'definition', file_path: 'imp.fk', symbol: 'greet', line: 2 });
  assert.equal(followed.content, 'Definition of greet:\nlib.fk:1:5  def greet');
});

test('LSP tool: rename asks like Edit, changes every file and can be undone', async () => {
  applyLspSettings({ servers: { fake: fake() } });
  const dir = project({ 'lib.fk': 'def greet\n', 'main.fk': 'use greet\ngreet again\n' });
  const lib = path.join(dir, 'lib.fk');
  const main = path.join(dir, 'main.fk');
  const { ctx, files } = toolContext(dir);
  const prep = await LspTool.prepare({ action: 'rename', file_path: 'lib.fk', symbol: 'greet', new_name: 'welcome' }, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  const req = prep.permission!;
  assert.equal(req.category, 'edit');
  assert.equal(req.subject, 'Rename greet to welcome in 2 files (3 changes)');
  assert.deepEqual(req.paths, [lib, main]);
  // Edit permission rules apply to every file of the rename.
  const perm: PermissionContext = { mode: 'default', allow: [], deny: [], ask: [], projectRoot: dir, additionalDirectories: [], sessionAllow: new Set(), interactive: true };
  assert.equal(decide(req, perm).action, 'ask');
  assert.equal(decide(req, { ...perm, mode: 'acceptEdits' }).action, 'allow');
  assert.equal(decide(req, { ...perm, mode: 'plan' }).action, 'deny');
  assert.equal(decide(req, { ...perm, mode: 'acceptEdits', deny: ['Edit(main.fk)'] }).action, 'deny');
  assert.equal(decide(req, { ...perm, allow: ['Edit(lib.fk)'] }).action, 'ask', 'an allow rule must cover every file');
  assert.equal(decide(req, { ...perm, allow: ['Edit(lib.fk)', 'Edit(main.fk)'] }).action, 'allow');
  assert.equal(readFileSync(main, 'utf8'), 'use greet\ngreet again\n', 'nothing changes before approval');
  const r = await prep.execute();
  assert.equal(r.isError, undefined, r.content);
  assert.equal(r.content, 'Renamed greet to welcome: 3 changes in 2 files.\n  lib.fk: 1 change (line 1)\n  main.fk: 2 changes (lines 1, 2)');
  assert.equal(readFileSync(lib, 'utf8'), 'def welcome\n');
  assert.equal(readFileSync(main, 'utf8'), 'use welcome\nwelcome again\n');
  // /undo puts both files back.
  const undone = await files.undoLast();
  assert.deepEqual(undone?.restored.sort(), [lib, main]);
  assert.equal(readFileSync(lib, 'utf8'), 'def greet\n');
  assert.equal(readFileSync(main, 'utf8'), 'use greet\ngreet again\n');
  // Sub-agents only read, and a word the server cannot rename is refused.
  const sub = await LspTool.prepare({ action: 'rename', file_path: 'lib.fk', symbol: 'greet', new_name: 'x' }, { ...ctx, depth: 1 });
  assert.match(sub.error?.content ?? '', /^Sub-agents can use LSP to read code/);
  const word = await LspTool.prepare({ action: 'rename', file_path: 'main.fk', symbol: 'again', new_name: 'x' }, ctx);
  assert.equal(word.error?.content, 'fakeLspServer cannot rename again here (not a symbol it can rename).');
});

test('LSP tool: after a rename every changed file is sent before any is checked', async () => {
  // With pulled diagnostics, app.fk (sent first) would be checked against the old lib.fk.
  applyLspSettings({ servers: { fake: fake({ pull: true }) } });
  const dir = project({ 'app.fk': 'use greet\n', 'lib.fk': 'def greet\n' });
  const prep = await LspTool.prepare({ action: 'rename', file_path: 'lib.fk', symbol: 'greet', new_name: 'welcome' }, toolContext(dir).ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  assert.equal((await prep.execute()).content, 'Renamed greet to welcome: 2 changes in 2 files.\n  app.fk: 1 change (line 1)\n  lib.fk: 1 change (line 1)');
});

test('LSP tool: without a language server it names the one to install and the command', async () => {
  const dir = project({ 'main.go': 'package main\n' });
  const empty = project({});
  const keys = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'GOPATH', 'GOBIN', 'CARGO_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, { PATH: empty, HOME: empty, USERPROFILE: empty });
    applyLspSettings({});
    const r = await toolContext(dir).run({ action: 'hover', file_path: 'main.go', symbol: 'main' });
    assert.equal(r.isError, true);
    assert.equal(r.content, 'No Go language server is installed. Install it with: go install golang.org/x/tools/gopls@latest');
    const message = (id: string) => {
      const res = resolveServer(SERVER_DEFS.find((d) => d.id === id)!, dir, undefined, true);
      return res.ok ? `found ${res.launch.command}` : res.message;
    };
    assert.equal(message('rust'), 'No Rust language server is installed. Install it with: rustup component add rust-analyzer');
    assert.equal(message('csharp'), 'No C# language server is installed. Install it with: dotnet tool install --global csharp-ls');
    assert.equal(message('typescript'), 'No TypeScript/JavaScript language server is installed. Install it with: npm install -g typescript-language-server typescript@6');
    assert.match(message('python'), /^No Python language server is installed\. Install it with: (npm install -g pyright|pip install pyright)$/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ------------------------------------------------------------------ detection and settings

test('server detection: languages by extension, settings keys, overrides and Windows .cmd shims', () => {
  const defs = serverDefs({ lua: { command: 'lua-language-server', extensions: ['lua', '.LUAU'] } });
  assert.equal(defForFile('src/app.TSX', defs)?.id, 'typescript');
  assert.equal(defForFile('lib/x.pyi', defs)?.id, 'python');
  assert.equal(defForFile('include/a.hpp', defs)?.id, 'cpp');
  assert.equal(defForFile('game/init.lua', defs)?.id, 'lua');
  assert.equal(defForFile('game/x.luau', defs)?.id, 'lua');
  assert.equal(defForFile('Makefile', defs), null);
  assert.equal(defForFile('notes.md', defs), null);
  assert.deepEqual(['TS', 'golang', 'C#', 'c++', 'py'].map(canonicalServerId), ['typescript', 'go', 'csharp', 'cpp', 'python']);
  const go = SERVER_DEFS.find((d) => d.id === 'go')!;
  assert.equal(resolveServer(go, tmp, { disabled: true }).ok, false);
  const custom = resolveServer(go, tmp, { command: process.execPath, args: ['server.js', '--stdio'] });
  assert.ok(custom.ok);
  assert.deepEqual([custom.launch.command, custom.launch.args, custom.launch.label], [process.execPath, ['server.js', '--stdio'], 'server']);
  // npm installs servers on Windows as .cmd shims, which only run through cmd.exe.
  const shim = spawnCommand('C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\typescript-language-server.cmd', ['--stdio'], true);
  assert.equal(shim.verbatim, true);
  assert.deepEqual(shim.args, ['/d', '/s', '/c', '""C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\typescript-language-server.cmd" --stdio"']);
  assert.deepEqual(spawnCommand('C:\\LLVM\\bin\\clangd.exe', ['--log=error'], true), { file: 'C:\\LLVM\\bin\\clangd.exe', args: ['--log=error'], verbatim: false });
  assert.deepEqual(spawnCommand('/usr/bin/gopls', [], false), { file: '/usr/bin/gopls', args: [], verbatim: false });
  assert.deepEqual(['--stdio', 'a b', 'x&y', ''].map(quoteForCmd), ['--stdio', '"a b"', '"x&y"', '""']);
});

test('a language server installed as a .cmd shim starts on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = project({ 'a.fk': 'use nothing\n' });
  // Outside the project (a program inside it needs approval first), with spaces in the path like "Program Files".
  const shim = path.join(project({}), 'Program Files', 'fake server.cmd');
  mkdirSync(path.dirname(shim));
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
  const m = manager({ servers: { fake: { command: shim, args: ['--stdio'], extensions: ['.fk'] } } });
  assert.match((await m.afterEdit([path.join(dir, 'a.fk')], dir))[0] ?? '', /^fake server found 1 error in a\.fk/);
  await m.stopAll();
});

test('settings: lsp is global only; turned off, the tool and its prompt line are gone', async () => {
  // A repository's settings can never choose programs for FreeCode to run.
  assert.equal(sanitizeUntrustedSettings({ lsp: { servers: { python: { command: 'evil' } } } }).lsp, undefined);
  const home = project({ 'config.json': JSON.stringify({ lsp: { enabled: true } }) });
  const repo = project({ '.freecode/settings.json': JSON.stringify({ lsp: { servers: { python: { command: 'evil' } } } }) });
  const old = process.env.FREECODE_HOME;
  process.env.FREECODE_HOME = home;
  try {
    // Even a trusted project: the language servers only get the global settings.
    assert.deepEqual(loadConfig(repo, undefined, { trusted: true }).global.lsp, { enabled: true });
  } finally {
    if (old === undefined) delete process.env.FREECODE_HOME;
    else process.env.FREECODE_HOME = old;
  }
  const opts = { depth: 0, planMode: false, interactive: false };
  applyLspSettings({ enabled: false });
  assert.equal(isLspEnabled(), false);
  assert.ok(!selectTools(opts).some((t) => t.name === 'LSP'));
  const acq = await getLsp().acquire(path.join(repo, 'a.py'), repo);
  assert.match(acq.ok ? '' : acq.message, /turned off in the settings \(lsp\.enabled\)/);
  assert.deepEqual(await getLsp().afterEdit([path.join(repo, 'a.py')], repo), [null]);
  applyLspSettings(undefined);
  assert.equal(isLspEnabled(), true, 'on by default');
  assert.ok(selectTools(opts).some((t) => t.name === 'LSP'));
  assert.ok(selectTools({ ...opts, depth: 1, agentType: 'explore' }).some((t) => t.name === 'LSP'), 'sub-agents get it for reading');
  const prompt = (lsp: boolean) => buildSystemPrompt({ projectRoot: repo, cwd: repo, mode: 'default', memory: [], depth: 0, lsp }, '');
  assert.ok(prompt(true).includes(LSP_RULE));
  assert.ok(!prompt(false).includes(LSP_RULE));
});

// ------------------------------------------------------------------ servers that run project code

function writeTypescript(dir: string, version: string): string {
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version }));
  writeFileSync(path.join(dir, 'lib', 'tsserver.js'), '');
  return path.join(dir, 'lib', 'tsserver.js');
}

/**
 * A global npm folder like `npm install -g typescript-language-server typescript` makes (the server is
 * the fake one), with TypeScript `ts` next to it, or none. Returns the folder to put on PATH.
 */
function globalTypescriptServer(ts: string | null): { binDir: string; tsserver: string } {
  const g = project({});
  const modules = win ? path.join(g, 'node_modules') : path.join(g, 'lib', 'node_modules');
  const pkg = path.join(modules, 'typescript-language-server');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript-language-server', version: '5.3.0' }));
  const cli = path.join(pkg, 'lib', 'cli.mjs');
  writeFileSync(cli, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(FAKE).href)};\n`);
  const tsserver = ts ? writeTypescript(path.join(modules, 'typescript'), ts) : '';
  if (win) {
    writeFileSync(path.join(g, 'typescript-language-server.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
    return { binDir: g, tsserver };
  }
  chmodSync(cli, 0o755);
  mkdirSync(path.join(g, 'bin'));
  symlinkSync(cli, path.join(g, 'bin', 'typescript-language-server'));
  return { binDir: path.join(g, 'bin'), tsserver };
}

test('TypeScript: the server gets a TypeScript from outside the project; with only the project\'s own it needs approval', async () => {
  const proj = project({ 'package.json': '{}', 'src/a.ts': 'config\n' });
  writeTypescript(path.join(proj, 'node_modules', 'typescript'), '5.4.5');
  const ts = SERVER_DEFS.find((d) => d.id === 'typescript')!;
  // Installed together with the server, outside the project.
  const outside = globalTypescriptServer('6.0.3');
  const r = withPath(outside.binDir, () => resolveServer(ts, proj, undefined, true));
  assert.ok(r.ok, r.ok ? '' : r.message);
  assert.deepEqual(r.launch.initializationOptions, { tsserver: { path: outside.tsserver } });
  assert.equal(r.launch.runsProjectCode, undefined, 'starts without asking');
  assert.equal(r.launch.label, 'typescript-language-server (TypeScript 6.0.3, the project has 5.4.5)');
  const c = new LspClient({ serverId: 'typescript', root: proj, launch: r.launch, languageId: () => 'typescript' });
  clients.push(c);
  await c.start();
  assert.deepEqual((await serverView(c, path.join(proj, 'src', 'a.ts'))).initializationOptions, { tsserver: { path: outside.tsserver } }, 'the server is told which tsserver to load');
  await c.shutdown();
  // No TypeScript outside the project: it would load the project's own, so it waits for the user.
  const alone = globalTypescriptServer(null);
  const own = withPath(alone.binDir, () => resolveServer(ts, proj, undefined, true));
  assert.ok(own.ok);
  assert.equal(own.launch.initializationOptions, undefined);
  assert.equal(own.launch.runsProjectCode, "loads the project's own TypeScript (node_modules/typescript), which is code from the project");
  const m = manager({});
  const acq = await withPath(alone.binDir, () => m.acquire(path.join(proj, 'src', 'a.ts'), proj));
  assert.equal(acq.ok ? '' : acq.reason, 'needs-approval');
  assert.match(acq.ok ? '' : acq.message, /^The TypeScript\/JavaScript language server was not started: typescript-language-server loads the project's own TypeScript .*permission rule LSP\(typescript\)/);
  assert.equal(m.running(proj).length, 0);
});

test('rust-analyzer starts with build scripts, proc macros and cargo check on save turned off', async () => {
  const rust = SERVER_DEFS.find((d) => d.id === 'rust')!;
  const safe = { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false };
  const dir = project({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': 'config\n' });
  const bin = project({ [`rust-analyzer${win ? '.cmd' : ''}`]: '' });
  const found = withPath(bin, () => resolveServer(rust, dir, undefined, true));
  assert.ok(found.ok, found.ok ? '' : found.message);
  assert.deepEqual(found.launch.initializationOptions, safe);
  assert.deepEqual(found.launch.settings, { 'rust-analyzer': safe });
  assert.equal(found.launch.runsProjectCode, undefined, 'starts without asking');
  // The settings go over them: more options, or one turned back on.
  const custom = resolveServer(rust, dir, { command: process.execPath, args: [FAKE], initializationOptions: { cargo: { features: 'all' }, procMacro: { enable: true } } }, true);
  assert.ok(custom.ok);
  assert.deepEqual(custom.launch.initializationOptions, { cargo: { buildScripts: { enable: false }, features: 'all' }, procMacro: { enable: true }, checkOnSave: false });
  // The server gets them when it starts and when it asks for its settings.
  const plain = resolveServer(rust, dir, { command: process.execPath, args: [FAKE] }, true);
  assert.ok(plain.ok);
  const c = new LspClient({ serverId: 'rust', root: dir, launch: plain.launch, languageId: () => 'rust' });
  clients.push(c);
  await c.start();
  const seen = await serverView(c, path.join(dir, 'src', 'main.rs'));
  assert.deepEqual(seen.initializationOptions, safe);
  assert.deepEqual(seen['cfg-1000'], [null, null, safe]);
  await c.shutdown();
});

test('pyright, pylsp, clangd and gopls start as they are, unless the program is inside the project', () => {
  const dir = project({ 'go.mod': 'module x\n', 'pyproject.toml': '', [`tools/gopls${win ? '.cmd' : ''}`]: '' });
  const bin = project(Object.fromEntries(['pyright-langserver', 'pylsp', 'clangd', 'gopls'].map((n) => [`${n}${win ? '.cmd' : ''}`, ''])));
  for (const id of ['python', 'cpp', 'go']) {
    const r = withPath(bin, () => resolveServer(SERVER_DEFS.find((d) => d.id === id)!, dir, undefined, true));
    assert.ok(r.ok, id);
    assert.deepEqual([r.launch.runsProjectCode, r.launch.initializationOptions], [undefined, undefined], id);
  }
  const pylsp = project({ [`pylsp${win ? '.cmd' : ''}`]: '' });
  const py = withPath(pylsp, () => resolveServer(SERVER_DEFS.find((d) => d.id === 'python')!, dir, undefined, true));
  assert.ok(py.ok && py.launch.label === 'pylsp' && py.launch.runsProjectCode === undefined);
  // A server program from the project's own folder (a PATH entry pointing into it) is the project's code.
  const inside = withPath(path.join(dir, 'tools'), () => resolveServer(SERVER_DEFS.find((d) => d.id === 'go')!, dir, undefined, true));
  assert.ok(inside.ok);
  assert.match(inside.launch.runsProjectCode ?? '', /^is a program inside the project folder \(tools[\\/]gopls/);
  // FreeCode opened in the home folder: the tools the user installed there are not the project's code.
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: dir, USERPROFILE: dir });
  try {
    const own = withPath(path.join(dir, 'tools'), () => resolveServer(SERVER_DEFS.find((d) => d.id === 'go')!, dir, undefined, true));
    assert.ok(own.ok && own.launch.runsProjectCode === undefined);
  } finally {
    for (const [k, v] of Object.entries(home)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('C#: diagnostics after edits start the server only with the rule LSP(csharp) or in bypass mode', async () => {
  applyLspSettings({ servers: { csharp: { command: process.execPath, args: [FAKE] } } });
  const lsp = getLsp();
  const p1 = project({ 'a.cs': 'use nothing\n' });
  const a1 = path.join(p1, 'a.cs');
  for (const mode of ['default', 'acceptEdits', 'plan'] as const) assert.deepEqual(await lsp.afterEdit([a1], p1, undefined, allowedBy(permissions(p1, mode))), [null], mode);
  lsp.warmUp(a1, p1, allowedBy(permissions(p1, 'default')));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lsp.running(p1).length, 0, 'not started by an edit or a read');
  assert.match((await lsp.afterEdit([a1], p1, undefined, allowedBy(permissions(p1, 'default', ['LSP(csharp)']))))[0] ?? '', /^fakeLspServer found 1 error in a\.cs after this edit:\n {2}1:5 Unknown name nothing \[E2\]/);
  assert.equal(lsp.running(p1).length, 1);
  const p2 = project({ 'a.cs': 'use nothing\n' });
  assert.match((await lsp.afterEdit([path.join(p2, 'a.cs')], p2, undefined, allowedBy(permissions(p2, 'bypassPermissions'))))[0] ?? '', /Unknown name nothing/, 'bypass mode starts it without asking');
  // A check of the whole project says how to allow it.
  const p3 = project({ 'a.cs': 'use nothing\n' });
  const res = await lsp.projectDiagnostics(p3, { mayStart: allowedBy(permissions(p3, 'default')) });
  assert.deepEqual(res.servers, []);
  assert.match(res.notes.join('\n'), /^The C# language server was not started: fakeLspServer loads the project's build files \(MSBuild\), which can run code\. .*LSP\(csharp\)/);
});

test('C#: the LSP tool asks before it starts the server, then answers without asking again', async () => {
  applyLspSettings({ servers: { csharp: { command: process.execPath, args: [FAKE] } } });
  const dir = project({ 'a.cs': 'def alpha\nuse alpha\n' });
  const { ctx, run } = toolContext(dir);
  const prep = await LspTool.prepare({ action: 'hover', file_path: 'a.cs', symbol: 'alpha', line: 2 }, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  const req = prep.permission!;
  assert.deepEqual(
    [req.tool, req.category, req.title, req.subject, req.specifier, req.ruleSuggestion, req.ruleLabel],
    ['LSP', 'execute', 'Start the C# language server for this project', "fakeLspServer loads the project's build files (MSBuild), which can run code.", 'csharp', 'LSP(csharp)', 'the C# language server'],
  );
  // The user is asked by default; the rule or bypass mode allow it without asking; plan mode and a deny rule refuse it.
  const perm = permissions(dir, 'default');
  assert.equal(decide(req, perm).action, 'ask');
  assert.equal(decide(req, { ...perm, allow: ['LSP(csharp)'] }).action, 'allow');
  assert.equal(decide(req, { ...perm, mode: 'bypassPermissions' }).action, 'allow');
  assert.equal(decide(req, { ...perm, mode: 'plan' }).action, 'deny');
  assert.equal(decide(req, { ...perm, mode: 'bypassPermissions', deny: ['LSP(csharp)'] }).action, 'deny');
  assert.equal(getLsp().running(dir).length, 0, 'nothing runs before the user allows it');
  assert.equal((await prep.execute()).content, 'alpha at a.cs:2:5:\n```fake\nalpha: symbol\n```');
  assert.equal(getLsp().running(dir).length, 1);
  assert.equal((await LspTool.prepare({ action: 'definition', file_path: 'a.cs', symbol: 'alpha', line: 2 }, ctx)).permission, undefined, 'allowed for this project now');
  assert.equal((await run({ action: 'definition', file_path: 'a.cs', symbol: 'alpha', line: 2 })).content, 'Definition of alpha:\na.cs:1:5  def alpha');
  // Edits in the project are checked from now on.
  writeFileSync(path.join(dir, 'a.cs'), 'def alpha\nuse beta\n');
  assert.match((await getLsp().afterEdit([path.join(dir, 'a.cs')], dir, undefined, allowedBy(perm)))[0] ?? '', /Unknown name beta/);
  // Nobody to ask (a run without a user): the answer says how to allow it.
  const other = project({ 'b.cs': 'use x\n' });
  const quiet = toolContext(other).ctx;
  quiet.services.permit = (r) => decide(r, { ...permissions(other, 'default'), interactive: false });
  const refused = await LspTool.prepare({ action: 'hover', file_path: 'b.cs', symbol: 'x' }, quiet);
  assert.match(refused.error?.content ?? '', /^The C# language server was not started: fakeLspServer loads the project's build files \(MSBuild\), which can run code\. It starts once you allow it for this project: .*the permission rule LSP\(csharp\) .* Right now: needs approval \(non-interactive run\)\.$/);
  // A rename asks to start the server first; the change itself is reviewed in the next call.
  const ren = await LspTool.prepare({ action: 'rename', file_path: 'b.cs', symbol: 'x', new_name: 'y' }, toolContext(other).ctx);
  assert.equal(ren.permission?.title, 'Start the C# language server for this project');
  assert.match((await ren.execute()).content, /^Allowed the C# language server for this project\. Run the rename again to review the change and apply it\.$/);
  assert.equal(readFileSync(path.join(other, 'b.cs'), 'utf8'), 'use x\n', 'nothing renamed yet');
});

// ------------------------------------------------------------------ the agent (real CLI, mock model)

/**
 * Runs `freecode -p` in a new project with these files and language server settings. The mock model
 * makes each call in its own step, then says "Done."; returns the tool results it got back.
 */
async function agentRun(files: Record<string, string>, servers: Record<string, ServerOverride>, calls: { name: string; args: Record<string, unknown> }[], flags: string[]): Promise<{ results: string[]; proj: string }> {
  const server = new MockServer();
  await server.start();
  try {
    const home = project({});
    const proj = project(files);
    const providers: Record<string, unknown> = {
      lspm: { baseURL: server.baseURL('lspm'), apiKey: 'test-key', discover: false, models: [{ id: 'm1', quality: 80, context: 100000, maxOutput: 4096, tools: 'native', speed: 50 }] },
    };
    for (const p of PROVIDERS) providers[p.id] ??= { enabled: false };
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ setupCompleted: true, router: { enabled: false, maxWaitSeconds: 1 }, providers, lsp: { servers } }));
    server.script('lspm', [...calls.map((c) => tools(c)), text('Done.')]);
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, '-p', 'go ahead', ...flags], {
        cwd: proj,
        env: { ...process.env, FREECODE_HOME: home, NO_COLOR: '1', HOME: home, USERPROFILE: home, FREECODE_DEBUG: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (b) => (stderr += b));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stderr });
      });
    });
    assert.equal(r.code, 0, r.stderr);
    const messages = server.requestsFor('lspm').at(-1)!.body.messages as { role: string; content: string }[];
    return { results: messages.filter((m) => m.role === 'tool').map((m) => m.content), proj };
  } finally {
    await server.stop();
  }
}

test('agent: an Edit result carries the errors the language server found (real CLI, mock model)', async () => {
  const { results, proj } = await agentRun({ 'a.fk': 'def alpha\nuse alpha\n' }, { fake: fake() }, [{ name: 'Edit', args: { file_path: 'a.fk', old_string: 'use alpha', new_string: 'use alpah' } }], ['--yolo']);
  assert.equal(readFileSync(path.join(proj, 'a.fk'), 'utf8'), 'def alpha\nuse alpah\n');
  assert.match(results[0]!, /^Edited a\.fk\./);
  assert.match(results[0]!, /\n\nfakeLspServer found 1 error in a\.fk after this edit:\n {2}2:5 Unknown name alpah \[E2\]\n/);
});

test('agent: the C# server starts without asking only with the rule LSP(csharp) or in bypass mode (real CLI)', async () => {
  const files = { 'a.cs': 'use alpha\n' };
  const servers = { csharp: { command: process.execPath, args: [FAKE] } };
  const calls = [
    { name: 'Edit', args: { file_path: 'a.cs', old_string: 'use alpha', new_string: 'use beta' } },
    { name: 'LSP', args: { action: 'hover', file_path: 'a.cs', symbol: 'beta' } },
  ];
  // Edits are allowed, the server is not (no rule, nobody to ask): no report, and the tool says how to allow it.
  let { results } = await agentRun(files, servers, calls, ['--accept-edits']);
  assert.match(results[0]!, /^Edited a\.cs\./);
  assert.doesNotMatch(results[0]!, /Unknown name/);
  assert.match(results[1]!, /^The C# language server was not started: .*permission rule LSP\(csharp\)/);
  for (const flags of [['--accept-edits', '--allowedTools', 'LSP(csharp)'], ['--yolo']]) {
    ({ results } = await agentRun(files, servers, calls, flags));
    assert.match(results[0]!, /\n\nfakeLspServer found 1 error in a\.cs after this edit:\n {2}1:5 Unknown name beta \[E2\]\n/, flags.join(' '));
    assert.equal(results[1], 'beta at a.cs:1:5:\n```fake\nbeta: symbol\n```', flags.join(' '));
  }
});

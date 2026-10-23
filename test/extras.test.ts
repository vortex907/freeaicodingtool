// Syntax checks after edits, workflow commands and the toolchain summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSyntax } from '../src/tools/syntaxCheck.js';
import { WORKFLOWS, findWorkflow } from '../src/agent/workflows.js';
import { refreshToolchain, toolchainSummary } from '../src/util/toolchain.js';
import { which } from '../src/util/platform.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { transcribe, voiceProvider } from '../src/server/voice.js';
import * as http from 'node:http';
import type { ProviderRuntime } from '../src/providers/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-extras-'));
const file = (name: string, text: string) => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
};

test('syntax check flags broken JSON and JavaScript and passes valid files', async () => {
  assert.match((await checkSyntax(file('bad.json', '{"a": 1,}\n'), dir)) ?? '', /bad\.json:1: invalid JSON/);
  assert.equal(await checkSyntax(file('good.json', '{"a": 1}\n'), dir), null);
  assert.equal(await checkSyntax(file('tsconfig.json', '{ // comments are allowed here\n "a": 1 }'), dir), null);
  assert.match((await checkSyntax(file('bad.js', 'function f( {\n'), dir)) ?? '', /bad\.js:\d+: SyntaxError/);
  assert.equal(await checkSyntax(file('good.mjs', 'export const a = 1;\n'), dir), null);
  assert.equal(await checkSyntax(file('notes.txt', '{{{'), dir), null);
});

test('syntax check flags broken Python when Python is installed', { skip: !(which('python3') || which('python')) && 'no python' }, async () => {
  const r = await checkSyntax(file('bad.py', 'def f(:\n    pass\n'), dir);
  // The Windows Store alias for python is not a real interpreter; then there is nothing to check.
  if (r === null && process.platform === 'win32') return;
  assert.match(r ?? '', /bad\.py:1:\d+ /);
  assert.equal(await checkSyntax(file('good.py', 'def f():\n    return 1\n'), dir), null);
});

test('workflow commands have prompts without em dashes and require arguments where needed', () => {
  const names = WORKFLOWS.map((w) => w.name);
  assert.equal(new Set(names).size, names.length);
  for (const w of WORKFLOWS) {
    const text = w.prompt('X');
    assert.ok(text.length > 80, w.name);
    assert.doesNotMatch(text, /[–—]/, `${w.name} uses a dash`);
  }
  assert.ok(findWorkflow('TDD')?.needsArgs);
  assert.match(findWorkflow('tdd')!.prompt('a login form'), /a login form/);
  assert.equal(findWorkflow('nope'), undefined);
});

test('toolchain summary lists node with a version', async () => {
  await refreshToolchain();
  assert.match(toolchainSummary(), /\bnode \d+\.\d+/);
});

test('rewinding to a checkpoint restores files from before that request and undoes later ones', async () => {
  const files = new FileTracker(true);
  const a = file('a.txt', 'v0');
  const b = path.join(dir, 'b.txt');
  files.beginTurn(1);
  await files.snapshot(a);
  writeFileSync(a, 'v1');
  files.beginTurn(2);
  await files.snapshot(a);
  writeFileSync(a, 'v2');
  await files.snapshot(b);
  writeFileSync(b, 'new');
  files.beginTurn(3);
  assert.deepEqual(files.checkpointList().map((c) => c.turn), [1, 2]);
  const r = await files.rewindTo(2);
  assert.deepEqual(r?.turns, [2]);
  assert.equal(readFileSync(a, 'utf8'), 'v1');
  assert.ok(!existsSync(b));
  await files.rewindTo(1);
  assert.equal(readFileSync(a, 'utf8'), 'v0');
  assert.equal(await files.rewindTo(1), null, 'nothing left to rewind');
});

test('voice input is sent to a Whisper endpoint as multipart audio', async () => {
  let seen = '';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = `${req.url} ${req.headers.authorization} ${body.includes('whisper-large-v3-turbo') ? 'model-ok' : ''} ${body.includes('filename="speech.webm"') ? 'file-ok' : ''}`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ' add a dark mode toggle ' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const groq = { id: 'groq', enabled: true, configured: true, paid: false, apiKeys: ['gsk_test'], baseURL: `http://127.0.0.1:${port}/openai/v1` } as never as ProviderRuntime;
  assert.equal(voiceProvider([]), undefined);
  assert.equal((await transcribe([], Buffer.from('x'), 'audio/webm')).ok, false);
  const r = await transcribe([groq], Buffer.from('fake audio bytes'), 'audio/webm;codecs=opus');
  srv.close();
  assert.deepEqual(r, { ok: true, text: 'add a dark mode toggle' });
  assert.equal(seen, '/openai/v1/audio/transcriptions Bearer gsk_test model-ok file-ok');
});

// Syntax checks after edits, workflow commands and the toolchain summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSyntax } from '../src/tools/syntaxCheck.js';
import { WORKFLOWS, findWorkflow } from '../src/agent/workflows.js';
import { refreshToolchain, toolchainSummary } from '../src/util/toolchain.js';
import { which } from '../src/util/platform.js';

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

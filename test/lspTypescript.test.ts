// Integration test with a real language server: typescript-language-server. It runs only when the
// server is installed (npm install -g typescript-language-server typescript@6) and is skipped otherwise,
// as on CI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyLspSettings, getLsp, stopLanguageServers } from '../src/lsp/index.js';
import { SERVER_DEFS, resolveServer } from '../src/lsp/servers.js';
import { LspTool } from '../src/tools/lspTool.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import type { SessionState, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'fc-tsls-')));
const found = resolveServer(SERVER_DEFS.find((d) => d.id === 'typescript')!, dir);
// It never runs the project's own TypeScript, so it needs a TypeScript 5 or 6 outside the project.
const tsserver = found.ok ? (found.launch.initializationOptions as { tsserver?: { path?: string } } | undefined)?.tsserver?.path : undefined;
const skip = found.ok && found.launch.label === 'typescript-language-server' && tsserver ? false : 'needs typescript-language-server and a global TypeScript 5 or 6';

after(() => stopLanguageServers());

function write(rel: string, text: string): string {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A path as the tools show it on this OS. */
const shown = (rel: string) => rel.split('/').join(path.sep);

test('typescript-language-server: definition, references, hover, errors after edits and a rename across files', { skip, timeout: 180_000 }, async () => {
  write('package.json', JSON.stringify({ name: 'tsls-check', private: true, type: 'module' }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, include: ['src'] }));
  const mathText = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
  const mainText = "import { add } from './math.js';\n\nconst total: number = add(1, 2);\nconsole.log(total);\n";
  const math = write('src/math.ts', mathText);
  const main = write('src/main.ts', mainText);
  applyLspSettings({});
  const lsp = getLsp();
  // The first start can take a while on a cold machine.
  const acq = await lsp.acquire(main, dir, { waitMs: 60_000 });
  assert.ok(acq.ok, acq.ok ? '' : acq.message);
  const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
  const files = new FileTracker(true);
  files.beginTurn(1);
  const ctx = { projectRoot: dir, session, settings: { permissions: { additionalDirectories: [] } }, files, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;
  const run = async (input: Record<string, unknown>): Promise<string> => {
    const prep = await LspTool.prepare(input, ctx);
    const r: ToolResult = prep.error ?? (await prep.execute());
    assert.equal(r.isError, undefined, r.content);
    return r.content;
  };

  // The project is loaded before the first answer: the definition is the function, not the import.
  assert.equal(await run({ action: 'definition', file_path: 'src/main.ts', symbol: 'add', line: 3 }), `Definition of add:\n${shown('src/math.ts')}:1:17  export function add(a: number, b: number): number {`);
  assert.equal(
    await run({ action: 'references', file_path: 'src/math.ts', symbol: 'add' }),
    [
      '3 references in 2 files to add (the definition included):',
      `${shown('src/main.ts')}:1:10  import { add } from './math.js';`,
      `${shown('src/main.ts')}:3:23  const total: number = add(1, 2);`,
      `${shown('src/math.ts')}:1:17  export function add(a: number, b: number): number {`,
    ].join('\n'),
  );
  assert.match(await run({ action: 'hover', file_path: 'src/main.ts', symbol: 'add', line: 3 }), /add\(a: number, b: number\): number/);
  assert.equal(await run({ action: 'symbols', file_path: 'src/math.ts' }), `Symbols in ${shown('src/math.ts')}:\nfunction add (line 1)`);

  // Errors after edits: a type error, its fix, and a changed signature that breaks the caller.
  writeFileSync(main, mainText.replace('const total: number', 'const total: string'));
  assert.equal((await lsp.afterEdit([main], dir))[0], `typescript-language-server found 1 error in ${shown('src/main.ts')} after this edit:\n  3:7 Type 'number' is not assignable to type 'string'. [TS2322]\nFix the errors this edit caused before moving on.`);
  writeFileSync(main, mainText);
  assert.equal((await lsp.afterEdit([main], dir))[0], `typescript-language-server: no errors left in ${shown('src/main.ts')}.`);
  // A file that stays clean gets no new diagnostics from this server; the edit still learns about the caller.
  writeFileSync(math, 'export function add(a: number): number {\n  return a;\n}\n');
  const started = Date.now();
  assert.equal((await lsp.afterEdit([math], dir))[0], `New errors in other files:\n  ${shown('src/main.ts')}:3:30 Expected 1 arguments, but got 2. [TS2554]`);
  assert.ok(Date.now() - started < 3500, 'not held up until the timeout');
  writeFileSync(math, mathText);
  await lsp.afterEdit([math], dir);

  // Rename across files, then undo.
  const prep = await LspTool.prepare({ action: 'rename', file_path: 'src/math.ts', symbol: 'add', new_name: 'sum' }, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  assert.match((await prep.execute()).content, /^Renamed add to sum: 3 changes in 2 files\./);
  assert.equal(readFileSync(math, 'utf8'), mathText.replace('add', 'sum'));
  assert.equal(readFileSync(main, 'utf8'), mainText.replaceAll('add', 'sum'));
  await files.undoLast();
  assert.equal(readFileSync(math, 'utf8'), mathText);
  assert.equal(readFileSync(main, 'utf8'), mainText);
});

test("typescript-language-server never runs the project's own TypeScript", { skip, timeout: 120_000 }, async () => {
  const hostile = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'fc-tsls-own-')));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(hostile, rel)), { recursive: true });
    writeFileSync(path.join(hostile, rel), text);
    return path.join(hostile, rel);
  };
  put('package.json', JSON.stringify({ name: 'own-ts', private: true }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
  // A repository can ship any node_modules/typescript; loading it would run its code.
  const marker = path.join(hostile, 'ran.txt');
  put('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.9.9' }));
  put('node_modules/typescript/lib/tsserver.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'the project code ran');\n`);
  const file = put('src/a.ts', 'const n: number = 1;\n');
  applyLspSettings({});
  const acq = await getLsp().acquire(file, hostile, { waitMs: 60_000 });
  assert.ok(acq.ok, acq.ok ? '' : acq.message);
  assert.match(acq.client.label, /^typescript-language-server \(TypeScript [56]\.[\d.]+, the project has 5\.9\.9\)$/);
  writeFileSync(file, "const n: number = 'one';\n");
  assert.match((await getLsp().afterEdit([file], hostile))[0] ?? '', /found 1 error in src[\\/]a\.ts after this edit:\n  1:7 Type 'string' is not assignable to type 'number'\. \[TS2322\]/);
  assert.equal(existsSync(marker), false, "the project's tsserver.js was never run");
});

// NotebookEdit: replace, insert and delete cells, keep the file's formatting, ask like Edit and undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotebookEditTool } from '../src/tools/notebook.js';
import { ReadTool } from '../src/tools/fileTools.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { decide, ruleMatches } from '../src/permissions/permissions.js';
import type { PreparedCall, SessionState, ToolContext } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-nb-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
const files = new FileTracker(true);
const ctx = { projectRoot: dir, session, settings: { env: {}, permissions: { additionalDirectories: [] } }, files, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;

/** Jupyter's own style: sorted keys, one-space indent, a final newline. */
const jupyter = (nb: unknown) => JSON.stringify(nb, null, 1) + '\n';

function notebook() {
  return {
    cells: [
      { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Title\n', 'Some text'] },
      {
        cell_type: 'code',
        execution_count: 3,
        id: 'calc',
        metadata: { tags: ['keep'] },
        outputs: [{ name: 'stdout', output_type: 'stream', text: ['42\n'] }],
        source: ['x = 6 * 7\n', 'print(x)'],
      },
      { cell_type: 'code', execution_count: null, id: 'tail', metadata: {}, outputs: [], source: [] },
    ],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python', version: '3.12.0' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function prepare(input: Record<string, unknown>): Promise<PreparedCall> {
  return NotebookEditTool.prepare(input, ctx);
}

async function edit(input: Record<string, unknown>): Promise<string> {
  const prep = await prepare(input);
  assert.equal(prep.error, undefined, prep.error?.content);
  const r = await prep.execute();
  assert.equal(r.isError, undefined, r.content);
  return r.content;
}

async function readFirst(file: string): Promise<string> {
  const prep = await ReadTool.prepare({ file_path: file }, ctx);
  session.toolSeq = (session.toolSeq ?? 0) + 1;
  return (await prep.execute()).content;
}

test('replace, insert and delete cells by number or id, keeping the rest of the file as it was', async () => {
  const file = path.join(dir, 'analysis.ipynb');
  const original = jupyter(notebook());
  writeFileSync(file, original);
  files.beginTurn(1);
  assert.match(await readFirst(file), /# %% \[code\] cell 2 \(id calc\)/);

  // Replace asks for permission exactly like Edit: an edit request with a diff preview.
  const prep = await prepare({ notebook_path: 'analysis.ipynb', cell_number: 2, new_source: 'x = 7 * 6\nprint(x)\n' });
  assert.equal(prep.permission?.category, 'edit');
  assert.equal(prep.permission?.tool, 'NotebookEdit');
  assert.equal(prep.permission?.path, file);
  assert.equal(prep.permission?.preview?.kind, 'diff');
  assert.ok(ruleMatches('Edit', prep.permission!, dir), 'Edit rules cover notebook edits');
  const perms = { mode: 'acceptEdits' as const, allow: [], deny: [], ask: [], projectRoot: dir, additionalDirectories: [], sessionAllow: new Set<string>(), interactive: true };
  assert.equal(decide(prep.permission!, perms).action, 'allow');
  assert.equal(decide(prep.permission!, { ...perms, mode: 'default' }).action, 'ask');
  const msg = (await prep.execute()).content;
  assert.match(msg, /Replaced cell 2 \(id calc\) .* with a code cell; its outputs were cleared/);
  const expected = notebook();
  Object.assign(expected.cells[1]!, { execution_count: null, outputs: [], source: ['x = 7 * 6\n', 'print(x)\n'] });
  assert.equal(readFileSync(file, 'utf8'), jupyter(expected), 'only the edited cell changed, formatting kept');

  // Insert a markdown cell first; it gets a fresh id because this is nbformat 4.5.
  files.beginTurn(2);
  assert.match(await edit({ notebook_path: file, edit_mode: 'insert', cell_number: 1, cell_type: 'markdown', new_source: 'Intro' }), /Inserted a markdown cell as cell 1 \(id [0-9a-f]{8}\).*now has 4 cells/);
  let nb = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(nb.cells[0]), ['cell_type', 'id', 'metadata', 'source']);
  assert.deepEqual(nb.cells[0].source, ['Intro']);
  assert.equal(nb.cells[1].id, 'intro');

  // Insert after a cell id, then delete by id.
  assert.match(await edit({ notebook_path: file, edit_mode: 'insert', cell_id: 'calc', new_source: 'y = x + 1' }), /Inserted a code cell as cell 4/);
  nb = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(nb.cells[3]), ['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);
  assert.match(await edit({ notebook_path: file, edit_mode: 'delete', cell_id: 'tail' }), /Deleted cell 5 \(code\).*now has 4 cells/);
  nb = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(nb.cells.map((c: { id: string }) => c.id).slice(1), ['intro', 'calc', nb.cells[3].id]);
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.nbformat_minor, 5);
  assert.deepEqual(nb.metadata, notebook().metadata);

  // Changing the type of a cell: code becomes markdown without outputs.
  assert.match(await edit({ notebook_path: file, cell_id: 'calc', cell_type: 'markdown', new_source: 'Now text' }), /with a markdown cell/);
  nb = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(nb.cells[2]), ['cell_type', 'id', 'metadata', 'source']);
  assert.deepEqual(nb.cells[2].metadata, { tags: ['keep'] });

  // Undo goes back request by request.
  await files.undoLast();
  assert.match(readFileSync(file, 'utf8'), /"x = 7 \* 6\\n"/);
  await files.undoLast();
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('bad requests are refused before anything is written', async () => {
  const file = path.join(dir, 'other.ipynb');
  writeFileSync(file, jupyter(notebook()));
  assert.match((await prepare({ notebook_path: file, cell_number: 1, new_source: 'x' })).error!.content, /Read .*other\.ipynb first/);
  await readFirst(file);
  assert.match((await prepare({ notebook_path: file, cell_number: 1 })).error!.content, /new_source/);
  assert.match((await prepare({ notebook_path: file, cell_number: 0, new_source: 'x' })).error!.content, /starts at 1/);
  assert.match((await prepare({ notebook_path: file, cell_number: 9, new_source: 'x' })).error!.content, /has 3 cells; there is no cell 9/);
  assert.match((await prepare({ notebook_path: file, cell_id: 'nope', new_source: 'x' })).error!.content, /No cell with id "nope".*1: intro, 2: calc, 3: tail/);
  assert.match((await prepare({ notebook_path: file, edit_mode: 'insert', cell_number: 5, new_source: 'x' })).error!.content, /cell_number 1 to 4/);
  assert.match((await prepare({ notebook_path: file, edit_mode: 'move', cell_number: 1 })).error!.content, /Unknown edit_mode/);
  assert.match((await prepare({ notebook_path: file, cell_number: 1, cell_type: 'raw', new_source: 'x' })).error!.content, /code or markdown/);
  writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.match((await prepare({ notebook_path: 'notes.txt', cell_number: 1, new_source: 'x' })).error!.content, /not a Jupyter notebook/);
  // A cell number given as an id still works.
  assert.equal((await prepare({ notebook_path: file, cell_id: '2', new_source: 'z = 1' })).error, undefined);
  // Changed on disk after the read.
  writeFileSync(file, jupyter({ ...notebook(), nbformat_minor: 4 }));
  const later = new Date(Date.now() + 5000);
  (await import('node:fs')).utimesSync(file, later, later);
  assert.match((await prepare({ notebook_path: file, cell_number: 1, new_source: 'x' })).error!.content, /modified .* since you last read it/);
});

test('notebooks written by other tools keep their indent, string sources and ASCII escapes', async () => {
  const file = path.join(dir, 'ascii.ipynb');
  const nb = { nbformat: 4, nbformat_minor: 2, metadata: {}, cells: [{ cell_type: 'markdown', metadata: {}, source: 'Caf\\u00e9 notes' }] };
  // Two-space indent and \u escapes, like json.dump(ensure_ascii=True); no cell ids before nbformat 4.5.
  writeFileSync(file, JSON.stringify(nb, null, 2).replace('Caf\\\\u00e9', 'Caf\\u00e9'));
  await readFirst(file);
  await edit({ notebook_path: file, edit_mode: 'insert', cell_type: 'code', new_source: 'print("na\u00efve")\nx = 1' });
  const raw = readFileSync(file, 'utf8');
  assert.match(raw, /^\{\n  "nbformat": 4,/);
  assert.ok(!raw.endsWith('\n'), 'no newline added at the end');
  assert.match(raw, /"source": "print\(\\"na\\u00efve\\"\)\\nx = 1"/);
  assert.match(raw, /Caf\\u00e9 notes/);
  const cells = JSON.parse(raw).cells;
  assert.equal(cells.length, 2);
  assert.equal(cells[1].id, undefined);
  assert.equal(cells[0].source, 'Caf\u00e9 notes');
});

// LSP tool: asks the project's language servers about code. Definition, references, hover (types),
// rename (edits files), symbols (outline or project search) and diagnostics (a file or the project).
// A server that runs code from the project (C#, TypeScript with only the project's own TypeScript)
// starts only after the user allowed it: the first call that needs it asks.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PermissionRequest, PreparedCall, Tool, ToolContext, ToolResult } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { isInProject, listFiles, resolvePath } from './listFiles.js';
import { buildHunks, diffStats } from './diff.js';
import { displayPath } from '../util/fs.js';
import { escapeRegExp, truncate } from '../util/strings.js';
import { isAbortError } from '../util/async.js';
import { getLsp, notStartedMessage, type StartCheck } from '../lsp/index.js';
import { LspError, MAX_SYNC_BYTES, RequestTimeoutError, ServerExitedError, type Doc, type LspClient } from '../lsp/client.js';
import { applyTextEdits, editsByFile } from '../lsp/edits.js';
import { fileDiagnosticsReport, hoverText, outline, plural, projectDiagnosticsReport, sourceLine, symbolKind } from '../lsp/format.js';
import { splitLines, uriKey, uriToPath, type Diagnostic, type DocumentSymbol, type Hover, type Location, type LocationLink, type Position, type SymbolInformation, type WorkspaceEdit } from '../lsp/protocol.js';

const ACTIONS = ['definition', 'references', 'hover', 'rename', 'symbols', 'diagnostics'] as const;
type Action = (typeof ACTIONS)[number];

/** How long a call waits for a server that is starting. */
const STARTUP_WAIT_MS = 60_000;
/** For this long after a server started, calls first wait for it to finish loading the project. */
const LOAD_WINDOW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REFERENCE_LINES = 80;
/** A line that imports a name: a definition answer pointing there stopped at the import. */
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s*[{*]|use\s|using\s|#\s*include\b)|\brequire\s*\(/;

export function parseAction(raw: string | undefined): Action | null {
  // "textDocument/definition", "find_references", "get_diagnostics", "documentSymbols" ...
  const a = (raw ?? '')
    .toLowerCase()
    .replace(/[\s_/-]+/g, '')
    .replace(/^(textdocument|workspace)(?=.)/, '')
    .replace(/^(get|find|goto|show|list|lookup)(?=.)/, '');
  if ((ACTIONS as readonly string[]).includes(a)) return a as Action;
  if (/^(type)?(def|decl|impl)/.test(a)) return 'definition';
  if (/^(ref|usage|uses|callers|occurrence)/.test(a)) return 'references';
  if (/^rename/.test(a)) return 'rename';
  // Before hover, which takes "doc...".
  if (/^(document|workspace|file|project)?(symbol|outline)/.test(a)) return 'symbols';
  if (/^(diag|error|problem|check|lint|warning)/.test(a)) return 'diagnostics';
  if (/^(hover|type|info|signature|doc|quickinfo)/.test(a)) return 'hover';
  return null;
}

/**
 * Where the model points: line and column (1-based), or a symbol name, looked for on the given line
 * first and then outwards (line numbers from models are often a little off). Several positions for a
 * name: the first hit may be in a comment, where the server finds nothing.
 */
export function locate(text: string, opts: { line?: number; column?: number; symbol?: string }): Position[] | string {
  const lines = splitLines(text);
  const { line, column } = opts;
  const name = opts.symbol?.trim();
  if (line !== undefined && (line < 1 || line > lines.length)) return `Line ${line} is outside the file (it has ${lines.length} lines).`;
  if (name) {
    // "obj.greet()", "Foo::bar", "ptr->baz": the name as given, then without the call, then its last part.
    const bare = name.replace(/\(\)$/, '');
    const names = [name, bare, bare.split(/::|->|[.#]/).pop()!].filter((n, i, all) => n && all.indexOf(n) === i);
    for (const n of names) {
      const re = new RegExp(`(?<![\\w$])${escapeRegExp(n)}(?![\\w$])`, 'g');
      const hits = (i: number): Position[] => [...(lines[i] ?? '').matchAll(re)].map((m) => ({ line: i, character: m.index! }));
      let found: Position[] = [];
      if (line !== undefined) {
        for (let d = 0; d <= 5 && !found.length; d++) for (const i of d ? [line - 1 - d, line - 1 + d] : [line - 1]) found.push(...hits(i));
        if (column !== undefined && found.length) found.sort((a, b) => Math.abs(a.character - (column - 1)) - Math.abs(b.character - (column - 1)));
      } else for (let i = 0; i < lines.length && found.length < 5; i++) found.push(...hits(i));
      if (found.length) return found.slice(0, 5);
    }
    return line !== undefined ? `"${name}" does not appear on or near line ${line}.` : `"${name}" does not appear in the file.`;
  }
  if (line === undefined) return 'Say which symbol: give symbol (its name), or line and column.';
  if (column === undefined) return 'Give column (1-based) or symbol together with line.';
  return [{ line: line - 1, character: Math.min(Math.max(0, column - 1), lines[line - 1]!.length) }];
}

function toLocations(res: Location | Location[] | LocationLink[] | null | undefined): Location[] {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l)).filter((l) => l && typeof l.uri === 'string' && l.range);
}

/** Reads files once per call, preferring what the server has open. */
function textReader(client: LspClient) {
  const cache = new Map<string, string | undefined>();
  return async (file: string): Promise<string | undefined> => {
    if (cache.has(file)) return cache.get(file);
    const text = client.doc(file)?.text ?? (await fsp.readFile(file, 'utf8').catch(() => undefined));
    cache.set(file, text);
    return text;
  };
}

async function locationLines(locs: Location[], client: LspClient, ctx: ToolContext, max: number): Promise<string[]> {
  const read = textReader(client);
  const out: string[] = [];
  for (const l of locs.slice(0, max)) {
    const file = uriToPath(l.uri);
    const where = `${file ? displayPath(file, ctx.session.cwd) : l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
    const src = file ? sourceLine(await read(file), l.range.start.line) : '';
    out.push(src ? `${where}  ${src}` : where);
  }
  if (locs.length > max) out.push(`and ${locs.length - max} more`);
  return out;
}

/** Added to an empty answer from a server that is still busy loading or indexing the project. */
const LOADING = ' The language server is still loading the project, so try again in a moment.';

type Run<T> = { ok: true; value: T; client: LspClient } | { ok: false; result: ToolResult };

/** A mistake in the call (a name not in the file, a line out of range): told to the model as it is. */
class UsageError extends Error {}

/** Servers that run project code may start when the permission rules or mode allow it without asking. */
function mayStart(ctx: ToolContext): StartCheck {
  return (req) => ctx.services.permit?.(req).action === 'allow';
}

function unsyncable(file: string, ctx: ToolContext): string {
  return `${displayPath(file, ctx.session.cwd)} cannot be read, or it is larger than ${MAX_SYNC_BYTES / 1024 / 1024} MB (language servers do not get files that big).`;
}

/** Runs `fn` against the server for `file`; a server that crashes in the middle is started once more. */
async function onServer<T>(file: string, ctx: ToolContext, fn: (client: LspClient) => Promise<T>): Promise<Run<T>> {
  for (let attempt = 0; ; attempt++) {
    const acq = await getLsp().acquire(file, ctx.projectRoot, { waitMs: STARTUP_WAIT_MS, signal: ctx.signal, mayStart: mayStart(ctx) });
    if (ctx.signal.aborted) return { ok: false, result: fail('Interrupted by the user.') };
    if (!acq.ok) return { ok: false, result: fail(acq.message) };
    try {
      // Files changed outside FreeCode (by a command, by the user) are sent again first.
      await acq.client.refreshOpenDocs();
      return { ok: true, value: await fn(acq.client), client: acq.client };
    } catch (e) {
      if (e instanceof ServerExitedError && attempt === 0) continue;
      if (e instanceof UsageError) return { ok: false, result: fail(e.message) };
      if (isAbortError(e) || ctx.signal.aborted) return { ok: false, result: fail('Interrupted by the user.') };
      if (e instanceof RequestTimeoutError) return { ok: false, result: fail(`${e.message}. It may still be loading the project; try again in a moment.`) };
      if (e instanceof ServerExitedError) return { ok: false, result: fail(e.message) };
      return { ok: false, result: fail(`${acq.client.label}: ${e instanceof LspError ? e.message.replace(/^[^:]*: /, '') : (e as Error).message}`) };
    }
  }
}

/**
 * Opens or updates `file` in the server. A server that started a short while ago may begin loading the
 * project only now and answer from part of it meanwhile (an import instead of the definition), so this
 * waits for that to finish, a while at most.
 */
async function syncFile(client: LspClient, file: string, ctx: ToolContext): Promise<{ doc: Doc; changed: boolean }> {
  const synced = await client.sync(file, { save: true });
  if (!synced) throw new UsageError(unsyncable(file, ctx));
  await client.whenIdle(client.readyAt + LOAD_WINDOW_MS - Date.now(), ctx.signal);
  return synced;
}

/** Syncs the file and finds the positions the model means; throws a readable message otherwise. */
async function openAt(client: LspClient, file: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ uri: string; positions: Position[]; text: string }> {
  const synced = await syncFile(client, file, ctx);
  const located = locate(synced.doc.text, { line: numParam(input, 'line', 'line_number', 'row'), column: numParam(input, 'column', 'character', 'col', 'char'), symbol: symbolParam(input) });
  if (typeof located === 'string') throw new UsageError(located);
  return { uri: synced.doc.uri, positions: located, text: synced.doc.text };
}

function symbolParam(input: Record<string, unknown>): string | undefined {
  return strParam(input, 'symbol', 'name', 'identifier', 'word', 'symbol_name')?.trim() || undefined;
}

/** The identifier around a position (the column may point into the middle of it). */
function nameAt(text: string, pos: Position): string {
  const line = splitLines(text)[pos.line] ?? '';
  let start = Math.min(pos.character, line.length);
  while (start > 0 && /[\w$]/.test(line[start - 1]!)) start--;
  const m = /^[\w$]+/.exec(line.slice(start));
  return m ? m[0] : `line ${pos.line + 1}`;
}

// ------------------------------------------------------------------ read actions

async function definition(file: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const run = await onServer(file, ctx, async (c) => {
    const at = await openAt(c, file, input, ctx);
    const ask = async (position: Position) => toLocations(await c.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', { textDocument: { uri: at.uri }, position }, REQUEST_TIMEOUT_MS, ctx.signal));
    const here = uriKey(at.uri);
    const lines = splitLines(at.text);
    for (const position of at.positions) {
      let locs = await ask(position);
      // Only the import of the name in this file (servers do that while loading): follow it once.
      const first = locs[0];
      if (first && locs.every((l) => uriKey(l.uri) === here && IMPORT_LINE.test(lines[l.range.start.line] ?? ''))) {
        const next = (await ask(first.range.start)).filter((l) => uriKey(l.uri) !== here || l.range.start.line !== first.range.start.line);
        if (next.length) locs = next;
      }
      if (locs.length) return { name: nameAt(at.text, position), lines: await locationLines(locs, c, ctx, 20), count: locs.length };
    }
    return { name: nameAt(at.text, at.positions[0]!), lines: [], count: 0 };
  });
  if (!run.ok) return run.result;
  const { name, lines, count } = run.value;
  if (!count) return ok(`${run.client.label} found no definition of ${name}.${run.client.busy ? LOADING : ' It may be built in, generated, or defined in a library without sources.'}`, { kind: 'summary', text: 'No definition found' });
  return ok(`Definition of ${name}:\n${lines.join('\n')}`, { kind: 'summary', text: count === 1 ? lines[0]!.split('  ')[0]! : `${count} definitions` });
}

async function references(file: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const run = await onServer(file, ctx, async (c) => {
    const at = await openAt(c, file, input, ctx);
    for (const position of at.positions) {
      const res = await c.request<Location[] | null>('textDocument/references', { textDocument: { uri: at.uri }, position, context: { includeDeclaration: true } }, REQUEST_TIMEOUT_MS, ctx.signal);
      const locs = toLocations(res).sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
      if (locs.length) return { name: nameAt(at.text, position), locs, lines: await locationLines(locs, c, ctx, MAX_REFERENCE_LINES) };
    }
    return { name: nameAt(at.text, at.positions[0]!), locs: [] as Location[], lines: [] as string[] };
  });
  if (!run.ok) return run.result;
  const { name, locs, lines } = run.value;
  if (!locs.length) return ok(`${run.client.label} found no references to ${name}.${run.client.busy ? LOADING : ''}`, { kind: 'summary', text: 'No references found' });
  const files = new Set(locs.map((l) => l.uri)).size;
  const summary = `${plural(locs.length, 'reference')} in ${plural(files, 'file')}`;
  return ok(`${summary} to ${name} (the definition included):\n${lines.join('\n')}`, { kind: 'summary', text: summary });
}

async function hover(file: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const run = await onServer(file, ctx, async (c) => {
    const at = await openAt(c, file, input, ctx);
    for (const position of at.positions) {
      const text = hoverText(await c.request<Hover | null>('textDocument/hover', { textDocument: { uri: at.uri }, position }, REQUEST_TIMEOUT_MS, ctx.signal));
      if (text) return { name: nameAt(at.text, position), position, text };
    }
    return { name: nameAt(at.text, at.positions[0]!), position: at.positions[0]!, text: '' };
  });
  if (!run.ok) return run.result;
  const { name, position, text } = run.value;
  const where = `${displayPath(file, ctx.session.cwd)}:${position.line + 1}:${position.character + 1}`;
  if (!text) return ok(`${run.client.label} has no type information for ${name} at ${where}.${run.client.busy ? LOADING : ''}`, { kind: 'summary', text: 'No information' });
  return ok(`${name} at ${where}:\n${truncate(text, 6000)}`, { kind: 'summary', text: truncate(text.replace(/```\w*\n?/g, '').split('\n').find((l) => l.trim()) ?? name, 80) });
}

/** A file of the project's main language, so a project-wide query has a server to ask. */
async function representativeFile(projectRoot: string): Promise<string | null> {
  const lsp = getLsp();
  const counts = new Map<string, { n: number; first: string }>();
  for (const rel of (await listFiles(projectRoot).catch(() => [] as string[])).slice(0, 20_000)) {
    const def = lsp.defFor(rel);
    if (!def) continue;
    const c = counts.get(def.id) ?? { n: 0, first: rel };
    c.n++;
    counts.set(def.id, c);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? path.join(projectRoot, best.first) : null;
}

async function symbols(file: string | null, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = strParam(input, 'query', 'q', 'search', 'pattern')?.trim();
  if (file && !query) {
    const run = await onServer(file, ctx, async (c) => {
      const synced = await syncFile(c, file, ctx);
      return (await c.request<(DocumentSymbol | SymbolInformation)[] | null>('textDocument/documentSymbol', { textDocument: { uri: synced.doc.uri } }, REQUEST_TIMEOUT_MS, ctx.signal)) ?? [];
    });
    if (!run.ok) return run.result;
    const rel = displayPath(file, ctx.session.cwd);
    if (!run.value.length) return ok(`${run.client.label} found no symbols in ${rel}.`, { kind: 'summary', text: 'No symbols' });
    const o = outline(run.value);
    return ok(`Symbols in ${rel}:\n${o.text}`, { kind: 'summary', text: `${plural(o.count, 'symbol')}` });
  }
  if (!query) return fail('Give file_path for the outline of a file, or query to search symbols in the whole project.');
  // Every running server of the project is asked; without one, the server of the main language starts.
  const targets = file ? [file] : getLsp().running(ctx.projectRoot).length ? [] : [await representativeFile(ctx.projectRoot)].filter((f): f is string => !!f);
  const clients = new Map<LspClient, string | null>();
  for (const t of targets) {
    const acq = await getLsp().acquire(t, ctx.projectRoot, { waitMs: STARTUP_WAIT_MS, signal: ctx.signal, mayStart: mayStart(ctx) });
    if (!acq.ok) return fail(acq.message);
    clients.set(acq.client, t);
  }
  if (!file) for (const r of getLsp().running(ctx.projectRoot)) if (!clients.has(r.client)) clients.set(r.client, null);
  if (!clients.size) return fail('No language server could be started for this project. Give file_path to say which language to use.');
  const found: { s: SymbolInformation; label: string }[] = [];
  const errors: string[] = [];
  await Promise.all(
    [...clients].map(async ([c, open]) => {
      try {
        // Some servers only know a project once one of its files is open.
        if (open) await syncFile(c, open, ctx);
        const res = await c.request<SymbolInformation[] | null>('workspace/symbol', { query }, REQUEST_TIMEOUT_MS, ctx.signal);
        for (const s of res ?? []) found.push({ s, label: c.label });
      } catch (e) {
        errors.push(`${c.label}: ${(e as Error).message}`);
      }
    }),
  );
  if (!found.length) return errors.length ? fail(`Symbol search failed: ${errors.join('; ')}`) : ok(`No symbols match "${query}".${[...clients.keys()].some((c) => c.busy) ? LOADING : ''}`, { kind: 'summary', text: 'No symbols found' });
  const q = query.toLowerCase();
  // Exact names first, then prefixes, then the rest; project files before libraries.
  const rank = (s: SymbolInformation) => {
    const n = s.name.toLowerCase();
    const file = uriToPath(s.location.uri);
    return (n === q ? 0 : n.startsWith(q) ? 1 : 2) * 2 + (file && isInProject(file, ctx.projectRoot) ? 0 : 1);
  };
  found.sort((a, b) => rank(a.s) - rank(b.s) || a.s.name.localeCompare(b.s.name));
  const lines = found.slice(0, 60).map(({ s }) => {
    const file = uriToPath(s.location.uri);
    const line = 'range' in s.location ? `:${s.location.range.start.line + 1}` : '';
    return `${symbolKind(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''}  ${file ? displayPath(file, ctx.session.cwd) : s.location.uri}${line}`;
  });
  if (found.length > 60) lines.push(`and ${found.length - 60} more`);
  return ok(`${plural(found.length, 'symbol')} matching "${query}":\n${lines.join('\n')}`, { kind: 'summary', text: `${plural(found.length, 'symbol')} matching "${truncate(query, 40)}"` });
}

async function diagnostics(file: string | null, ctx: ToolContext): Promise<ToolResult> {
  if (!file) {
    const changed = [...ctx.files.sessionChanges().keys()];
    const res = await getLsp().projectDiagnostics(ctx.projectRoot, { signal: ctx.signal, prefer: changed, timeoutMs: 45_000, mayStart: mayStart(ctx) });
    if (ctx.signal.aborted) return fail('Interrupted by the user.');
    if (!res.servers.length) return fail(res.notes.length ? res.notes.join('\n') : 'No files of a language with a language server were found in this project.');
    const report = projectDiagnosticsReport(res.files.map((f) => ({ rel: displayPath(f.file, ctx.session.cwd), items: f.items })));
    const head = `${res.servers.join(', ')} checked ${plural(res.checked, 'file')}${res.limited ? ' (the most recently changed ones of each language)' : ''}: ${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}.`;
    const text = [head, report.text, ...res.notes].filter(Boolean).join('\n');
    return ok(text, { kind: 'summary', text: `${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}` });
  }
  const run = await onServer(file, ctx, async (c) => {
    const since = c.diagnosticsSeq;
    const synced = await c.sync(file, { save: true });
    if (!synced) throw new UsageError(unsyncable(file, ctx));
    // A document the server already had unchanged: what it pushed last is current.
    const known = c.lastDiagnostics(file);
    const items: Diagnostic[] | null = !synced.changed && !c.pullsDiagnostics && known ? known : await c.diagnosticsFor(synced.doc, synced.changed ? since : -1, 15_000, ctx.signal);
    return items;
  });
  if (!run.ok) return run.result;
  const rel = displayPath(file, ctx.session.cwd);
  if (!run.value) return fail(`${run.client.label} did not report diagnostics for ${rel} in time. It may still be loading the project; try again in a moment.`);
  const note = getLsp().defFor(file)?.unreliable?.(run.value, run.client.root);
  const errors = run.value.filter((d) => d.severity === undefined || d.severity === 1).length;
  const warnings = run.value.filter((d) => d.severity === 2).length;
  return ok(fileDiagnosticsReport(rel, run.client.label, run.value) + (note ? `\n${note}` : ''), { kind: 'summary', text: `${plural(errors, 'error')}, ${plural(warnings, 'warning')} in ${path.basename(file)}` });
}

// ------------------------------------------------------------------ rename

interface FileChange {
  file: string;
  before: string;
  after: string;
  count: number;
  lines: number[];
}

const newNameParam = (input: Record<string, unknown>) => strParam(input, 'new_name', 'newName', 'to', 'new', 'rename_to')?.trim() || undefined;

/** Renames that are refused before any server is asked. */
function renameRefusal(input: Record<string, unknown>, ctx: ToolContext): PreparedCall | null {
  if (ctx.depth > 0) return errorResult('Sub-agents can use LSP to read code (definition, references, hover, symbols, diagnostics) but not to rename. Report what should be renamed instead.');
  if (ctx.session.permissionMode === 'plan') return errorResult('Plan mode is read-only: rename after the plan is approved.');
  if (!newNameParam(input)) return errorResult('Missing required parameter for rename: new_name');
  return null;
}

async function prepareRename(file: string, input: Record<string, unknown>, ctx: ToolContext): Promise<PreparedCall> {
  const newName = newNameParam(input)!;
  const run = await onServer(file, ctx, async (c) => {
    const at = await openAt(c, file, input, ctx);
    const canPrepare = !!(c.capabilities.renameProvider && typeof c.capabilities.renameProvider === 'object' && (c.capabilities.renameProvider as { prepareProvider?: boolean }).prepareProvider);
    for (const position of at.positions) {
      const params = { textDocument: { uri: at.uri }, position };
      // prepareRename says whether something renameable is here (null: no, try the next spot).
      if (canPrepare && (await c.request<unknown>('textDocument/prepareRename', params, REQUEST_TIMEOUT_MS, ctx.signal).catch(() => undefined)) === null) continue;
      const edit = await c.request<WorkspaceEdit | null>('textDocument/rename', { ...params, newName }, REQUEST_TIMEOUT_MS, ctx.signal);
      if (edit) return { edit, name: nameAt(at.text, position) };
    }
    return { edit: null, name: nameAt(at.text, at.positions[0]!) };
  });
  if (!run.ok) return { error: run.result, execute: async () => run.result };
  const { edit, name } = run.value;
  if (!edit) return errorResult(`${run.client.label} cannot rename ${name} here (not a symbol it can rename).`);
  const { files, error } = editsByFile(edit);
  if (error) return errorResult(`Rename not applied: ${error}.`);
  const changes: FileChange[] = [];
  for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const before = await fsp.readFile(f.file, 'utf8').catch(() => null);
    if (before === null) return errorResult(`Rename not applied: ${f.file} cannot be read.`);
    let after: string;
    try {
      after = applyTextEdits(before, f.edits);
    } catch (e) {
      return errorResult(`Rename not applied: ${(e as Error).message} for ${displayPath(f.file, ctx.session.cwd)}.`);
    }
    if (after !== before) changes.push({ file: f.file, before, after, count: f.edits.length, lines: [...new Set(f.edits.map((e) => e.range.start.line + 1))].sort((a, b) => a - b) });
  }
  if (!changes.length) return errorResult(`Renaming ${name} to ${newName} changes nothing.`);
  const total = changes.reduce((n, c) => n + c.count, 0);
  const rel = (f: string) => displayPath(f, ctx.session.cwd);
  const outside = changes.filter((c) => !isInProject(c.file, ctx.projectRoot, ctx.settings.permissions.additionalDirectories));
  const single = changes.length === 1 ? changes[0]! : null;
  const hunks = single ? buildHunks(single.before, single.after) : [];
  const preview = single ? { kind: 'diff' as const, path: displayPath(single.file, ctx.session.cwd), hunks, ...diffStats(hunks) } : undefined;
  const where = single ? rel(single.file) : `${changes.length} files`;
  return {
    permission: {
      tool: 'LSP',
      category: 'edit',
      title: 'Rename symbol',
      subject: `Rename ${name} to ${newName} in ${where} (${plural(total, 'change')})`,
      description: changes.map((c) => `${displayPath(c.file, ctx.projectRoot)} (${c.count})`).join(', '),
      preview,
      // Rules and acceptEdits are checked for every file; an outside one is named first.
      path: (outside[0] ?? changes[0]!).file,
      paths: changes.map((c) => c.file),
      danger: outside.length ? `This also changes ${plural(outside.length, 'file')} outside the project: ${outside.map((c) => c.file).join(', ')}` : undefined,
    },
    execute: async () => {
      // Same guard as Edit: nothing may change between the preview and the write.
      for (const c of changes) {
        const now = await fsp.readFile(c.file, 'utf8').catch(() => null);
        if (now !== c.before) return fail(`${rel(c.file)} changed while waiting for approval. Run the rename again.`);
      }
      // Snapshots first, so /undo and rewind restore every file of the rename.
      for (const c of changes) await ctx.files.snapshot(c.file);
      for (const c of changes) {
        await fsp.writeFile(c.file, c.after, 'utf8');
        ctx.files.recordWrite(c.file);
      }
      const list = changes.map((c) => `  ${rel(c.file)}: ${plural(c.count, 'change')} (line${c.lines.length === 1 ? '' : 's'} ${truncate(c.lines.join(', '), 80)})`);
      // The server gets the new contents and reports what broke.
      const reports = (await getLsp().afterEdit(changes.map((c) => c.file), ctx.projectRoot, ctx.signal, mayStart(ctx)).catch(() => [])).filter(Boolean);
      const text = [`Renamed ${name} to ${newName}: ${plural(total, 'change')} in ${plural(changes.length, 'file')}.`, ...list, ...(reports.length ? ['', ...reports] : [])].join('\n');
      return ok(text, preview ?? { kind: 'summary', text: `Renamed ${name} to ${newName} in ${plural(changes.length, 'file')}` });
    },
  };
}

// ------------------------------------------------------------------ the tool

export const LspTool: Tool = {
  name: 'LSP',
  category: 'read',
  description:
    'Ask the language server about code. Precise where text search guesses: it follows imports, types and scopes. Actions: ' +
    'definition (where a symbol is defined), references (every use across the project), hover (type and docs of a symbol), ' +
    'symbols (outline of file_path; with query, find symbols by name in the whole project), ' +
    'diagnostics (errors and warnings of file_path, or of the whole project without file_path), ' +
    'rename (renames a symbol everywhere, other files included; give new_name). ' +
    'Point at a symbol with file_path plus symbol (its name; add line when the name occurs more than once), or plus line and column (1-based, as Read shows them). ' +
    'Works for TypeScript/JavaScript, Python, Rust, Go, C/C++, C#, shell and PHP when their language server is installed; otherwise it says what to install. ' +
    'A server that would run code from the project (C#) asks the user before it starts. ' +
    'Errors after Edit and Write are reported automatically; use diagnostics to check other files.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'definition, references, hover, rename, symbols or diagnostics' },
      file_path: { type: 'string', description: 'The file (absolute or relative to the working directory). Not needed for symbols with query or for diagnostics of the whole project.' },
      symbol: { type: 'string', description: 'Name of the symbol in the file, e.g. "parseConfig"' },
      line: { type: 'number', description: '1-based line of the symbol' },
      column: { type: 'number', description: '1-based column of the symbol (not needed when symbol is given)' },
      new_name: { type: 'string', description: 'The new name (rename only)' },
      query: { type: 'string', description: 'Name or part of a name to find in the whole project (symbols only)' },
    },
    required: ['action'],
  },
  label: (input, ctx) => {
    const action = parseAction(strParam(input, 'action', 'operation', 'command', 'mode')) ?? 'LSP';
    const p = strParam(input, 'file_path', 'path', 'filePath', 'file');
    const line = numParam(input, 'line');
    const sym = symbolParam(input);
    const target = [p ? `${displayPath(resolvePath(p, ctx.cwd), ctx.cwd)}${line ? `:${line}` : ''}` : '', sym ?? strParam(input, 'query') ?? ''].filter(Boolean).join(' ');
    return `LSP(${action}${target ? `: ${truncate(target, 80)}` : ''})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const action = parseAction(strParam(input, 'action', 'operation', 'command', 'mode'));
    if (!action) return errorResult(`Unknown or missing action. Use one of: ${ACTIONS.join(', ')}.`);
    const p = strParam(input, 'file_path', 'path', 'filePath', 'file', 'uri');
    const file = p ? resolvePath(p, ctx.session.cwd) : null;
    if (!file && action !== 'symbols' && action !== 'diagnostics') return errorResult(`Missing required parameter for ${action}: file_path`);
    if (file) {
      const st = await fsp.stat(file).catch(() => null);
      if (!st) return errorResult(`File not found: ${file}`);
      if (st.isDirectory()) return errorResult(`${file} is a folder. Give a source file.`);
    }
    if (action === 'rename') {
      const refused = renameRefusal(input, ctx);
      if (refused) return refused;
    }
    const start = await neededStart(action, file, input, ctx);
    if (action === 'rename') {
      if (!start) return prepareRename(file!, input, ctx);
      // A rename is reviewed before it is applied, which takes a call of its own once the server runs.
      return askToStart(start, ctx, async () => {
        getLsp().warmUp(file!, ctx.projectRoot);
        return ok(`Allowed ${start.ruleLabel} for this project. Run the rename again to review the change and apply it.`, { kind: 'summary', text: 'Language server allowed' });
      });
    }
    const run = async (): Promise<ToolResult> => {
      switch (action) {
        case 'definition':
          return definition(file!, input, ctx);
        case 'references':
          return references(file!, input, ctx);
        case 'hover':
          return hover(file!, input, ctx);
        case 'symbols':
          return symbols(file, input, ctx);
        case 'diagnostics':
          return diagnostics(file, ctx);
      }
    };
    return start ? askToStart(start, ctx, run) : { execute: run };
  },
};

/** The permission a call still needs to start a server that runs code from the project, or null. */
async function neededStart(action: Action, file: string | null, input: Record<string, unknown>, ctx: ToolContext): Promise<PermissionRequest | null> {
  const lsp = getLsp();
  if (file) return lsp.startRequest(file, ctx.projectRoot);
  if (action === 'diagnostics') return lsp.projectStartRequest(ctx.projectRoot);
  if (action === 'symbols' && strParam(input, 'query', 'q', 'search', 'pattern')?.trim() && !lsp.running(ctx.projectRoot).length) {
    const rep = await representativeFile(ctx.projectRoot);
    return rep ? lsp.startRequest(rep, ctx.projectRoot) : null;
  }
  return null;
}

/**
 * The call waits for the user's approval to start the server (the rule LSP(<language>) or bypass mode
 * give it without asking). When the rules say no outright (plan mode, nobody to ask, a deny rule), the
 * answer says how to allow it instead.
 */
function askToStart(req: PermissionRequest, ctx: ToolContext, run: () => Promise<ToolResult>): PreparedCall {
  const decided = ctx.services.permit?.(req);
  if (decided?.action === 'deny') return errorResult(`${notStartedMessage(req)} Right now: ${decided.reason ?? 'not allowed'}.`);
  return {
    permission: req,
    execute: async () => {
      getLsp().approve(ctx.projectRoot, req.specifier!);
      return run();
    },
  };
}

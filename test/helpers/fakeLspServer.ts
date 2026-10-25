// A tiny language server for tests, run with node over stdio. Its language ("fake", *.fk files):
//   def NAME       defines NAME (one per line, indented defs are children of the def above)
//   use NAME       an error "Unknown name NAME" unless some .fk file in the folder defines it
//   ERROR: text    an error on that line; WARN: text a warning
//   import NAME    the definition of a use of NAME in this file is this line (like a server that is
//                  still loading the project); asked on this line, it is the def
// Every word is a reference to the def of the same name. Hovering the word "crash" kills the server,
// hovering "config" returns what the server got: initialize parameters and the answers to its requests.
// initializationOptions: { pull?: true } (pull diagnostics instead of push), { dedupe?: true } (skip
// pushes that would repeat the last one), { noVersion?: true } (pushes without a version), { silent?: true }
// (never reports diagnostics), { crashOnChange?: true } (exits on didChange), { initDelayMs?: n } (answers
// initialize late), { failInit?: true } (answers initialize with an error).
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Pos = { line: number; character: number };
type Range = { start: Pos; end: Pos };
type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

let root = process.cwd();
let opts: { pull?: boolean; dedupe?: boolean; noVersion?: boolean; silent?: boolean; crashOnChange?: boolean; initDelayMs?: number; failInit?: boolean } = {};
const docs = new Map<string, { text: string; version: number }>();
const lastPushed = new Map<string, string>();
const clientAnswers: Record<string, unknown> = {};
let nextId = 1000;

// Some servers print to stdout before speaking the protocol; the client must skip it.
process.stdout.write('fake language server starting\n');

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const m = /Content-Length: *(\d+)/i.exec(buf.subarray(0, sep).toString('ascii'));
    const len = m ? Number(m[1]) : 0;
    if (buf.length < sep + 4 + len) return;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.subarray(sep + 4 + len);
    handle(JSON.parse(body) as Msg);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(msg: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  // Two writes, so the client sees a header without its body for a moment.
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const reply = (id: Msg['id'], result: unknown) => send({ id, result });

function files(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.fk')) out.set(pathToFileURL(p).href, readFileSync(p, 'utf8'));
    }
  };
  try {
    walk(root);
  } catch {
    // folder gone
  }
  for (const [uri, d] of docs) out.set(uri, d.text);
  return out;
}

function wordAt(text: string, pos: Pos): { word: string; range: Range } | null {
  const line = text.split('\n')[pos.line] ?? '';
  const re = /[A-Za-z_]\w*/g;
  for (let m; (m = re.exec(line)); ) {
    if (pos.character >= m.index && pos.character <= m.index + m[0].length) return { word: m[0], range: { start: { line: pos.line, character: m.index }, end: { line: pos.line, character: m.index + m[0].length } } };
  }
  return null;
}

function occurrences(word: string): { uri: string; range: Range }[] {
  const out: { uri: string; range: Range }[] = [];
  for (const [uri, text] of files()) {
    text.split('\n').forEach((l, line) => {
      const re = new RegExp(`\\b${word}\\b`, 'g');
      for (let m; (m = re.exec(l)); ) out.push({ uri, range: { start: { line, character: m.index }, end: { line, character: m.index + word.length } } });
    });
  }
  return out;
}

function definitions(): Map<string, { uri: string; range: Range; indent: number }[]> {
  const out = new Map<string, { uri: string; range: Range; indent: number }[]>();
  for (const [uri, text] of files()) {
    text.split('\n').forEach((l, line) => {
      const m = /^(\s*)def\s+([A-Za-z_]\w*)/.exec(l);
      if (!m) return;
      const character = l.indexOf(m[2]!, m[1]!.length + 3);
      out.set(m[2]!, [...(out.get(m[2]!) ?? []), { uri, range: { start: { line, character }, end: { line, character: character + m[2]!.length } }, indent: m[1]!.length }]);
    });
  }
  return out;
}

function diagnose(uri: string): unknown[] {
  const text = docs.get(uri)?.text ?? files().get(uri) ?? '';
  const defs = definitions();
  const out: unknown[] = [];
  text.split('\n').forEach((l, line) => {
    const err = /ERROR:\s*(.*)$/.exec(l);
    if (err) out.push({ range: { start: { line, character: err.index }, end: { line, character: l.length } }, severity: 1, source: 'fake', code: 'E1', message: err[1] });
    const warn = /WARN:\s*(.*)$/.exec(l);
    if (warn) out.push({ range: { start: { line, character: warn.index }, end: { line, character: l.length } }, severity: 2, source: 'fake', message: warn[1] });
    const use = /\buse\s+([A-Za-z_]\w*)/.exec(l);
    if (use && !defs.has(use[1]!)) {
      const character = l.indexOf(use[1]!, use.index + 3);
      out.push({ range: { start: { line, character }, end: { line, character: character + use[1]!.length } }, severity: 1, source: 'fake', code: 'E2', message: `Unknown name ${use[1]}` });
    }
  });
  return out;
}

/** Like real servers: after a change, every open document is checked again. */
function publishAll(): void {
  if (opts.pull || opts.silent) return;
  setTimeout(() => {
    for (const [uri, d] of docs) {
      const diagnostics = diagnose(uri);
      const sig = JSON.stringify(diagnostics);
      if (opts.dedupe && lastPushed.get(uri) === sig) continue;
      lastPushed.set(uri, sig);
      send({ method: 'textDocument/publishDiagnostics', params: { uri, ...(opts.noVersion ? {} : { version: d.version }), diagnostics } });
    }
  }, 30);
}

function handle(msg: Msg): void {
  if (msg.method === undefined) {
    // An answer to one of our requests.
    clientAnswers[String(msg.id)] = msg.error ? { error: msg.error } : msg.result;
    return;
  }
  const p = (msg.params ?? {}) as Record<string, any>;
  const pos = p.position as Pos | undefined;
  const uri = p.textDocument?.uri as string | undefined;
  const at = () => (uri && pos ? wordAt(files().get(uri) ?? '', pos) : null);
  switch (msg.method) {
    case 'initialize': {
      root = p.rootUri ? fileURLToPath(p.rootUri) : root;
      opts = p.initializationOptions ?? {};
      clientAnswers.capabilities = p.capabilities;
      clientAnswers.processId = p.processId;
      clientAnswers.workspaceFolders = p.workspaceFolders;
      clientAnswers.initializationOptions = p.initializationOptions;
      if (opts.failInit) return send({ id: msg.id, error: { code: -32603, message: 'cannot load this project' } });
      const answer = () =>
        reply(msg.id, {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            ...(opts.pull ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } : {}),
          },
          serverInfo: { name: 'fake', version: '1.0' },
        });
      if (opts.initDelayMs) setTimeout(answer, opts.initDelayMs);
      else answer();
      return;
    }
    case 'initialized':
      // Servers ask the client things too; the answers are kept for the "config" hover.
      send({ id: `cfg-${nextId++}`, method: 'workspace/configuration', params: { items: [{ section: 'fake' }, { section: 'other' }, { section: 'rust-analyzer' }] } });
      send({ id: 'progress-1', method: 'window/workDoneProgress/create', params: { token: 'index' } });
      send({ id: 'unknown-1', method: 'fake/somethingNew', params: {} });
      send({ method: '$/progress', params: { token: 'index', value: { kind: 'begin', title: 'Indexing' } } });
      setTimeout(() => send({ method: '$/progress', params: { token: 'index', value: { kind: 'end' } } }), 50);
      send({ method: 'window/logMessage', params: { type: 3, message: 'hello from fake' } });
      return;
    case 'textDocument/didOpen':
      docs.set(p.textDocument.uri, { text: p.textDocument.text, version: p.textDocument.version });
      return publishAll();
    case 'textDocument/didChange': {
      if (opts.crashOnChange) process.exit(3);
      const change = (p.contentChanges as { text: string; range?: Range }[]).at(-1)!;
      docs.set(p.textDocument.uri, { text: change.text, version: p.textDocument.version });
      return publishAll();
    }
    case 'textDocument/didSave':
      clientAnswers.saved = [...((clientAnswers.saved as string[]) ?? []), p.textDocument.uri];
      return;
    case 'textDocument/didClose':
      docs.delete(p.textDocument.uri);
      lastPushed.delete(p.textDocument.uri);
      if (!opts.pull) send({ method: 'textDocument/publishDiagnostics', params: { uri: p.textDocument.uri, diagnostics: [] } });
      return;
    case 'textDocument/diagnostic':
      return reply(msg.id, { kind: 'full', items: diagnose(uri!) });
    case 'textDocument/definition': {
      const w = at();
      if (!w) return reply(msg.id, []);
      const lines = (files().get(uri!) ?? '').split('\n');
      const imp = lines.findIndex((l) => new RegExp(`^import\\s+${w.word}\\b`).test(l));
      if (imp >= 0 && imp !== pos!.line) {
        const character = lines[imp]!.indexOf(w.word, 6);
        return reply(msg.id, [{ uri, range: { start: { line: imp, character }, end: { line: imp, character: character + w.word.length } } }]);
      }
      return reply(
        msg.id,
        (definitions().get(w.word) ?? []).map((d) => ({ uri: d.uri, range: d.range })),
      );
    }
    case 'textDocument/references': {
      const w = at();
      if (!w) return reply(msg.id, []);
      const defs = definitions().get(w.word) ?? [];
      const isDef = (o: { uri: string; range: Range }) => defs.some((d) => d.uri === o.uri && d.range.start.line === o.range.start.line && d.range.start.character === o.range.start.character);
      return reply(
        msg.id,
        occurrences(w.word).filter((o) => p.context?.includeDeclaration || !isDef(o)),
      );
    }
    case 'textDocument/hover': {
      const w = at();
      if (!w) return reply(msg.id, null);
      if (w.word === 'crash') process.exit(3);
      if (w.word === 'config') return reply(msg.id, { contents: { kind: 'plaintext', value: JSON.stringify(clientAnswers) } });
      return reply(msg.id, { contents: { kind: 'markdown', value: `\`\`\`fake\n${w.word}: symbol\n\`\`\`` }, range: w.range });
    }
    case 'textDocument/prepareRename': {
      const w = at();
      return reply(msg.id, w && definitions().has(w.word) ? w.range : null);
    }
    case 'textDocument/rename': {
      const w = at();
      if (!w) return reply(msg.id, null);
      const byUri = new Map<string, { range: Range; newText: string }[]>();
      for (const o of occurrences(w.word)) byUri.set(o.uri, [...(byUri.get(o.uri) ?? []), { range: o.range, newText: p.newName }]);
      const caps = clientAnswers.capabilities as { workspace?: { workspaceEdit?: { documentChanges?: boolean } } };
      if (caps?.workspace?.workspaceEdit?.documentChanges) {
        return reply(msg.id, { documentChanges: [...byUri].map(([u, edits]) => ({ textDocument: { uri: u, version: docs.get(u)?.version ?? null }, edits })) });
      }
      return reply(msg.id, { changes: Object.fromEntries(byUri) });
    }
    case 'textDocument/documentSymbol': {
      const text = files().get(uri!) ?? '';
      const top: Record<string, unknown>[] = [];
      text.split('\n').forEach((l, line) => {
        const m = /^(\s*)def\s+([A-Za-z_]\w*)/.exec(l);
        if (!m) return;
        const character = l.indexOf(m[2]!, m[1]!.length + 3);
        const range = { start: { line, character: 0 }, end: { line, character: l.length } };
        const sym = { name: m[2], kind: 12, range, selectionRange: { start: { line, character }, end: { line, character: character + m[2]!.length } }, children: [] as unknown[] };
        if (m[1]!.length && top.length) (top.at(-1)!.children as unknown[]).push(sym);
        else top.push(sym);
      });
      return reply(msg.id, top);
    }
    case 'workspace/symbol': {
      const q = String(p.query ?? '').toLowerCase();
      const out: unknown[] = [];
      for (const [name, defs] of definitions()) if (name.toLowerCase().includes(q)) for (const d of defs) out.push({ name, kind: 12, location: { uri: d.uri, range: d.range } });
      return reply(msg.id, out);
    }
    case 'fake/hang':
      // Never answered: for the client's request timeout.
      return;
    case 'shutdown':
      return reply(msg.id, null);
    case 'exit':
      return process.exit(0);
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}

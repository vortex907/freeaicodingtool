// Quick syntax check of a file right after the agent edits it. Weak models often leave a stray brace or
// quote; catching it in the same step saves a broken build and several steps of confusion later.
// Only parsers that are fast and have no side effects are used (no compilers that write output).
import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isWindows, which } from '../util/platform.js';

const TIMEOUT_MS = 8000;

function run(file: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
      const code = !e ? 0 : e.killed ? null : typeof e.code === 'number' ? e.code : 1;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

function python(): string | null {
  for (const cmd of isWindows ? ['python', 'py'] : ['python3', 'python']) {
    const p = which(cmd);
    if (p && !(isWindows && /\\WindowsApps\\/i.test(p))) return p;
  }
  return null;
}

/** The project's own TypeScript, if it has one (we never install anything). */
function projectTypescript(file: string, root: string): string | null {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const ts = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js');
    if (existsSync(ts)) return ts;
    if (dir === root || path.dirname(dir) === dir) return null;
  }
}

const TS_CHECK = `
const ts = require(process.argv[1]);
const fs = require('fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const kind = /\\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\\.jsx$/i.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
for (const d of (sf.parseDiagnostics || []).slice(0, 5)) {
  const p = sf.getLineAndCharacterOfPosition(d.start || 0);
  console.log((p.line + 1) + ':' + (p.character + 1) + ' ' + ts.flattenDiagnosticMessageText(d.messageText, ' '));
}`;

const PY_CHECK = 'import ast,sys\nf=sys.argv[1]\ntry:\n ast.parse(open(f,encoding="utf-8").read(),f)\nexcept SyntaxError as e:\n print(f"{e.lineno}:{e.offset or 0} {e.msg}")';

/** Returns a short description of syntax errors in `file`, or null when it parses (or can't be checked). */
export async function checkSyntax(file: string, root: string): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  try {
    if (ext === '.json' && !/^(tsconfig|jsconfig).*\.json$|^\.?(eslintrc|babelrc)/i.test(name) && !file.includes(`${path.sep}.vscode${path.sep}`)) {
      const text = await fsp.readFile(file, 'utf8');
      try {
        JSON.parse(text.replace(/^\uFEFF/, ''));
        return null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const pos = /position (\d+)/.exec(msg);
        const line = pos ? text.slice(0, Number(pos[1])).split('\n').length : undefined;
        return `${name}${line ? `:${line}` : ''}: invalid JSON (${msg.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '')})`;
      }
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const r = await run(process.execPath, ['--check', file], path.dirname(file));
      if (r.code === 0 || r.code === null) return null;
      const lines = r.out.split('\n');
      const where = lines.find((l) => l.includes(file)) ?? '';
      const lineNo = /:(\d+)\s*$/.exec(where)?.[1];
      const err = lines.find((l) => /Error:/.test(l)) ?? lines[lines.length - 1] ?? 'syntax error';
      // JSX in .js files and ES modules in projects without "type": "module" are normal with bundlers.
      if (/Unexpected token '<'|Cannot use import statement outside a module|Unexpected token 'export'/.test(err)) return null;
      return `${name}${lineNo ? `:${lineNo}` : ''}: ${err.trim()}`;
    }
    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts' || ext === '.jsx') {
      const ts = projectTypescript(file, root);
      if (!ts) return null;
      const r = await run(process.execPath, ['-e', TS_CHECK, ts, file], path.dirname(file));
      if (r.code !== 0 || !r.out) return null;
      return r.out.split('\n').slice(0, 3).map((l) => `${name}:${l}`).join('\n');
    }
    if (ext === '.py' || ext === '.pyw') {
      const py = python();
      if (!py) return null;
      const r = await run(py, ['-c', PY_CHECK, file], path.dirname(file));
      if (r.code !== 0 || !r.out) return null;
      return `${name}:${r.out.split('\n')[0]}`;
    }
  } catch {
    // a checker that fails must never break the edit
  }
  return null;
}

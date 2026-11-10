// Glob, Grep and LS tools.
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PreparedCall, Tool, ToolContext } from './types.js';
import { boolParam, errorResult, fail, numParam, ok, strParam } from './types.js';
import { DEFAULT_IGNORED_DIRS, listFiles, resolvePath, sortByMtime } from './listFiles.js';
import { globToRegExp, matchPathOrBase } from './glob.js';
import { ripgrepPath } from '../util/platform.js';
import { displayPath, isBinaryBuffer } from '../util/fs.js';
import { truncate } from '../util/strings.js';

function relTo(base: string, abs: string): string {
  const r = path.relative(base, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : abs;
}

export const GlobTool: Tool = {
  name: 'Glob',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description:
    'Find files by name pattern, e.g. "**/*.ts", "src/**/*.test.js", "**/package.json". Respects .gitignore. ' +
    'Returns matching paths (newest first). Use this instead of `find` or `ls -R`.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  label: (input) => `Glob(${strParam(input, 'pattern', 'glob') ?? '?'})`,
  async prepare(input, ctx): Promise<PreparedCall> {
    let pattern = strParam(input, 'pattern', 'glob', 'name');
    if (!pattern) return errorResult('Missing required parameter: pattern');
    const base = resolvePath(strParam(input, 'path', 'directory', 'dir', 'cwd') ?? '.', ctx.session.cwd);
    return {
      execute: async () => {
        try {
          const st = await fsp.stat(base);
          if (!st.isDirectory()) return fail(`${base} is not a directory`);
        } catch {
          return fail(`Directory not found: ${base}`);
        }
        // Absolute pattern inside base -> make relative
        if (path.isAbsolute(pattern!)) {
          const rel = path.relative(base, pattern!);
          if (!rel.startsWith('..')) pattern = rel.split(path.sep).join('/');
        }
        const files = await listFiles(base, { includeHidden: pattern!.includes('/.') || pattern!.startsWith('.') });
        const rx = globToRegExp(pattern!, { dot: true });
        let matches = files.filter((f) => rx.test(f));
        let note = '';
        if (!matches.length && !pattern!.includes('/')) {
          const rx2 = globToRegExp(`**/${pattern}`, { dot: true });
          matches = files.filter((f) => rx2.test(f));
          if (matches.length) note = `(no matches for "${pattern}" at the top level; showing matches for "**/${pattern}")\n`;
        }
        if (!matches.length) {
          const rx3 = globToRegExp(pattern!, { dot: true, nocase: true });
          matches = files.filter((f) => rx3.test(f) || (!pattern!.includes('/') && matchPathOrBase(pattern!.toLowerCase(), f.toLowerCase())));
          if (matches.length) note = '(case-insensitive matches)\n';
        }
        if (!matches.length) return ok(`No files matched "${pattern}" in ${displayPath(base, ctx.session.cwd)}.`, { kind: 'summary', text: 'No matches' });
        const sorted = await sortByMtime(base, matches);
        const limit = 200;
        const shown = sorted.slice(0, limit).map((f) => relTo(ctx.session.cwd, path.join(base, f)));
        const more = sorted.length > limit ? `\n(${sorted.length - limit} more not shown; use a more specific pattern)` : '';
        return ok(note + shown.join('\n') + more, { kind: 'summary', text: `Found ${sorted.length} file${sorted.length === 1 ? '' : 's'}` });
      },
    };
  },
};

const TYPE_GLOBS: Record<string, string[]> = {
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  rust: ['*.rs'],
  rs: ['*.rs'],
  go: ['*.go'],
  java: ['*.java'],
  kotlin: ['*.kt', '*.kts'],
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  cs: ['*.cs'],
  csharp: ['*.cs'],
  rb: ['*.rb'],
  ruby: ['*.rb'],
  php: ['*.php'],
  swift: ['*.swift'],
  md: ['*.md', '*.markdown', '*.mdx'],
  json: ['*.json', '*.jsonc'],
  yaml: ['*.yml', '*.yaml'],
  html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  sql: ['*.sql'],
  vue: ['*.vue'],
  svelte: ['*.svelte'],
  dart: ['*.dart'],
  lua: ['*.lua'],
  scala: ['*.scala'],
  toml: ['*.toml'],
  xml: ['*.xml'],
};

interface GrepOptions {
  pattern: string;
  base: string;
  glob?: string;
  type?: string;
  mode: 'content' | 'files_with_matches' | 'count';
  ignoreCase: boolean;
  lineNumbers: boolean;
  after: number;
  before: number;
  multiline: boolean;
  headLimit: number;
  /** Search just this file (relative to base). */
  singleFile?: string;
}

function runRg(rg: string, o: GrepOptions, signal: AbortSignal): Promise<{ out: string; code: number | null; err: string }> {
  const args = ['--no-heading', '--color', 'never', '--max-columns', '400', '--max-columns-preview'];
  if (o.mode === 'files_with_matches') args.push('--files-with-matches', '--sortr', 'modified');
  else if (o.mode === 'count') args.push('--count');
  else {
    args.push('--with-filename');
    if (o.lineNumbers) args.push('--line-number');
    if (o.after) args.push('-A', String(o.after));
    if (o.before) args.push('-B', String(o.before));
  }
  if (o.ignoreCase) args.push('-i');
  if (o.multiline) args.push('-U', '--multiline-dotall');
  if (o.glob) for (const g of o.glob.split(/[,\s]+/).filter(Boolean)) args.push('--glob', g);
  if (o.type) {
    const globs = TYPE_GLOBS[o.type.toLowerCase()];
    if (globs) for (const g of globs) args.push('--glob', g);
    else args.push('--type', o.type);
  }
  args.push('--', o.pattern, o.singleFile ?? '.');
  return new Promise((resolve) => {
    const child = spawn(rg, args, { cwd: o.base, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let lines = 0;
    const cap = o.headLimit + 1;
    child.stdout.on('data', (b: Buffer) => {
      if (lines > cap) return;
      const s = b.toString('utf8');
      out += s;
      lines += (s.match(/\n/g) || []).length;
      if (lines > cap * 4 && o.mode !== 'files_with_matches') child.kill();
    });
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ out, code, err });
    });
    child.on('error', (e) => resolve({ out: '', code: 2, err: e.message }));
  });
}

async function jsGrep(o: GrepOptions, signal: AbortSignal): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(o.pattern, (o.ignoreCase ? 'i' : '') + (o.multiline ? 'gms' : ''));
  } catch (e) {
    throw new Error(`Invalid regular expression: ${(e as Error).message}`);
  }
  let files = o.singleFile ? [o.singleFile] : await listFiles(o.base);
  if (o.glob && !o.singleFile) {
    const globs = o.glob.split(/[,\s]+/).filter(Boolean);
    files = files.filter((f) => globs.some((g) => matchPathOrBase(g, f)));
  }
  if (o.type) {
    const globs = TYPE_GLOBS[o.type.toLowerCase()] ?? [`*.${o.type}`];
    files = files.filter((f) => globs.some((g) => matchPathOrBase(g, f)));
  }
  files = await sortByMtime(o.base, files);
  const out: string[] = [];
  let total = 0;
  for (const f of files) {
    if (signal.aborted) break;
    if (out.length > o.headLimit * 2) break;
    const abs = path.join(o.base, f);
    let buf: Buffer;
    try {
      const st = await fsp.stat(abs);
      if (st.size > 2 * 1024 * 1024) continue;
      buf = await fsp.readFile(abs);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) continue;
    const text = buf.toString('utf8');
    if (o.multiline) {
      re.lastIndex = 0;
      const ms = [...text.matchAll(re)];
      if (!ms.length) continue;
      total += ms.length;
      if (o.mode === 'files_with_matches') out.push(f);
      else if (o.mode === 'count') out.push(`${f}:${ms.length}`);
      else {
        for (const m of ms) {
          const line = text.slice(0, m.index).split('\n').length;
          out.push(`${f}:${line}:${truncate(m[0].replace(/\n/g, '\\n'), 400)}`);
        }
      }
      continue;
    }
    const lines = text.split(/\r?\n/);
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) hits.push(i);
    if (!hits.length) continue;
    total += hits.length;
    if (o.mode === 'files_with_matches') {
      out.push(f);
      continue;
    }
    if (o.mode === 'count') {
      out.push(`${f}:${hits.length}`);
      continue;
    }
    const printed = new Set<number>();
    for (const h of hits) {
      for (let i = Math.max(0, h - o.before); i <= Math.min(lines.length - 1, h + o.after); i++) {
        if (printed.has(i)) continue;
        printed.add(i);
        const sep = i === h || hits.includes(i) ? ':' : '-';
        out.push(`${f}${sep}${o.lineNumbers ? `${i + 1}${sep}` : ''}${truncate(lines[i]!, 400)}`);
      }
    }
  }
  void total;
  return out.join('\n');
}

export const GrepTool: Tool = {
  name: 'Grep',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. ' +
    'output_mode: "files_with_matches" (default, list of files), "content" (matching lines with line numbers), or "count". ' +
    'Filter files with glob (e.g. "*.ts") or type (e.g. "py"). Use -i for case-insensitive search and -A/-B/-C for context lines. Use this instead of grep/rg in Bash.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js" or "src/**/*.ts"' },
      type: { type: 'string', description: 'File type to search, e.g. js, ts, py, go, rust, java' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'What to return (default files_with_matches)' },
      '-i': { type: 'boolean', description: 'Case insensitive search' },
      '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true)' },
      '-A': { type: 'number', description: 'Lines of context after each match (content mode)' },
      '-B': { type: 'number', description: 'Lines of context before each match (content mode)' },
      '-C': { type: 'number', description: 'Lines of context before and after each match (content mode)' },
      multiline: { type: 'boolean', description: 'Allow patterns to span lines (. matches newline)' },
      head_limit: { type: 'number', description: 'Maximum number of results to return' },
    },
    required: ['pattern'],
  },
  label: (input) => {
    const p = strParam(input, 'pattern', 'query', 'regex') ?? '?';
    const g = strParam(input, 'glob', 'include');
    return `Grep(${truncate(p, 60)}${g ? ` in ${g}` : ''})`;
  },
  async prepare(input, ctx: ToolContext): Promise<PreparedCall> {
    const pattern = strParam(input, 'pattern', 'query', 'regex', 'search');
    if (!pattern) return errorResult('Missing required parameter: pattern');
    const target = resolvePath(strParam(input, 'path', 'directory', 'dir') ?? '.', ctx.session.cwd);
    const modeRaw = strParam(input, 'output_mode', 'mode') ?? 'files_with_matches';
    const mode = (['content', 'files_with_matches', 'count'].includes(modeRaw) ? modeRaw : modeRaw.startsWith('file') ? 'files_with_matches' : 'content') as GrepOptions['mode'];
    const ctxLines = numParam(input, '-C', 'context') ?? 0;
    const o: GrepOptions = {
      pattern,
      base: target,
      glob: strParam(input, 'glob', 'include', 'file_pattern'),
      type: strParam(input, 'type', 'file_type'),
      mode,
      ignoreCase: boolParam(input, '-i', 'case_insensitive', 'ignore_case') ?? false,
      lineNumbers: boolParam(input, '-n', 'line_numbers') ?? true,
      after: Math.min(20, numParam(input, '-A', 'after') ?? ctxLines),
      before: Math.min(20, numParam(input, '-B', 'before') ?? ctxLines),
      multiline: boolParam(input, 'multiline') ?? false,
      headLimit: Math.max(1, Math.min(2000, numParam(input, 'head_limit', 'limit', 'max_results') ?? (mode === 'content' ? 250 : 150))),
    };
    return {
      execute: async () => {
        let st;
        try {
          st = await fsp.stat(target);
        } catch {
          return fail(`Path not found: ${target}`);
        }
        if (st.isFile()) {
          o.singleFile = path.basename(target);
          o.base = path.dirname(target);
        }
        let raw: string;
        const rg = ripgrepPath();
        if (rg) {
          const r = await runRg(rg, o, ctx.signal);
          if (r.code === 2 && !r.out) {
            if (/regex parse error|error parsing/i.test(r.err)) return fail(`Invalid regex: ${r.err.split('\n').slice(0, 6).join('\n')}`);
            try {
              raw = await jsGrep(o, ctx.signal);
            } catch (e) {
              return fail((e as Error).message);
            }
          } else raw = r.out;
        } else {
          try {
            raw = await jsGrep(o, ctx.signal);
          } catch (e) {
            return fail((e as Error).message);
          }
        }
        let lines = raw.split('\n').filter((l) => l.length);
        lines = lines.map((l) => l.replace(/^\.\//, ''));
        if (!lines.length) return ok(`No matches for /${pattern}/${o.glob ? ` in ${o.glob}` : ''}.`, { kind: 'summary', text: 'No matches' });
        const total = lines.length;
        const shown = lines.slice(0, o.headLimit);
        // Make paths relative to the working directory for readability.
        const prefix = relTo(ctx.session.cwd, o.base);
        const fix = (l: string) => (prefix && prefix !== '.' && prefix !== o.base ? `${prefix}/${l}` : o.base === ctx.session.cwd ? l : path.join(o.base, l));
        const body = shown.map((l) => (l === '--' ? l : fix(l))).join('\n');
        const more = total > o.headLimit ? `\n(${total - o.headLimit}+ more results not shown; narrow the search or raise head_limit)` : '';
        const what = mode === 'files_with_matches' ? `${Math.min(total, o.headLimit)}${total > o.headLimit ? '+' : ''} file${total === 1 ? '' : 's'}` : mode === 'count' ? `${total} file${total === 1 ? '' : 's'}` : `${total} line${total === 1 ? '' : 's'}`;
        return ok(body + more, { kind: 'summary', text: `Found ${what}` });
      },
    };
  },
};

export const LSTool: Tool = {
  name: 'LS',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description: 'List the files and folders in a directory as a tree (2 levels deep by default). Heavy folders like node_modules are summarized. Prefer Glob/Grep to find specific files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default: working directory)' },
      depth: { type: 'number', description: 'How many levels to show (default 2, max 5)' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to hide' },
    },
  },
  label: (input, ctx) => `LS(${displayPath(resolvePath(strParam(input, 'path', 'directory', 'dir') ?? '.', ctx.cwd), ctx.cwd)})`,
  async prepare(input, ctx) {
    const dir = resolvePath(strParam(input, 'path', 'directory', 'dir') ?? '.', ctx.session.cwd);
    const depth = Math.max(1, Math.min(5, numParam(input, 'depth') ?? 2));
    const ignore = Array.isArray(input.ignore) ? (input.ignore as unknown[]).map(String) : [];
    return {
      execute: async () => {
        try {
          const st = await fsp.stat(dir);
          if (!st.isDirectory()) return fail(`${dir} is a file, not a directory. Use Read to view it.`);
        } catch {
          return fail(`Directory not found: ${dir}`);
        }
        const lines: string[] = [`${dir}${path.sep}`];
        let count = 0;
        const LIMIT = 500;
        const walk = async (abs: string, rel: string, level: number) => {
          if (count >= LIMIT) return;
          let entries: import('node:fs').Dirent[];
          try {
            entries = await fsp.readdir(abs, { withFileTypes: true });
          } catch {
            return;
          }
          entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
          for (const e of entries) {
            if (count >= LIMIT) {
              lines.push(`${'  '.repeat(level)}... (more entries not shown)`);
              return;
            }
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.name === '.git' || e.name === '.DS_Store') continue;
            if (ignore.some((g) => matchPathOrBase(g, childRel))) continue;
            count++;
            if (e.isDirectory()) {
              if (DEFAULT_IGNORED_DIRS.has(e.name)) {
                lines.push(`${'  '.repeat(level)}- ${e.name}/ (contents skipped)`);
                continue;
              }
              lines.push(`${'  '.repeat(level)}- ${e.name}/`);
              if (level < depth) await walk(path.join(abs, e.name), childRel, level + 1);
            } else lines.push(`${'  '.repeat(level)}- ${e.name}`);
          }
        };
        await walk(dir, '', 1);
        return ok(lines.join('\n'), { kind: 'summary', text: `Listed ${count} entr${count === 1 ? 'y' : 'ies'}` });
      },
    };
  },
};

// Compact text for the model: path:line ranges, the symbol, short snippets, a hint when results
// are weak. Every formatter stays within a character budget.
import { promises as fsp } from 'node:fs';
import type { IndexManager } from './manager.js';
import { textTerms } from './tokenize.js';
import type { CommitResult, ProjectProfile, ProjectSummary, ReferenceHit, SearchResult, SymbolHit, UnusedReport } from './types.js';

export const OUTPUT_BUDGET = 8000;
const MAX_SNIPPET_LINES = 12;
const MAX_LINE_CHARS = 160;

class FileCache {
  private files = new Map<string, string[] | null>();
  async lines(file: string): Promise<string[] | null> {
    if (this.files.has(file)) return this.files.get(file)!;
    let lines: string[] | null = null;
    try {
      lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
    } catch {
      lines = null;
    }
    this.files.set(file, lines);
    return lines;
  }
}

function clipLine(s: string): string {
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)} ...` : s;
}

/** Numbered lines with their common indentation removed ("  12  code"). */
function numbered(lines: { n: number; text: string }[]): string {
  let indent = Infinity;
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const m = /^[ \t]*/.exec(l.text)![0].length;
    if (m < indent) indent = m;
  }
  if (!isFinite(indent)) indent = 0;
  return lines.map((l) => (l.n < 0 ? '   ...' : `${String(l.n).padStart(5)}  ${clipLine(l.text.slice(indent).replace(/\t/g, '  '))}`)).join('\n');
}

/** The most useful lines of a chunk: all of it when short, else its first lines plus the best-matching part. */
async function snippet(cache: FileCache, file: string, start: number, end: number, terms: string[], max: number): Promise<string> {
  const lines = await cache.lines(file);
  if (!lines) return '';
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  if (e < s) return '';
  const pick: { n: number; text: string }[] = [];
  const add = (a: number, b: number) => {
    for (let i = a; i <= b; i++) pick.push({ n: i, text: lines[i - 1]! });
  };
  // Skip blank lines at the start of the chunk.
  let first = s;
  while (first < e && !lines[first - 1]!.trim()) first++;
  if (e - first + 1 <= max) add(first, e);
  else {
    let best = first;
    let bestScore = 0;
    for (let i = first; i <= e; i++) {
      const l = lines[i - 1]!.toLowerCase();
      let sc = 0;
      for (const t of terms) if (l.includes(t)) sc++;
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    }
    const head = Math.min(3, max - 2);
    if (best - first < max - 1) add(first, first + max - 1);
    else {
      add(first, first + head - 1);
      pick.push({ n: -1, text: '' });
      const rest = max - head - 1;
      const a = Math.max(first + head, best - Math.floor(rest / 3));
      add(a, Math.min(e, a + rest - 1));
    }
  }
  return numbered(pick);
}

function queryNeedles(query: string): string[] {
  return [...new Set(textTerms(query).filter((t) => t.length >= 3))];
}

function plural(n: number, w: string, p = `${w}s`): string {
  return `${n} ${n === 1 ? w : p}`;
}

export interface SearchFormatInput {
  query: string;
  scope: string;
  limit: number;
  result: SearchResult;
  otherProjects: number;
}

export async function formatSearch(idx: IndexManager, input: SearchFormatInput): Promise<string> {
  const { result, query, scope, limit } = input;
  const cache = new FileCache();
  const needles = queryNeedles(query);
  const allowAll = scope !== 'all' && input.otherProjects > 0;
  if (!result.hits.length) {
    const unknown = result.unknownWords.length ? ` Nothing in the index mentions ${result.unknownWords.slice(0, 4).map((w) => `"${w}"`).join(', ')}.` : '';
    return `No results for "${query}" (scope: ${scope}).${unknown}\nHint: try words that appear in the code (identifiers, messages), mode "definition" for an exact name${allowAll ? ', scope "all" for the other projects' : ''}, or Grep with a regex.`;
  }
  const perHit = Math.max(3, Math.min(MAX_SNIPPET_LINES, Math.floor((OUTPUT_BUDGET - 120 * limit) / (limit * 70))));
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  for (const h of result.hits) {
    const where = `${idx.displayPath(h.file)}:${h.start}-${h.end}`;
    const sym = h.symbol ? `  ${h.symbol}${h.kind ? ` (${h.kind})` : ''}` : '';
    // Files outside the current project carry their project's name.
    const tag = h.project && idx.displayPath(h.file) === h.file ? `  [${h.project}]` : '';
    const body = await snippet(cache, h.file, h.start, h.end, needles, perHit);
    const block = `${where}${sym}${tag}\n${body}`;
    if (used + block.length > OUTPUT_BUDGET && shown > 0) break;
    parts.push(block);
    used += block.length + 2;
    shown++;
  }
  let head = `${plural(shown, 'result')} for "${query}" (scope: ${scope})`;
  if (shown < result.hits.length) head += `; ${result.hits.length - shown} more cut for length`;
  let out = `${head}:\n\n${parts.join('\n\n')}`;
  let hint = '';
  if (result.weak) {
    if (result.unknownWords.length) hint = `Hint: weak matches; nothing in the index mentions ${result.unknownWords.slice(0, 3).map((w) => `"${w}"`).join(', ')}. Use words from the code itself`;
    else hint = 'Hint: weak matches; try exact identifiers from the code or fewer words';
    hint += allowAll ? ', or scope "all" for the other projects.' : '.';
  } else if (allowAll && result.hits.length < Math.min(3, limit)) hint = 'Hint: scope "all" also searches the other indexed projects.';
  if (hint) out += `\n\n${hint}`;
  return out;
}

export async function formatDefinitions(idx: IndexManager, name: string, scope: string, hits: SymbolHit[], limit: number): Promise<string> {
  if (!hits.length) return '';
  const cache = new FileCache();
  const lines: string[] = [];
  let used = 0;
  for (const h of hits.slice(0, limit)) {
    const text = (await cache.lines(h.file))?.[h.line - 1]?.trim() ?? '';
    const path = idx.displayPath(h.file);
    const tag = h.project && path === h.file ? `  [${h.project}]` : '';
    const entry = `${path}:${h.line}  ${h.kind} ${h.parent ? `${h.parent}.` : ''}${h.name}${h.exported ? ' (exported)' : ''}${tag}\n      ${clipLine(text)}`;
    if (used + entry.length > OUTPUT_BUDGET) break;
    lines.push(entry);
    used += entry.length;
  }
  const more = hits.length > lines.length ? ` (showing ${lines.length})` : '';
  return `${plural(hits.length, 'definition')} of "${name}"${more} (scope: ${scope}):\n${lines.join('\n')}`;
}

export function formatReferences(idx: IndexManager, name: string, scope: string, refs: { hits: ReferenceHit[]; files: number; outOfScope: number }, limit: number): string {
  if (!refs.hits.length) return '';
  const byFile = new Map<string, ReferenceHit[]>();
  for (const h of refs.hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  const parts: string[] = [];
  let used = 0;
  let files = 0;
  for (const [file, hits] of byFile) {
    if (files >= limit) break;
    const path = idx.displayPath(file);
    const tag = hits[0]!.project && path === file ? `  [${hits[0]!.project}]` : '';
    const shown = hits.slice(0, 6).map((h) => `  ${h.line}: ${clipLine(h.text)}`);
    if (hits.length > 6) shown.push(`  ... ${hits.length - 6} more in this file`);
    const block = `${path}${tag}\n${shown.join('\n')}`;
    if (used + block.length > OUTPUT_BUDGET && files > 0) break;
    parts.push(block);
    used += block.length;
    files++;
  }
  let head = `${plural(refs.hits.length, 'reference')} to "${name}" in ${plural(refs.files, 'file')} (definition lines excluded; scope: ${scope})`;
  if (files < byFile.size) head += `; showing ${files} files`;
  let out = `${head}:\n${parts.join('\n')}`;
  if (refs.outOfScope && scope !== 'all') out += `\n\n${plural(refs.outOfScope, 'more file')} outside this scope mention "${name}" (use scope "all").`;
  return out;
}

export function formatProjects(list: ProjectSummary[], current: string | undefined): string {
  if (!list.length) return 'No projects are indexed yet.';
  const lines: string[] = [];
  let used = 0;
  for (const p of list) {
    const langs = p.languages.slice(0, 4).map((l) => `${l.name} ${l.files}`).join(', ') || 'no source files';
    const mark = current && p.path === current ? ' (current)' : '';
    const line = `- ${p.name}${mark} (${langs})${p.summary ? `: ${p.summary.replace(/\s+/g, ' ').slice(0, 160)}` : ''}\n  ${p.path}`;
    if (used + line.length > OUTPUT_BUDGET) {
      lines.push(`- ... ${list.length - lines.length} more`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return `${plural(list.length, 'indexed project')}:\n${lines.join('\n')}`;
}

export function formatProfile(p: ProjectProfile): string {
  const out: string[] = [`Project ${p.name}${p.version ? ` ${p.version}` : ''}: ${p.path}`];
  if (p.description) out.push(`Description: ${p.description}`);
  if (p.readme && p.readme !== p.description) out.push(`README: ${p.readme}`);
  out.push(`Files indexed: ${p.files}${p.lastModified ? `, last change ${new Date(p.lastModified).toISOString().slice(0, 10)}` : ''}${p.git ? `, git repository (${p.commits} commits indexed)` : ''}`);
  if (p.languages.length) out.push(`Languages: ${p.languages.map((l) => `${l.name} ${l.files}`).join(', ')}`);
  if (p.markers.length) out.push(`Manifests: ${p.markers.join(', ')}`);
  if (p.platform.length) out.push(`Runtime, SDK or engine: ${p.platform.join(', ')}`);
  const scripts = Object.entries(p.scripts);
  if (scripts.length) out.push(`Scripts:\n${scripts.slice(0, 25).map(([k, v]) => `  ${k}: ${v.slice(0, 160)}`).join('\n')}`);
  const fmt = (ds: ProjectProfile['dependencies']) => ds.map((d) => (d.version && d.version !== '*' ? `${d.name} ${d.version}` : d.name)).join(', ');
  const prod = p.dependencies.filter((d) => !d.dev);
  const dev = p.dependencies.filter((d) => d.dev);
  if (prod.length) out.push(`Dependencies (${prod.length}): ${fmt(prod)}`);
  if (dev.length) out.push(`Dev dependencies (${dev.length}): ${fmt(dev)}`);
  if (p.configs.length) out.push(`Config files: ${p.configs.join(', ')}`);
  if (p.envExample) out.push(p.envMissing.length ? `Keys in ${p.envExample} that .env does not set: ${p.envMissing.join(', ')}` : `All keys in ${p.envExample} are set in .env.`);
  if (p.uses.length) out.push(`Uses:\n${p.uses.map((u) => `  ${u.name}${u.imports ? `: ${plural(u.imports, 'import')} in ${u.files.slice(0, 6).join(', ')}${u.files.length > 6 ? ', ...' : ''}` : ''}${u.declared ? ' (declared in the manifest)' : ''}`).join('\n')}`);
  if (p.usedBy.length) out.push(`Used by:\n${p.usedBy.map((u) => `  ${u.name}${u.imports ? ` (${plural(u.imports, 'import')})` : ''}${u.declared ? ' (declared in its manifest)' : ''}`).join('\n')}`);
  const text = out.join('\n');
  return text.length > OUTPUT_BUDGET ? `${text.slice(0, OUTPUT_BUDGET - 20)}\n... (cut for length)` : text;
}

export function formatHistory(idx: IndexManager, query: string, scope: string, res: { commits: CommitResult[]; repos: number; total: number }): string {
  if (!res.repos) return `No git history is indexed for scope "${scope}" (not a git repository, git is not installed, or indexing is still running).`;
  if (!res.commits.length) return `No commits match "${query}" (${res.total} commits searched in ${plural(res.repos, 'repository', 'repositories')}). Try other words or a file name.`;
  const lines: string[] = [];
  let used = 0;
  for (const c of res.commits) {
    const tag = res.repos > 1 ? `  [${c.project}]` : '';
    const entry = `${c.hash.slice(0, 10)} ${c.date} ${c.author}: ${clipLine(c.subject)}${tag}${c.files.length ? `\n    files: ${c.files.slice(0, 5).join(', ')}` : ''}`;
    if (used + entry.length > OUTPUT_BUDGET) break;
    lines.push(entry);
    used += entry.length;
  }
  // git show needs the repository folder when it is not the current project.
  const folders = [...new Map(res.commits.slice(0, lines.length).map((c) => [c.projectPath, c.project])).entries()].filter(([dir]) => idx.displayPath(dir) !== '.');
  const where = folders.length ? ` in the repository folder (${folders.map(([dir, name]) => `${name}: ${dir}`).join('; ')})` : '';
  return `${plural(lines.length, 'commit')} matching "${query}" (${res.total} commits searched in ${plural(res.repos, 'repository', 'repositories')}; scope: ${scope}):\n${lines.join('\n')}\nUse git show <hash>${where} for details.`;
}

export function formatUnused(idx: IndexManager, r: UnusedReport, limit: number): string {
  if (!r.symbols.length) return `No unused definitions found in ${r.project} (${r.checked} exported or top-level definitions checked). ${r.note}`;
  const lines: string[] = [];
  let used = 0;
  for (const s of r.symbols.slice(0, Math.max(limit, 1))) {
    const line = `${idx.displayPath(s.file)}:${s.line}  ${s.kind} ${s.name}`;
    if (used + line.length > OUTPUT_BUDGET - 400) break;
    lines.push(line);
    used += line.length;
  }
  const more = r.symbols.length > lines.length ? `\n... ${r.symbols.length - lines.length} more (raise limit to see them)` : '';
  return `Possibly unused in ${r.project} (approximate): ${plural(r.symbols.length, 'definition')} of ${r.checked} exported or top-level ones have no reference anywhere in the indexed folders.\n${lines.join('\n')}${more}\n${r.note} Check with mode "references" or Grep before deleting anything.`;
}

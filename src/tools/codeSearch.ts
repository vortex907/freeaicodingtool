// CodeSearch: the code index as a tool. Search by meaning and keywords, symbol definitions and
// references, project profiles and links, git history and possibly unused code, across the current
// project and the other project folders the user configured.
import type { PreparedCall, Tool, ToolContext } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { getIndex, ScopeError, type IndexManager } from '../codeindex/index.js';
import { formatDefinitions, formatHistory, formatProfile, formatProjects, formatReferences, formatSearch, formatUnused } from '../codeindex/format.js';
import { truncate } from '../util/strings.js';

const MODES = ['search', 'definition', 'references', 'projects', 'project', 'history', 'unused'] as const;
type Mode = (typeof MODES)[number];

/** How long a call waits for the index to catch up before answering from what it has. */
export const REFRESH_CAP_MS = 3000;

function parseMode(raw: string | undefined): Mode {
  const m = (raw ?? 'search').toLowerCase().trim();
  if ((MODES as readonly string[]).includes(m)) return m as Mode;
  if (/^def/.test(m)) return 'definition';
  if (/^(ref|usage|uses|callers)/.test(m)) return 'references';
  if (/^(list|all projects)/.test(m)) return 'projects';
  if (/^(profile|proj)/.test(m)) return 'project';
  if (/^(commit|git|log)/.test(m)) return 'history';
  if (/^(dead|unreferenced)/.test(m)) return 'unused';
  return 'search';
}

/** Lets the index catch up (it is incremental), but never longer than the cap. True when it finished. */
async function catchUp(idx: IndexManager, projectRoot: string, capMs: number, signal: AbortSignal): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      idx.ensureProject(projectRoot).then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), capMs);
      }),
      new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function stillIndexing(idx: IndexManager): string {
  const p = idx.status().progress;
  const where = p.total ? ` (${p.phase} ${p.done} of ${p.total} files)` : p.phase !== 'idle' ? ` (${p.phase})` : '';
  return `Note: the index is still being updated${where}; these results may be incomplete. Ask again in a moment, or use Grep.\n\n`;
}

/** limit: results for search and history; listLimit: entries for the list modes (definitions, references, unused). */
async function run(mode: Mode, query: string, scopeArg: string | undefined, limit: number, listLimit: number, ctx: ToolContext): Promise<{ text: string; summary: string }> {
  const idx = getIndex();
  const scope = scopeArg || 'project';
  const opts = { scope, limit, projectRoot: ctx.projectRoot };
  switch (mode) {
    case 'search': {
      const result = await idx.search(query, opts);
      const text = await formatSearch(idx, { query, scope, limit, result, otherProjects: idx.otherProjectCount(ctx.projectRoot) });
      return { text, summary: `${result.hits.length} result${result.hits.length === 1 ? '' : 's'} for "${truncate(query, 50)}"` };
    }
    case 'definition': {
      let usedScope = scope;
      let hits = await idx.definitions(query, { ...opts, limit: 50 });
      if (!hits.length && !scopeArg) {
        usedScope = 'all';
        hits = await idx.definitions(query, { ...opts, scope: 'all', limit: 50 });
      }
      const text = hits.length ? await formatDefinitions(idx, query, usedScope, hits, listLimit) : `No definition of "${query}" found (scope: ${usedScope}). It may come from a library, be generated, or be named differently: try mode "search" or Grep.`;
      return { text, summary: `${hits.length} definition${hits.length === 1 ? '' : 's'} of "${truncate(query, 40)}"` };
    }
    case 'references': {
      let usedScope = scope;
      let refs = await idx.references(query, opts);
      if (!refs.hits.length && !scopeArg && refs.outOfScope) {
        usedScope = 'all';
        refs = await idx.references(query, { ...opts, scope: 'all' });
      }
      const text = refs.hits.length ? formatReferences(idx, query, usedScope, refs, listLimit) : `No references to "${query}" found (scope: ${usedScope}, definition lines excluded).`;
      return { text, summary: `${refs.hits.length} reference${refs.hits.length === 1 ? '' : 's'} to "${truncate(query, 40)}"` };
    }
    case 'projects': {
      const list = idx.projects();
      return { text: formatProjects(list, ctx.projectRoot), summary: `${list.length} indexed project${list.length === 1 ? '' : 's'}` };
    }
    case 'project': {
      const target = query || (scopeArg && !/^(project|all)$/i.test(scopeArg) ? scopeArg : '') || ctx.projectRoot;
      const profile = await idx.projectProfile(target);
      if (!profile) return { text: `No indexed project matches "${target}". Use mode "projects" to list them.`, summary: 'Project not found' };
      return { text: formatProfile(profile), summary: `Profile of ${profile.name}` };
    }
    case 'history': {
      const res = await idx.history(query, opts);
      return { text: formatHistory(idx, query, scope, res), summary: `${res.commits.length} commit${res.commits.length === 1 ? '' : 's'} for "${truncate(query, 40)}"` };
    }
    case 'unused': {
      const target = query || (scopeArg && !/^(project|all)$/i.test(scopeArg) ? scopeArg : '') || ctx.projectRoot;
      const report = await idx.unused(target);
      if (!report) return { text: `No indexed project matches "${target}". Use mode "projects" to list them.`, summary: 'Project not found' };
      return { text: formatUnused(idx, report, listLimit), summary: `${report.symbols.length} possibly unused in ${report.project}` };
    }
  }
}

export const CodeSearchTool: Tool = {
  name: 'CodeSearch',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description:
    'Search the code index: this project plus the other project folders the user keeps next to it. Use it first for questions like "where is X handled", ' +
    '"how does A use B" or "which project defines Y", then Read the hits. It ranks code by keywords and identifier words (computeDamage matches "compute damage"), ' +
    'favours symbol names and file paths, and returns path:line ranges with short snippets. ' +
    'Modes: search (default; plain words or identifiers), definition (where a symbol is defined), references (lines that use a name), ' +
    'projects (list the indexed projects), project (profile: languages, dependencies with versions, scripts, configs, missing .env keys, which projects it uses and is used by), ' +
    'history (git commits by message words or changed file), unused (exported or top-level definitions nothing references; approximate).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find: words or an identifier; a symbol name for definition/references; a project name for project; commit words or a file name for history. May be empty for projects and unused.' },
      mode: { type: 'string', enum: [...MODES], description: 'search (default), definition, references, projects, project, history or unused' },
      scope: { type: 'string', description: '"project" (default: the current project), "all" (every indexed project) or a project name' },
      limit: { type: 'number', description: 'Maximum results (default 8, max 30)' },
    },
    required: ['query'],
  },
  label: (input) => {
    const mode = parseMode(strParam(input, 'mode', 'type'));
    const q = strParam(input, 'query', 'q', 'pattern', 'name', 'symbol') ?? '';
    return `CodeSearch(${mode === 'search' ? '' : `${mode}${q ? ': ' : ''}`}${truncate(q, 60)})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const mode = parseMode(strParam(input, 'mode', 'type'));
    const query = (strParam(input, 'query', 'q', 'pattern', 'name', 'symbol', 'search') ?? '').trim();
    const scope = strParam(input, 'scope', 'in')?.trim() || undefined;
    const limitArg = numParam(input, 'limit', 'max_results', 'top_k');
    const clamp = (n: number) => Math.max(1, Math.min(30, Math.round(n)));
    const limit = clamp(limitArg ?? 8);
    const listLimit = clamp(limitArg ?? 30);
    if (!query && (mode === 'search' || mode === 'definition' || mode === 'references')) return errorResult(`Missing required parameter: query (${mode === 'search' ? 'words or an identifier to search for' : 'the symbol name'})`);
    return {
      execute: async () => {
        const idx = getIndex();
        if (!idx.enabled) return fail('The code index is turned off in the settings (index.enabled). Use Grep, Glob and Read instead.');
        const finished = await catchUp(idx, ctx.projectRoot, REFRESH_CAP_MS, ctx.signal);
        if (ctx.signal.aborted) return fail('Interrupted by the user.');
        try {
          const { text, summary } = await run(mode, query, scope, limit, listLimit, ctx);
          return ok((finished ? '' : stillIndexing(idx)) + text, { kind: 'summary', text: summary });
        } catch (e) {
          if (e instanceof ScopeError) return fail(e.message);
          throw e;
        }
      },
    };
  },
};

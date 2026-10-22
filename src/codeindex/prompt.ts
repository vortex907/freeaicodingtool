// System prompt sections built from the index: a profile of the current project (so the agent does
// not guess versions and commands) and the other projects the user keeps next to it. They ride along
// with every request, so they stay short.
import type { IndexManager } from './manager.js';
import type { ProjectProfile } from './types.js';
import { isInside } from '../util/fs.js';

function clip(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

function deps(list: ProjectProfile['dependencies'], max: number): string {
  const shown = list.slice(0, max).map((d) => (d.version && d.version !== '*' ? `${d.name} ${d.version}` : d.name));
  return shown.join(', ') + (list.length > max ? `, +${list.length - max} more` : '');
}

/** Profile of the current project, at most 20 lines. Empty when the index does not know it yet. */
export async function currentProjectSection(idx: IndexManager, projectRoot: string): Promise<string> {
  const p = await idx.projectProfile(projectRoot);
  if (!p) return '';
  const lines: string[] = [];
  const langs = p.languages.slice(0, 6).map((l) => `${l.name} (${l.files} file${l.files === 1 ? '' : 's'})`);
  if (langs.length) lines.push(`Languages: ${langs.join(', ')}`);
  if (p.platform.length) lines.push(clip(`Runtime, SDK or engine: ${p.platform.join(', ')}`));
  const prod = p.dependencies.filter((d) => !d.dev);
  const dev = p.dependencies.filter((d) => d.dev);
  if (prod.length) lines.push(clip(`Dependencies: ${deps(prod, 25)}`, 500));
  if (dev.length) lines.push(clip(`Dev dependencies: ${deps(dev, 15)}`, 400));
  const scripts = Object.entries(p.scripts);
  if (scripts.length) lines.push(clip(`Scripts: ${scripts.slice(0, 10).map(([k, v]) => `${k}: ${clip(v, 70)}`).join(' | ')}`, 600));
  if (p.configs.length) lines.push(clip(`Config files: ${p.configs.join(', ')}`));
  if (p.envMissing.length) lines.push(clip(`Keys in ${p.envExample ?? '.env.example'} that .env does not set: ${p.envMissing.join(', ')}`));
  if (p.uses.length) lines.push(clip(`Uses these other indexed projects: ${p.uses.map((u) => `${u.name} (${u.imports ? `${u.files.length} file${u.files.length === 1 ? '' : 's'}` : 'manifest'})`).join(', ')}`));
  if (p.usedBy.length) lines.push(clip(`Used by: ${p.usedBy.map((u) => u.name).join(', ')}`));
  if (!lines.length) return '';
  return `# Project profile (from the code index)\n${lines.slice(0, 19).join('\n')}`;
}

/** The other projects in the indexed folders, at most 25 lines. Empty when there are none. */
export function otherProjectsSection(idx: IndexManager, projectRoot: string): string {
  const others = idx.projects().filter((p) => !isInside(p.path, projectRoot) && !isInside(projectRoot, p.path));
  if (!others.length) return '';
  const MAX = 22;
  const lines = others.slice(0, MAX).map((p) => {
    const langs = p.languages.slice(0, 3).map((l) => l.name).join(', ') || 'no source files';
    const summary = p.summary ? `: ${clip(p.summary, 140)}` : '';
    return `- ${p.name} (${langs})${summary} [${p.path}]`;
  });
  if (others.length > MAX) lines.push(`- ... ${others.length - MAX} more (CodeSearch mode "projects" lists all)`);
  return `# Other projects\nThe user keeps these projects next to this one, and they are indexed. Use CodeSearch with scope "all" to look across them (or a project name as the scope).\n${lines.join('\n')}`;
}

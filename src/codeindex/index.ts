// Code index: an always-on index of the current project and of the folders the user lists in the
// "index.roots" setting. Gives the agent (CodeSearch tool), the system prompt and later the UI:
//   getIndex()                 the shared IndexManager: ensureProject, refresh, status, subscribe,
//                              search, definitions, references, projects, projectProfile, history, unused
//   applyIndexSettings(cfg)    applies { enabled, roots } from the global settings
//   indexPromptSection(root)   cached prompt sections from the index ('' until it is ready)
import { expandHome } from '../util/fs.js';
import { IndexManager } from './manager.js';

export { IndexManager, ScopeError, MAX_FILES_PER_ROOT, type ManagerOptions } from './manager.js';
export type * from './types.js';

let shared: IndexManager | null = null;

/** The index shared by the whole process (the app server, the REPL and print mode each have one). */
export function getIndex(): IndexManager {
  if (!shared) shared = new IndexManager();
  return shared;
}

export interface IndexSettings {
  enabled?: boolean;
  roots?: string[];
}

/** Applies the "index" settings: on by default, extra roots on top of the current project. */
export function applyIndexSettings(cfg: IndexSettings | undefined): void {
  const idx = getIndex();
  idx.setEnabled(cfg?.enabled !== false);
  const roots = Array.isArray(cfg?.roots) ? cfg.roots.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => expandHome(r.trim())) : [];
  idx.setRoots(roots);
}

export function isCodeIndexEnabled(): boolean {
  return getIndex().enabled;
}

/** Profile of the current project plus the other indexed projects, for the system prompt. Never blocks. */
export function indexPromptSection(projectRoot: string): string {
  return getIndex().promptSection(projectRoot);
}

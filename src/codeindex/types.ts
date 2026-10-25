// Types shared by the code index modules and its public API.
import type { FileData } from './analyze.js';
import type { Commit } from './history.js';
import type { ProjectRec } from './projects.js';

/** One indexed file. Entries are replaced, never mutated, so a snapshot of them stays consistent. */
export interface FileEntry extends FileData {
  /** Path relative to the root, forward slashes. */
  rel: string;
  size: number;
  mtime: number;
  /** Binary or unreadable: remembered so it is not read again until it changes. */
  skipped?: boolean;
}

export interface HistoryRec {
  stamp: string;
  at: number;
  commits: Commit[];
}

export interface RootState {
  /** Normalized absolute path (lowercase on Windows), used as the key. */
  key: string;
  dir: string;
  files: Map<string, FileEntry>;
  projects: ProjectRec[];
  /** Git history per project rel. */
  history: Map<string, HistoryRec>;
  truncated: boolean;
}

// ------------------------------------------------------------------ public API shapes

export interface IndexProgress {
  phase: 'idle' | 'loading' | 'scanning' | 'indexing' | 'history' | 'saving';
  root?: string;
  done: number;
  total: number;
}

export interface IndexStatus {
  enabled: boolean;
  roots: { path: string; files: number; projects: number; truncated: boolean; lastIndexed: number | null }[];
  files: number;
  chunks: number;
  symbols: number;
  projects: number;
  indexing: boolean;
  progress: IndexProgress;
  /** When the last refresh finished (ms since epoch). */
  lastUpdate: number | null;
  errors: string[];
}

export interface SearchOptions {
  /** "project" (default: the current project), "all", or a project name or path. */
  scope?: string;
  limit?: number;
  /** The current project for scope "project" (defaults to the last ensureProject call). */
  projectRoot?: string;
}

export interface SearchHit {
  /** Absolute path */
  file: string;
  /** Path relative to its project (or root) */
  rel: string;
  project?: string;
  start: number;
  end: number;
  symbol?: string;
  kind?: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Query words that appear nowhere in the index. */
  unknownWords: string[];
  /** Best hit matched less than half of the query's weight. */
  weak: boolean;
  /** Chunks searched (after the scope filter). */
  searched: number;
}

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  rel: string;
  project?: string;
  line: number;
  parent?: string;
  exported: boolean;
}

export interface ReferenceHit {
  file: string;
  rel: string;
  project?: string;
  line: number;
  text: string;
}

export interface ProjectSummary {
  name: string;
  path: string;
  folder: string;
  languages: { name: string; files: number }[];
  summary?: string;
  git: boolean;
}

export interface ProjectLinkInfo {
  name: string;
  path: string;
  /** Files with imports that resolve to the other project. */
  files: string[];
  imports: number;
  /** Also listed as a dependency or reference in the manifest. */
  declared: boolean;
}

export interface ProjectProfile extends ProjectSummary {
  root: string;
  markers: string[];
  lastModified: number | null;
  description?: string;
  version?: string;
  platform: string[];
  scripts: Record<string, string>;
  dependencies: { name: string; version: string; dev?: boolean }[];
  configs: string[];
  envExample?: string;
  envMissing: string[];
  readme?: string;
  uses: ProjectLinkInfo[];
  usedBy: ProjectLinkInfo[];
  files: number;
  commits: number;
}

export interface CommitResult {
  project: string;
  projectPath: string;
  hash: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
}

export interface UnusedSymbol {
  name: string;
  kind: string;
  file: string;
  rel: string;
  line: number;
}

export interface UnusedReport {
  project: string;
  path: string;
  /** Definitions checked (exported or top-level). */
  checked: number;
  symbols: UnusedSymbol[];
  /** Always true: name matching cannot see dynamic use. */
  approximate: true;
  note: string;
}

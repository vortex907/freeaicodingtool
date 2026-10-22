// Git history: the last commits of a repository (message, author, date, changed files), searchable
// by words in the message and by changed paths. Git is optional; without it there is no history.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { git, hasGit } from '../util/git.js';
import { textTerms } from './tokenize.js';

export const MAX_COMMITS = 2000;
const MAX_FILES_PER_COMMIT = 60;

export interface Commit {
  hash: string;
  /** Unix seconds */
  time: number;
  author: string;
  subject: string;
  files: string[];
}

/** Runs git log (no shell, with a timeout). Null when git is missing or the folder has no commits. */
export async function readHistory(dir: string, max = MAX_COMMITS): Promise<Commit[] | null> {
  if (!hasGit()) return null;
  const r = await git(['-c', 'core.quotepath=off', 'log', `-n${max}`, '--no-color', '--name-only', '--format=%x1e%H%x1f%at%x1f%an%x1f%s'], dir, 20_000, 64 * 1024 * 1024);
  if (r.code !== 0) return null;
  return parseLog(r.stdout);
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const [hash, time, author, subject] = lines[0]!.split('\x1f');
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) continue;
    const files: string[] = [];
    for (let i = 1; i < lines.length && files.length < MAX_FILES_PER_COMMIT; i++) {
      const f = lines[i]!.trim();
      if (f) files.push(f);
    }
    commits.push({ hash, time: Number(time) || 0, author: author ?? '', subject: subject ?? '', files });
  }
  return commits;
}

/**
 * Cheap "has HEAD moved" check that reads .git files instead of spawning git (that costs tens of
 * milliseconds per repository on Windows). Handles worktrees and packed refs.
 */
export async function headStamp(projectDir: string): Promise<string | null> {
  try {
    let gitDir = path.join(projectDir, '.git');
    const st = await fsp.stat(gitDir);
    if (st.isFile()) {
      const m = /gitdir:\s*(.+)/.exec(await fsp.readFile(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(projectDir, m[1]!.trim());
    }
    const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    let common = gitDir;
    try {
      common = path.resolve(gitDir, (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim());
    } catch {
      // not a linked worktree
    }
    for (const base of [gitDir, common]) {
      try {
        return `${ref}@${(await fsp.readFile(path.join(base, ref), 'utf8')).trim()}`;
      } catch {
        // try the next location
      }
    }
    try {
      const packed = await fsp.readFile(path.join(common, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.trim().endsWith(` ${ref}`));
      if (line) return `${ref}@${line.split(' ')[0]}`;
    } catch {
      // no packed refs
    }
    return `${ref}@unborn`;
  } catch {
    return null;
  }
}

export interface CommitHit {
  commit: Commit;
  /** Changed files that match the query (all files when none do). */
  files: string[];
  score: number;
}

const termsCache = new WeakMap<Commit, Set<string>>();

function commitTerms(c: Commit): Set<string> {
  let t = termsCache.get(c);
  if (!t) {
    t = new Set([...textTerms(c.subject), ...textTerms(c.author)]);
    termsCache.set(c, t);
  }
  return t;
}

/** Ranks commits by query words in the message (and author) and by matching changed paths. */
export function searchCommits(commits: Commit[], query: string, limit: number): CommitHit[] {
  const q = query.trim().toLowerCase();
  const terms = [...new Set(textTerms(query))];
  if (!terms.length && !q) return commits.slice(0, limit).map((commit) => ({ commit, files: commit.files.slice(0, 5), score: 0 }));
  // Rare words count more than words in every message ("fix", "update").
  const df = new Map<string, number>();
  for (const c of commits) {
    const ct = commitTerms(c);
    for (const t of terms) if (ct.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = commits.length || 1;
  const pathLike = /[/\\.]/.test(q) ? q.replace(/\\/g, '/') : '';
  const hits: CommitHit[] = [];
  for (const c of commits) {
    const ct = commitTerms(c);
    let score = 0;
    for (const t of terms) if (ct.has(t)) score += 2 * Math.log(1 + n / (df.get(t) ?? 1));
    const files: string[] = [];
    for (const f of c.files) {
      const lf = f.toLowerCase();
      if ((pathLike && lf.includes(pathLike)) || terms.some((t) => t.length >= 3 && lf.includes(t))) files.push(f);
    }
    if (files.length) score += pathLike ? 3 : 1;
    if (score > 0) hits.push({ commit: c, files: files.length ? files.slice(0, 5) : c.files.slice(0, 5), score });
  }
  // Ties go to the newer commit.
  hits.sort((a, b) => b.score - a.score || b.commit.time - a.commit.time);
  return hits.slice(0, limit);
}

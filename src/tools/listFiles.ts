// Project file listing that respects .gitignore (via git when available) and skips heavy folders.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { gitListFiles, gitRoot } from '../util/git.js';
import { isInside } from '../util/fs.js';
import { matchPathOrBase } from './glob.js';

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'coverage',
  '.gradle',
  '.idea',
  'bower_components',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'Pods',
  'DerivedData',
  '.terraform',
  '.serverless',
  'vendor',
  '.yarn',
  '.pnpm-store',
  '.dart_tool',
  '.angular',
  'elm-stuff',
]);

const MAX_FILES = 200_000;

interface CacheEntry {
  at: number;
  files: string[];
}
const listCache = new Map<string, CacheEntry>();

export function invalidateFileListCache(): void {
  listCache.clear();
}

/** Parses simple .gitignore patterns for the non-git fallback (and the code index walker). */
export async function readGitignore(dir: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  } catch {
    return [];
  }
}

export function ignoredByPatterns(rel: string, isDir: boolean, patterns: string[]): boolean {
  for (let p of patterns) {
    const dirOnly = p.endsWith('/');
    if (dirOnly) {
      if (!isDir) continue;
      p = p.slice(0, -1);
    }
    const anchored = p.startsWith('/');
    if (anchored) p = p.slice(1);
    if (anchored || p.includes('/')) {
      if (matchPathOrBase(p, rel) || matchPathOrBase(`${p}/**`, rel)) return true;
    } else if (matchPathOrBase(p, rel.slice(rel.lastIndexOf('/') + 1))) return true;
  }
  return false;
}

async function walk(root: string, opts: { includeHidden: boolean; limit: number }): Promise<string[]> {
  const out: string[] = [];
  const patterns = await readGitignore(root);
  const stack: string[] = [''];
  while (stack.length && out.length < opts.limit) {
    const rel = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(e.name)) continue;
        if (!opts.includeHidden && e.name.startsWith('.') && e.name !== '.github') continue;
        if (ignoredByPatterns(childRel, true, patterns)) continue;
        stack.push(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (ignoredByPatterns(childRel, false, patterns)) continue;
        out.push(childRel);
        if (out.length >= opts.limit) break;
      }
    }
  }
  return out;
}

/**
 * Lists files under `dir` as forward-slash paths relative to `dir`.
 * Uses `git ls-files` inside repositories (respects .gitignore), else a filtered directory walk.
 */
export async function listFiles(dir: string, opts: { includeHidden?: boolean; noCache?: boolean; includeIgnored?: boolean } = {}): Promise<string[]> {
  const key = `${dir}|${opts.includeHidden ? 1 : 0}|${opts.includeIgnored ? 1 : 0}`;
  const hit = listCache.get(key);
  if (hit && !opts.noCache && Date.now() - hit.at < 5000) return hit.files;
  let files: string[] | null = null;
  if (!opts.includeIgnored) {
    const root = await gitRoot(dir);
    if (root) {
      const all = await gitListFiles(dir);
      if (all) {
        // git ls-files run in `dir` returns paths relative to dir
        files = all.filter((f) => !f.startsWith('../'));
        // Drop deleted files that git still lists
        if (files.length < 20_000) {
          const exists = await Promise.all(files.map((f) => fsp.stat(path.join(dir, f)).then(() => true, () => false)));
          files = files.filter((_, i) => exists[i]);
        }
      }
    }
  }
  if (!files) files = await walk(dir, { includeHidden: !!opts.includeHidden, limit: MAX_FILES });
  if (files.length > MAX_FILES) files = files.slice(0, MAX_FILES);
  listCache.set(key, { at: Date.now(), files });
  return files;
}

/** Sorts relative paths by modification time, newest first. */
export async function sortByMtime(base: string, rels: string[]): Promise<string[]> {
  if (rels.length > 5000) return rels; // too many to stat cheaply
  const stats = await Promise.all(
    rels.map((r) =>
      fsp.stat(path.join(base, r)).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  );
  return rels.map((r, i) => [r, stats[i]!] as const).sort((a, b) => b[1] - a[1]).map(([r]) => r);
}

/** Resolves a user/model supplied path against the working directory. */
export function resolvePath(p: string, cwd: string): string {
  let s = p.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (s.startsWith('~/') || s === '~') s = path.join(process.env.HOME || process.env.USERPROFILE || '', s.slice(1));
  if (s.startsWith('file://')) s = s.slice(7);
  return path.resolve(cwd, s);
}

export function isInProject(abs: string, projectRoot: string, extraDirs: string[] = []): boolean {
  return isInside(abs, projectRoot) || extraDirs.some((d) => isInside(abs, path.resolve(d)));
}

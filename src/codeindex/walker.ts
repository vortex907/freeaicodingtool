// Lists the indexable files of a root folder with their size and mtime. Prunes build, vendor and
// engine cache folders while walking (they can hold far more files than the code itself) and
// honours each folder's .gitignore.
import { promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_IGNORED_DIRS, ignoredByPatterns, readGitignore } from '../tools/listFiles.js';
import { indexableName } from './lang.js';

/** Build output and engine caches on top of the folders every tool skips. */
export const EXTRA_IGNORED_DIRS = ['bin', 'obj', 'target', 'build', 'dist', 'out', '.next', '.venv', 'venv', '__pycache__', 'Library', 'Temp', 'Intermediate', 'Binaries', 'Saved', '.godot', 'DerivedDataCache', 'ipch'];

const IGNORED = new Set([...DEFAULT_IGNORED_DIRS, ...EXTRA_IGNORED_DIRS]);

export const MAX_FILE_BYTES = 1024 * 1024;

/** Folders never worth descending into (also used to find projects). */
export function isIgnoredDir(name: string): boolean {
  return IGNORED.has(name) || (name.startsWith('.') && name !== '.github');
}

export interface WalkFile {
  rel: string;
  size: number;
  mtime: number;
}

export interface WalkResult {
  files: WalkFile[];
  /** Stopped at the file cap. */
  truncated: boolean;
  /** False when the root could not be read or the walk was aborted. */
  complete: boolean;
  errors: string[];
}

interface IgnoreScope {
  base: string;
  patterns: string[];
}

function ignored(rel: string, isDir: boolean, scopes: IgnoreScope[]): boolean {
  for (const sc of scopes) {
    const r = sc.base ? rel.slice(sc.base.length + 1) : rel;
    if (ignoredByPatterns(r, isDir, sc.patterns)) return true;
  }
  return false;
}

const DIR_CONCURRENCY = 8;

export async function walkRoot(root: string, opts: { maxFiles: number; signal?: AbortSignal; onProgress?: (files: number) => void }): Promise<WalkResult> {
  const files: WalkFile[] = [];
  const errors: string[] = [];
  const queue: { rel: string; scopes: IgnoreScope[] }[] = [{ rel: '', scopes: [] }];
  let qi = 0;
  let truncated = false;
  let rootOk = true;
  let lastReport = 0;

  const processDir = async (rel: string, scopes: IgnoreScope[]): Promise<void> => {
    const abs = rel ? path.join(root, rel) : root;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (!rel) rootOk = false;
      if (errors.length < 20) errors.push(`${abs}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      return;
    }
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const patterns = await readGitignore(abs);
      if (patterns.length) scopes = [...scopes, { base: rel, patterns }];
    }
    const candidates: string[] = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredDir(e.name) || ignored(childRel, true, scopes)) continue;
        queue.push({ rel: childRel, scopes });
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (!indexableName(e.name) || ignored(childRel, false, scopes)) continue;
        candidates.push(childRel);
      }
    }
    const stats = await Promise.all(candidates.map((r) => fsp.stat(path.join(root, r)).catch(() => null)));
    for (let i = 0; i < candidates.length; i++) {
      const st = stats[i];
      // Symlinks to folders are not followed (no cycles); oversized files are skipped.
      if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
      files.push({ rel: candidates[i]!, size: st.size, mtime: st.mtimeMs });
    }
    if (opts.onProgress && files.length - lastReport >= 500) {
      lastReport = files.length;
      opts.onProgress(files.length);
    }
  };

  // Breadth first, so a capped walk still covers the top of every project in the root.
  await new Promise<void>((resolve) => {
    let running = 0;
    const pump = () => {
      const stop = truncated || !!opts.signal?.aborted;
      while (!stop && running < DIR_CONCURRENCY && qi < queue.length) {
        const d = queue[qi++]!;
        running++;
        void processDir(d.rel, d.scopes)
          .catch(() => undefined)
          .finally(() => {
            running--;
            pump();
          });
      }
      if (running === 0 && (stop || qi >= queue.length)) resolve();
    };
    pump();
  });
  return { files, truncated, complete: rootOk && !opts.signal?.aborted, errors };
}

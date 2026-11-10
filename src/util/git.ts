// Thin wrappers over the git CLI (all optional: everything degrades gracefully without git).
import { execFile } from 'node:child_process';
import { which } from './platform.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function hasGit(): boolean {
  return which('git') !== null;
}

export function git(args: string[], cwd: string, timeoutMs = 8000, maxBuffer = 64 * 1024 * 1024): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!hasGit()) return resolve({ code: 127, stdout: '', stderr: 'git not found' });
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' } },
      (err, stdout, stderr) => {
        const raw = err ? (err as unknown as { code?: number | string }).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const rootCache = new Map<string, string | null>();

export async function gitRoot(cwd: string): Promise<string | null> {
  if (rootCache.has(cwd)) return rootCache.get(cwd)!;
  const r = await git(['rev-parse', '--show-toplevel'], cwd, 4000);
  const root = r.code === 0 ? r.stdout.trim() || null : null;
  rootCache.set(cwd, root);
  return root;
}

export interface GitInfo {
  root: string;
  branch: string;
  mainBranch: string | null;
  status: string[];
  recentCommits: string[];
}

export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const root = await gitRoot(cwd);
  if (!root) return null;
  const [branch, status, log, mainRef] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 4000),
    git(['status', '--porcelain'], cwd, 6000),
    git(['log', '--oneline', '-n', '5'], cwd, 4000),
    git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd, 4000),
  ]);
  let mainBranch: string | null = null;
  if (mainRef.code === 0) mainBranch = mainRef.stdout.trim().replace(/^origin\//, '') || null;
  return {
    root,
    branch: branch.code === 0 ? branch.stdout.trim() : '(unknown)',
    mainBranch,
    status: status.stdout.split('\n').filter(Boolean),
    recentCommits: log.stdout.split('\n').filter(Boolean),
  };
}

/** Lists files that git would consider part of the project (tracked + untracked, not ignored). */
export async function gitListFiles(cwd: string): Promise<string[] | null> {
  const root = await gitRoot(cwd);
  if (!root) return null;
  const r = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd, 20000);
  if (r.code !== 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of r.stdout.split('\0')) {
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

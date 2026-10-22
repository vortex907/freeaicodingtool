// Which developer tools are installed, with versions, for the environment section of the prompt.
// Models otherwise guess (python3 on Windows, a dotnet SDK that isn't there) and waste steps.
import { execFile } from 'node:child_process';
import { isWindows, which } from './platform.js';

interface ToolSpec {
  name: string;
  /** Executable names to look for, in order. */
  cmds: string[];
  args: string[];
}

const TOOLS: ToolSpec[] = [
  { name: 'node', cmds: ['node'], args: ['--version'] },
  { name: 'npm', cmds: ['npm'], args: ['--version'] },
  { name: 'pnpm', cmds: ['pnpm'], args: ['--version'] },
  { name: 'bun', cmds: ['bun'], args: ['--version'] },
  { name: 'python', cmds: isWindows ? ['python', 'py'] : ['python3', 'python'], args: ['--version'] },
  { name: 'dotnet', cmds: ['dotnet'], args: ['--version'] },
  { name: 'java', cmds: ['java'], args: ['-version'] },
  { name: 'go', cmds: ['go'], args: ['version'] },
  { name: 'rustc', cmds: ['rustc'], args: ['--version'] },
  { name: 'gcc', cmds: ['gcc'], args: ['--version'] },
  { name: 'clang', cmds: ['clang'], args: ['--version'] },
  { name: 'cmake', cmds: ['cmake'], args: ['--version'] },
  { name: 'git', cmds: ['git'], args: ['--version'] },
  { name: 'docker', cmds: ['docker'], args: ['--version'] },
  { name: 'gh', cmds: ['gh'], args: ['--version'] },
];

interface Found {
  name: string;
  cmd: string;
  path: string;
  version?: string;
}

let cache: { at: number; found: Found[]; missing: string[]; versions: boolean } | null = null;
let pending: Promise<void> | null = null;

function locate(): { found: Found[]; missing: string[] } {
  const found: Found[] = [];
  const missing: string[] = [];
  for (const t of TOOLS) {
    let hit: Found | null = null;
    for (const cmd of t.cmds) {
      const p = which(cmd);
      // The Microsoft Store alias for python only opens the Store.
      if (p && !(isWindows && /\\WindowsApps\\/i.test(p) && /python|py\.exe/i.test(p))) {
        hit = { name: t.name, cmd, path: p };
        break;
      }
    }
    if (hit) found.push(hit);
    else missing.push(t.name);
  }
  return { found, missing };
}

function versionOf(f: Found, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    // .cmd and .bat files (npm, pnpm on Windows) only run through cmd.exe.
    const viaCmd = isWindows && /\.(cmd|bat)$/i.test(f.path);
    const file = viaCmd ? process.env.ComSpec || 'cmd.exe' : f.path;
    const argv = viaCmd ? ['/d', '/s', '/c', `"${f.path}" ${args.join(' ')}`] : args;
    execFile(file, argv, { timeout: 5000, windowsHide: true, windowsVerbatimArguments: viaCmd }, (_err, stdout, stderr) => {
      // Skip notices like "Picked up JAVA_TOOL_OPTIONS: ...127.0.0.1..." and prefer "version x.y".
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.split('\n').filter((l) => !/^Picked up /.test(l)).join('\n');
      resolve((/\b(?:version|v)\s*"?(\d+\.\d+(?:\.\d+)?)/i.exec(text) ?? /(\d+\.\d+(?:\.\d+)?)/.exec(text))?.[1]);
    });
  });
}

/** Looks up versions in the background (call early; the summary is usable before it finishes). */
export function refreshToolchain(): Promise<void> {
  if (pending) return pending;
  const { found, missing } = locate();
  cache = { at: Date.now(), found, missing, versions: false };
  pending = Promise.all(found.map(async (f) => (f.version = await versionOf(f, TOOLS.find((t) => t.name === f.name)!.args)))).then(() => {
    cache = { at: Date.now(), found, missing, versions: true };
    pending = null;
  });
  return pending;
}

/** One line for the prompt, e.g. "node 22.11.0, python 3.12.4 (python), git 2.47.0; not installed: go, rustc". */
export function toolchainSummary(): string {
  if (!cache || Date.now() - cache.at > 6 * 3600_000) void refreshToolchain();
  if (!cache) return '';
  const tools = cache.found.map((f) => `${f.name}${f.version ? ` ${f.version}` : ''}${f.cmd !== f.name ? ` (run as "${f.cmd}")` : ''}`);
  return `${tools.join(', ') || 'none detected'}${cache.missing.length ? `; not installed: ${cache.missing.join(', ')}` : ''}`;
}

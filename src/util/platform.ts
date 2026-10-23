// Platform detection: OS, shell, executables on PATH.
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

const whichCache = new Map<string, string | null>();

/** Finds an executable on PATH (like `which`). `fresh` looks again (something may have been installed since). */
export function which(cmd: string, fresh = false): string | null {
  if (!fresh && whichCache.has(cmd)) return whichCache.get(cmd)!;
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let found: string | null = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const st = statSync(candidate);
        if (st.isFile()) {
          found = candidate;
          break outer;
        }
      } catch {
        // keep looking
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}

export interface ShellInfo {
  /** Executable path */
  path: string;
  /** Kind of shell, decides how commands are passed */
  kind: 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd';
  /** Human readable name for the system prompt */
  name: string;
}

let shellCache: ShellInfo | null = null;

export function detectShell(): ShellInfo {
  if (shellCache) return shellCache;
  if (isWindows) {
    const custom = process.env.FREECODE_SHELL;
    if (custom && existsSync(custom)) {
      const base = path.basename(custom).toLowerCase();
      if (/^(pwsh|powershell)(\.exe)?$/.test(base)) return (shellCache = { path: custom, kind: 'powershell', name: 'PowerShell' });
      if (/^cmd(\.exe)?$/.test(base)) return (shellCache = { path: custom, kind: 'cmd', name: 'cmd.exe' });
      return (shellCache = { path: custom, kind: 'bash', name: base.replace(/\.exe$/, '') });
    }
    const gitBashCandidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
    ].filter(Boolean) as string[];
    for (const c of gitBashCandidates) {
      if (existsSync(c)) return (shellCache = { path: c, kind: 'bash', name: 'bash (Git Bash)' });
    }
    const bash = which('bash');
    if (bash && !bash.toLowerCase().includes('system32')) return (shellCache = { path: bash, kind: 'bash', name: 'bash' });
    const pwsh = which('pwsh') || which('powershell');
    if (pwsh) return (shellCache = { path: pwsh, kind: 'powershell', name: 'PowerShell' });
    return (shellCache = { path: process.env.ComSpec || 'cmd.exe', kind: 'cmd', name: 'cmd.exe' });
  }
  const override = process.env.FREECODE_SHELL;
  if (override && existsSync(override)) {
    const base = path.basename(override);
    const kind = base.includes('zsh') ? 'zsh' : base.includes('bash') ? 'bash' : 'sh';
    return (shellCache = { path: override, kind, name: base });
  }
  const userShell = process.env.SHELL || '';
  if (/bash$/.test(userShell) && existsSync(userShell)) return (shellCache = { path: userShell, kind: 'bash', name: 'bash' });
  if (/zsh$/.test(userShell) && existsSync(userShell)) return (shellCache = { path: userShell, kind: 'zsh', name: 'zsh' });
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (existsSync(p)) return (shellCache = { path: p, kind: 'bash', name: 'bash' });
  }
  return (shellCache = { path: '/bin/sh', kind: 'sh', name: 'sh' });
}

export function osDescription(): string {
  const plat = process.platform;
  const rel = os.release();
  if (plat === 'darwin') return `macOS (Darwin ${rel})`;
  if (plat === 'win32') return `Windows (${rel})`;
  if (plat === 'linux') return `Linux ${rel}`;
  return `${plat} ${rel}`;
}

let rgPath: string | null | undefined;
export function ripgrepPath(): string | null {
  if (rgPath !== undefined) return rgPath;
  if (process.env.FREECODE_NO_RG) return (rgPath = null);
  rgPath = which('rg');
  return rgPath;
}

export function terminalWidth(): number {
  const w = process.stdout.columns;
  return w && w > 10 ? w : 100;
}

export function terminalHeight(): number {
  const h = process.stdout.rows;
  return h && h > 5 ? h : 40;
}

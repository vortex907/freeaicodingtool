// "Open in" (editors, file manager, terminal) and "Run" (the project's start command, in a terminal
// window) for the app's top bar.
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { isMac, isWindows, which } from '../util/platform.js';

export interface OpenTarget {
  id: string;
  name: string;
  kind: 'editor' | 'files' | 'terminal';
}

export interface RunCommand {
  command: string;
  /** Where the command came from. */
  source: 'saved' | 'detected';
}

interface EditorDef {
  id: string;
  name: string;
  cli: string;
  /** Windows install locations (environment variables in %...%). */
  win?: string[];
  /** macOS application name. */
  mac?: string;
}

const EDITORS: EditorDef[] = [
  { id: 'vscode', name: 'VS Code', cli: 'code', win: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'], mac: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor', cli: 'cursor', win: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'], mac: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf', cli: 'windsurf', win: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'], mac: 'Windsurf' },
  { id: 'vscodium', name: 'VSCodium', cli: 'codium', win: ['%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe'], mac: 'VSCodium' },
  { id: 'zed', name: 'Zed', cli: 'zed', mac: 'Zed' },
];

function expandWin(p: string): string {
  return p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? '');
}

function detached(file: string, args: string[], opts: SpawnOptions = {}): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => undefined);
  child.unref();
}

/** Runs a PowerShell script with values passed as environment variables (no quoting problems). */
function powershell(script: string, env: Record<string, string>): void {
  detached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, ...env }, windowsHide: true });
}

interface Found {
  def: EditorDef;
  exe?: string;
}

let editorCache: { at: number; found: Found[] } | null = null;

function findEditors(): Found[] {
  if (editorCache && Date.now() - editorCache.at < 60_000) return editorCache.found;
  const found: Found[] = [];
  for (const def of EDITORS) {
    if (isWindows) {
      const exe = (def.win ?? []).map(expandWin).find((p) => p && existsSync(p));
      if (exe) found.push({ def, exe });
      else if (which(def.cli)) found.push({ def });
    } else if (isMac) {
      if (def.mac && (existsSync(`/Applications/${def.mac}.app`) || existsSync(path.join(process.env.HOME ?? '', 'Applications', `${def.mac}.app`)))) found.push({ def });
      else if (which(def.cli)) found.push({ def });
    } else if (which(def.cli)) found.push({ def });
  }
  editorCache = { at: Date.now(), found };
  return found;
}

function visualStudio(): string | null {
  if (!isWindows) return null;
  const vswhere = expandWin('%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe');
  if (!existsSync(vswhere)) return null;
  return vswhere;
}

function findSolution(dir: string): string | null {
  try {
    const sln = readdirSync(dir).find((f) => /\.slnx?$/i.test(f));
    return sln ? path.join(dir, sln) : null;
  } catch {
    return null;
  }
}

export function openTargets(dir: string): OpenTarget[] {
  const out: OpenTarget[] = findEditors().map((f) => ({ id: f.def.id, name: f.def.name, kind: 'editor' as const }));
  if (findSolution(dir) && visualStudio()) out.push({ id: 'visualstudio', name: 'Visual Studio', kind: 'editor' });
  out.push({ id: 'files', name: isWindows ? 'File Explorer' : isMac ? 'Finder' : 'Files', kind: 'files' });
  out.push({ id: 'terminal', name: isWindows ? 'Terminal' : 'Terminal', kind: 'terminal' });
  return out;
}

function linuxTerminal(): { file: string; args: (dir: string, command?: string) => string[] } | null {
  const sh = (dir: string, command?: string) => `cd '${dir.replace(/'/g, `'\\''`)}' && ${command ? `${command}; echo; echo "[finished - press Enter to close]"; read _` : 'exec "${SHELL:-bash}"'}`;
  if (which('gnome-terminal')) return { file: 'gnome-terminal', args: (d, c) => ['--', 'bash', '-c', sh(d, c)] };
  if (which('konsole')) return { file: 'konsole', args: (d, c) => ['-e', 'bash', '-c', sh(d, c)] };
  if (which('xfce4-terminal')) return { file: 'xfce4-terminal', args: (d, c) => ['-x', 'bash', '-c', sh(d, c)] };
  if (which('x-terminal-emulator')) return { file: 'x-terminal-emulator', args: (d, c) => ['-e', 'bash', '-c', sh(d, c)] };
  if (which('xterm')) return { file: 'xterm', args: (d, c) => ['-e', 'bash', '-c', sh(d, c)] };
  return null;
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Opens the project folder in an editor, the file manager or a terminal. */
export async function openIn(target: string, dir: string): Promise<{ ok: boolean; error?: string }> {
  if (target === 'files') {
    if (isWindows) detached('explorer.exe', [dir]);
    else detached(isMac ? 'open' : 'xdg-open', [dir]);
    return { ok: true };
  }
  if (target === 'terminal') {
    if (isWindows) {
      const wt = expandWin('%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe');
      if (existsSync(wt)) detached(wt, ['-d', dir]);
      else powershell('Start-Process -FilePath powershell.exe -WorkingDirectory $env:FC_DIR', { FC_DIR: dir });
    } else if (isMac) detached('open', ['-a', 'Terminal', dir]);
    else {
      const t = linuxTerminal();
      if (!t) return { ok: false, error: 'No terminal program found' };
      detached(t.file, t.args(dir));
    }
    return { ok: true };
  }
  if (target === 'visualstudio') {
    const sln = findSolution(dir);
    const vswhere = visualStudio();
    if (!sln || !vswhere) return { ok: false, error: 'Visual Studio or a .sln file was not found' };
    const devenv = await new Promise<string>((resolve) =>
      execFile(vswhere, ['-latest', '-property', 'productPath'], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout.trim())),
    );
    if (!devenv) return { ok: false, error: 'Visual Studio was not found' };
    detached(devenv, [sln]);
    return { ok: true };
  }
  const found = findEditors().find((f) => f.def.id === target);
  if (!found) return { ok: false, error: 'That editor was not found' };
  if (found.exe) detached(found.exe, [dir]);
  else if (isMac && found.def.mac && !which(found.def.cli)) detached('open', ['-a', found.def.mac, dir]);
  else if (isWindows) detached('cmd.exe', ['/d', '/c', `${found.def.cli} "${dir}"`], { windowsVerbatimArguments: true, windowsHide: true });
  else detached(found.def.cli, [dir]);
  return { ok: true };
}

// ------------------------------------------------------------------ run

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Guesses how to start the project in `dir`. */
export function detectRunCommand(dir: string): string | null {
  const files = listFiles(dir);
  const has = (f: string) => files.includes(f);
  const pkg = has('package.json') ? readJson(path.join(dir, 'package.json')) : null;
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const deps = Object.keys({ ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) }).length;
    const install = deps && !has('node_modules') ? `${pm} install && ` : '';
    const script = (s: string) => (pm === 'npm' ? (s === 'start' ? 'npm start' : `npm run ${s}`) : pm === 'bun' ? `bun run ${s}` : `${pm} ${s}`);
    for (const s of ['dev', 'start', 'serve', 'preview']) if (scripts[s]) return install + script(s);
    if (typeof pkg.main === 'string') return `${install}node ${pkg.main}`;
  }
  // .NET: a project file here or one level down.
  const csproj = files.filter((f) => /\.(cs|fs|vb)proj$/i.test(f));
  if (csproj.length) return 'dotnet run';
  for (const sub of files) {
    if (sub.startsWith('.') || sub === 'node_modules' || sub === 'bin' || sub === 'obj') continue;
    const inner = listFiles(path.join(dir, sub)).filter((f) => /\.(cs|fs|vb)proj$/i.test(f));
    const exe = inner.find((f) => /<OutputType>\s*(Win)?Exe\s*<\/OutputType>/i.test(readFileSafe(path.join(dir, sub, f))));
    if (exe || inner.length) return `dotnet run --project "${path.join(sub, exe ?? inner[0]!)}"`;
  }
  if (has('Cargo.toml')) return 'cargo run';
  if (has('go.mod')) return 'go run .';
  const py = isWindows ? 'python' : 'python3';
  if (has('manage.py')) return `${py} manage.py runserver`;
  for (const f of ['main.py', 'app.py', 'run.py', '__main__.py']) if (has(f)) return `${py} ${f}`;
  if (has('pom.xml')) return 'mvn -q exec:java';
  if (has('gradlew') || has('gradlew.bat')) return isWindows ? 'gradlew.bat run' : './gradlew run';
  if (has('Makefile') && /^run:/m.test(readFileSafe(path.join(dir, 'Makefile')))) return 'make run';
  if (has('index.html')) return 'open index.html';
  return null;
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Starts `command` in its own terminal window in `dir` (so the user sees its output and can stop it). */
export function runInTerminal(command: string, dir: string): { ok: boolean; error?: string } {
  const open = /^open\s+(.+)$/i.exec(command.trim());
  if (open) {
    // "open index.html": show a page in the browser.
    const target = path.resolve(dir, open[1]!.replace(/^"|"$/g, ''));
    if (isWindows) detached('explorer.exe', [target]);
    else detached(isMac ? 'open' : 'xdg-open', [target]);
    return { ok: true };
  }
  if (isWindows) {
    powershell(
      "Start-Process -FilePath cmd.exe -WorkingDirectory $env:FC_DIR -ArgumentList '/k', ('title FreeCode - ' + $env:FC_RUN + ' & ' + $env:FC_RUN)",
      { FC_DIR: dir, FC_RUN: command },
    );
    return { ok: true };
  }
  if (isMac) {
    const script = `cd '${dir.replace(/'/g, `'\\''`)}' && ${command}`;
    detached('osascript', ['-e', `tell application "Terminal" to do script ${appleScriptString(script)}`, '-e', 'tell application "Terminal" to activate']);
    return { ok: true };
  }
  const t = linuxTerminal();
  if (!t) return { ok: false, error: 'No terminal program found' };
  detached(t.file, t.args(dir, command));
  return { ok: true };
}

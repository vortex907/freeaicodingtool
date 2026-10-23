// Which language server handles which files, how to find it on this machine, which folder it works
// in, and what to tell the user when it is not installed.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMac, isWindows, which } from '../util/platform.js';
import { isInside } from '../util/fs.js';
import type { Diagnostic } from './protocol.js';
import type { ServerLaunch } from './client.js';

/** Per-language settings (lsp.servers.<language>), global settings only. */
export interface ServerOverride {
  command?: string;
  args?: string[];
  /** Extensions for a language FreeCode does not know, e.g. [".lua"]. */
  extensions?: string[];
  disabled?: boolean;
  initializationOptions?: unknown;
}

export interface ServerDef {
  /** Settings key, e.g. "typescript". */
  id: string;
  /** Language name for messages. */
  name: string;
  /** Lower-case extension with the dot -> LSP language id. */
  extensions: Record<string, string>;
  /** Files that mark a project folder for this language ("*.sln" matches by extension). */
  rootMarkers: string[];
  /** outermost: one server for the whole project (default); nearest: the closest marked folder. */
  rootStrategy?: 'outermost' | 'nearest';
  /** Exact install command for the default server on this OS ('' for custom languages). */
  install: () => string;
  /** An installed server for this project folder, or null. `fresh` skips cached PATH lookups. */
  find: (root: string, fresh: boolean) => ServerLaunch | null;
  /** See ClientOptions.quietMs, dedupes and indexesInBackground. */
  quietMs?: number;
  dedupes?: boolean;
  indexesInBackground?: boolean;
  /** Diagnostics that cannot be trusted without more project setup: a note saying what is missing. */
  unreliable?: (items: Diagnostic[], root: string) => string | null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Looks for `name` in folders that installers use but PATH often lacks (~/go/bin, ~/.dotnet/tools). */
function findIn(dirs: string[], name: string): string | null {
  const exts = isWindows ? ['.exe', '.cmd', '.bat'] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      if (isFile(p)) return p;
    }
  }
  return null;
}

interface Bin {
  name: string;
  args: string[];
  label?: string;
  dirs?: () => string[];
}

function firstBin(bins: Bin[], fresh: boolean): ServerLaunch | null {
  for (const b of bins) {
    const found = which(b.name, { fresh }) ?? findIn(b.dirs?.() ?? [], b.name);
    if (found) return { command: found, args: b.args, label: b.label ?? b.name };
  }
  return null;
}

const home = () => os.homedir();
const goBin = () => [process.env.GOBIN ?? '', path.join(process.env.GOPATH || path.join(home(), 'go'), 'bin')].filter(Boolean);
const cargoBin = () => [path.join(process.env.CARGO_HOME || path.join(home(), '.cargo'), 'bin')];
const dotnetTools = () => [path.join(home(), '.dotnet', 'tools')];
const llvmBin = () => (isWindows ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin')] : isMac ? ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'] : []);

// ------------------------------------------------------------------ TypeScript

export interface TsInstall {
  dir: string;
  version: string;
  major: number;
}

export function readTypescript(dir: string): TsInstall | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (pkg.name !== 'typescript' || typeof pkg.version !== 'string') return null;
    return { dir, version: pkg.version, major: Number(pkg.version.split('.')[0]) || 0 };
  } catch {
    return null;
  }
}

/** The project's own TypeScript (only its version is read here). */
function projectTypescript(root: string): TsInstall | null {
  for (let d = root; ; d = path.dirname(d)) {
    const ts = readTypescript(path.join(d, 'node_modules', 'typescript'));
    if (ts) return ts;
    if (path.dirname(d) === d) return null;
  }
}

/** The TypeScript package that the `tsc` on PATH belongs to. */
function typescriptOnPath(fresh: boolean): { ts: TsInstall; tsc: string } | null {
  const tsc = which('tsc', { fresh });
  if (!tsc) return null;
  const dirs: string[] = [];
  try {
    // npm links bin/tsc into the prefix on Linux and macOS.
    dirs.push(path.dirname(path.dirname(realpathSync(tsc))));
  } catch {
    // broken link
  }
  // Windows shims (tsc.cmd) sit next to node_modules; Unix prefixes keep it in ../lib/node_modules.
  dirs.push(path.join(path.dirname(tsc), 'node_modules', 'typescript'), path.join(path.dirname(tsc), '..', 'lib', 'node_modules', 'typescript'));
  for (const d of dirs) {
    const ts = readTypescript(d);
    if (ts) return { ts, tsc };
  }
  return null;
}

/**
 * TypeScript 5 and 6 run in tsserver behind typescript-language-server; TypeScript 7 has its own
 * server (tsc --lsp). The project's own TypeScript version decides when both are installed.
 */
function typescriptServer(root: string, fresh: boolean): ServerLaunch | null {
  const local = projectTypescript(root);
  const global = typescriptOnPath(fresh);
  const tls = which('typescript-language-server', { fresh });
  const tsgo = which('tsgo', { fresh });
  const native: ServerLaunch | null =
    global && global.ts.major >= 7 ? { command: global.tsc, args: ['--lsp', '--stdio'], label: `tsc ${global.ts.version}` } : tsgo ? { command: tsgo, args: ['--lsp', '--stdio'], label: 'tsgo' } : null;
  if (local && local.major >= 7 && native) return native;
  const classicGlobal = global && global.ts.major < 7 ? global.ts : null;
  if (tls && ((local && local.major < 7) || classicGlobal || !native)) {
    // The project's TypeScript comes first; a global 5 or 6 is the fallback (a TypeScript 7 next to
    // typescript-language-server has no tsserver and would make it fail).
    const fallback = classicGlobal ? path.join(classicGlobal.dir, 'lib', 'tsserver.js') : undefined;
    return { command: tls, args: ['--stdio'], label: 'typescript-language-server', initializationOptions: fallback && isFile(fallback) ? { tsserver: { fallbackPath: fallback } } : undefined };
  }
  return native;
}

// ------------------------------------------------------------------ definitions

/** Without a compile database clangd guesses the include paths; missing headers make its errors noise. */
function clangdUnreliable(items: Diagnostic[], root: string): string | null {
  if (!items.some((d) => d.code === 'pp_file_not_found')) return null;
  const db = ['compile_commands.json', 'compile_flags.txt', path.join('build', 'compile_commands.json')].some((f) => isFile(path.join(root, f)));
  return db ? null : 'clangd could not find some headers because the project has no compile_commands.json (CMake: configure with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON).';
}

export const SERVER_DEFS: ServerDef[] = [
  {
    id: 'typescript',
    name: 'TypeScript/JavaScript',
    extensions: { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' },
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: () => 'npm install -g typescript-language-server typescript@6',
    find: typescriptServer,
    // tsserver reports syntax errors first and type errors a little later.
    quietMs: 500,
    // typescript-language-server sends nothing for a file that had no errors and still has none.
    dedupes: true,
  },
  {
    id: 'python',
    name: 'Python',
    extensions: { '.py': 'python', '.pyi': 'python', '.pyw': 'python' },
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'pyrightconfig.json', 'Pipfile'],
    // Imports resolve from the package folder, not from the repository root.
    rootStrategy: 'nearest',
    install: () => (which('npm') ? 'npm install -g pyright' : 'pip install pyright'),
    find: (_root, fresh) =>
      firstBin(
        [
          { name: 'pyright-langserver', args: ['--stdio'], label: 'pyright' },
          { name: 'basedpyright-langserver', args: ['--stdio'], label: 'basedpyright' },
          { name: 'pylsp', args: [] },
        ],
        fresh,
      ),
  },
  {
    id: 'rust',
    name: 'Rust',
    extensions: { '.rs': 'rust' },
    rootMarkers: ['Cargo.toml'],
    install: () => 'rustup component add rust-analyzer',
    find: (_root, fresh) => firstBin([{ name: 'rust-analyzer', args: [], dirs: cargoBin }], fresh),
    dedupes: true,
  },
  {
    id: 'go',
    name: 'Go',
    extensions: { '.go': 'go' },
    rootMarkers: ['go.work', 'go.mod'],
    install: () => 'go install golang.org/x/tools/gopls@latest',
    find: (_root, fresh) => firstBin([{ name: 'gopls', args: [], dirs: goBin }], fresh),
    dedupes: true,
  },
  {
    id: 'cpp',
    name: 'C/C++',
    extensions: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h++': 'cpp' },
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', 'meson.build', 'Makefile'],
    install: () => (isWindows ? 'winget install LLVM.LLVM' : isMac ? 'brew install llvm' : 'sudo apt install clangd'),
    find: (_root, fresh) => firstBin([{ name: 'clangd', args: [], dirs: llvmBin }], fresh),
    unreliable: clangdUnreliable,
    // Its background index can take many minutes; it answers meanwhile.
    indexesInBackground: true,
  },
  {
    id: 'csharp',
    name: 'C#',
    extensions: { '.cs': 'csharp' },
    rootMarkers: ['*.sln', '*.slnx', '*.csproj'],
    install: () => 'dotnet tool install --global csharp-ls',
    find: (_root, fresh) =>
      firstBin(
        [
          { name: 'csharp-ls', args: [], dirs: dotnetTools },
          { name: 'OmniSharp', args: ['-lsp'], label: 'OmniSharp' },
          { name: 'omnisharp', args: ['-lsp'], label: 'OmniSharp' },
        ],
        fresh,
      ),
  },
  {
    id: 'bash',
    name: 'Shell',
    extensions: { '.sh': 'shellscript', '.bash': 'shellscript' },
    rootMarkers: [],
    install: () => 'npm install -g bash-language-server',
    find: (_root, fresh) => firstBin([{ name: 'bash-language-server', args: ['start'] }], fresh),
  },
  {
    id: 'php',
    name: 'PHP',
    extensions: { '.php': 'php' },
    rootMarkers: ['composer.json'],
    install: () => 'npm install -g intelephense',
    find: (_root, fresh) => firstBin([{ name: 'intelephense', args: ['--stdio'] }], fresh),
  },
];

/** Other names people use for the settings keys. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'typescript',
  javascript: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  c: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  clangd: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  dotnet: 'csharp',
  sh: 'bash',
  shell: 'bash',
};

export function canonicalServerId(key: string): string {
  const k = key.trim().toLowerCase();
  return ALIASES[k] ?? k;
}

/** Built-in definitions plus custom languages from lsp.servers entries that list extensions. */
export function serverDefs(overrides: Record<string, ServerOverride>): ServerDef[] {
  const custom: ServerDef[] = [];
  for (const [key, o] of Object.entries(overrides)) {
    const id = canonicalServerId(key);
    if (SERVER_DEFS.some((d) => d.id === id) || !o?.command || !Array.isArray(o.extensions) || !o.extensions.length) continue;
    const exts: Record<string, string> = {};
    for (const e of o.extensions) if (typeof e === 'string' && e.trim()) exts[(e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`).toLowerCase()] = id;
    custom.push({ id, name: id, extensions: exts, rootMarkers: [], install: () => '', find: () => null });
  }
  // Custom languages win when they claim an extension a built-in one has.
  return [...custom, ...SERVER_DEFS];
}

export function defForFile(file: string, defs: ServerDef[]): ServerDef | null {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  if (!ext) return null;
  return defs.find((d) => ext in d.extensions) ?? null;
}

export function languageIdFor(def: ServerDef, file: string): string {
  return def.extensions[path.extname(file).toLowerCase()] ?? def.id;
}

export type Resolved = { ok: true; launch: ServerLaunch } | { ok: false; reason: 'disabled' | 'missing' | 'bad-override'; message: string };

/** The server to start for `def` in `root`: the settings override, else the first one installed. */
export function resolveServer(def: ServerDef, root: string, override?: ServerOverride, fresh = false): Resolved {
  if (override?.disabled) return { ok: false, reason: 'disabled', message: `The ${def.name} language server is turned off in the settings (lsp.servers.${def.id}.disabled).` };
  if (override?.command) {
    const cmd = override.command.trim();
    // which() adds the Windows extensions itself, so "pylsp.exe" is looked up as "pylsp".
    const bare = isWindows ? cmd.replace(/\.(exe|cmd|bat|com)$/i, '') : cmd;
    const found = path.isAbsolute(cmd) ? (isFile(cmd) ? cmd : null) : which(bare, { fresh });
    if (!found) return { ok: false, reason: 'bad-override', message: `The language server command from the settings (lsp.servers.${def.id}.command = "${cmd}") was not found.` };
    const args = Array.isArray(override.args) ? override.args.map(String) : [];
    // "node server.js" is better known by its script than by the interpreter.
    const named = /^(node|python3?|py|java|dotnet|deno|bun)$/i.test(path.basename(cmd).replace(/\.(exe|cmd|bat)$/i, '')) && args[0] && !args[0].startsWith('-') ? args[0] : cmd;
    const label = path.basename(named).replace(/\.(exe|cmd|bat|js|mjs|cjs|py|jar|dll)$/i, '');
    return { ok: true, launch: { command: found, args, label, initializationOptions: override.initializationOptions } };
  }
  const launch = def.find(root, fresh);
  if (!launch) {
    const install = def.install();
    return { ok: false, reason: 'missing', message: install ? `No ${def.name} language server is installed. Install it with: ${install}` : `No language server is configured for ${def.name}.` };
  }
  if (Array.isArray(override?.args)) launch.args = override.args.map(String);
  if (override?.initializationOptions !== undefined) launch.initializationOptions = override.initializationOptions;
  return { ok: true, launch };
}

function hasMarker(dir: string, markers: string[]): boolean {
  for (const m of markers) {
    if (m.startsWith('*.')) {
      try {
        const ext = m.slice(1).toLowerCase();
        if (readdirSync(dir).some((f) => f.toLowerCase().endsWith(ext))) return true;
      } catch {
        // unreadable folder
      }
    } else if (isFile(path.join(dir, m)) || (m.startsWith('.') && isDir(path.join(dir, m)))) return true;
  }
  return false;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/**
 * The folder a server for `file` works in. Inside the project: the outermost (or nearest) folder with a
 * marker between the file and the project root, else the project root. Outside it: the nearest marked
 * folder, else the file's folder.
 */
export function findRoot(def: ServerDef, file: string, projectRoot: string): string {
  const dir = path.dirname(path.resolve(file));
  if (isInside(dir, projectRoot)) {
    let found: string | null = null;
    for (let d = dir; ; d = path.dirname(d)) {
      if (hasMarker(d, def.rootMarkers)) {
        found = d;
        if (def.rootStrategy === 'nearest') break;
      }
      if (samePath(d, projectRoot) || path.dirname(d) === d) break;
    }
    return found ?? path.resolve(projectRoot);
  }
  for (let d = dir; ; d = path.dirname(d)) {
    if (hasMarker(d, def.rootMarkers)) return d;
    if (path.dirname(d) === d) return dir;
  }
}

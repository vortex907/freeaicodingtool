// Debug adapters: which one debugs a program, where it is installed, how to launch the program with it,
// and what to install when it is missing.
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPython, PYTHON_MISSING, type PythonCommand } from '../tools/repl.js';
import { isMac, isWindows, which } from '../util/platform.js';
import { randomId } from '../util/strings.js';

/** Language family of a DAP session; also what Debugger(...) permission rules match. */
export type DebugKind = 'python' | 'native' | 'csharp' | 'go';

/** A running process to attach to: by id, or (debugpy) the address a `python -m debugpy --listen` program listens on. */
export interface AttachTarget {
  pid?: number;
  host?: string;
  port?: number;
  /** The program the process runs, when known (lldb-dap loads its symbols). */
  program?: string;
}

export interface LaunchTarget {
  program: string;
  args: string[];
  cwd: string;
  stopOnEntry: boolean;
  /** Attach instead of launching. */
  attach?: AttachTarget;
}

export interface AdapterSpec {
  /** Shown to the user, e.g. "lldb-dap". */
  name: string;
  kind: DebugKind;
  command: string;
  args: string[];
  transport: 'stdio' | 'tcp';
  /** adapterID of the initialize request. */
  adapterID: string;
  env?: NodeJS.ProcessEnv;
  launchArgs: (t: LaunchTarget) => Record<string, unknown>;
  /** Arguments of the attach request; missing when the adapter cannot attach. */
  attachArgs?: (a: AttachTarget) => Record<string, unknown>;
  /** Attach can also go to an adapter the program started itself, listening on a port (AttachTarget.port). */
  attachByPort?: boolean;
  /** Pause at the start with a function breakpoint here: the adapter's stopOnEntry stops in the loader. */
  entryFunction?: string;
  /** Console lines that are adapter chatter, not program output. */
  noise?: RegExp;
  /** Console output with the exit code, for adapters that send no exited event. */
  exitStatus?: RegExp;
  /** Cleans up the program output before it is shown. */
  filterOutput?: (text: string) => string;
}

export type Backend = { type: 'pdb'; note?: string } | { type: 'node' } | { type: 'dap'; spec: AdapterSpec; program: string };

export const TYPESCRIPT_ERROR =
  'TypeScript cannot be debugged directly. Compile it first (for example `npx tsc`) and start the debugger on the generated .js file; line numbers then follow the .js file.';

// ------------------------------------------------------------------ finding adapters

const debugpyFound = new Set<string>();

/** A Python that can import debugpy. A miss is checked again next time: the user may install it meanwhile. */
export async function findDebugpy(): Promise<PythonCommand | null> {
  const py = await findPython();
  if (!py) return null;
  if (debugpyFound.has(py.file)) return py;
  const ok = await new Promise<boolean>((resolve) => {
    execFile(py.file, [...py.args, '-c', 'import debugpy'], { cwd: path.dirname(process.execPath), timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
  });
  if (ok) debugpyFound.add(py.file);
  return ok ? py : null;
}

/** lldb-dap, or lldb-vscode as LLVM 17 and older call it. */
export function findLldbDap(): string | null {
  const names = ['lldb-dap', 'lldb-vscode'];
  for (const n of names) {
    const p = which(n, true);
    if (p) return p;
  }
  if (process.platform === 'linux') {
    // Debian and Ubuntu install versioned names such as lldb-dap-18.
    for (let v = 30; v >= 10; v--) {
      for (const n of names) {
        const p = which(`${n}-${v}`, true);
        if (p) return p;
      }
    }
  }
  if (isMac) {
    // Xcode ships lldb-dap without putting it on PATH; Homebrew's LLVM is keg-only.
    const r = spawnSync('xcrun', ['--find', 'lldb-dap'], { encoding: 'utf8', timeout: 5000 });
    const found = r.status === 0 ? r.stdout.trim() : '';
    for (const p of [found, '/opt/homebrew/opt/llvm/bin/lldb-dap', '/usr/local/opt/llvm/bin/lldb-dap']) if (p && existsSync(p)) return p;
  }
  if (isWindows) {
    const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin', 'lldb-dap.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

/** dlv, also where `go install` puts it when that folder is not on PATH. */
export function findDlv(): string | null {
  const p = which('dlv', true);
  if (p) return p;
  const exe = isWindows ? 'dlv.exe' : 'dlv';
  const gopath = process.env.GOPATH?.split(path.delimiter)[0];
  for (const dir of [process.env.GOBIN, gopath && path.join(gopath, 'bin'), path.join(os.homedir(), 'go', 'bin')]) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

/** What to install when no adapter fits. */
export function installHint(kind: DebugKind): string {
  if (kind === 'python') {
    const py = isWindows ? 'python' : 'python3';
    const apt = process.platform === 'linux' ? ' On Debian or Ubuntu, if pip refuses because the Python is externally managed: sudo apt install python3-debugpy.' : '';
    return `debugpy is not installed. Install it with: ${py} -m pip install debugpy.${apt}`;
  }
  if (kind === 'go') {
    const go = which('go', true) ? '' : ' Go itself is not installed either: get it from https://go.dev/dl first.';
    return `Delve (dlv) was not found. Install it with: go install github.com/go-delve/delve/cmd/dlv@latest (it goes to the bin folder of "go env GOPATH", which should be on PATH).${go}`;
  }
  if (kind === 'csharp') {
    return 'netcoredbg was not found. Download the build for your platform from https://github.com/Samsung/netcoredbg/releases, unpack it and add the folder that contains netcoredbg to PATH.';
  }
  const base = 'No lldb-dap (called lldb-vscode before LLVM 18) was found.';
  if (isWindows) return `${base} Install LLVM with: winget install LLVM.LLVM, then add C:\\Program Files\\LLVM\\bin to PATH.`;
  if (isMac) return `${base} Install the Xcode command line tools with: xcode-select --install (Xcode 16 or newer includes lldb-dap), or LLVM with: brew install llvm.`;
  return `${base} Install lldb with your package manager: sudo apt install lldb (Debian and Ubuntu, where the command is named like lldb-dap-18), sudo dnf install lldb (Fedora) or sudo pacman -S lldb (Arch).`;
}

// ------------------------------------------------------------------ adapter specs

/** Drops the frames of debugpy and runpy from Python tracebacks: the program runs inside them. */
export function hideDebuggerFrames(text: string): string {
  return text.replace(/^ {2}File "[^"\n]*(?:[\\/]debugpy[\\/][^"\n]*|[\\/]runpy\.py)", line \d+[^\n]*\n(?: {4,}[^\n]*\n)*/gm, '');
}

function debugpySpec(py: PythonCommand): AdapterSpec {
  return {
    name: 'debugpy',
    kind: 'python',
    command: py.file,
    args: [...py.args, '-m', 'debugpy.adapter'],
    transport: 'stdio',
    adapterID: 'debugpy',
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    filterOutput: hideDebuggerFrames,
    launchArgs: (t) => ({
      type: 'python',
      request: 'launch',
      name: 'FreeCode',
      program: t.program,
      args: t.args,
      cwd: t.cwd,
      console: 'internalConsole',
      redirectOutput: true,
      stopOnEntry: t.stopOnEntry,
      justMyCode: true,
      subProcess: false,
      showReturnValue: true,
    }),
    // By process id debugpy injects itself with gdb or lldb. A program started with --listen runs its own
    // adapter on that port, which FreeCode connects to directly.
    attachArgs: (a) => ({
      type: 'python',
      request: 'attach',
      name: 'FreeCode',
      justMyCode: true,
      showReturnValue: true,
      redirectOutput: true,
      ...(a.port !== undefined ? { connect: { host: a.host || '127.0.0.1', port: a.port } } : { processId: a.pid }),
    }),
    attachByPort: true,
  };
}

/** rustc's own lldb formatters, so String and Vec show their contents. */
function rustFormatters(program: string): string[] {
  if (!program) return [];
  const dir = path.dirname(program);
  const stem = path.basename(program).replace(/\.exe$/i, '');
  // cargo builds into target/<profile>/; `rustc -g main.rs` leaves the program next to main.rs.
  let rust = existsSync(path.join(dir, `${stem}.rs`));
  for (let d = dir, i = 0; !rust && i < 4; i++, d = path.dirname(d)) {
    rust = path.basename(d) === 'target' && existsSync(path.join(path.dirname(d), 'Cargo.toml'));
  }
  const rustc = rust ? which('rustc', true) : null;
  if (!rustc) return [];
  const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).stdout?.trim();
  const etc = sysroot ? path.join(sysroot, 'lib', 'rustlib', 'etc') : '';
  if (!etc || !existsSync(path.join(etc, 'lldb_lookup.py'))) return [];
  // lldb reads backslashes in quoted arguments as escapes.
  const quoted = (f: string) => `"${path.join(etc, f).replace(/\\/g, '/')}"`;
  return [`command script import ${quoted('lldb_lookup.py')}`, `command source -s 1 ${quoted('lldb_commands')}`];
}

function lldbSpec(exe: string, program: string): AdapterSpec {
  const init = rustFormatters(program);
  return {
    name: path.basename(exe).replace(/\.exe$/i, ''),
    kind: 'native',
    command: exe,
    args: [],
    transport: 'stdio',
    adapterID: 'lldb-dap',
    entryFunction: 'main',
    launchArgs: (t) => ({ type: 'lldb-dap', request: 'launch', name: 'FreeCode', program: t.program, args: t.args, cwd: t.cwd, stopOnEntry: false, ...(init.length ? { initCommands: init } : {}) }),
    attachArgs: (a) => ({ type: 'lldb-dap', request: 'attach', name: 'FreeCode', pid: a.pid, ...(a.program ? { program: a.program } : {}), ...(init.length ? { initCommands: init } : {}) }),
  };
}

function netcoredbgSpec(exe: string): AdapterSpec {
  return {
    name: 'netcoredbg',
    kind: 'csharp',
    command: exe,
    args: ['--interpreter=vscode'],
    transport: 'stdio',
    adapterID: 'coreclr',
    // netcoredbg runs `dotnet <program>` for a .dll.
    launchArgs: (t) => ({ type: 'coreclr', request: 'launch', name: 'FreeCode', program: t.program, args: t.args, cwd: t.cwd, stopAtEntry: t.stopOnEntry, justMyCode: true, console: 'internalConsole' }),
    attachArgs: (a) => ({ type: 'coreclr', request: 'attach', name: 'FreeCode', processId: a.pid, justMyCode: true }),
  };
}

/** A main.go next to other files of its package is built as the package. */
function goTarget(program: string): string {
  if (!program.endsWith('.go')) return program;
  const dir = path.dirname(program);
  try {
    const others = readdirSync(dir).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && f !== path.basename(program));
    return others.length ? dir : program;
  } catch {
    return program;
  }
}

function dlvSpec(exe: string, program: string): AdapterSpec {
  const fromSource = program.endsWith('.go') || isDirectory(program);
  // dlv builds the program; keep the binary out of the project folder (dlv deletes it when done).
  const output = path.join(os.tmpdir(), `freecode-dlv-${randomId(8)}${isWindows ? '.exe' : ''}`);
  return {
    name: 'dlv',
    kind: 'go',
    command: exe,
    args: ['dap', '--listen=127.0.0.1:0'],
    transport: 'tcp',
    adapterID: 'go',
    entryFunction: 'main.main',
    noise: /^(Type 'dlv help' for list of commands\.|Detaching.*|Process \d+ has exited with status -?\d+)$/,
    exitStatus: /Process \d+ has exited with status (-?\d+)/,
    launchArgs: (t) => ({
      type: 'go',
      request: 'launch',
      name: 'FreeCode',
      mode: fromSource ? 'debug' : 'exec',
      program: goTarget(t.program),
      args: t.args,
      cwd: t.cwd,
      stopOnEntry: false,
      ...(fromSource ? { output } : {}),
    }),
    // On a port: a server started with `dlv --headless --listen=:<port>`, which already runs the program.
    attachArgs: (a) => ({ type: 'go', request: 'attach', name: 'FreeCode', ...(a.port !== undefined ? { mode: 'remote' } : { mode: 'local', processId: a.pid }) }),
    attachByPort: true,
  };
}

// ------------------------------------------------------------------ choosing

const extraAdapters = new Map<string, AdapterSpec>();

/** Lets `adapter: name` start this adapter (the tests use it for a fake adapter). */
export function registerAdapter(name: string, spec: AdapterSpec): void {
  extraAdapters.set(name, spec);
}

const ADAPTER_NAMES: Record<string, string> = {
  auto: 'auto',
  python: 'auto',
  debugpy: 'debugpy',
  pdb: 'pdb',
  node: 'node',
  nodejs: 'node',
  inspect: 'node',
  node_inspect: 'node',
  lldb: 'lldb-dap',
  lldb_dap: 'lldb-dap',
  lldb_vscode: 'lldb-dap',
  native: 'lldb-dap',
  c: 'lldb-dap',
  cpp: 'lldb-dap',
  'c++': 'lldb-dap',
  rust: 'lldb-dap',
  swift: 'lldb-dap',
  netcoredbg: 'netcoredbg',
  coreclr: 'netcoredbg',
  dotnet: 'netcoredbg',
  csharp: 'netcoredbg',
  'c#': 'netcoredbg',
  dlv: 'dlv',
  delve: 'dlv',
  go: 'dlv',
};

/** The adapter a start call asked for ('auto' when none), or null for an unknown name. */
export function parseAdapter(value: string | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  if (extraAdapters.has(v)) return v;
  return ADAPTER_NAMES[v.replace(/[\s-]+/g, '_')] ?? null;
}

const ADAPTER_KIND: Record<string, DebugKind> = { debugpy: 'python', 'lldb-dap': 'native', netcoredbg: 'csharp', dlv: 'go' };

/** The installed adapter for `kind`, or null. */
async function adapterFor(kind: DebugKind, program: string): Promise<AdapterSpec | null> {
  if (kind === 'python') {
    const py = await findDebugpy();
    return py ? debugpySpec(py) : null;
  }
  if (kind === 'native') {
    const exe = findLldbDap();
    return exe ? lldbSpec(exe, program) : null;
  }
  if (kind === 'go') {
    const exe = findDlv();
    return exe ? dlvSpec(exe, program) : null;
  }
  const exe = which('netcoredbg', true);
  return exe ? netcoredbgSpec(exe) : null;
}

/** Picks the debugger for `file` (absolute): a DAP adapter, or pdb / node inspect. */
export async function chooseBackend(file: string, adapter: string): Promise<Backend | { error: string }> {
  const extra = extraAdapters.get(adapter);
  if (extra) return { type: 'dap', spec: extra, program: file };
  if (adapter === 'pdb') return { type: 'pdb' };
  if (adapter === 'node') return { type: 'node' };
  let kind: DebugKind;
  let program = file;
  if (adapter === 'auto') {
    const c = classifyProgram(file);
    if ('error' in c) return c;
    if (c.kind === 'node') return { type: 'node' };
    kind = c.kind;
    program = c.program;
  } else {
    if (!existsSync(file)) return { error: `File not found: ${file}` };
    kind = ADAPTER_KIND[adapter]!;
    // The apphost next to a .NET program's .dll is not what netcoredbg runs.
    if (kind === 'csharp' && /\.exe$/i.test(file)) program = dotnetDll(path.dirname(file), path.basename(file, path.extname(file))) ?? file;
  }
  const spec = await adapterFor(kind, program);
  if (spec) return { type: 'dap', spec, program };
  if (kind !== 'python') return { error: installHint(kind) };
  // Without Python at all, the pdb path reports how to install it.
  if (!(await findPython())) return { type: 'pdb' };
  if (adapter === 'debugpy') return { error: installHint('python') };
  return { type: 'pdb', note: `${installHint('python')} Using pdb until then.` };
}

/** The adapter that attaches to a running process: the one asked for, or the one for `program`. */
export async function attachBackend(adapter: string, program: string | undefined): Promise<{ spec: AdapterSpec } | { error: string }> {
  const extra = extraAdapters.get(adapter);
  if (extra) return extra.attachArgs ? { spec: extra } : { error: `${extra.name} cannot attach to a process.` };
  let kind: DebugKind | undefined = ADAPTER_KIND[adapter];
  if (adapter === 'auto' && program) {
    const c = classifyProgram(program);
    if ('error' in c) return c;
    if (c.kind !== 'node') kind = c.kind;
  }
  if (!kind) return { error: 'Attaching works with debugpy, lldb-dap, netcoredbg and dlv: set adapter to one of them.' };
  const spec = await adapterFor(kind, program ?? '');
  if (spec) return { spec };
  return { error: kind === 'python' && !(await findPython()) ? PYTHON_MISSING : installHint(kind) };
}

// ------------------------------------------------------------------ what kind of program

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function firstBytes(file: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A .NET program (dotnet build output) has a runtimeconfig.json next to its .dll. */
function dotnetDll(dir: string, stem: string): string | null {
  const dll = path.join(dir, `${stem}.dll`);
  return existsSync(dll) && (existsSync(path.join(dir, `${stem}.runtimeconfig.json`)) || existsSync(path.join(dir, `${stem}.deps.json`))) ? dll : null;
}

function buildFirst(file: string): string | null {
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.c') return `Compile it with debug info first, for example \`cc -g -O0 ${base} -o ${stem}\`, then start the debugger on ${stem}.`;
  if (['.cc', '.cpp', '.cxx', '.c++'].includes(ext)) return `Compile it with debug info first, for example \`c++ -g -O0 ${base} -o ${stem}\`, then start the debugger on ${stem}.`;
  if (ext === '.rs') return `Build it first with \`cargo build\` (debug builds have debug info) and start the debugger on target/debug/<name>, or compile one file with \`rustc -g ${base}\`.`;
  if (ext === '.swift') return `Build it first with \`swift build\` and start .build/debug/<name>, or compile one file with \`swiftc -g ${base}\`.`;
  if (['.cs', '.csproj', '.sln', '.fs', '.fsproj', '.vb', '.vbproj'].includes(ext)) return 'Build it first with `dotnet build` and start the debugger on bin/Debug/<framework>/<name>.dll.';
  if (['.h', '.hpp', '.hh'].includes(ext)) return 'A header is not a program: start the debugger on the compiled executable and set breakpoints in the header with break.';
  return null;
}

/** What `file` is and how to debug it. */
export function classifyProgram(file: string): { kind: DebugKind | 'node'; program: string } | { error: string } {
  if (/\.(ts|tsx|mts|cts)$/i.test(file)) return { error: TYPESCRIPT_ERROR };
  if (!existsSync(file)) return { error: `File not found: ${file}` };
  if (isDirectory(file)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(file);
    } catch {
      // unreadable: reported below
    }
    if (entries.some((e) => e === 'go.mod' || e.endsWith('.go'))) return { kind: 'go', program: file };
    if (entries.includes('Cargo.toml')) return { error: `${file} is a Rust project. Build it with \`cargo build\` and start the debugger on target/debug/<name>.` };
    if (entries.some((e) => /\.(csproj|fsproj|sln)$/i.test(e))) return { error: `${file} is a .NET project. Build it with \`dotnet build\` and start the debugger on bin/Debug/<framework>/<name>.dll.` };
    return { error: `${file} is a folder. Pass the program to debug (a Go package folder works too).` };
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return { kind: 'python', program: file };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { kind: 'node', program: file };
  if (ext === '.go') return { kind: 'go', program: file };
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  if (ext === '.dll') {
    return dotnetDll(dir, stem) ? { kind: 'csharp', program: file } : { error: `${path.basename(file)} is a library, not a program. Start the debugger on the program that loads it.` };
  }
  const hint = buildFirst(file);
  if (hint) return { error: `${path.basename(file)} is source code. ${hint}` };
  const head = firstBytes(file, 256);
  const magic = head.subarray(0, 4).toString('hex');
  // PE (Windows), ELF, Mach-O (32/64 bit, both byte orders, universal).
  if (head.subarray(0, 2).toString('latin1') === 'MZ') {
    const dll = dotnetDll(dir, stem);
    return dll ? { kind: 'csharp', program: dll } : { kind: 'native', program: file };
  }
  if (['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)) return { kind: 'native', program: file };
  const shebang = /^#!.*\b(python[\d.]*|node)\b/.exec(head.toString('utf8').split('\n')[0] ?? '');
  if (shebang) return shebang[1] === 'node' ? { kind: 'node', program: file } : { kind: 'python', program: file };
  return {
    error: `Cannot tell how to debug ${path.basename(file)}. Pass a Python or JavaScript file, a Go file or package folder, a .NET .dll or a native executable built with debug info, or set adapter.`,
  };
}

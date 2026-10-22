// Bash tool (plus BashOutput / KillShell for background processes).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fsp, existsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BackgroundShell, PreparedCall, Tool, ToolContext, ToolResult } from './types.js';
import { boolParam, errorResult, fail, numParam, ok, strParam } from './types.js';
import { detectShell, isWindows } from '../util/platform.js';
import { stripAnsi } from '../util/ansi.js';
import { formatDuration, randomId, truncate, truncateMiddle } from '../util/strings.js';
import { invalidateFileListCache } from './listFiles.js';

const MAX_OUTPUT_FOR_MODEL = 30_000;
const MAX_CAPTURE = 4 * 1024 * 1024;

const INTERACTIVE: { re: RegExp; hint: string }[] = [
  { re: /^(vim?|nvim|nano|emacs|pico|joe|micro)\b/, hint: 'Text editors are interactive. Use the Edit or Write tools instead.' },
  { re: /^(less|more|most)\b/, hint: 'Pagers are interactive. Use Read (or `cat`/`head`) instead.' },
  { re: /^(top|htop|btop|watch)\b/, hint: 'This is an interactive monitor. Use a one-shot command like `ps aux` instead.' },
  { re: /^man\b/, hint: 'Use `<command> --help` instead of man pages.' },
  { re: /^git\s+(rebase\s+-i|rebase\s+--interactive|add\s+(-p|--patch|-i)|commit\s*$)/, hint: 'Interactive git commands hang. Use non-interactive flags (e.g. `git commit -m "msg"`).' },
  { re: /^(python3?|node|irb|ghci|lua|php\s+-a|psql|mysql|sqlite3|mongo|mongosh|redis-cli)\s*$/, hint: 'Starting a REPL would hang. Run a script or pass the code with -c / -e instead.' },
  { re: /^ssh\s+[^\s]+\s*$/, hint: 'Interactive SSH sessions are not supported. Pass the remote command as an argument.' },
];

function checkInteractive(command: string): string | null {
  const segments = command.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const cleaned = seg.replace(/^(sudo|time|nohup|env\s+\S+=\S+)\s+/, '');
    for (const { re, hint } of INTERACTIVE) if (re.test(cleaned)) return hint;
  }
  return null;
}

/** Collapses carriage-return progress bars and strips ANSI codes. */
export function cleanOutput(s: string): string {
  const noAnsi = stripAnsi(s);
  return noAnsi
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r', line.length - 2);
      return (i >= 0 ? line.slice(i + 1) : line).replace(/\r$/, '');
    })
    .join('\n');
}

const MULTIWORD = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'python', 'python3', 'pip', 'pip3', 'poetry', 'uv', 'docker', 'kubectl', 'make', 'gradle', './gradlew', 'mvn', 'dotnet', 'deno', 'rails', 'bundle', 'composer', 'php', 'swift', 'flutter', 'dart', 'terraform', 'helm', 'gh', 'brew', 'apt', 'apt-get', 'pytest', 'node']);

/** Suggests a reusable permission rule for a command, e.g. "Bash(npm run test:*)". */
export function suggestBashRule(command: string): { rule: string; label: string } {
  const first = command.split(/&&|\|\||;|\||\n/)[0]!.trim();
  const tokens = first.split(/\s+/).filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
  let n = 1;
  if (MULTIWORD.has(tokens[0] ?? '')) n = 2;
  if ((tokens[0] === 'npm' || tokens[0] === 'pnpm' || tokens[0] === 'yarn' || tokens[0] === 'bun') && tokens[1] === 'run') n = 3;
  if (tokens[0] === 'python' || tokens[0] === 'python3') n = tokens[1] === '-m' ? 3 : 2;
  const prefix = tokens.slice(0, n).join(' ') || first;
  return { rule: `Bash(${prefix}:*)`, label: `\`${prefix}\` commands` };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

interface SpawnResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  newCwd?: string;
}

/**
 * Git Bash only puts its own tools (ls, grep, sed, ...) on PATH in login shells. We run `bash -c`,
 * so add Git's usr\bin and mingw64\bin ourselves.
 */
export function gitBashPath(bashPath: string, currentPath: string): string {
  let root = path.win32.dirname(path.win32.dirname(bashPath)); // ...\Git\bin\bash.exe -> ...\Git
  if (/\\usr$/i.test(root)) root = path.win32.dirname(root); // ...\Git\usr\bin\bash.exe
  const extra = [path.win32.join(root, 'usr', 'bin'), path.win32.join(root, 'mingw64', 'bin')];
  const parts = currentPath.split(';').filter(Boolean);
  const missing = extra.filter((d) => !parts.some((p) => p.toLowerCase() === d.toLowerCase()));
  return [...missing, ...parts].join(';');
}

function shellEnv(ctx: ToolContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sh = detectShell();
  if (isWindows && sh.kind === 'bash') {
    // Windows environment names are case-insensitive; keep a single PATH entry.
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    const current = env[key] ?? '';
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path' && k !== key) delete env[k];
    env[key] = gitBashPath(sh.path, current);
    env.MSYSTEM ??= 'MINGW64';
    env.CHERE_INVOKING = '1';
  }
  return {
    ...env,
    ...ctx.settings.env,
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    EDITOR: 'true',
    VISUAL: 'true',
    NO_COLOR: '1',
    CLICOLOR: '0',
    TERM: 'dumb',
    DEBIAN_FRONTEND: 'noninteractive',
    PIP_NO_INPUT: '1',
    npm_config_yes: 'true',
    FREECODE: '1',
  };
}

interface Invocation {
  file: string;
  args: string[];
  /** cmd.exe parses its own command line, so the arguments must reach it unquoted by Node. */
  verbatim?: boolean;
  /** Temporary script to delete afterwards. */
  scriptFile?: string;
}

/**
 * PowerShell wrapper: UTF-8 output, the working directory reported back, and a meaningful exit code.
 * When a program ran, its exit code wins: Windows PowerShell sets $? to false for any program that
 * writes to stderr under 2>&1, even when it succeeded.
 */
export function powershellScript(command: string, cwdFile: string | null): string {
  const saveCwd = cwdFile ? `try { [IO.File]::WriteAllText('${cwdFile.replace(/'/g, "''")}', (Get-Location).ProviderPath) } catch {}\n` : '';
  return (
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}\n' +
    '$OutputEncoding = [Text.Encoding]::UTF8\n' +
    '$global:LASTEXITCODE = $null\n' +
    `${command}\n` +
    '$__fcOk = $?\n' +
    saveCwd +
    'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n' +
    'if ($__fcOk) { exit 0 } else { exit 1 }'
  );
}

export function buildInvocation(command: string, cwdFile: string | null): Invocation {
  const sh = detectShell();
  if (sh.kind === 'powershell') {
    // -ExecutionPolicy Bypass lets npm/npx/yarn's .ps1 shims run under the default "Restricted" policy.
    const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    const script = powershellScript(command, cwdFile);
    // -EncodedCommand sidesteps every quoting problem; very long scripts go through a temporary file instead.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length < 30_000) return { file: sh.path, args: [...base, '-EncodedCommand', encoded] };
    const scriptFile = path.join(os.tmpdir(), `freecode-${process.pid}-${randomId(8)}.ps1`);
    writeFileSync(scriptFile, '\ufeff' + script, 'utf8');
    return { file: sh.path, args: [...base, '-File', scriptFile], scriptFile };
  }
  if (sh.kind === 'cmd') return { file: sh.path, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  // Git Bash: `pwd -W` prints a Windows path (C:/Users/...) that Node understands.
  const pwd = isWindows ? 'pwd -W' : 'pwd -P';
  const trailer = cwdFile ? `\n__fc_ec=$?\n${pwd} > '${cwdFile.replace(/'/g, "'\\''")}' 2>/dev/null\nexit $__fc_ec` : '';
  return { file: sh.path, args: ['-c', command + trailer] };
}

function runCommand(command: string, ctx: ToolContext, timeoutMs: number, onOutput: (chunk: string) => void): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // cmd.exe can't report its final directory, every other shell can.
    const cwdFile = detectShell().kind === 'cmd' ? null : path.join(os.tmpdir(), `freecode-cwd-${process.pid}-${randomId(6)}`);
    const { file, args, verbatim, scriptFile } = buildInvocation(command, cwdFile);
    let cwd = ctx.session.cwd;
    if (!existsSync(cwd)) cwd = ctx.projectRoot;
    const child = spawn(file, args, {
      cwd,
      env: shellEnv(ctx),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let output = '';
    let dropped = 0;
    const onData = (b: Buffer) => {
      const s = b.toString('utf8');
      if (output.length + s.length > MAX_CAPTURE) {
        // Keep the head and the most recent output.
        const keepHead = output.slice(0, MAX_CAPTURE / 4);
        const tail = (output + s).slice(-(MAX_CAPTURE / 2));
        dropped += output.length + s.length - keepHead.length - tail.length;
        output = keepHead + `\n[... output truncated ...]\n` + tail;
      } else output += s;
      onOutput(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
      setTimeout(() => killTree(child, 'SIGKILL'), 1500).unref();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const finish = async (code: number | null, sig: NodeJS.Signals | null) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      let newCwd: string | undefined;
      if (cwdFile) {
        try {
          const c = (await fsp.readFile(cwdFile, 'utf8')).trim();
          if (c && c !== ctx.session.cwd && existsSync(c)) newCwd = c;
          await fsp.unlink(cwdFile);
        } catch {
          // no cwd info
        }
      }
      if (scriptFile) await fsp.unlink(scriptFile).catch(() => undefined);
      if (dropped) output += `\n[${dropped} bytes of output were dropped]`;
      resolve({ output, exitCode: code, signal: sig, timedOut, aborted, durationMs: Date.now() - started, newCwd });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      void finish(127, null);
    });
    child.on('close', (code, sig) => void finish(code, sig));
  });
}

function startBackground(command: string, ctx: ToolContext): BackgroundShell {
  const { file, args, verbatim, scriptFile } = buildInvocation(command, null);
  const child = spawn(file, args, {
    cwd: existsSync(ctx.session.cwd) ? ctx.session.cwd : ctx.projectRoot,
    env: shellEnv(ctx),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
  const id = `shell_${++ctx.session.shellCounter}`;
  const shell: BackgroundShell = {
    id,
    command,
    startedAt: Date.now(),
    output: '',
    readOffset: 0,
    exitCode: null,
    running: true,
    kill: () => killTree(child),
  };
  const onData = (b: Buffer) => {
    shell.output += b.toString('utf8');
    if (shell.output.length > MAX_CAPTURE) {
      const cut = shell.output.length - MAX_CAPTURE / 2;
      shell.output = shell.output.slice(cut);
      shell.readOffset = Math.max(0, shell.readOffset - cut);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('close', (code) => {
    shell.running = false;
    shell.exitCode = code;
    if (scriptFile) void fsp.unlink(scriptFile).catch(() => undefined);
  });
  child.on('error', (e) => {
    shell.output += `\n${e.message}`;
    shell.running = false;
    shell.exitCode = 127;
  });
  ctx.session.shells.set(id, shell);
  return shell;
}

export const BashTool: Tool = {
  name: 'Bash',
  category: 'execute',
  description:
    'Run a shell command in the project and return its output (stdout+stderr) and exit code. The working directory persists between calls. ' +
    'Use it for builds, tests, git, package managers and other CLI tools. Do NOT use it to read, search or edit files (use Read, Grep, Glob, Edit, Write). ' +
    'Commands cannot be interactive (no editors, pagers or prompts). For servers or watchers set run_in_background=true and check them with BashOutput. ' +
    'Default timeout is 2 minutes (max 10).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      description: { type: 'string', description: 'Short (5-10 words) description of what the command does' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000)' },
      run_in_background: { type: 'boolean', description: 'Start the command in the background and return immediately' },
    },
    required: ['command'],
  },
  label: (input) => `Bash(${truncate((strParam(input, 'command', 'cmd', 'script') ?? '?').replace(/\s+/g, ' '), 100)})`,
  async prepare(input, ctx): Promise<PreparedCall> {
    const command = strParam(input, 'command', 'cmd', 'script', 'shell_command');
    if (!command || !command.trim()) return errorResult('Missing required parameter: command');
    const interactive = checkInteractive(command.trim());
    if (interactive) return errorResult(`This command would wait for keyboard input and hang: ${interactive}`);
    const background = boolParam(input, 'run_in_background', 'background') ?? false;
    const timeout = Math.min(600_000, Math.max(1000, numParam(input, 'timeout', 'timeout_ms') ?? ctx.settings.bashTimeoutMs ?? 120_000));
    const description = strParam(input, 'description');
    const rule = suggestBashRule(command);
    return {
      permission: {
        tool: 'Bash',
        category: 'execute',
        title: background ? 'Background command' : 'Bash command',
        subject: command,
        command,
        description,
        ruleSuggestion: rule.rule,
        ruleLabel: rule.label,
      },
      execute: async (): Promise<ToolResult> => {
        if (background) {
          const sh = startBackground(command, ctx);
          return ok(`Started in background as ${sh.id}. Use BashOutput with bash_id="${sh.id}" to read its output and KillShell to stop it.`, {
            kind: 'summary',
            text: `Running in background (${sh.id})`,
          });
        }
        let lastProgress = 0;
        let tail = '';
        const res = await runCommand(command, ctx, timeout, (chunk) => {
          tail = (tail + chunk).slice(-2000);
          const now = Date.now();
          if (now - lastProgress > 150) {
            lastProgress = now;
            const lines = cleanOutput(tail).split('\n').filter((l) => l.trim());
            ctx.services.progress(lines.slice(-3).join('\n'));
          }
        });
        invalidateFileListCache();
        if (res.newCwd) ctx.session.cwd = res.newCwd;
        let out = cleanOutput(res.output).replace(/\s+$/, '');
        const shown = out;
        if (out.length > MAX_OUTPUT_FOR_MODEL) out = truncateMiddle(out, MAX_OUTPUT_FOR_MODEL, 0.3);
        const parts: string[] = [];
        parts.push(out || '(no output)');
        if (res.aborted) parts.push('[Command was interrupted by the user]');
        else if (res.timedOut) parts.push(`[Command timed out after ${formatDuration(timeout)} and was killed. For long-running processes use run_in_background=true.]`);
        else if (res.exitCode !== 0) parts.push(`[Exit code: ${res.exitCode ?? res.signal}]`);
        if (res.newCwd) parts.push(`[Working directory is now ${res.newCwd}]`);
        const isError = res.timedOut || res.aborted || (res.exitCode !== 0 && res.exitCode !== null);
        return {
          content: parts.join('\n'),
          isError,
          display: { kind: 'text', text: shown || (res.exitCode === 0 ? '(no output)' : `Exit code ${res.exitCode}`), maxLines: 6, dim: true },
        };
      },
    };
  },
};

export const BashOutputTool: Tool = {
  name: 'BashOutput',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description: 'Read new output from a background shell started with Bash(run_in_background=true). Returns only output produced since the last read, plus the process status.',
  parameters: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'Id of the background shell (e.g. shell_1)' },
      filter: { type: 'string', description: 'Optional regular expression; only matching lines are returned' },
    },
    required: ['bash_id'],
  },
  label: (input) => `BashOutput(${strParam(input, 'bash_id', 'shell_id', 'id') ?? '?'})`,
  async prepare(input, ctx) {
    const id = strParam(input, 'bash_id', 'shell_id', 'id');
    if (!id) return errorResult('Missing required parameter: bash_id');
    const sh = ctx.session.shells.get(id);
    if (!sh) return errorResult(`No background shell with id ${id}. Running shells: ${[...ctx.session.shells.keys()].join(', ') || 'none'}`);
    return {
      execute: async () => {
        let fresh = cleanOutput(sh.output.slice(sh.readOffset));
        sh.readOffset = sh.output.length;
        const filter = strParam(input, 'filter');
        if (filter) {
          try {
            const re = new RegExp(filter);
            fresh = fresh.split('\n').filter((l) => re.test(l)).join('\n');
          } catch {
            return fail(`Invalid filter regex: ${filter}`);
          }
        }
        if (fresh.length > MAX_OUTPUT_FOR_MODEL) fresh = truncateMiddle(fresh, MAX_OUTPUT_FOR_MODEL, 0.2);
        const status = sh.running ? `running (for ${formatDuration(Date.now() - sh.startedAt)})` : `exited with code ${sh.exitCode}`;
        return ok(`Status: ${status}\n${fresh.trim() ? fresh : '(no new output)'}`, { kind: 'summary', text: `${status}${fresh.trim() ? `, ${fresh.split('\n').length} new lines` : ''}` });
      },
    };
  },
};

export const KillShellTool: Tool = {
  name: 'KillShell',
  category: 'execute',
  description: 'Stop a background shell started with Bash(run_in_background=true).',
  parameters: {
    type: 'object',
    properties: { shell_id: { type: 'string', description: 'Id of the background shell to stop' } },
    required: ['shell_id'],
  },
  label: (input) => `KillShell(${strParam(input, 'shell_id', 'bash_id', 'id') ?? '?'})`,
  async prepare(input, ctx) {
    const id = strParam(input, 'shell_id', 'bash_id', 'id');
    if (!id) return errorResult('Missing required parameter: shell_id');
    const sh = ctx.session.shells.get(id);
    if (!sh) return errorResult(`No background shell with id ${id}.`);
    return {
      execute: async () => {
        if (sh.running) sh.kill();
        ctx.session.shells.delete(id);
        return ok(`Stopped ${id} (${truncate(sh.command, 80)}).`);
      },
    };
  },
};

/** Kills all background shells (on exit). */
export function killAllShells(shells: Map<string, BackgroundShell>): void {
  for (const sh of shells.values()) if (sh.running) sh.kill();
}

/** Runs a command directly for the user's "!" shell shortcut. */
export async function runUserShellCommand(command: string, ctx: ToolContext, onOutput: (s: string) => void): Promise<{ output: string; exitCode: number | null; newCwd?: string }> {
  const res = await runCommand(command, ctx, ctx.settings.bashTimeoutMs ?? 120_000, onOutput);
  if (res.newCwd) ctx.session.cwd = res.newCwd;
  return { output: cleanOutput(res.output), exitCode: res.exitCode, newCwd: res.newCwd };
}

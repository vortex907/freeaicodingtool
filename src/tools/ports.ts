// Which TCP ports a background shell's process tree listens on, using what the system has: /proc plus ss
// or lsof on Linux, ps and lsof on macOS, PowerShell (Get-NetTCPConnection, or netstat -ano) on Windows.
// Also guesses the port a dev server command will use, so a second copy of a running server can be spotted.
import { execFile } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { isWindows, which } from '../util/platform.js';

interface Proc {
  pid: number;
  ppid: number;
  pgid?: number;
}

export interface Listener {
  pid: number;
  port: number;
}

/** stdout of a command, '' when it found nothing (non-zero exit, no output), null when it could not run. */
function exec(file: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        const out = String(stdout ?? '');
        const failed = err && (typeof (err as NodeJS.ErrnoException).code === 'string' || (err as { killed?: boolean }).killed);
        resolve(failed && !out ? null : out);
      });
    } catch {
      resolve(null);
    }
  });
}

/** `ss -ltnp` lines: State Recv-Q Send-Q Local:Port Peer:Port users:(("node",pid=123,fd=19)). */
export function parseSs(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^\d+$/.test(cols[1] ?? '')) continue;
    const port = Number(/:(\d+)$/.exec(cols[3]!)?.[1]);
    if (!port) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) res.push({ pid: Number(m[1]), port });
  }
  return res;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: "p<pid>" lines, each followed by "n<address>:<port>" lines. */
export function parseLsof(out: string): Listener[] {
  const res: Listener[] = [];
  let pid = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port) res.push({ pid, port });
    }
  }
  return res;
}

/** `netstat -ano` on Windows: "TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  1234". */
export function parseNetstat(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0]!)) continue;
    // Listening sockets have no remote end (port 0). The state column is translated on non-English Windows.
    if (!/:0$/.test(cols[2]!)) continue;
    const port = Number(/:(\d+)$/.exec(cols[1]!)?.[1]);
    const pid = Number(cols[cols.length - 1]);
    if (port && pid) res.push({ pid, port });
  }
  return res;
}

async function unixProcesses(): Promise<Proc[] | null> {
  if (process.platform === 'linux') {
    try {
      const pids = (await fsp.readdir('/proc')).filter((e) => /^\d+$/.test(e));
      const procs = await Promise.all(
        pids.map(async (pid) => {
          try {
            // "pid (comm) state ppid pgrp ...": comm may contain spaces and parentheses.
            const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return { pid: Number(pid), ppid: Number(rest[1]), pgid: Number(rest[2]) };
          } catch {
            return null;
          }
        }),
      );
      const list = procs.filter((p): p is { pid: number; ppid: number; pgid: number } => !!p);
      if (list.length) return list;
    } catch {
      // no /proc: use ps
    }
  }
  const out = await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=']);
  if (!out) return null;
  const list: Proc[] = [];
  for (const line of out.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) list.push({ pid: pid!, ppid: ppid!, pgid: Number.isFinite(pgid) ? pgid : undefined });
  }
  return list.length ? list : null;
}

/** Linux without ss or lsof: listening sockets from /proc/net/tcp*, matched to the processes' open sockets. */
async function procNetListeners(pids: Iterable<number>): Promise<Listener[]> {
  const inodes = new Map<string, number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      // sl local_address rem_address st ... inode; st 0A is LISTEN, the port is hex.
      const cols = line.trim().split(/\s+/);
      if (cols[3] !== '0A' || !cols[9]) continue;
      const port = parseInt(cols[1]?.split(':')[1] ?? '', 16);
      if (port) inodes.set(cols[9], port);
    }
  }
  const res: Listener[] = [];
  if (!inodes.size) return res;
  await Promise.all(
    [...pids].map(async (pid) => {
      const fds = await fsp.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        const link = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        const port = inodes.get(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? '');
        if (port) res.push({ pid, port });
      }
    }),
  );
  return res;
}

async function unixListeners(pids: Iterable<number>): Promise<Listener[] | null> {
  if (process.platform === 'linux' && which('ss')) {
    const out = await exec('ss', ['-ltnp']);
    if (out !== null) return parseSs(out);
  }
  if (which('lsof')) {
    const out = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    if (out !== null) return parseLsof(out);
  }
  return process.platform === 'linux' ? procNetListeners(pids) : null;
}

/** One PowerShell call for the process list and the listening ports; netstat when the second part fails. */
async function windowsInfo(): Promise<{ procs: Proc[] | null; listeners: Listener[] | null }> {
  let procs: Proc[] | null = null;
  let listeners: Listener[] | null = null;
  const ps = which('powershell') ?? which('pwsh');
  if (ps) {
    const script =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      "Get-CimInstance Win32_Process | ForEach-Object { 'P ' + $_.ProcessId + ' ' + $_.ParentProcessId }\n" +
      "Get-NetTCPConnection -State Listen | ForEach-Object { 'L ' + $_.LocalPort + ' ' + $_.OwningProcess }";
    const out = await exec(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 30_000);
    const p: Proc[] = [];
    const l: Listener[] = [];
    for (const line of (out ?? '').split(/\r?\n/)) {
      const m = /^([PL]) (\d+) (\d+)$/.exec(line.trim());
      if (m?.[1] === 'P') p.push({ pid: Number(m[2]), ppid: Number(m[3]) });
      else if (m?.[1] === 'L') l.push({ port: Number(m[2]), pid: Number(m[3]) });
    }
    if (p.length) procs = p;
    if (l.length) listeners = l;
  }
  if (!listeners) {
    const out = await exec('netstat', ['-ano']);
    if (out !== null) listeners = parseNetstat(out);
  }
  return { procs, listeners };
}

/**
 * The TCP ports each root process's tree listens on (sorted), keyed by root pid.
 * Null when the system has no way to tell (no ss, lsof, /proc or netstat).
 */
export async function listeningPortsByTree(roots: number[]): Promise<Map<number, number[]> | null> {
  if (!roots.length) return new Map();
  let procs: Proc[] | null;
  let listeners: Listener[] | null = null;
  if (isWindows) ({ procs, listeners } = await windowsInfo());
  else procs = await unixProcesses();
  const children = new Map<number, number[]>();
  for (const p of procs ?? []) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const owner = new Map<number, number>();
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (owner.has(pid)) continue;
      owner.set(pid, root);
      stack.push(...(children.get(pid) ?? []));
    }
  }
  // Background shells lead their own process group; children that daemonized keep it.
  for (const p of procs ?? []) if (p.pgid !== undefined && !owner.has(p.pid) && roots.includes(p.pgid)) owner.set(p.pid, p.pgid);
  if (!isWindows) listeners = await unixListeners(owner.keys());
  if (!listeners) return null;
  const result = new Map<number, number[]>(roots.map((r) => [r, []]));
  for (const l of listeners) {
    const root = owner.get(l.pid);
    const ports = root === undefined ? undefined : result.get(root);
    if (ports && !ports.includes(l.port)) ports.push(l.port);
  }
  for (const ports of result.values()) ports.sort((a, b) => a - b);
  return result;
}

// ------------------------------------------------------------------ dev server ports

/** Default ports of common dev servers; the more specific patterns come first. */
const SERVER_DEFAULTS: { re: RegExp; port: number }[] = [
  { re: /\bvite\s+preview\b/, port: 4173 },
  { re: /\bng\s+serve\b/, port: 4200 },
  { re: /\bastro\s+(dev|preview|start)\b/, port: 4321 },
  { re: /\b(webpack-dev-server|webpack\s+serve|http-server|live-server|vue-cli-service\s+serve)\b|\beleventy\b.*--serve/, port: 8080 },
  { re: /\b(storybook\s+dev|start-storybook)\b/, port: 6006 },
  { re: /\bhugo\s+server\b/, port: 1313 },
  { re: /\bjekyll\s+serve\b/, port: 4000 },
  { re: /\bwrangler\s+dev\b/, port: 8787 },
  { re: /\bexpo\s+start\b/, port: 8081 },
  { re: /\bparcel\b(?!\s+build)/, port: 1234 },
  { re: /\bflask\s+run\b/, port: 5000 },
  { re: /\b(gatsby\s+develop|uvicorn|gunicorn|fastapi\s+(dev|run)|runserver|http\.server|artisan\s+serve|mkdocs\s+serve)\b/, port: 8000 },
  { re: /\b(next\s+(dev|start)|react-scripts\s+start|nuxi?\s+(dev|start|preview)|remix\s+dev|docusaurus\s+start|rails\s+(s|server))\b/, port: 3000 },
  { re: /\bvite\b(?!\s+(build|optimize))|\bsvelte-kit\s+dev\b/, port: 5173 },
  { re: /(^|&&|;|\|)\s*(npx\s+)?serve(\s|$)/, port: 3000 },
];

const SERVERISH = /\b(serve|server|dev|start|preview|watch|listen|nodemon|runserver)\b|\s-S\s/;

function packageScript(dir: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const s = pkg.scripts?.[name];
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The port a command that starts a dev server will most likely use (explicit flags first, then the
 * tool's default), or null when it does not look like a server. "npm run dev" looks at package.json.
 */
export function guessServerPort(command: string, cwd: string, depth = 0): number | null {
  let cmd = command.trim();
  let dir = cwd;
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/.exec(cmd);
  if (cd) {
    dir = path.resolve(cwd, cd[1]!.replace(/^["']|["']$/g, ''));
    cmd = cmd.slice(cd[0].length);
  }
  const known = SERVER_DEFAULTS.find((d) => d.re.test(cmd));
  const explicit = /(?:^|\s)--port(?:=|\s+)(\d{2,5})\b/.exec(cmd) ?? /\bPORT=(\d{2,5})\b/.exec(cmd);
  if (explicit) return Number(explicit[1]);
  if (known || SERVERISH.test(cmd)) {
    const other =
      /(?:^|\s)-p\s*(\d{2,5})\b/.exec(cmd) ??
      /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*):(\d{2,5})\b/.exec(cmd) ??
      /\b(?:runserver|http\.server)\s+(\d{2,5})\b/.exec(cmd);
    if (other) return Number(other[1]);
  }
  if (known) return known.port;
  // npm run dev, npm start, yarn dev, pnpm run serve, bun run dev: follow the package.json script.
  const run = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(cmd);
  if (run && depth < 2) {
    const script = packageScript(dir, run[1]!);
    if (script) return guessServerPort(script, dir, depth + 1);
  }
  return null;
}

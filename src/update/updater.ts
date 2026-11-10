// Updates from GitHub Releases. Installs made with the Windows setup update themselves: the new
// setup is downloaded in the background, checked against the release's SHA256SUMS.txt, and run
// silently (it closes FreeCode, installs, and opens it again). npm/git installs get a notice.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { globalPaths } from '../config/paths.js';
import { debug } from '../util/log.js';

export const UPDATE_REPO = 'vortex907/freeaicodingtool';

export type InstallMethod = 'installer' | 'npm' | 'git' | 'unknown';

export interface ReleaseInfo {
  version: string;
  notes: string;
  url: string;
  publishedAt?: string;
  setupUrl?: string;
  setupName?: string;
  sumsUrl?: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  current: string;
  method: InstallMethod;
  latest?: ReleaseInfo;
  /** 0-1 while downloading. */
  progress?: number;
  error?: string;
  checkedAt?: number;
  /** How to update by hand (npm/git installs). */
  command?: string;
}

interface Pending {
  version: string;
  file: string;
  sha256: string;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function installMethod(): InstallMethod {
  const runtimeDir = path.dirname(process.execPath);
  if (process.platform === 'win32' && path.basename(runtimeDir).toLowerCase() === 'runtime' && existsSync(path.join(runtimeDir, '..', 'FreeCode.exe'))) return 'installer';
  const root = packageRoot();
  if (existsSync(path.join(root, '.git'))) return 'git';
  if (root.split(path.sep).includes('node_modules')) return 'npm';
  return 'unknown';
}

/** Compares dotted versions ("1.10.0" > "1.9.2"); a pre-release ("1.2.0-beta") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/i, '').split('-', 2);
    return { nums: main!.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `FreeCode/${VERSION}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const j = (await res.json()) as { tag_name?: string; body?: string; html_url?: string; published_at?: string; assets?: { name: string; browser_download_url: string }[] };
  const assets = j.assets ?? [];
  const setup = assets.find((a) => /^FreeCode-Setup-.*\.exe$/i.test(a.name));
  const sums = assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  return {
    version: (j.tag_name ?? '').replace(/^v/i, ''),
    notes: (j.body ?? '').slice(0, 4000),
    url: j.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
    publishedAt: j.published_at,
    setupUrl: setup?.browser_download_url,
    setupName: setup?.name,
    sumsUrl: sums?.browser_download_url,
  };
}

function pendingFile(): string {
  return path.join(globalPaths.stateDir, 'update.json');
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** A downloaded, verified installer newer than this version, if any. */
export function pendingUpdate(): Pending | null {
  try {
    const p = JSON.parse(readFileSync(pendingFile(), 'utf8')) as Pending;
    if (compareVersions(p.version, VERSION) <= 0 || !existsSync(p.file) || sha256File(p.file) !== p.sha256) {
      rmSync(pendingFile(), { force: true });
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

/** Runs a downloaded setup silently; it closes FreeCode, installs and starts the new version. */
export function runInstaller(p: Pending): void {
  rmSync(pendingFile(), { force: true });
  const child = spawn(p.file, ['/S', '/RELAUNCH'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
}

export class Updater {
  state: UpdateState;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private onChange: (s: UpdateState) => void) {
    const method = installMethod();
    this.state = { status: 'idle', current: VERSION, method, command: manualCommand(method) };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Checks shortly after start and then every 6 hours. */
  start(auto: () => boolean): void {
    const tick = () => void this.check(auto()).catch(() => undefined);
    setTimeout(tick, 15_000).unref();
    this.timer = setInterval(tick, 6 * 3600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(autoDownload: boolean): Promise<UpdateState> {
    if (this.busy) return this.state;
    this.busy = true;
    try {
      this.set({ status: 'checking', error: undefined });
      const latest = await fetchLatestRelease();
      if (!latest || !latest.version || compareVersions(latest.version, VERSION) <= 0) {
        this.set({ status: 'up-to-date', latest: latest ?? undefined, checkedAt: Date.now() });
        return this.state;
      }
      const pending = pendingUpdate();
      if (pending && pending.version === latest.version) {
        this.set({ status: 'ready', latest, checkedAt: Date.now() });
        return this.state;
      }
      this.set({ status: 'available', latest, checkedAt: Date.now() });
      if (autoDownload && this.state.method === 'installer' && latest.setupUrl) await this.download();
      return this.state;
    } catch (e) {
      debug('update', 'check failed', e);
      this.set({ status: 'error', error: (e as Error).message, checkedAt: Date.now() });
      return this.state;
    } finally {
      this.busy = false;
    }
  }

  /** Downloads and verifies the new setup. */
  async download(): Promise<void> {
    const latest = this.state.latest;
    if (!latest?.setupUrl) throw new Error('This release has no Windows setup to download.');
    this.set({ status: 'downloading', progress: 0 });
    try {
      let expected: string | undefined;
      if (latest.sumsUrl) {
        const sums = await (await fetch(latest.sumsUrl, { signal: AbortSignal.timeout(30_000) })).text();
        expected = sums
          .split('\n')
          .map((l) => l.trim().split(/\s+\*?/))
          .find((parts) => parts[1] === latest.setupName)?.[0]
          ?.toLowerCase();
      }
      if (!expected) throw new Error('The release has no checksum for the setup, so it was not installed.');
      const dir = path.join(os.tmpdir(), 'freecode-update');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, latest.setupName ?? `FreeCode-Setup-${latest.version}.exe`);
      const res = await fetch(latest.setupUrl, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length') ?? 0);
      const hash = createHash('sha256');
      const out = createWriteStream(file);
      let got = 0;
      let lastReport = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (total && Date.now() - lastReport > 300) {
          lastReport = Date.now();
          this.set({ progress: got / total });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      const actual = hash.digest('hex');
      if (actual !== expected) {
        rmSync(file, { force: true });
        throw new Error('The downloaded setup did not match its checksum, so it was deleted.');
      }
      mkdirSync(path.dirname(pendingFile()), { recursive: true });
      writeFileSync(pendingFile(), JSON.stringify({ version: latest.version, file, sha256: actual } satisfies Pending));
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.set({ status: 'error', error: (e as Error).message });
      throw e;
    }
  }

  /** Starts the verified setup. The caller should exit right after. */
  install(): boolean {
    const p = pendingUpdate();
    if (!p) return false;
    this.set({ status: 'installing' });
    runInstaller(p);
    return true;
  }
}

function manualCommand(method: InstallMethod): string | undefined {
  if (method === 'npm') return `npm install -g github:${UPDATE_REPO}`;
  if (method === 'git') return 'git pull && npm install';
  return undefined;
}

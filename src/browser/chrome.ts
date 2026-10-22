// Finds an installed Chromium-based browser (Edge ships with Windows) and starts it headless with
// a private profile, so it never touches the user's own browser data or open windows.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMac, isWindows, which } from '../util/platform.js';

function expandWin(p: string): string {
  return p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? '');
}

/** Playwright's Chromium (developer machines and CI). */
function playwrightChromium(): string | null {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean) as string[];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

export function findBrowser(): string | null {
  const override = process.env.FREECODE_BROWSER;
  if (override && existsSync(override)) return override;
  if (isWindows) {
    const known = [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe',
    ].map(expandWin);
    return known.find((p) => p && existsSync(p)) ?? which('msedge') ?? which('chrome') ?? playwrightChromium();
  }
  if (isMac) {
    const known = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return known.find((p) => existsSync(p)) ?? playwrightChromium();
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
    const p = which(name);
    if (p) return p;
  }
  return playwrightChromium();
}

export interface LaunchedBrowser {
  wsUrl: string;
  child: ChildProcess;
  profileDir: string;
  /** Kills the browser and deletes its temporary profile. */
  kill: () => void;
}

export async function launchBrowser(exe: string, timeoutMs = 25_000): Promise<LaunchedBrowser> {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'freecode-browser-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--window-size=1280,800',
  ];
  // Chromium refuses to start its sandbox as root (containers, CI).
  if (!isWindows && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const kill = () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    // The profile is still locked for a moment after the process exits.
    setTimeout(() => rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }), 1500).unref();
  };
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`The browser did not start within ${timeoutMs / 1000}s.${err ? ` Output: ${err.slice(-400)}` : ''}`)), timeoutMs);
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        err += chunk;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The browser exited during startup (code ${code}). ${err.slice(-400)}`));
      });
    });
    child.stderr!.removeAllListeners('data');
    child.stderr!.resume();
    return { wsUrl, child, profileDir, kill };
  } catch (e) {
    kill();
    throw e;
  }
}

// Opens the app in its own window (Chrome/Edge/Chromium "app mode") or the default browser.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isMac, isWindows, which } from '../util/platform.js';
import { freecodeHome } from '../config/paths.js';
import { openInBrowser } from '../ui/setup.js';

export function findAppBrowser(): string | null {
  const env = process.env.FREECODE_BROWSER;
  if (env && existsSync(env)) return env;
  const candidates: string[] = [];
  if (isWindows) {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (isMac) {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    );
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const p = which(name);
      if (p) candidates.push(p);
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

export interface LaunchResult {
  mode: 'app-window' | 'browser' | 'none';
  child?: ChildProcess;
}

/** Opens `url` in a standalone app window when possible. */
export function launchApp(url: string): LaunchResult {
  const hasDisplay = isWindows || isMac || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  if (!hasDisplay) return { mode: 'none' };
  const browser = findAppBrowser();
  if (browser) {
    try {
      const profile = path.join(freecodeHome(), 'app-window');
      const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1320,880', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'], {
        stdio: 'ignore',
        detached: false,
        windowsHide: false,
      });
      child.on('error', () => undefined);
      return { mode: 'app-window', child };
    } catch {
      // fall through
    }
  }
  return openInBrowser(url) ? { mode: 'browser' } : { mode: 'none' };
}

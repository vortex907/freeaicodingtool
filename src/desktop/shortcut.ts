// `freecode install-shortcut`: puts a FreeCode icon on the desktop and in the app menu, for
// installs made with npm or from a clone. (The Windows installer creates its own shortcuts.)
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { isMac, isWindows, which } from '../util/platform.js';

export interface ShortcutResult {
  created: string[];
  removed: string[];
  notes: string[];
}

/** Root of the installed package (the folder holding bin/, dist/, web/ and assets/). */
export function packageRoot(): string {
  // dist/src/desktop/shortcut.js -> package root is three levels up from dist/src/desktop
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Values reach PowerShell through environment variables, so paths never need quoting. */
const PS_LINK = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FC_LNK)
$s.TargetPath = $env:FC_TARGET
$s.Arguments = $env:FC_ARGS
$s.WorkingDirectory = $env:FC_WD
$s.IconLocation = $env:FC_ICON + ',0'
$s.WindowStyle = [int]$env:FC_STYLE
$s.Description = 'FreeCode - free AI coding agent'
$s.Save()`;

function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

async function windows(remove: boolean, r: ShortcutResult): Promise<void> {
  const folders = await run('powershell.exe', [...PS_ARGS, "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')"]);
  const [desktop, programs] = folders.split(/\r?\n/).map((s) => s.trim());
  const links = [desktop, programs].filter((d): d is string => !!d).map((d) => path.join(d, 'FreeCode.lnk'));
  if (remove) {
    for (const l of links) {
      if (existsSync(l)) {
        rmSync(l, { force: true });
        r.removed.push(l);
      }
    }
    return;
  }
  const root = packageRoot();
  const script = path.join(root, 'bin', 'freecode.js');
  // Installed with the Windows installer: point at its windowless launcher.
  const launcher = path.join(root, '..', 'FreeCode.exe');
  const useLauncher = existsSync(launcher);
  const env = {
    FC_TARGET: useLauncher ? launcher : process.execPath,
    FC_ARGS: useLauncher ? '' : [script, 'app', '--desktop', '--detach'].map(quoteArg).join(' '),
    FC_WD: os.homedir(),
    FC_ICON: path.join(root, 'assets', 'freecode.ico'),
    // node.exe is a console program: start it minimized; it hands off to a hidden process right away.
    FC_STYLE: useLauncher ? '1' : '7',
  };
  for (const l of links) {
    mkdirSync(path.dirname(l), { recursive: true });
    await run('powershell.exe', [...PS_ARGS, PS_LINK], { ...env, FC_LNK: l });
    r.created.push(l);
  }
}

function plist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>FreeCode</string>
  <key>CFBundleDisplayName</key><string>FreeCode</string>
  <key>CFBundleIdentifier</key><string>dev.freecode.app</string>
  <key>CFBundleExecutable</key><string>FreeCode</string>
  <key>CFBundleIconFile</key><string>FreeCode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function mac(remove: boolean, r: ShortcutResult): void {
  const app = path.join(os.homedir(), 'Applications', 'FreeCode.app');
  const desktopLink = path.join(os.homedir(), 'Desktop', 'FreeCode.app');
  if (remove) {
    for (const p of [desktopLink, app]) {
      if (existsSync(p) || isSymlink(p)) {
        rmSync(p, { recursive: true, force: true });
        r.removed.push(p);
      }
    }
    return;
  }
  const root = packageRoot();
  rmSync(app, { recursive: true, force: true });
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist());
  copyFileSync(path.join(root, 'assets', 'freecode.icns'), path.join(app, 'Contents', 'Resources', 'FreeCode.icns'));
  const exe = path.join(app, 'Contents', 'MacOS', 'FreeCode');
  writeFileSync(exe, `#!/bin/sh\n# Starts the FreeCode app window.\nexec ${shQuote(process.execPath)} ${shQuote(path.join(root, 'bin', 'freecode.js'))} app --desktop "$@" >/dev/null 2>&1\n`);
  chmodSync(exe, 0o755);
  r.created.push(app);
  if (existsSync(path.dirname(desktopLink))) {
    rmSync(desktopLink, { recursive: true, force: true });
    symlinkSync(app, desktopLink);
    r.created.push(desktopLink);
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function desktopEntryQuote(s: string): string {
  return `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
}

async function linux(remove: boolean, r: ShortcutResult): Promise<void> {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const menuEntry = path.join(dataHome, 'applications', 'freecode.desktop');
  let desktopDir = path.join(os.homedir(), 'Desktop');
  if (which('xdg-user-dir')) {
    try {
      desktopDir = (await run('xdg-user-dir', ['DESKTOP'])) || desktopDir;
    } catch {
      // keep ~/Desktop
    }
  }
  const desktopEntry = path.join(desktopDir, 'freecode.desktop');
  if (remove) {
    for (const p of [desktopEntry, menuEntry]) {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        r.removed.push(p);
      }
    }
    return;
  }
  const root = packageRoot();
  const exec = [process.execPath, path.join(root, 'bin', 'freecode.js')].map(desktopEntryQuote).join(' ');
  const entry = `[Desktop Entry]
Type=Application
Name=FreeCode
GenericName=AI Coding Agent
Comment=Free AI coding agent that pools free LLM providers
Exec=${exec} app --desktop %f
Icon=${path.join(root, 'assets', 'icon-512.png')}
Terminal=false
Categories=Development;IDE;
StartupNotify=false
`;
  mkdirSync(path.dirname(menuEntry), { recursive: true });
  writeFileSync(menuEntry, entry);
  chmodSync(menuEntry, 0o755);
  r.created.push(menuEntry);
  if (existsSync(desktopDir)) {
    writeFileSync(desktopEntry, entry);
    chmodSync(desktopEntry, 0o755);
    r.created.push(desktopEntry);
    // GNOME only starts desktop files that are marked trusted.
    if (which('gio')) await run('gio', ['set', desktopEntry, 'metadata::trusted', 'true']).catch(() => undefined);
    r.notes.push('If the desktop icon shows a warning, right-click it and choose "Allow Launching".');
  }
}

export async function installShortcuts(opts: { remove?: boolean } = {}): Promise<ShortcutResult> {
  const r: ShortcutResult = { created: [], removed: [], notes: [] };
  const remove = !!opts.remove;
  if (isWindows) await windows(remove, r);
  else if (isMac) mac(remove, r);
  else await linux(remove, r);
  return r;
}

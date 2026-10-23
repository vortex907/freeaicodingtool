// Debug logging to ~/.freecode/logs/debug.log (enabled with --debug or FREECODE_DEBUG=1).
import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let enabled = !!process.env.FREECODE_DEBUG;
let logFile = path.join(process.env.FREECODE_HOME || path.join(os.homedir(), '.freecode'), 'logs', 'debug.log');
let dirReady = false;

export function enableDebug(file?: string): void {
  enabled = true;
  if (file) logFile = file;
}

export function isDebug(): boolean {
  return enabled;
}

export function debugLogPath(): string {
  return logFile;
}

export function debug(scope: string, ...args: unknown[]): void {
  if (!enabled) return;
  try {
    if (!dirReady) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      dirReady = true;
    }
    const msg = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    appendFileSync(logFile, `${new Date().toISOString()} [${scope}] ${msg}\n`);
  } catch {
    // logging must never break the app
  }
}

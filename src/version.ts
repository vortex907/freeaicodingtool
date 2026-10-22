// Single source of truth for the version: package.json (shipped next to dist/).
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0';
}

export const VERSION = readVersion();
export const APP_NAME = 'FreeCode';

// Filesystem helpers.
import { promises as fsp, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(raw)) as T;
  } catch {
    return fallback;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(stripJsonComments(raw)) as T;
  } catch {
    return fallback;
  }
}

/** Writes JSON atomically (write temp file then rename). */
export function writeJsonSync(file: string, data: unknown, mode?: number): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  renameSync(tmp, file);
}

export async function writeJson(file: string, data: unknown, mode?: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  await fsp.rename(tmp, file);
}

/** Removes // and /* *\/ comments outside of strings so settings files may be JSONC. */
export function stripJsonComments(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const next = s[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // Allow trailing commas.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / len > 0.1;
}

export function fileExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function statSafe(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Formats a path relative to base when inside it, otherwise returns it as-is (with ~ for home). */
export function displayPath(p: string, base: string): string {
  const rel = path.relative(base, p);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function detectLineEnding(s: string): '\r\n' | '\n' {
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

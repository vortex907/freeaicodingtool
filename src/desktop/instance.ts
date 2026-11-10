// Registry of running app servers, so a second desktop launch opens a window on the running
// FreeCode instead of starting another one.
import * as http from 'node:http';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { freecodeHome } from '../config/paths.js';

export interface InstanceInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: number;
}

export interface LiveInstance extends InstanceInfo {
  projectRoot: string;
  busy: boolean;
}

function instancesDir(): string {
  return path.join(freecodeHome(), 'instances');
}

/** Records this server; the returned function removes the record again. */
export function registerInstance(info: InstanceInfo): () => void {
  const dir = instancesDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${info.pid}.json`);
  writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
}

export function instanceUrl(i: InstanceInfo): string {
  return `http://127.0.0.1:${i.port}/?t=${i.token}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Asks a server who it is. Uses node:http directly so no proxy settings get in the way. */
function probe(i: InstanceInfo): Promise<{ projectRoot: string; busy: boolean } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: i.port, path: '/api/instance', headers: { 'x-freecode-token': i.token }, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const j = JSON.parse(body) as { pid?: number; projectRoot?: string; busy?: boolean };
          resolve(j.pid === i.pid && typeof j.projectRoot === 'string' ? { projectRoot: j.projectRoot, busy: !!j.busy } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Running instances that answer, newest first. Records of dead servers are cleaned up. */
export async function liveInstances(): Promise<LiveInstance[]> {
  const dir = instancesDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const found: LiveInstance[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let info: InstanceInfo;
    try {
      info = JSON.parse(readFileSync(file, 'utf8')) as InstanceInfo;
    } catch {
      continue;
    }
    const answer = pidAlive(info.pid) ? await probe(info) : null;
    if (answer) {
      found.push({ ...info, ...answer });
      continue;
    }
    // Dead, or the pid now belongs to something else. Leave very fresh records alone: that server may still be starting.
    if (!pidAlive(info.pid) || Date.now() - info.startedAt > 60_000) {
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

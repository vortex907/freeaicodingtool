// Session persistence (~/.freecode/projects/<project>/<id>.json) and prompt history.
import { promises as fsp, appendFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, Usage } from '../providers/types.js';
import type { PermissionMode } from '../config/config.js';
import type { Todo } from '../tools/types.js';
import { globalPaths, projectSlug } from '../config/paths.js';
import { ensureDirSync, writeJson } from '../util/fs.js';
import { randomId } from '../util/strings.js';

export interface SavedSession {
  version: 1;
  id: string;
  projectRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  todos: Todo[];
  modelKey?: string;
  usage: Usage;
  requests: number;
  permissionMode?: PermissionMode;
}

export function newSessionId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${stamp}-${randomId(6)}`;
}

function sessionDir(projectRoot: string): string {
  return path.join(globalPaths.projectsDir, projectSlug(projectRoot));
}

export function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && !m.meta?.synthetic);
  return (first?.content ?? 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
}

export async function saveSession(s: SavedSession): Promise<void> {
  const dir = sessionDir(s.projectRoot);
  const messages = s.messages.map((m) => (m.images?.length ? { ...m, images: undefined, content: `${m.content}\n[${m.images.length} image(s) not saved]` } : m));
  await writeJson(path.join(dir, `${s.id}.json`), { ...s, messages });
}

export async function loadSession(projectRoot: string, id: string): Promise<SavedSession | null> {
  const dir = sessionDir(projectRoot);
  try {
    const raw = await fsp.readFile(path.join(dir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as SavedSession;
  } catch {
    // allow prefix match
    try {
      const files = await fsp.readdir(dir);
      const hit = files.find((f) => f.startsWith(id) || f.includes(id));
      if (hit) return JSON.parse(await fsp.readFile(path.join(dir, hit), 'utf8')) as SavedSession;
    } catch {
      // none
    }
    return null;
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messages: number;
}

export async function listSessions(projectRoot: string, limit = 30): Promise<SessionSummary[]> {
  const dir = sessionDir(projectRoot);
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await fsp.stat(path.join(dir, f));
        return { f, mtime: st.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const { f } of stats.slice(0, limit)) {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as SavedSession;
      out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, messages: s.messages.filter((m) => m.role === 'user' && !m.meta?.synthetic).length });
    } catch {
      // skip broken
    }
  }
  return out;
}

export async function latestSession(projectRoot: string): Promise<SavedSession | null> {
  const list = await listSessions(projectRoot, 1);
  return list[0] ? loadSession(projectRoot, list[0].id) : null;
}

// ------------------------------------------------------------------ prompt history

export function appendHistory(text: string, projectRoot: string): void {
  try {
    ensureDirSync(globalPaths.home);
    appendFileSync(globalPaths.historyFile, JSON.stringify({ ts: Date.now(), project: projectRoot, text }) + '\n');
  } catch {
    // history is optional
  }
}

export function loadHistory(projectRoot: string, limit = 500): string[] {
  try {
    const lines = readFileSync(globalPaths.historyFile, 'utf8').split('\n').filter(Boolean).slice(-5000);
    const entries = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { project: string; text: string };
        } catch {
          return null;
        }
      })
      .filter((e): e is { project: string; text: string } => !!e);
    const project = entries.filter((e) => e.project === projectRoot).map((e) => e.text);
    const other = entries.filter((e) => e.project !== projectRoot).map((e) => e.text);
    const merged = [...other.slice(-100), ...project];
    const dedup: string[] = [];
    for (const t of merged) {
      if (dedup[dedup.length - 1] !== t) dedup.push(t);
    }
    return dedup.slice(-limit);
  } catch {
    return [];
  }
}

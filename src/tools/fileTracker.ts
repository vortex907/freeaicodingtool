// Tracks which files the agent has read (to catch stale edits) and snapshots files before the agent
// changes them so /undo can restore them.
import { promises as fsp, statSync } from 'node:fs';
import * as path from 'node:path';

interface ReadRecord {
  mtimeMs: number;
  size: number;
  at: number;
}

interface Snapshot {
  /** null = the file did not exist */
  before: string | null;
  path: string;
}

export interface TurnChanges {
  turn: number;
  files: Snapshot[];
}

export class FileTracker {
  private reads = new Map<string, ReadRecord>();
  private turns: TurnChanges[] = [];
  private currentTurn = 0;
  /** Files changed in this session (abs path -> original content) for /diff. */
  private originals = new Map<string, string | null>();
  maxTurnsKept = 50;

  constructor(public checkpoints = true) {}

  beginTurn(turn: number): void {
    this.currentTurn = turn;
  }

  recordRead(absPath: string): void {
    try {
      const st = statSync(absPath);
      this.reads.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now() });
    } catch {
      // ignore
    }
  }

  wasRead(absPath: string): boolean {
    return this.reads.has(absPath);
  }

  /** True when the file changed on disk after the agent last read it. */
  isStale(absPath: string): boolean {
    const r = this.reads.get(absPath);
    if (!r) return false;
    try {
      const st = statSync(absPath);
      return st.mtimeMs !== r.mtimeMs || st.size !== r.size;
    } catch {
      return false;
    }
  }

  /** Call after the agent wrote a file so it is considered fresh. */
  recordWrite(absPath: string): void {
    this.recordRead(absPath);
  }

  /** Snapshot a file's content before the first modification in the current turn. */
  async snapshot(absPath: string): Promise<void> {
    let content: string | null;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      content = null;
    }
    if (!this.originals.has(absPath)) this.originals.set(absPath, content);
    if (!this.checkpoints) return;
    let t = this.turns[this.turns.length - 1];
    if (!t || t.turn !== this.currentTurn) {
      t = { turn: this.currentTurn, files: [] };
      this.turns.push(t);
      if (this.turns.length > this.maxTurnsKept) this.turns.shift();
    }
    if (t.files.some((f) => f.path === absPath)) return;
    t.files.push({ path: absPath, before: content });
  }

  hasUndo(): boolean {
    return this.turns.length > 0;
  }

  lastChangedTurn(): TurnChanges | undefined {
    return this.turns[this.turns.length - 1];
  }

  /** Restores the files changed in the most recent turn that changed files. */
  async undoLast(): Promise<{ restored: string[]; deleted: string[]; turn: number } | null> {
    const t = this.turns.pop();
    if (!t) return null;
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const f of [...t.files].reverse()) {
      if (f.before === null) {
        try {
          await fsp.unlink(f.path);
          deleted.push(f.path);
        } catch {
          // already gone
        }
      } else {
        await fsp.mkdir(path.dirname(f.path), { recursive: true });
        await fsp.writeFile(f.path, f.before, 'utf8');
        restored.push(f.path);
      }
      this.reads.delete(f.path);
    }
    return { restored, deleted, turn: t.turn };
  }

  /** Files modified during this session with their original content. */
  sessionChanges(): Map<string, string | null> {
    return this.originals;
  }

  reset(): void {
    this.reads.clear();
  }
}

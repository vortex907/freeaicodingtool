// Project memory / instruction files: AGENTS.md (standard), FREECODE.md, CLAUDE.md (compatibility).
import { promises as fsp, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { globalPaths } from '../config/paths.js';

export const MEMORY_FILENAMES = ['AGENTS.md', 'FREECODE.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];
const MAX_TOTAL = 24_000;
const MAX_FILE = 12_000;

export interface MemoryFile {
  path: string;
  content: string;
  scope: 'global' | 'project';
}

/** Loads instruction files from the global dir and from every folder between the project root and cwd. */
export async function loadMemoryFiles(projectRoot: string, cwd: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];
  const read = async (p: string, scope: MemoryFile['scope']) => {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) return;
      let content = await fsp.readFile(p, 'utf8');
      if (content.length > MAX_FILE) content = content.slice(0, MAX_FILE) + '\n[... file truncated ...]';
      if (content.trim()) files.push({ path: p, content: content.trim(), scope });
    } catch {
      // missing
    }
  };
  await read(globalPaths.memoryFile, 'global');
  await read(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'global');
  // Folders from the project root down to cwd (and parents of the root up to home, for monorepos).
  const dirs: string[] = [];
  const home = os.homedir();
  let d = path.resolve(projectRoot);
  const above: string[] = [];
  let parent = path.dirname(d);
  while (parent !== d && parent.startsWith(home) && parent !== home) {
    above.unshift(parent);
    d = parent;
    parent = path.dirname(d);
  }
  dirs.push(...above);
  const rel = path.relative(projectRoot, cwd);
  dirs.push(projectRoot);
  if (rel && !rel.startsWith('..')) {
    let cur = projectRoot;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      dirs.push(cur);
    }
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of MEMORY_FILENAMES) {
      const p = path.join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      if (existsSync(p)) await read(p, 'project');
    }
    const nested = path.join(dir, '.freecode', 'AGENTS.md');
    if (existsSync(nested)) await read(nested, 'project');
  }
  // Enforce the total budget (keep the most specific = last files).
  let total = 0;
  const kept: MemoryFile[] = [];
  for (const f of [...files].reverse()) {
    if (total + f.content.length > MAX_TOTAL) continue;
    total += f.content.length;
    kept.unshift(f);
  }
  return kept;
}

/** Appends a note to a memory file (creating it if needed). */
export async function appendMemory(file: string, note: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    existing = '';
  }
  const line = note.trim().startsWith('-') ? note.trim() : `- ${note.trim()}`;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  const header = existing ? '' : '# Project notes for AI agents\n\n';
  await fsp.writeFile(file, `${existing}${sep}${header}${line}\n`, 'utf8');
}

// @file mentions in prompts: attach file contents (or folder listings / images) to the message.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ImageAttachment } from '../providers/types.js';
import type { FileTracker } from '../tools/fileTracker.js';
import { isBinaryBuffer } from '../util/fs.js';
import { formatWithLineNumbers } from '../tools/fileTools.js';
import { listFiles } from '../tools/listFiles.js';
import { fuzzyScore } from '../util/strings.js';
import type { CompletionItem } from './inputEditor.js';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MENTION_RE = /(^|\s)@((?:\\ |[^\s"'`])+)/g;

export interface Attachment {
  path: string;
  kind: 'file' | 'dir' | 'image';
  lines?: number;
}

export async function expandMentions(text: string, cwd: string, files: FileTracker): Promise<{ content: string; images: ImageAttachment[]; attached: Attachment[] }> {
  const attached: Attachment[] = [];
  const images: ImageAttachment[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    let raw = m[2]!.replace(/\\ /g, ' ');
    raw = raw.replace(/[,.;:!?)\]]+$/, '');
    if (!raw) continue;
    // Support @path:10-20 line ranges
    const range = /^(.*?):(\d+)(?:-(\d+))?$/.exec(raw);
    const p = range ? range[1]! : raw;
    const abs = path.resolve(cwd, p);
    if (seen.has(abs + (range?.[0] ?? ''))) continue;
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      continue;
    }
    seen.add(abs + (range?.[0] ?? ''));
    const rel = path.relative(cwd, abs) || '.';
    if (st.isDirectory()) {
      const entries = (await fsp.readdir(abs, { withFileTypes: true })).slice(0, 200).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      blocks.push(`<attached-folder path="${rel}">\n${entries.join('\n')}\n</attached-folder>`);
      attached.push({ path: rel, kind: 'dir' });
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (st.size > 5 * 1024 * 1024) continue;
      const data = (await fsp.readFile(abs)).toString('base64');
      images.push({ mediaType: IMAGE_TYPES[ext]!, data });
      attached.push({ path: rel, kind: 'image' });
      continue;
    }
    if (st.size > 2 * 1024 * 1024) {
      blocks.push(`<attached-file path="${rel}">(file too large to attach: ${st.size} bytes; use Read with offset/limit)</attached-file>`);
      continue;
    }
    const buf = await fsp.readFile(abs);
    if (isBinaryBuffer(buf)) continue;
    let lines = buf.toString('utf8').split(/\r?\n/);
    let start = 1;
    if (range) {
      start = Math.max(1, Number(range[2]));
      const end = range[3] ? Number(range[3]) : start;
      lines = lines.slice(start - 1, end);
    } else if (lines.length > 2000) lines = lines.slice(0, 2000);
    let body = formatWithLineNumbers(lines, start);
    if (total + body.length > 200_000) body = body.slice(0, Math.max(0, 200_000 - total)) + '\n[... truncated ...]';
    total += body.length;
    blocks.push(`<attached-file path="${rel}">\n${body}\n</attached-file>`);
    files.recordRead(abs);
    attached.push({ path: rel, kind: 'file', lines: lines.length });
  }
  const content = blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text;
  return { content, images, attached };
}

/** Completion items for an @mention, from a (cached) project file list. */
export function mentionCompletions(query: string, files: string[]): CompletionItem[] {
  const dirs = new Set<string>();
  for (const f of files.slice(0, 20000)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  const all = [...dirs, ...files];
  const scored = query
    ? all.map((f) => ({ f, s: fuzzyScore(query, f) })).filter((x) => x.s > -1).sort((a, b) => b.s - a.s)
    : all.filter((f) => !f.includes('/') || (f.endsWith('/') && f.split('/').length === 2)).map((f) => ({ f, s: 0 }));
  return scored.slice(0, 12).map(({ f }) => ({ label: f, insert: `@${f.replace(/ /g, '\\ ')}${f.endsWith('/') ? '' : ' '}`, description: f.endsWith('/') ? 'folder' : '' }));
}

export async function projectFileList(cwd: string): Promise<string[]> {
  try {
    return await listFiles(cwd);
  } catch {
    return [];
  }
}

// Read, Write, Edit and MultiEdit tools.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { DiffHunk, PreparedCall, Tool, ToolContext, ToolResult } from './types.js';
import { boolParam, errorResult, fail, numParam, ok, strParam } from './types.js';
import { applyEdit, type EditOutcome } from './editMatch.js';
import { buildHunks, diffStats } from './diff.js';
import { isInProject, listFiles, resolvePath } from './listFiles.js';
import { IMAGE_MEDIA_TYPES, imageSize, sniffImage } from './images.js';
import { pageRangeText, readPdf } from './pdf.js';
import { saveScreenshot } from '../browser/browser.js';
import { displayPath, formatBytes, isBinaryBuffer } from '../util/fs.js';
import { fuzzyScore } from '../util/strings.js';
import { warmUpLanguageServer } from '../lsp/index.js';

const MAX_READ_BYTES = 20 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 40_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Images Read sends to the model; the other image formats are refused. */
const VIEWABLE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OTHER_IMAGE_EXT = new Set(['.bmp', '.ico', '.svgz', '.tif', '.tiff', '.heic', '.heif', '.avif', '.psd']);
const BINARY_EXT = new Set(['.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.o', '.a', '.wasm', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db', '.bin']);

function pathParam(input: Record<string, unknown>): string | undefined {
  return strParam(input, 'file_path', 'path', 'filePath', 'filename', 'file', 'target_file');
}

async function suggestSimilar(abs: string, ctx: ToolContext): Promise<string> {
  try {
    const files = await listFiles(ctx.projectRoot);
    const base = path.basename(abs);
    const scored = files
      .map((f) => ({ f, s: fuzzyScore(base, f) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5);
    if (!scored.length) return '';
    return `\nDid you mean one of these?\n${scored.map((x) => `  ${x.f}`).join('\n')}`;
  } catch {
    return '';
  }
}

export function formatWithLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((l, i) => {
      const t = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + ' [line truncated]' : l;
      return `${String(startLine + i).padStart(6)}\t${t}`;
    })
    .join('\n');
}

/** A notebook as text: one "# %% [type] cell N" header per cell (with its id when it has one), then source and outputs. */
export function renderNotebook(raw: string): string {
  try {
    const nb = JSON.parse(raw) as { cells?: { cell_type: string; id?: string; source: string | string[]; outputs?: { text?: string | string[]; data?: Record<string, unknown> }[] }[] };
    const out: string[] = [];
    (nb.cells ?? []).forEach((cell, i) => {
      const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
      out.push(`# %% [${cell.cell_type}] cell ${i + 1}${typeof cell.id === 'string' && cell.id ? ` (id ${cell.id})` : ''}`);
      out.push(src);
      for (const o of cell.outputs ?? []) {
        const text = o.text ?? (o.data?.['text/plain'] as string | string[] | undefined);
        if (text) out.push(`# output:\n${(Array.isArray(text) ? text.join('') : text).slice(0, 2000)}`);
      }
      out.push('');
    });
    return out.join('\n');
  } catch {
    return raw;
  }
}

/** Images go to the model as an image part; models without vision only get the one-line description. */
async function readImage(abs: string, size: number, ctx: ToolContext, data?: Buffer): Promise<ToolResult> {
  const rel = displayPath(abs, ctx.session.cwd);
  if (size > MAX_IMAGE_BYTES) return fail(`${rel} is ${formatBytes(size)}. Read sends images of up to 5 MB; make a smaller copy (scale it down or save it as JPEG) and read that.`);
  const buf = data ?? (await fsp.readFile(abs));
  const format = sniffImage(buf);
  if (!format) return fail(`${rel} is not a valid PNG, JPEG, GIF or WebP image (its first bytes do not match any of them).`);
  const dims = imageSize(buf, format);
  const desc = `${format.toUpperCase()}${dims ? `, ${dims.width}x${dims.height}` : ''}, ${formatBytes(size)}`;
  ctx.files.recordRead(abs);
  let name: string | null = null;
  try {
    name = saveScreenshot(buf, format === 'jpeg' ? 'jpg' : format);
  } catch {
    // The copy only feeds the preview in the app.
  }
  return {
    content: `Image ${rel} (${desc}). It is attached for models that can see images; a model without vision gets only this description.`,
    images: [{ mediaType: IMAGE_MEDIA_TYPES[format], data: buf.toString('base64') }],
    display: name ? { kind: 'image', name, summary: desc } : { kind: 'summary', text: `Image (${desc})` },
  };
}

/** PDF text page by page (pdftotext when installed, else the built-in reader). */
async function readPdfFile(abs: string, input: Record<string, unknown>, ctx: ToolContext, data?: Buffer): Promise<ToolResult> {
  const rel = displayPath(abs, ctx.session.cwd);
  const buf = data ?? (await fsp.readFile(abs));
  const r = await readPdf(abs, buf, strParam(input, 'pages', 'page', 'page_range'), MAX_READ_CHARS);
  if (typeof r === 'string') return fail(`${rel}: ${r}`);
  ctx.files.recordRead(abs);
  const count = `${r.total} page${r.total === 1 ? '' : 's'}`;
  if (r.noText) {
    const why =
      r.noText === 'scanned'
        ? 'the pages are scanned images without a text layer. Run OCR on it (for example ocrmypdf or tesseract) or ask the user for a text version.'
        : r.noText === 'fonts'
          ? 'its fonts have no Unicode mapping, so the built-in reader cannot decode the text. Install pdftotext (poppler-utils) and read it again.'
          : 'the selected pages contain no text.';
    return ok(`${rel} is a PDF with ${count}, but no text could be extracted: ${why}`, { kind: 'summary', text: r.noText === 'scanned' ? 'Scanned PDF without text' : 'No text found in the PDF' });
  }
  const shown = r.pages.map((p) => p.number);
  const body = r.pages.map((p) => `--- Page ${p.number} ---\n${p.text || '(no text on this page)'}`).join('\n\n');
  let note = '';
  if (r.remaining.length) {
    const next = pageRangeText(r.remaining.slice(0, Math.max(1, shown.length))).replace(/, /g, ',');
    note = `\n\n<system-note>Showing page${shown.length === 1 ? '' : 's'} ${pageRangeText(shown)} of ${r.total} (output size limit). Use pages="${next}" to read more.</system-note>`;
  }
  const summary = shown.length === r.total ? `Read ${count} of PDF text` : `Read page${shown.length === 1 ? '' : 's'} ${pageRangeText(shown)} of ${r.total}`;
  return ok(`PDF ${rel}, ${count}:\n\n${body}${note}`, { kind: 'summary', text: summary });
}

export const ReadTool: Tool = {
  name: 'Read',
  category: 'read',
  parallelSafe: true,
  planSafe: true,
  description:
    'Read a file from the local filesystem. Text files come back with lines prefixed with line numbers (like `cat -n`); the prefix is NOT part of the file. ' +
    'By default reads up to 2000 lines from the start; use offset (1-based line) and limit for large files. ' +
    'Images (PNG, JPEG, GIF, WebP up to 5 MB) are shown to models that can see images. PDFs return their text page by page; use pages (e.g. "1-5") for long ones. ' +
    'Always read a file before editing it. You can call Read on several files in parallel.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file (absolute or relative to the working directory)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based). Optional.' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Optional.' },
      pages: { type: 'string', description: 'PDF files only: pages to read, e.g. "3", "1-5" or "2,4-6". Optional.' },
    },
    required: ['file_path'],
  },
  label: (input, ctx) => {
    const p = pathParam(input) ?? '?';
    const abs = resolvePath(p, ctx.cwd);
    const off = numParam(input, 'offset');
    const pages = strParam(input, 'pages', 'page');
    return `Read(${displayPath(abs, ctx.cwd)}${off ? `:${off}` : ''}${pages ? `, pages ${pages}` : ''})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const p = pathParam(input);
    if (!p) return errorResult('Missing required parameter: file_path');
    const abs = resolvePath(p, ctx.session.cwd);
    return {
      execute: async (): Promise<ToolResult> => {
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          return fail(`File not found: ${abs}${await suggestSimilar(abs, ctx)}`);
        }
        if (st.isDirectory()) return fail(`${abs} is a directory, not a file. Use LS or Glob to list its contents.`);
        const ext = path.extname(abs).toLowerCase();
        if (VIEWABLE_IMAGE_EXT.has(ext)) return readImage(abs, st.size, ctx);
        if (OTHER_IMAGE_EXT.has(ext)) return fail(`${abs} is an image in ${ext.slice(1).toUpperCase()} format (${formatBytes(st.size)}). Read shows PNG, JPEG, GIF and WebP images; convert it to one of those first.`);
        if (ext === '.pdf') return readPdfFile(abs, input, ctx);
        if (BINARY_EXT.has(ext)) return fail(`${abs} is a binary file (${formatBytes(st.size)}) and cannot be read as text.`);
        let offset = Math.max(1, Math.floor(numParam(input, 'offset', 'start_line', 'line') ?? 1));
        const limitRaw = numParam(input, 'limit', 'lines', 'num_lines');
        let limit = Math.max(1, Math.floor(limitRaw ?? DEFAULT_READ_LINES));
        const end = numParam(input, 'end_line');
        if (end && !limitRaw) limit = Math.max(1, end - offset + 1);
        if (st.size > MAX_READ_BYTES && offset === 1 && !limitRaw) {
          return fail(`File is too large to read at once (${formatBytes(st.size)}). Use offset and limit to read part of it, or Grep to search it.`);
        }
        // Re-reading the same unchanged lines moments later only costs tokens: point back to them instead.
        const range = `${offset}:${limitRaw ?? ''}:${end ?? ''}`;
        const seq = ctx.session.toolSeq ?? 0;
        if (ctx.files.shownRecently(abs, range, seq)) {
          return ok(`<system-note>${abs} has not changed since you read these lines a few steps ago; that result is still above. Use it instead of reading again.</system-note>`, { kind: 'summary', text: 'Unchanged since the last read' });
        }
        const buf = await fsp.readFile(abs);
        if (isBinaryBuffer(buf)) {
          // Images and PDFs with an unusual name still get read as what they are.
          if (sniffImage(buf)) return readImage(abs, st.size, ctx, buf);
          if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return readPdfFile(abs, input, ctx, buf);
          return fail(`${abs} appears to be a binary file and cannot be read as text.`);
        }
        let text = buf.toString('utf8');
        if (ext === '.ipynb') text = renderNotebook(text);
        ctx.files.recordRead(abs);
        ctx.files.recordView(abs, range, seq);
        // Files are read before they are edited: start the language server now so the edit is checked at once.
        warmUpLanguageServer(abs, ctx.projectRoot, (req) => ctx.services.permit?.(req).action === 'allow');
        if (!text.length) return ok(`<system-note>The file ${abs} exists but is empty.</system-note>`, { kind: 'summary', text: 'Read 0 lines (empty file)' });
        const allLines = text.split(/\r?\n/);
        if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();
        const total = allLines.length;
        if (offset > total) return fail(`offset ${offset} is beyond the end of the file (${total} lines).`);
        let slice = allLines.slice(offset - 1, offset - 1 + limit);
        let body = formatWithLineNumbers(slice, offset);
        let truncatedByChars = false;
        if (body.length > MAX_READ_CHARS) {
          let acc = 0;
          let n = 0;
          for (const l of slice) {
            acc += l.length + 8;
            if (acc > MAX_READ_CHARS) break;
            n++;
          }
          slice = slice.slice(0, Math.max(1, n));
          body = formatWithLineNumbers(slice, offset);
          truncatedByChars = true;
        }
        const lastShown = offset + slice.length - 1;
        let note = '';
        if (lastShown < total) {
          note = `\n\n<system-note>Showing lines ${offset}-${lastShown} of ${total}${truncatedByChars ? ' (output size limit)' : ''}. Use offset=${lastShown + 1} to continue reading.</system-note>`;
        }
        const summary = offset === 1 && lastShown >= total ? `Read ${total} line${total === 1 ? '' : 's'}` : `Read lines ${offset}-${lastShown} of ${total}`;
        return ok(body + note, { kind: 'summary', text: summary });
      },
    };
  },
};

export async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

export function diffDisplay(abs: string, cwd: string, before: string, after: string, created: boolean) {
  const hunks: DiffHunk[] = buildHunks(before, after);
  const { added, removed } = diffStats(hunks);
  return { kind: 'diff' as const, path: displayPath(abs, cwd), hunks, added, removed, created };
}

export function outsideWarning(abs: string, ctx: ToolContext): string | undefined {
  return isInProject(abs, ctx.projectRoot, ctx.settings.permissions.additionalDirectories) ? undefined : 'This file is outside the project folder.';
}

/** Snippet of the file around the edited lines, returned to the model so it can verify the edit. */
function snippetAround(content: string, firstLine: number, lastLine: number): string {
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, firstLine - 3);
  const to = Math.min(lines.length, lastLine + 3);
  if (to - from > 60) return formatWithLineNumbers(lines.slice(from - 1, from + 29), from) + '\n   ...';
  return formatWithLineNumbers(lines.slice(from - 1, to), from);
}

export const WriteTool: Tool = {
  name: 'Write',
  category: 'edit',
  description:
    'Create a new file or completely overwrite an existing one with the given content. ' +
    'Prefer Edit for changing existing files. If the file already exists you must Read it first. Parent folders are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'The full content of the file' },
    },
    required: ['file_path', 'content'],
  },
  label: (input, ctx) => `Write(${displayPath(resolvePath(pathParam(input) ?? '?', ctx.cwd), ctx.cwd)})`,
  async prepare(input, ctx): Promise<PreparedCall> {
    const p = pathParam(input);
    if (!p) return errorResult('Missing required parameter: file_path');
    let content = strParam(input, 'content', 'text', 'contents', 'code', 'data');
    if (content === undefined) return errorResult('Missing required parameter: content');
    const abs = resolvePath(p, ctx.session.cwd);
    const before = await readIfExists(abs);
    if (before !== null && !ctx.files.wasRead(abs) && before.trim().length > 0) {
      return errorResult(`${displayPath(abs, ctx.session.cwd)} already exists. Read it first before overwriting it (or use Edit to change part of it).`);
    }
    if (before !== null && ctx.files.isStale(abs)) {
      return errorResult(`${displayPath(abs, ctx.session.cwd)} was modified since you last read it. Read it again before writing.`);
    }
    if (before !== null && before.includes('\r\n') && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
    const display = diffDisplay(abs, ctx.session.cwd, before ?? '', content, before === null);
    return {
      permission: {
        tool: 'Write',
        category: 'edit',
        title: before === null ? 'Create file' : 'Overwrite file',
        subject: displayPath(abs, ctx.projectRoot),
        path: abs,
        preview: display,
        danger: outsideWarning(abs, ctx),
      },
      execute: async () => {
        await ctx.files.snapshot(abs);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content!, 'utf8');
        ctx.files.recordWrite(abs);
        const lines = content!.split('\n').length;
        const rel = displayPath(abs, ctx.session.cwd);
        return ok(before === null ? `Created ${rel} (${lines} lines).` : `Overwrote ${rel} (${lines} lines).`, display);
      },
    };
  },
};

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function editSpec(raw: Record<string, unknown>): EditSpec | string {
  const old_string = strParam(raw, 'old_string', 'old_str', 'oldString', 'old', 'search', 'find', 'old_text', 'original');
  const new_string = strParam(raw, 'new_string', 'new_str', 'newString', 'new', 'replace', 'replacement', 'new_text', 'updated');
  if (old_string === undefined) return 'Missing required parameter: old_string';
  if (new_string === undefined) return 'Missing required parameter: new_string';
  return { old_string, new_string, replace_all: boolParam(raw, 'replace_all', 'replaceAll', 'all') ?? false };
}

async function prepareEdits(abs: string, edits: EditSpec[], ctx: ToolContext, toolName: string): Promise<PreparedCall> {
  const rel = displayPath(abs, ctx.session.cwd);
  const before = await readIfExists(abs);
  if (before === null) {
    // Creating a file with an empty old_string is allowed.
    if (edits.length === 1 && edits[0]!.old_string === '') {
      const content = edits[0]!.new_string;
      const display = diffDisplay(abs, ctx.session.cwd, '', content, true);
      return {
        permission: { tool: toolName, category: 'edit', title: 'Create file', subject: displayPath(abs, ctx.projectRoot), path: abs, preview: display, danger: outsideWarning(abs, ctx) },
        execute: async () => {
          await ctx.files.snapshot(abs);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, content, 'utf8');
          ctx.files.recordWrite(abs);
          return ok(`Created ${rel}.`, display);
        },
      };
    }
    return errorResult(`File not found: ${abs}. To create a new file use the Write tool.${await suggestSimilar(abs, ctx)}`);
  }
  if (ctx.files.isStale(abs)) {
    return errorResult(`${rel} was modified (by the user or another process) since you last read it. Read it again, then retry the edit.`);
  }
  let content = before;
  const notes: string[] = [];
  let first = Infinity;
  let last = 0;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const res: EditOutcome = applyEdit(content, e.old_string, e.new_string, e.replace_all);
    if (!res.ok) {
      const which = edits.length > 1 ? `Edit #${i + 1} of ${edits.length} failed (no changes were applied): ` : '';
      return errorResult(which + res.error);
    }
    content = res.content;
    first = Math.min(first, res.firstLine);
    last = Math.max(last, res.lastLine);
    if (res.strategy !== 'exact') notes.push(`edit ${edits.length > 1 ? `#${i + 1} ` : ''}matched after normalizing ${res.strategy.replace('-', ' ')}`);
    if (res.count > 1) notes.push(`replaced ${res.count} occurrences`);
  }
  if (content === before) return errorResult('The edit produced no change to the file.');
  const display = diffDisplay(abs, ctx.session.cwd, before, content, false);
  const finalContent = content;
  return {
    permission: { tool: toolName, category: 'edit', title: 'Edit file', subject: displayPath(abs, ctx.projectRoot), path: abs, preview: display, danger: outsideWarning(abs, ctx) },
    execute: async () => {
      // Guard against concurrent modification between preview and write.
      const now = await readIfExists(abs);
      if (now !== before) return fail(`${rel} changed while waiting for approval. Read it again and redo the edit.`);
      await ctx.files.snapshot(abs);
      await fsp.writeFile(abs, finalContent, 'utf8');
      ctx.files.recordWrite(abs);
      const noteText = notes.length ? ` (${notes.join('; ')})` : '';
      const snippet = snippetAround(finalContent, first, last);
      return ok(`Edited ${rel}${noteText}. Updated section:\n${snippet}`, display);
    },
  };
}

export const EditTool: Tool = {
  name: 'Edit',
  category: 'edit',
  description:
    'Replace text in a file. old_string must match the current file content exactly (whitespace and indentation included, without the line-number prefixes shown by Read) ' +
    'and must be unique in the file unless replace_all is true. Include 2-3 surrounding lines to make it unique. ' +
    'Read the file before editing. To create a new file use Write (or Edit with an empty old_string).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text (must differ from old_string)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  label: (input, ctx) => `Update(${displayPath(resolvePath(pathParam(input) ?? '?', ctx.cwd), ctx.cwd)})`,
  async prepare(input, ctx) {
    const p = pathParam(input);
    if (!p) return errorResult('Missing required parameter: file_path');
    const spec = editSpec(input);
    if (typeof spec === 'string') return errorResult(spec);
    return prepareEdits(resolvePath(p, ctx.session.cwd), [spec], ctx, 'Edit');
  },
};

export const MultiEditTool: Tool = {
  name: 'MultiEdit',
  category: 'edit',
  description:
    'Make several replacements in ONE file in a single step. Edits are applied in order, each to the result of the previous one; ' +
    'either all succeed or none are applied. Same matching rules as Edit.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify' },
      edits: {
        type: 'array',
        description: 'List of edits to apply in order',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to replace' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  label: (input, ctx) => `Update(${displayPath(resolvePath(pathParam(input) ?? '?', ctx.cwd), ctx.cwd)})`,
  async prepare(input, ctx) {
    const p = pathParam(input);
    if (!p) return errorResult('Missing required parameter: file_path');
    let raw = input.edits ?? input.changes ?? input.replacements;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return errorResult('edits must be an array of {old_string, new_string} objects');
      }
    }
    if (!Array.isArray(raw) || !raw.length) return errorResult('edits must be a non-empty array of {old_string, new_string} objects');
    const specs: EditSpec[] = [];
    for (const r of raw) {
      const s = editSpec((r ?? {}) as Record<string, unknown>);
      if (typeof s === 'string') return errorResult(s);
      specs.push(s);
    }
    return prepareEdits(resolvePath(p, ctx.session.cwd), specs, ctx, 'MultiEdit');
  },
};

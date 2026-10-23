// NotebookEdit: replace, insert or delete one cell of a Jupyter notebook (.ipynb). The rest of the file is
// written back the way it was (indentation, key order, nbformat fields, the other cells).
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PreparedCall, Tool } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { diffDisplay, outsideWarning, readIfExists, renderNotebook } from './fileTools.js';
import { resolvePath } from './listFiles.js';
import { displayPath } from '../util/fs.js';

const MODES = ['replace', 'insert', 'delete'] as const;
type Mode = (typeof MODES)[number];
type CellType = 'code' | 'markdown';

type Cell = Record<string, unknown> & { cell_type?: string; id?: unknown; source?: string | string[]; outputs?: unknown; execution_count?: unknown };

interface Notebook {
  cells: Cell[];
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

/** How the file was written, so the edited notebook comes out the same way. */
interface Style {
  indent: string;
  crlf: boolean;
  finalNewline: boolean;
  /** Written with json.dump(ensure_ascii=True): \u escapes instead of raw non-ASCII characters. */
  ascii: boolean;
  /** Jupyter stores source as a list of lines; some tools write one string. */
  sourceAsList: boolean;
}

function detectStyle(raw: string, nb: Notebook): Style {
  return {
    indent: /\n([ \t]+)"/.exec(raw)?.[1] ?? '',
    crlf: raw.includes('\r\n'),
    finalNewline: /\n$/.test(raw),
    ascii: !/[^\x00-\x7f]/.test(raw) && /\\u[0-9a-fA-F]{4}/.test(raw),
    sourceAsList: !nb.cells.some((c) => typeof c.source === 'string'),
  };
}

function serialize(nb: Notebook, style: Style): string {
  let out = style.indent ? JSON.stringify(nb, null, style.indent) : JSON.stringify(nb);
  if (style.ascii) out = out.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (style.finalNewline) out += '\n';
  return style.crlf ? out.replace(/\n/g, '\r\n') : out;
}

function toSource(text: string, asList: boolean): string | string[] {
  if (!asList) return text;
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/** Jupyter writes keys in alphabetical order; keep that when the original cell had it. */
function sortedLike(original: Cell, next: Cell): Cell {
  const keys = Object.keys(original);
  if (!keys.every((k, i) => i === 0 || keys[i - 1]! <= k)) return next;
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Cell;
}

function withType(cell: Cell, type: CellType): Cell {
  const next: Cell = { ...cell, cell_type: type };
  if (type === 'code') {
    if (!('execution_count' in next)) next.execution_count = null;
    if (!Array.isArray(next.outputs)) next.outputs = [];
  } else {
    delete next.execution_count;
    delete next.outputs;
  }
  return sortedLike(cell, next);
}

/** nbformat 4.5 and later require cell ids. */
function usesIds(nb: Notebook): boolean {
  const major = nb.nbformat ?? 4;
  return major > 4 || (major === 4 && (nb.nbformat_minor ?? 0) >= 5) || nb.cells.some((c) => typeof c.id === 'string');
}

function newCellId(nb: Notebook): string {
  const used = new Set(nb.cells.map((c) => c.id));
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!used.has(id)) return id;
  }
}

function cellIds(cells: Cell[]): string {
  const ids = cells.map((c, i) => (typeof c.id === 'string' ? `${i + 1}: ${c.id}` : '')).filter(Boolean);
  return ids.length ? `Cell ids: ${ids.slice(0, 30).join(', ')}${ids.length > 30 ? ', ...' : ''}.` : 'This notebook has no cell ids; use cell_number.';
}

const plural = (n: number) => `${n} cell${n === 1 ? '' : 's'}`;

export const NotebookEditTool: Tool = {
  name: 'NotebookEdit',
  category: 'edit',
  description:
    'Edit one cell of a Jupyter notebook (.ipynb): replace its source, insert a new cell or delete a cell. ' +
    'Pick the cell by cell_number (1 is the first cell, numbered as Read shows them) or by cell_id. Replacing a code cell clears its outputs. ' +
    'Read the notebook first. Use this instead of Edit or Write for notebooks.',
  parameters: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path of the .ipynb file' },
      edit_mode: { type: 'string', enum: [...MODES], description: 'replace (default), insert or delete' },
      cell_number: { type: 'number', description: 'Cell position, 1 = first (Read shows "cell 3"). For insert: the position of the new cell (default: at the end)' },
      cell_id: { type: 'string', description: 'Cell id, instead of cell_number. For insert: the new cell goes right after this cell' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'For insert: the type of the new cell (default code). For replace: changes the type' },
      new_source: { type: 'string', description: 'New source of the cell (replace and insert)' },
    },
    required: ['notebook_path'],
  },
  label: (input, ctx) => {
    const p = strParam(input, 'notebook_path', 'file_path', 'path', 'notebook') ?? '?';
    const mode = strParam(input, 'edit_mode', 'mode', 'action') ?? 'replace';
    const which = strParam(input, 'cell_id', 'cell_number', 'cell_index', 'index');
    return `NotebookEdit(${displayPath(resolvePath(p, ctx.cwd), ctx.cwd)}${which ? `, ${mode} cell ${which}` : mode !== 'replace' ? `, ${mode}` : ''})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const p = strParam(input, 'notebook_path', 'file_path', 'path', 'notebook');
    if (!p) return errorResult('Missing required parameter: notebook_path');
    const abs = resolvePath(p, ctx.session.cwd);
    const rel = displayPath(abs, ctx.session.cwd);
    if (path.extname(abs).toLowerCase() !== '.ipynb') return errorResult(`${rel} is not a Jupyter notebook (.ipynb). Use Edit for other files.`);
    const mode = (strParam(input, 'edit_mode', 'mode', 'action') ?? 'replace').toLowerCase() as Mode;
    if (!MODES.includes(mode)) return errorResult(`Unknown edit_mode "${mode}". Use replace, insert or delete.`);
    const typeParam = strParam(input, 'cell_type', 'type')?.toLowerCase();
    if (typeParam !== undefined && typeParam !== 'code' && typeParam !== 'markdown') return errorResult(`cell_type must be code or markdown, not "${typeParam}".`);
    const cellType = typeParam as CellType | undefined;
    const newSource = strParam(input, 'new_source', 'source', 'content', 'new_content', 'code');
    if (mode !== 'delete' && newSource === undefined) return errorResult(`Missing required parameter for ${mode}: new_source`);

    const raw = await readIfExists(abs);
    if (raw === null) return errorResult(`Notebook not found: ${abs}. To create a notebook, Write it as JSON (nbformat 4) first.`);
    if (!ctx.files.wasRead(abs)) return errorResult(`Read ${rel} first so you know its cells, then edit it.`);
    if (ctx.files.isStale(abs)) return errorResult(`${rel} was modified (by the user or another process) since you last read it. Read it again, then retry.`);
    let nb: Notebook;
    try {
      nb = JSON.parse(raw) as Notebook;
    } catch (e) {
      return errorResult(`${rel} is not valid JSON (${(e as Error).message}), so it cannot be edited as a notebook.`);
    }
    if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) return errorResult(`${rel} has no "cells" list. Only nbformat 4 notebooks can be edited.`);
    const cells = nb.cells;

    // Which cell: an id, or a 1-based number (also accepted in cell_id, as "3" or "cell-3").
    const idParam = strParam(input, 'cell_id', 'id')?.trim();
    let byId: number | undefined;
    let byNumber = numParam(input, 'cell_number', 'cell_index', 'index', 'cell');
    if (idParam) {
      const i = cells.findIndex((c) => c.id === idParam);
      const asNumber = /^(?:cell[-_ ]?)?(\d+)$/i.exec(idParam);
      if (i >= 0) byId = i;
      else if (asNumber) byNumber = Number(asNumber[1]);
      else return errorResult(`No cell with id "${idParam}" in ${rel}. ${cellIds(cells)}`);
    }
    if (byNumber !== undefined && (!Number.isInteger(byNumber) || byNumber < 1)) return errorResult('cell_number starts at 1 (cell 1 is the first cell, as Read shows them).');

    const style = detectStyle(raw, nb);
    const next: Notebook = { ...nb, cells: cells.slice() };
    let summary: string;
    if (mode === 'insert') {
      const at = byId !== undefined ? byId + 1 : byNumber !== undefined ? byNumber - 1 : cells.length;
      if (at > cells.length) return errorResult(`${rel} has ${plural(cells.length)}; a new cell can go at cell_number 1 to ${cells.length + 1}.`);
      const type = cellType ?? 'code';
      const id = usesIds(nb) ? newCellId(nb) : undefined;
      const source = toSource(newSource!, style.sourceAsList);
      const cell: Cell =
        type === 'code'
          ? { cell_type: 'code', execution_count: null, ...(id ? { id } : {}), metadata: {}, outputs: [], source }
          : { cell_type: 'markdown', ...(id ? { id } : {}), metadata: {}, source };
      next.cells.splice(at, 0, cell);
      summary = `Inserted a ${type} cell as cell ${at + 1}${id ? ` (id ${id})` : ''} of ${rel}. The notebook now has ${plural(next.cells.length)}.`;
    } else {
      const index = byId ?? (byNumber !== undefined ? byNumber - 1 : undefined);
      if (index === undefined) return errorResult(`Say which cell to ${mode}: cell_number (1 = first) or cell_id.`);
      if (index >= cells.length) return errorResult(`${rel} has ${plural(cells.length)}; there is no cell ${index + 1}.`);
      const old = cells[index]!;
      if (mode === 'delete') {
        next.cells.splice(index, 1);
        summary = `Deleted cell ${index + 1} (${old.cell_type ?? 'cell'}) of ${rel}. The notebook now has ${plural(next.cells.length)}.`;
      } else {
        let cell: Cell = { ...old, source: toSource(newSource!, style.sourceAsList) };
        if (cellType && cellType !== old.cell_type) cell = withType(cell, cellType);
        let cleared = false;
        if (cell.cell_type === 'code') {
          // Old outputs no longer match the new code.
          cleared = (Array.isArray(old.outputs) && old.outputs.length > 0) || (old.execution_count !== null && old.execution_count !== undefined);
          cell.outputs = [];
          cell.execution_count = null;
        }
        next.cells[index] = cell;
        const id = typeof cell.id === 'string' ? ` (id ${cell.id})` : '';
        summary = `Replaced cell ${index + 1}${id} of ${rel} with a ${cell.cell_type} cell${cleared ? '; its outputs were cleared' : ''}.`;
      }
    }
    const after = serialize(next, style);
    if (after === raw) return errorResult('The edit produced no change to the notebook.');
    const display = diffDisplay(abs, ctx.session.cwd, renderNotebook(raw), renderNotebook(after), false);
    return {
      permission: { tool: 'NotebookEdit', category: 'edit', title: 'Edit notebook', subject: displayPath(abs, ctx.projectRoot), path: abs, preview: display, danger: outsideWarning(abs, ctx) },
      execute: async () => {
        // Guard against changes between the preview and the write.
        if ((await readIfExists(abs)) !== raw) return fail(`${rel} changed while waiting for approval. Read it again and redo the edit.`);
        await ctx.files.snapshot(abs);
        await fsp.writeFile(abs, after, 'utf8');
        ctx.files.recordWrite(abs);
        return ok(summary, display);
      },
    };
  },
};

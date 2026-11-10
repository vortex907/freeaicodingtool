// Applying a WorkspaceEdit (what a rename returns) to file contents.
import { offsetAt, uriToPath, type TextEdit, type TextDocumentEdit, type WorkspaceEdit } from './protocol.js';

export interface FileEdits {
  file: string;
  edits: TextEdit[];
}

/** The text edits of a WorkspaceEdit per local file. File operations (create, rename, delete) are refused. */
export function editsByFile(edit: WorkspaceEdit | null | undefined): { files: FileEdits[]; error?: string } {
  if (!edit) return { files: [] };
  const map = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => {
    const file = uriToPath(uri);
    if (!file) throw new Error(`the server wants to change ${uri}, which is not a local file`);
    map.set(file, [...(map.get(file) ?? []), ...edits]);
  };
  try {
    if (Array.isArray(edit.documentChanges)) {
      for (const c of edit.documentChanges) {
        if ('kind' in c) return { files: [], error: `the server wants to ${c.kind} a file as part of this change, which FreeCode does not do automatically` };
        const d = c as TextDocumentEdit;
        add(d.textDocument.uri, d.edits ?? []);
      }
    } else if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits ?? []);
    }
  } catch (e) {
    return { files: [], error: (e as Error).message };
  }
  return { files: [...map.entries()].filter(([, e]) => e.length).map(([file, edits]) => ({ file, edits })) };
}

/** Applies LSP text edits (positions refer to the original text) to `text`. Throws on overlapping edits. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const spans = edits
    .map((e, i) => ({ start: offsetAt(text, e.range.start), end: offsetAt(text, e.range.end), newText: e.newText ?? '', i }))
    // Same start: keep the server's order (inserts at one spot apply in sequence).
    .sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);
  let out = '';
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) throw new Error('the server sent overlapping edits');
    if (s.end < s.start) throw new Error('the server sent an edit whose end is before its start');
    out += text.slice(pos, s.start) + s.newText;
    pos = s.end;
  }
  return out + text.slice(pos);
}

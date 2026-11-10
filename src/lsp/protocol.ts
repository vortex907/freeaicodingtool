// Language Server Protocol plumbing: Content-Length framing of JSON-RPC messages and the small part
// of the LSP types FreeCode uses.
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

export interface Position {
  /** 0-based line */
  line: number;
  /** 0-based UTF-16 offset in the line */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export type Severity = 1 | 2 | 3 | 4;

export interface Diagnostic {
  range: Range;
  /** 1 error, 2 warning, 3 information, 4 hint (missing counts as an error) */
  severity?: Severity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: TextEdit[];
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  /** TextDocumentEdits, or file operations ({ kind: 'create' | 'rename' | 'delete' }) */
  documentChanges?: (TextDocumentEdit | { kind: string })[];
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  /** Workspace symbols may leave out the range (resolved later); FreeCode does not resolve them. */
  location: Location | { uri: string };
  containerName?: string;
}

export interface MarkupContent {
  kind: string;
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export interface ResponseError {
  code: number;
  message: string;
  data?: unknown;
}

export interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: ResponseError;
}

/** JSON-RPC error codes FreeCode sends or reacts to. */
export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
  /** The server cancelled a request; retry when data.retriggerRequest is true. */
  ServerCancelled: -32802,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const;

export function encodeMessage(msg: Message): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');
/** A header block never gets this big; without a header end by then the stream is not LSP. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Splits a byte stream into messages. A message is a header block ending in an empty line, with a
 * Content-Length that counts bytes (not characters), and a JSON body. Text a server prints outside
 * the framing is skipped.
 */
export class MessageReader {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Bytes needed before the next message is complete (0 = header not parsed yet). */
  private need = 0;
  /** Messages or header blocks that could not be understood. */
  errors = 0;

  push(chunk: Buffer): Message[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out: Message[] = [];
    // Large bodies arrive in many chunks: join them once, when the whole message is there.
    if (this.need && this.size < this.need) return out;
    let buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
    for (;;) {
      const end = buf.indexOf(HEADER_END);
      if (end < 0) {
        if (buf.length > MAX_HEADER_BYTES) {
          this.errors++;
          buf = buf.subarray(buf.length - HEADER_END.length);
        }
        this.need = 0;
        break;
      }
      const m = /content-length:[ \t]*(\d+)/i.exec(buf.subarray(0, end).toString('latin1'));
      if (!m) {
        this.errors++;
        buf = buf.subarray(end + HEADER_END.length);
        continue;
      }
      const start = end + HEADER_END.length;
      const total = start + Number(m[1]);
      if (buf.length < total) {
        this.need = total;
        break;
      }
      const body = buf.subarray(start, total).toString('utf8');
      buf = buf.subarray(total);
      this.need = 0;
      try {
        const msg = JSON.parse(body) as Message;
        if (msg && typeof msg === 'object') out.push(msg);
        else this.errors++;
      } catch {
        this.errors++;
      }
    }
    this.chunks = buf.length ? [buf] : [];
    this.size = buf.length;
    return out;
  }
}

// ------------------------------------------------------------------ paths and positions

export function fileUri(file: string): string {
  return pathToFileURL(file).href;
}

/** The local path of a file:// URI, or null for other schemes. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Key for comparing documents: servers may spell a URI differently than FreeCode did (an encoded
 * colon or a lower-case drive letter on Windows).
 */
export function uriKey(uri: string): string {
  const p = uriToPath(uri);
  if (!p) return uri;
  const n = path.normalize(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

export function pathKey(file: string): string {
  const n = path.normalize(path.resolve(file));
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** Splits text into lines the way LSP counts them (\n, \r\n and \r all end a line). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Offset in `text` of an LSP position (clamped to the text, like editors do). */
export function offsetAt(text: string, pos: Position): number {
  let line = 0;
  let i = 0;
  while (line < pos.line) {
    const nl = text.indexOf('\n', i);
    const cr = text.indexOf('\r', i);
    if (nl < 0 && cr < 0) return text.length;
    // \r\n counts as one line break.
    if (cr >= 0 && (nl < 0 || cr < nl)) i = text[cr + 1] === '\n' ? cr + 2 : cr + 1;
    else i = nl + 1;
    line++;
  }
  let lineEnd = text.length;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\n' || text[j] === '\r') {
      lineEnd = j;
      break;
    }
  }
  return Math.min(i + Math.max(0, pos.character), lineEnd);
}

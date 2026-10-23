// Debug Adapter Protocol: the message shapes FreeCode uses and the Content-Length framing.
// Spec: https://microsoft.github.io/debug-adapter-protocol/specification

export interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: unknown;
}

export interface DapResponse {
  seq: number;
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface ExceptionFilter {
  filter: string;
  label: string;
  default?: boolean;
}

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  exceptionBreakpointFilters?: ExceptionFilter[];
}

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  presentationHint?: string;
}

export interface Thread {
  id: number;
  name: string;
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  line?: number;
  source?: Source;
}

export interface StoppedEventBody {
  reason: string;
  description?: string;
  threadId?: number;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

export interface OutputEventBody {
  category?: string;
  output: string;
}

export interface EvaluateResponseBody {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface ExceptionInfoResponseBody {
  exceptionId: string;
  description?: string;
  details?: { message?: string; typeName?: string };
}

/** One message as it goes over the wire. */
export function encodeMessage(msg: object): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'), json]);
}

const MAX_JUNK = 64 * 1024;

/** Splits a byte stream into messages. Text outside the frames (an adapter printing to stdout) is set aside. */
export class MessageReader {
  /** Text that was not part of any message, for error reports. */
  junk = '';
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DapMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: DapMessage[] = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) {
        // No header in sight: do not let a chatty adapter grow the buffer without bound.
        if (this.buf.length > MAX_JUNK) this.skip(this.buf.length - 32);
        return out;
      }
      const header = this.buf.subarray(0, end).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.skip(end + 4);
        continue;
      }
      if (m.index > 0) this.junk = (this.junk + header.slice(0, m.index)).slice(-MAX_JUNK);
      const start = end + 4;
      const length = Number(m[1]);
      if (this.buf.length < start + length) return out;
      const text = this.buf.subarray(start, start + length).toString('utf8');
      this.buf = this.buf.subarray(start + length);
      try {
        out.push(JSON.parse(text) as DapMessage);
      } catch {
        this.junk = (this.junk + text).slice(-MAX_JUNK);
      }
    }
  }

  private skip(n: number): void {
    this.junk = (this.junk + this.buf.subarray(0, n).toString('utf8')).slice(-MAX_JUNK);
    this.buf = this.buf.subarray(n);
  }
}

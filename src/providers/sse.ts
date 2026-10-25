// Server-Sent Events parsing for streaming chat completions.

export interface SseEvent {
  event?: string;
  data: string;
}

/** Incrementally parses an SSE byte stream into events. */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Feeds a chunk of text and returns completed events. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const nl = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      // A lone '\r' at the end of the buffer may be the first half of '\r\n': wait for more data.
      if (this.buffer[idx] === '\r' && idx + 1 >= this.buffer.length) break;
      this.buffer = this.buffer.slice(idx + nl);
      this.processLine(line, events);
    }
    return events;
  }

  /** Flushes any trailing event at end of stream. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length) {
      this.processLine(this.buffer, events);
      this.buffer = '';
    }
    this.dispatch(events);
    return events;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    else if (colon < 0 && /^\s*[{[]/.test(line)) {
      // Some servers send bare JSON lines (NDJSON) instead of SSE.
      this.dataLines.push(line);
      this.dispatch(events);
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (!this.dataLines.length) {
      this.eventName = undefined;
      return;
    }
    events.push({ event: this.eventName, data: this.dataLines.join('\n') });
    this.dataLines = [];
    this.eventName = undefined;
  }
}

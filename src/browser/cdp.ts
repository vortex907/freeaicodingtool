// Minimal Chrome DevTools Protocol client over the WebSocket built into Node 22+ (no dependencies).
// One connection to the browser; pages are driven through flattened target sessions.

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export class CdpError extends Error {}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: CdpEvent) => void>();
  closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  static connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    if (typeof WebSocket === 'undefined') return Promise.reject(new CdpError('The browser tools need Node.js 22 or newer.'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CdpError('Timed out connecting to the browser'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('Could not connect to the browser'));
      });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('The browser is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Subscribes to events; returns the unsubscribe function. */
  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first matching event (or rejects after the timeout). */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number, match?: (p: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on((e) => {
        if (e.method !== method || (sessionId && e.sessionId !== sessionId) || (match && !match(e.params))) return;
        clearTimeout(timer);
        off();
        resolve(e.params);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // already closing
    }
    this.onClose();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string; data?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message ?? 'error'}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const ev: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const l of [...this.listeners]) {
        try {
          l(ev);
        } catch {
          // a listener bug must not break the connection
        }
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError('The browser connection closed'));
    }
    this.pending.clear();
    for (const l of [...this.listeners]) l({ method: 'Connection.closed', params: {} });
  }
}

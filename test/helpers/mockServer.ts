// A scriptable OpenAI-compatible mock server used by the integration tests.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  name: string;
  args: Record<string, unknown> | string;
  /** Sent as the tool call's `extra_content` (Gemini thought signatures). */
  extra?: Record<string, unknown>;
}

export type MockResponse =
  | { kind: 'text'; text: string; reasoning?: string; finish?: string }
  | { kind: 'tools'; text?: string; calls: MockCall[]; omitIndex?: boolean }
  | { kind: 'error'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'hang' };

export interface RecordedRequest {
  provider: string;
  path: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export type Handler = (req: RecordedRequest, index: number) => MockResponse;

export class MockServer {
  server: http.Server;
  port = 0;
  requests: RecordedRequest[] = [];
  handlers = new Map<string, Handler>();
  models = new Map<string, string[]>();
  private counters = new Map<string, number>();

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  baseURL(provider: string): string {
    return `http://127.0.0.1:${this.port}/${provider}/v1`;
  }

  /** Scripted sequence of responses for a provider (the last one repeats). */
  script(provider: string, responses: MockResponse[]): void {
    this.handlers.set(provider, (_r, i) => responses[Math.min(i, responses.length - 1)]!);
  }

  on(provider: string, handler: Handler): void {
    this.handlers.set(provider, handler);
  }

  requestsFor(provider: string): RecordedRequest[] {
    return this.requests.filter((r) => r.provider === provider);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const m = /^\/([^/]+)\/v1(\/.*)$/.exec(url);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const [, provider, rest] = m;
    if (req.method === 'GET' && rest === '/models') {
      const ids = this.models.get(provider!) ?? [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ids.map((id) => ({ id, context_length: 100000 })) }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // ignore
    }
    const rec: RecordedRequest = { provider: provider!, path: rest!, body, headers: req.headers };
    this.requests.push(rec);
    const handler = this.handlers.get(provider!);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such provider' } }));
      return;
    }
    const idx = this.counters.get(provider!) ?? 0;
    this.counters.set(provider!, idx + 1);
    const r = handler(rec, idx);
    const stream = body.stream !== false;
    if (r.kind === 'hang') return; // never answers
    if (r.kind === 'error') {
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }).end(JSON.stringify(r.body));
      return;
    }
    if (r.kind === 'json') {
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
      return;
    }
    const id = `chatcmpl-${idx}`;
    const model = String(body.model ?? 'mock');
    if (!stream) {
      const message: Record<string, unknown> = { role: 'assistant', content: r.kind === 'text' ? r.text : r.text ?? null };
      if (r.kind === 'tools') {
        message.tool_calls = r.calls.map((c, i) => ({ id: `call_${idx}_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ id, object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: r.kind === 'tools' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-ratelimit-remaining-requests': '99' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => send({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] });
    res.write(': keep-alive\n\n');
    chunk({ role: 'assistant' });
    if (r.kind === 'text') {
      if (r.reasoning) chunk({ reasoning_content: r.reasoning });
      // Split text into a few pieces to exercise streaming.
      const pieces = r.text.match(/[\s\S]{1,7}/g) ?? [''];
      for (const p of pieces) chunk({ content: p });
      chunk({}, r.finish ?? 'stop');
    } else {
      if (r.text) chunk({ content: r.text });
      r.calls.forEach((c, i) => {
        const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args);
        const head: Record<string, unknown> = { id: `call_${idx}_${i}`, type: 'function', function: { name: c.name, arguments: '' } };
        if (c.extra) head.extra_content = c.extra;
        if (!r.omitIndex) head.index = i;
        chunk({ tool_calls: [head] });
        const parts = args.match(/[\s\S]{1,10}/g) ?? [''];
        for (const p of parts) chunk({ tool_calls: [{ ...(r.omitIndex ? {} : { index: i }), function: { arguments: p } }] });
      });
      chunk({}, 'tool_calls');
    }
    send({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

export const text = (t: string, extra: Partial<Extract<MockResponse, { kind: 'text' }>> = {}): MockResponse => ({ kind: 'text', text: t, ...extra });
export const tools = (...calls: MockCall[]): MockResponse => ({ kind: 'tools', calls });
export const rateLimited = (seconds = 30): MockResponse => ({
  kind: 'error',
  status: 429,
  body: { error: { message: `Rate limit reached for model on requests per minute (RPM). Please try again in ${seconds}s.`, type: 'requests', code: 'rate_limit_exceeded' } },
});

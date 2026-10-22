// Streaming chat-completions client for OpenAI-compatible APIs (and Ollama's native API).
import type { ChatMessage, ChatResult, ModelInfo, ProviderRuntime, ToolCall, ToolSchema, ToolMode, Usage } from './types.js';
import { ProviderError, classifyHttpError, classifyNetworkError, rateLimitFromHeaders } from './errors.js';
import { SseParser } from './sse.js';
import { buildRequestBody, toWireMessages } from './wire.js';
import { newToolCallId } from './textTools.js';
import { anySignal } from '../util/async.js';
import { debug } from '../util/log.js';
import { VERSION } from '../version.js';

export interface ChatRequest {
  provider: ProviderRuntime;
  model: ModelInfo;
  apiKey: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolMode: ToolMode;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  minimal?: boolean;
  strict?: boolean;
  noSystemRole?: boolean;
  /** Send earlier tool calls/results as text (for providers that reject the tool history). */
  historyAsText?: boolean;
  /** Abort if no response headers arrive within this time. */
  headersTimeoutMs?: number;
  /** Abort if the stream is silent for this long. */
  idleTimeoutMs?: number;
  stream?: boolean;
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCallStart?: (name: string) => void;
}

/** Splits <think>...</think> sections out of streamed content. */
export class ThinkTagFilter {
  private inside = false;
  private pending = '';
  constructor(
    private emitText: (s: string) => void,
    private emitThink: (s: string) => void,
  ) {}

  push(chunk: string): void {
    let s = this.pending + chunk;
    this.pending = '';
    while (s.length) {
      const tag = this.inside ? /<\/think(?:ing)?>/ : /<think(?:ing)?>/;
      const m = tag.exec(s);
      if (m) {
        this.out(s.slice(0, m.index));
        this.inside = !this.inside;
        s = s.slice(m.index + m[0].length);
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      const lt = s.lastIndexOf('<');
      if (lt >= 0 && s.length - lt <= 11) {
        const tail = s.slice(lt);
        const target = this.inside ? '</thinking>' : '<thinking>';
        const target2 = this.inside ? '</think>' : '<think>';
        if (target.startsWith(tail) || target2.startsWith(tail)) {
          this.out(s.slice(0, lt));
          this.pending = tail;
          return;
        }
      }
      this.out(s);
      s = '';
    }
  }

  flush(): void {
    if (this.pending) {
      this.out(this.pending);
      this.pending = '';
    }
  }

  private out(s: string): void {
    if (!s) return;
    if (this.inside) this.emitThink(s);
    else this.emitText(s);
  }
}

/** Accumulates streamed tool-call deltas, tolerating the many provider variations. */
function mergeExtra(a: Record<string, unknown> | undefined, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = prev && v && typeof prev === 'object' && typeof v === 'object' && !Array.isArray(v) ? { ...(prev as object), ...(v as object) } : v;
  }
  return out;
}

export class ToolCallAccumulator {
  calls: { id?: string; name: string; args: string; extra?: Record<string, unknown> }[] = [];
  private byIndex = new Map<number, number>();

  add(deltas: unknown[], onStart?: (name: string) => void): void {
    for (const raw of deltas) {
      const d = raw as { index?: number; id?: string; function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown };
      const fn = d.function ?? { name: d.name, arguments: d.arguments };
      let idx: number | undefined;
      if (typeof d.index === 'number') {
        const existing = this.byIndex.get(d.index);
        if (existing !== undefined && d.id && this.calls[existing]!.id && d.id !== this.calls[existing]!.id) {
          idx = undefined; // provider reused the index for a new call
        } else idx = existing;
        if (idx === undefined) {
          idx = this.calls.length;
          this.calls.push({ id: d.id, name: '', args: '' });
          this.byIndex.set(d.index, idx);
        }
      } else if (d.id) {
        idx = this.calls.findIndex((c) => c.id === d.id);
        if (idx < 0) {
          idx = this.calls.length;
          this.calls.push({ id: d.id, name: '', args: '' });
        }
      } else {
        idx = this.calls.length - 1;
        if (idx < 0 || (fn.name && this.calls[idx]!.name && this.calls[idx]!.args.trim().endsWith('}') && isCompleteJson(this.calls[idx]!.args))) {
          idx = this.calls.length;
          this.calls.push({ name: '', args: '' });
        }
      }
      const c = this.calls[idx]!;
      if (d.id && !c.id) c.id = d.id;
      const extra = (raw as { extra_content?: unknown }).extra_content;
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) c.extra = mergeExtra(c.extra, extra as Record<string, unknown>);
      if (typeof fn.name === 'string' && fn.name) {
        const hadName = !!c.name;
        if (!c.name) c.name = fn.name;
        else if (fn.name === c.name) {
          // repeated full name
        } else if (fn.name.startsWith(c.name)) c.name = fn.name;
        else c.name += fn.name;
        if (!hadName && onStart) onStart(c.name);
      }
      const a = fn.arguments;
      if (a !== undefined && a !== null) {
        if (typeof a === 'object') c.args = JSON.stringify(a);
        else {
          const s = String(a);
          if (c.args && s.length > c.args.length && s.startsWith(c.args) && isCompleteJson(s)) c.args = s; // cumulative
          else c.args += s;
        }
      }
    }
  }

  result(): ToolCall[] {
    return this.calls
      .filter((c) => c.name)
      .map((c) => ({ id: c.id || newToolCallId(), name: c.name.trim(), arguments: c.args.trim() || '{}', ...(c.extra ? { extra: c.extra } : {}) }));
  }
}

function isCompleteJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function resolveUrl(provider: ProviderRuntime, path: string): string {
  return provider.baseURL.replace(/\/+$/, '') + path;
}

function authHeaders(provider: ProviderRuntime, apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `FreeCode/${VERSION}`,
    ...provider.headers,
  };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function parseUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const x = u as Record<string, number>;
  const prompt = x.prompt_tokens ?? x.input_tokens ?? x.promptTokens ?? 0;
  const completion = x.completion_tokens ?? x.output_tokens ?? x.completionTokens ?? 0;
  if (!prompt && !completion) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: x.total_tokens ?? prompt + completion };
}

/** Fetch with header/idle timeouts and abort support. Returns the response once headers arrive. */
async function timedFetch(url: string, init: RequestInit, req: ChatRequest): Promise<{ res: Response; abort: AbortController }> {
  const ctrl = new AbortController();
  const signal = anySignal([req.signal, ctrl.signal]);
  const headersTimeout = setTimeout(() => ctrl.abort(new ProviderError('timeout', `No response from ${req.provider.name} within ${Math.round((req.headersTimeoutMs ?? 60000) / 1000)}s`)), req.headersTimeoutMs ?? 60000);
  try {
    const res = await fetch(url, { ...init, signal });
    return { res, abort: ctrl };
  } catch (e) {
    if (req.signal?.aborted) throw new ProviderError('aborted', 'Aborted');
    const reason = ctrl.signal.reason;
    if (reason instanceof ProviderError) throw reason;
    const c = classifyNetworkError(e);
    throw new ProviderError(c.kind, `${req.provider.name}: ${c.message}`);
  } finally {
    clearTimeout(headersTimeout);
  }
}

/** Reads a streaming body with an idle timeout, yielding decoded text chunks. */
async function* readBody(res: Response, abort: AbortController, req: ChatRequest): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const idleMs = req.idleTimeoutMs ?? 180000;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new ProviderError('timeout', `${req.provider.name} stopped responding (no data for ${Math.round(idleMs / 1000)}s)`)), idleMs);
  };
  arm();
  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (e) {
        if (req.signal?.aborted) throw new ProviderError('aborted', 'Aborted');
        const reason = abort.signal.reason;
        if (reason instanceof ProviderError) throw reason;
        const c = classifyNetworkError(e);
        throw new ProviderError(c.kind === 'aborted' ? 'network' : c.kind, `${req.provider.name}: stream interrupted (${c.message})`);
      }
      if (chunk.done) break;
      arm();
      yield decoder.decode(chunk.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function errorFromPayload(payload: Record<string, unknown>, req: ChatRequest): ProviderError {
  const err = (payload.error ?? payload) as Record<string, unknown>;
  const code = Number(err.code ?? err.status ?? (payload as { status?: number }).status);
  const status = !isNaN(code) && code >= 400 && code < 600 ? code : 500;
  const body = JSON.stringify(payload);
  const c = classifyHttpError(status, body);
  return new ProviderError(c.kind, `${req.provider.name}/${req.model.id}: ${c.message}`, {
    status,
    retryAfterMs: c.retryAfterMs,
    limitTokens: c.limitTokens,
    providerId: req.provider.id,
    modelId: req.model.id,
    body,
  });
}

/** Sends one chat request and streams the answer. Throws ProviderError on failure. */
export async function chatCompletion(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
  if (req.provider.def.api === 'ollama') return ollamaChat(req, handlers);
  const started = Date.now();
  const quirks = req.provider.def.quirks ?? {};
  const body = buildRequestBody(req.messages, {
    quirks,
    model: req.model,
    toolMode: req.toolMode,
    tools: req.tools,
    minimal: req.minimal,
    strict: req.strict,
    noSystemRole: req.noSystemRole,
    historyAsText: req.historyAsText,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    stream: req.stream ?? true,
  });
  const url = resolveUrl(req.provider, '/chat/completions');
  debug('client', `POST ${url} model=${req.model.id} msgs=${(body.messages as unknown[]).length} tools=${req.toolMode}:${req.tools?.length ?? 0} minimal=${!!req.minimal}`);
  const { res, abort } = await timedFetch(url, { method: 'POST', headers: authHeaders(req.provider, req.apiKey), body: JSON.stringify(body) }, req);

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore
    }
    const c = classifyHttpError(res.status, text, res.headers);
    debug('client', `HTTP ${res.status} ${req.provider.id}/${req.model.id}: ${text.slice(0, 1000)}`);
    throw new ProviderError(c.kind, `${req.provider.name}/${req.model.id}: ${c.message}`, {
      status: res.status,
      retryAfterMs: c.retryAfterMs,
      limitTokens: c.limitTokens,
      providerId: req.provider.id,
      modelId: req.model.id,
      body: text.slice(0, 20000),
    });
  }

  const rateLimit = rateLimitFromHeaders(res.headers);
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  let ttftMs: number | undefined;
  const acc = new ToolCallAccumulator();
  const markFirst = () => {
    if (ttftMs === undefined) ttftMs = Date.now() - started;
  };
  const think = new ThinkTagFilter(
    (t) => {
      content += t;
      markFirst();
      handlers.onText?.(t);
    },
    (t) => {
      reasoning += t;
      markFirst();
      handlers.onReasoning?.(t);
    },
  );
  const emitReasoning = (t: string) => {
    if (!t) return;
    reasoning += t;
    markFirst();
    handlers.onReasoning?.(t);
  };

  const handleChoice = (choice: Record<string, unknown>) => {
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    // Reasoning (several field names in the wild)
    for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
      const v = delta[key];
      if (typeof v === 'string') emitReasoning(v);
    }
    const details = delta.reasoning_details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const t = (d as { text?: string; summary?: string }).text ?? (d as { summary?: string }).summary;
        if (typeof t === 'string' && typeof delta.reasoning !== 'string') emitReasoning(t);
      }
    }
    const c = delta.content;
    if (typeof c === 'string') think.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        const p = part as { type?: string; text?: string; thinking?: unknown };
        if (p.type === 'thinking') {
          const th = p.thinking;
          if (typeof th === 'string') emitReasoning(th);
          else if (Array.isArray(th)) for (const x of th) emitReasoning((x as { text?: string }).text ?? '');
        } else if (typeof p.text === 'string') think.push(p.text);
      }
    }
    const tcs = delta.tool_calls ?? (delta.function_call ? [{ index: 0, function: delta.function_call }] : undefined);
    if (Array.isArray(tcs) && tcs.length) {
      markFirst();
      acc.add(tcs, handlers.onToolCallStart);
    }
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
  };

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('event-stream') && !contentType.includes('ndjson') && contentType.includes('json')) {
    // Non-streaming response
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('bad_request', `${req.provider.name}: invalid JSON response`, { providerId: req.provider.id, modelId: req.model.id });
    }
    if (json.error) throw errorFromPayload(json, req);
    const choices = (json.choices as Record<string, unknown>[]) || [];
    if (choices[0]) handleChoice(choices[0]);
    usage = parseUsage(json.usage);
  } else {
    const parser = new SseParser();
    const handleData = (data: string) => {
      const trimmed = data.trim();
      if (!trimmed || trimmed === '[DONE]') return;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(trimmed);
      } catch {
        debug('client', `unparseable chunk: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (json.error) throw errorFromPayload(json, req);
      const u = parseUsage(json.usage ?? (json.x_groq as { usage?: unknown } | undefined)?.usage);
      if (u) usage = u;
      const choices = json.choices as Record<string, unknown>[] | undefined;
      if (Array.isArray(choices)) for (const ch of choices) handleChoice(ch);
    };
    for await (const chunk of readBody(res, abort, req)) {
      for (const ev of parser.push(chunk)) {
        if (ev.event === 'error') {
          let payload: Record<string, unknown> = { error: { message: ev.data } };
          try {
            payload = JSON.parse(ev.data);
          } catch {
            // keep text
          }
          throw errorFromPayload(payload, req);
        }
        handleData(ev.data);
      }
    }
    for (const ev of parser.end()) handleData(ev.data);
  }
  think.flush();

  const toolCalls = acc.result();
  return {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage,
    rateLimit,
    latencyMs: Date.now() - started,
    ttftMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Ollama native API (/api/chat) so we can set num_ctx (the OpenAI-compatible endpoint can't).

function ollamaRoot(provider: ProviderRuntime): string {
  return provider.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function ollamaChat(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
  const started = Date.now();
  const wire = toWireMessages(req.messages, {
    quirks: req.provider.def.quirks ?? {},
    model: req.model,
    toolMode: req.toolMode,
    tools: req.tools,
    historyAsText: req.historyAsText,
  });
  const messages = wire.map((m) => {
    const out: Record<string, unknown> = { role: m.role };
    if (Array.isArray(m.content)) {
      out.content = (m.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      out.images = (m.content as { type: string; image_url?: { url: string } }[])
        .filter((p) => p.type === 'image_url')
        .map((p) => p.image_url!.url.replace(/^data:[^;]+;base64,/, ''));
    } else out.content = m.content ?? '';
    if (m.tool_calls) {
      out.tool_calls = (m.tool_calls as { function: { name: string; arguments: string } }[]).map((tc) => {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // keep empty
        }
        return { function: { name: tc.function.name, arguments: args } };
      });
    }
    if (m.role === 'tool') {
      // find tool name from previous assistant call
      out.tool_name = findToolName(wire, m.tool_call_id as string);
    }
    return out;
  });
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages,
    stream: true,
    options: { num_ctx: req.model.context, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
  };
  if (req.toolMode === 'native' && req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const url = `${ollamaRoot(req.provider)}/api/chat`;
  debug('client', `POST ${url} model=${req.model.id} num_ctx=${req.model.context}`);
  const { res, abort } = await timedFetch(url, { method: 'POST', headers: authHeaders(req.provider, req.apiKey), body: JSON.stringify(body) }, { ...req, headersTimeoutMs: req.headersTimeoutMs ?? 300000 });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const c = classifyHttpError(res.status, text, res.headers);
    throw new ProviderError(c.kind, `Ollama/${req.model.id}: ${c.message}`, { status: res.status, providerId: req.provider.id, modelId: req.model.id });
  }
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  let ttftMs: number | undefined;
  const toolCalls: ToolCall[] = [];
  const think = new ThinkTagFilter(
    (t) => {
      content += t;
      ttftMs ??= Date.now() - started;
      handlers.onText?.(t);
    },
    (t) => {
      reasoning += t;
      handlers.onReasoning?.(t);
    },
  );
  let buf = '';
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (json.error) throw new ProviderError(classifyHttpError(500, JSON.stringify(json)).kind, `Ollama: ${String(json.error)}`, { providerId: req.provider.id, modelId: req.model.id });
    const msg = (json.message ?? {}) as Record<string, unknown>;
    if (typeof msg.thinking === 'string' && msg.thinking) {
      reasoning += msg.thinking;
      handlers.onReasoning?.(msg.thinking);
    }
    if (typeof msg.content === 'string' && msg.content) think.push(msg.content);
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as { function: { name: string; arguments: unknown } }[]) {
        handlers.onToolCallStart?.(tc.function.name);
        toolCalls.push({
          id: newToolCallId(),
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
        });
      }
    }
    if (json.done) {
      finishReason = String(json.done_reason ?? 'stop');
      const p = Number(json.prompt_eval_count ?? 0);
      const c = Number(json.eval_count ?? 0);
      usage = { promptTokens: p, completionTokens: c, totalTokens: p + c };
    }
  };
  for await (const chunk of readBody(res, abort, req)) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handleLine(buf);
  think.flush();
  return { content, reasoning, toolCalls, finishReason, usage, latencyMs: Date.now() - started, ttftMs };
}

function findToolName(wire: Record<string, unknown>[], id: string): string | undefined {
  for (const m of wire) {
    const calls = m.tool_calls as { id: string; function: { name: string } }[] | undefined;
    const hit = calls?.find((c) => c.id === id);
    if (hit) return hit.function.name;
  }
  return undefined;
}

/** Lists models from an OpenAI-compatible /models endpoint. */
export async function fetchModelList(provider: ProviderRuntime, apiKey: string, timeoutMs = 8000): Promise<Record<string, unknown>[]> {
  const url = resolveUrl(provider, '/models');
  const res = await fetch(url, { headers: authHeaders(provider, apiKey), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const c = classifyHttpError(res.status, text, res.headers);
    throw new ProviderError(c.kind, `${provider.name}: ${c.message}`, { status: res.status, providerId: provider.id });
  }
  const json = JSON.parse(text) as { data?: unknown; models?: unknown } | unknown[];
  const list = Array.isArray(json) ? json : ((json as { data?: unknown }).data ?? (json as { models?: unknown }).models);
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

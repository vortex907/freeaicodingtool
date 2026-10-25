// Claude through Anthropic's Messages API, using the official SDK (loaded the first time a Claude model
// is used). Three things keep long agent sessions cheap and correct:
//  - prompt caching: one breakpoint after the system prompt (tools and system are cached together) and
//    an automatic one that moves with the end of the conversation, so each step pays full price only for
//    what was added since the last one;
//  - Claude's own reply blocks are sent back unchanged: thinking blocks are bound to the conversation
//    that produced them, and blocks the API can no longer verify are dropped instead of failing;
//  - the effort level, which sets how much Claude thinks (and so most of the output cost).
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ChatMessage, ChatResult, EffortLevel, NativeContent, ProviderRuntime, RateLimitSnapshot, ToolCall, Usage } from './types.js';
import type { ChatRequest, StreamHandlers } from './client.js';
import { ProviderError, classifyHttpError, classifyNetworkError, parseDurationMs } from './errors.js';
import { sanitizeSchema } from './wire.js';
import { anySignal } from '../util/async.js';
import { debug } from '../util/log.js';

type Sdk = typeof import('@anthropic-ai/sdk');
type Params = BetaMessageStreamParams;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Block = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** Lets the API drop thinking blocks it can no longer verify (after compaction or a trimmed tool output). */
export const BLOCK_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

let sdkPromise: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@anthropic-ai/sdk').catch((e: unknown) => {
    sdkPromise = null;
    throw new ProviderError('unknown', `The Anthropic SDK could not be loaded (${e instanceof Error ? e.message : String(e)}). Reinstall FreeCode.`);
  });
  return sdkPromise;
}

/** The SDK adds /v1 itself. */
function sdkBaseURL(provider: ProviderRuntime): string {
  return provider.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The effort level to send, if any: only to models that take one (no level leaves the model's default). */
export function claudeEffort(req: Pick<ChatRequest, 'effort' | 'model'>): EffortLevel | undefined {
  return req.model.effort ? req.effort : undefined;
}

// ------------------------------------------------------------------ conversation

function parseInput(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

function userBlocks(m: ChatMessage): Block[] {
  const out: Block[] = [];
  for (const img of m.images ?? []) {
    out.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.data } });
  }
  if (m.content.trim()) out.push({ type: 'text', text: m.content });
  return out;
}

/** Claude's blocks for a turn it wrote itself (matching FreeCode's tool calls), else rebuilt from the message. */
function assistantBlocks(m: ChatMessage, answered: Set<string>, stripThinking: boolean): Block[] {
  const calls = m.toolCalls ?? [];
  const native = m.native?.provider === 'anthropic' && Array.isArray(m.native.content) ? (m.native.content as Record<string, unknown>[]) : null;
  if (native) {
    const uses = native.filter((b) => b.type === 'tool_use');
    // Only when the calls are still the ones Claude made (FreeCode may rename or renumber some).
    if (uses.length === calls.length && uses.every((b, i) => b.id === calls[i]!.id && b.name === calls[i]!.name)) {
      const out: Block[] = [];
      for (const b of native) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          if (!stripThinking) out.push(b as unknown as Block);
        } else if (b.type === 'text') {
          if (typeof b.text === 'string' && b.text) out.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          if (answered.has(String(b.id))) out.push(b as unknown as Block);
        }
      }
      return out;
    }
  }
  const out: Block[] = [];
  if (m.content.trim()) out.push({ type: 'text', text: m.content });
  for (const tc of calls) {
    if (answered.has(tc.id)) out.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseInput(tc.arguments) });
  }
  return out;
}

/**
 * FreeCode's conversation as Anthropic messages. Deterministic, so the same history always renders to the
 * same bytes (the prompt cache and the thinking-block check both depend on it).
 */
export function toAnthropicMessages(messages: ChatMessage[], opts: { stripThinking?: boolean } = {}): { system: string; messages: MessageParam[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const answered = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!));
  const called = new Set<string>();
  const add = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      if (!out.length) system.push(m.content);
      else add('user', [{ type: 'text', text: `<system-reminder>\n${m.content}\n</system-reminder>` }]);
    } else if (m.role === 'user') {
      add('user', userBlocks(m));
    } else if (m.role === 'tool') {
      const id = m.toolCallId;
      if (id && called.has(id)) {
        add('user', [{ type: 'tool_result', tool_use_id: id, content: m.content || '(no output)', ...(m.isError ? { is_error: true } : {}) }]);
      } else if (m.content.trim()) {
        add('user', [{ type: 'text', text: `Result of ${m.toolName ?? 'a tool'}:\n${m.content}` }]);
      }
    } else {
      const blocks = assistantBlocks(m, answered, !!opts.stripThinking);
      for (const b of blocks) if (b.type === 'tool_use') called.add(b.id);
      add('assistant', blocks);
    }
  }
  // Tool results lead their user message; anything else said in that turn follows them.
  for (const msg of out) {
    if (msg.role === 'user') msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  // Claude 5 models take no prefill: a conversation that ends with Claude's own text gets a nudge instead.
  const last = out[out.length - 1];
  if (last?.role === 'assistant') {
    const text = last.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlockParam => b.type === 'text').map((b) => b.text).join('\n');
    out.push({ role: 'user', content: [{ type: 'text', text: text ? 'Please continue.' : '(continue)' }] });
  }
  return { system: system.join('\n\n'), messages: out };
}

/** The full request: cache breakpoints, adaptive thinking that survives history edits, effort. */
export function anthropicParams(req: ChatRequest): Params {
  const conv = toAnthropicMessages(req.messages, { stripThinking: !!req.minimal });
  const params: Params = {
    model: req.model.id,
    max_tokens: Math.max(256, req.maxTokens ?? 16384),
    messages: conv.messages,
    // Automatic breakpoint at the end of the conversation: the next step reads everything up to here.
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    betas: [BLOCK_BINDING_BETA],
  };
  // A breakpoint on the system prompt caches tools and system together, whatever happens later.
  if (conv.system) params.system = [{ type: 'text', text: conv.system, cache_control: { type: 'ephemeral' } }];
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: sanitizeSchema(t.parameters, 'openai') as Anthropic.Beta.Messages.BetaTool.InputSchema,
      // Large inputs (a whole file for Write) stream as they are written, which also keeps the stream alive.
      eager_input_streaming: true,
    }));
  }
  const effort = claudeEffort(req);
  if (effort) params.output_config = { effort };
  return params;
}

// ------------------------------------------------------------------ transport

const STATUS_BY_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

function toProviderError(e: unknown, sdk: Sdk, req: ChatRequest, ctrl: AbortController): ProviderError {
  if (e instanceof ProviderError) return e;
  if (req.signal?.aborted) return new ProviderError('aborted', 'Aborted');
  const reason: unknown = ctrl.signal.reason;
  if (reason instanceof ProviderError) return reason;
  const where = `${req.provider.name}/${req.model.id}`;
  if (e instanceof sdk.APIUserAbortError) return new ProviderError('aborted', 'Aborted');
  if (e instanceof sdk.APIConnectionTimeoutError) return new ProviderError('timeout', `${where}: request timed out`);
  if (e instanceof sdk.APIConnectionError) {
    const c = classifyNetworkError((e as { cause?: unknown }).cause ?? e);
    return new ProviderError(c.kind === 'aborted' ? 'network' : c.kind, `${req.provider.name}: ${c.message}`);
  }
  if (e instanceof sdk.APIError) {
    const type = (e as { type?: string }).type ?? (e.error as { error?: { type?: string } } | undefined)?.error?.type ?? '';
    const status = e.status ?? STATUS_BY_TYPE[type] ?? 500;
    const body = JSON.stringify(e.error ?? { error: { message: e.message } });
    const c = classifyHttpError(status, body, e.headers ?? undefined);
    // "Your credit balance is too low" comes back as a 400; it will not pass by retrying.
    const kind = /credit balance|purchase credits|billing/i.test(c.message) ? 'quota' : c.kind;
    return new ProviderError(kind, `${where}: ${c.message}`, { status, retryAfterMs: c.retryAfterMs, limitTokens: c.limitTokens, providerId: req.provider.id, modelId: req.model.id, body: body.slice(0, 20000) });
  }
  // For example a tool call whose input could not be read at all: worth another attempt.
  return new ProviderError('server', `${where}: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * fetch with FreeCode's timeouts: no response headers within headersTimeoutMs, or no bytes for idleMs
 * (Anthropic's keep-alive pings count, so a model that thinks quietly for minutes is not cut off).
 */
function watchedFetch(ctrl: AbortController, req: ChatRequest): { fetch: typeof fetch; stop: () => void } {
  const name = req.provider.name;
  const headersMs = req.headersTimeoutMs ?? 60_000;
  const idleMs = req.idleTimeoutMs ?? 180_000;
  let idle: NodeJS.Timeout | undefined;
  const stop = () => clearTimeout(idle);
  const arm = () => {
    stop();
    idle = setTimeout(() => ctrl.abort(new ProviderError('timeout', `${name} stopped responding (no data for ${Math.round(idleMs / 1000)}s)`)), idleMs);
  };
  const watched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const wait = setTimeout(() => ctrl.abort(new ProviderError('timeout', `No response from ${name} within ${Math.round(headersMs / 1000)}s`)), headersMs);
    let res: Response;
    try {
      res = await fetch(input, init);
    } finally {
      clearTimeout(wait);
    }
    if (!res.body) return res;
    arm();
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          arm();
          out.enqueue(chunk);
        },
        flush: stop,
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { fetch: watched as typeof fetch, stop };
}

function clientFor(sdk: Sdk, req: Pick<ChatRequest, 'provider' | 'apiKey'>, extra: Partial<ConstructorParameters<Sdk['default']>[0]> = {}): Anthropic {
  // authToken: null keeps an ANTHROPIC_AUTH_TOKEN in the environment from being sent alongside the key.
  return new sdk.default({ apiKey: req.apiKey, authToken: null, baseURL: sdkBaseURL(req.provider), maxRetries: 0, timeout: 20 * 60_000, ...extra });
}

/** anthropic-ratelimit-* headers in the shape the router's health tracking uses. */
export function anthropicRateLimit(headers: Headers | undefined | null): RateLimitSnapshot | undefined {
  if (!headers) return undefined;
  const num = (n: string) => {
    const v = headers.get(n);
    return v !== null && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined;
  };
  const reset = (n: string) => {
    const v = headers.get(n);
    if (!v) return undefined;
    const at = Date.parse(v);
    return isNaN(at) ? parseDurationMs(v) : Math.max(0, at - Date.now());
  };
  const snap: RateLimitSnapshot = {
    remainingRequests: num('anthropic-ratelimit-requests-remaining'),
    remainingTokens: num('anthropic-ratelimit-input-tokens-remaining') ?? num('anthropic-ratelimit-tokens-remaining'),
    resetRequestsMs: reset('anthropic-ratelimit-requests-reset'),
    resetTokensMs: reset('anthropic-ratelimit-input-tokens-reset') ?? reset('anthropic-ratelimit-tokens-reset'),
  };
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

function usageOf(m: Message): Usage {
  const u = m.usage;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const prompt = u.input_tokens + read + write;
  return { promptTokens: prompt, completionTokens: u.output_tokens, totalTokens: prompt + u.output_tokens, cacheReadTokens: read, cacheWriteTokens: write };
}

const FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', pause_turn: 'pause' };

/** Sends one request to Claude and streams the answer. Throws ProviderError on failure. */
export async function anthropicChat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
  const sdk = await loadSdk();
  const started = Date.now();
  const ctrl = new AbortController();
  const signal = anySignal([req.signal, ctrl.signal]);
  const watch = watchedFetch(ctrl, req);
  const params = anthropicParams(req);
  debug('client', `POST ${sdkBaseURL(req.provider)}/v1/messages model=${req.model.id} msgs=${params.messages.length} tools=${params.tools?.length ?? 0} effort=${params.output_config?.effort ?? 'default'} minimal=${!!req.minimal}`);
  let content = '';
  let reasoning = '';
  let ttftMs: number | undefined;
  try {
    const stream = clientFor(sdk, req, { fetch: watch.fetch }).beta.messages.stream(params, { signal });
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'tool_use') handlers.onToolCallStart?.(b.name);
        else if (b.type === 'text' && content) {
          content += '\n\n';
          handlers.onText?.('\n\n');
        } else if (b.type === 'thinking' && reasoning) {
          reasoning += '\n\n';
          handlers.onReasoning?.('\n\n');
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d.type === 'text_delta') {
          ttftMs ??= Date.now() - started;
          content += d.text;
          handlers.onText?.(d.text);
        } else if (d.type === 'thinking_delta') {
          reasoning += d.thinking;
          handlers.onReasoning?.(d.thinking);
        }
      }
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      const why = msg.stop_details?.category ? ` (${msg.stop_details.category})` : '';
      throw new ProviderError('content_filter', `${req.provider.name}/${req.model.id}: Claude declined this request${why}.`, { providerId: req.provider.id, modelId: req.model.id });
    }
    let blocks = msg.content as unknown as Record<string, unknown>[];
    // A tool call cut off by max_tokens has incomplete input; the earlier ones are whole.
    if (msg.stop_reason === 'max_tokens' && blocks[blocks.length - 1]?.type === 'tool_use') blocks = blocks.slice(0, -1);
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) }));
    const native: NativeContent = { provider: 'anthropic', model: req.model.id, content: blocks };
    const usage = usageOf(msg);
    debug('client', `claude usage: input ${msg.usage.input_tokens}, cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}, output ${usage.completionTokens}`);
    return {
      content,
      reasoning,
      toolCalls,
      finishReason: msg.stop_reason ? FINISH[msg.stop_reason] ?? msg.stop_reason : null,
      usage,
      rateLimit: anthropicRateLimit(stream.response?.headers),
      latencyMs: Date.now() - started,
      ttftMs,
      native,
    };
  } catch (e) {
    throw toProviderError(e, sdk, req, ctrl);
  } finally {
    watch.stop();
  }
}

/** Lists the account's models (used to check a key; costs nothing). */
export async function anthropicModelList(provider: ProviderRuntime, apiKey: string, timeoutMs = 8000): Promise<Record<string, unknown>[]> {
  const sdk = await loadSdk();
  const ctrl = new AbortController();
  const req = { provider, apiKey, model: { id: 'models' }, signal: undefined } as unknown as ChatRequest;
  try {
    const page = await clientFor(sdk, req, { timeout: timeoutMs }).models.list({ limit: 100 });
    return page.data.map((m) => ({ id: m.id, name: m.display_name, context_length: m.max_input_tokens, max_output_tokens: m.max_tokens }));
  } catch (e) {
    throw toProviderError(e, sdk, req, ctrl);
  }
}

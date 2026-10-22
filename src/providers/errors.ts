// Classification of provider failures so the router knows whether to retry, wait or fail over.
import type { RateLimitSnapshot } from './types.js';

export type ErrorKind =
  | 'rate_limit' // short-term limit (per minute) -> cool down briefly, try another model
  | 'quota' // daily/monthly allowance or credits exhausted -> long cool down
  | 'auth' // bad/missing key -> disable provider
  | 'forbidden_model' // key works but this model is not allowed -> disable model
  | 'not_found' // model unknown / no free endpoint -> disable model
  | 'context_length' // prompt too long for this model -> learn limit, use bigger model
  | 'too_large' // request exceeds per-minute token cap -> learn limit
  | 'tools_unsupported' // model rejects tools -> switch to text tool protocol
  | 'bad_request' // other 400 -> retry once in compatibility mode
  | 'server' // 5xx/overloaded -> retry / fail over
  | 'network' // connection errors
  | 'timeout'
  | 'empty' // model returned nothing
  | 'content_filter'
  | 'aborted'
  | 'unknown';

export class ProviderError extends Error {
  kind: ErrorKind;
  status?: number;
  retryAfterMs?: number;
  providerId?: string;
  modelId?: string;
  body?: string;
  /** Parsed token limit from messages like "Limit 6000, Requested 7812". */
  limitTokens?: number;

  constructor(kind: ErrorKind, message: string, extra: Partial<ProviderError> = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** Parses durations like "1m26.4s", "7.66s", "120ms", "2h3m", "34s" into milliseconds. */
export function parseDurationMs(s: string): number | undefined {
  const str = s.trim();
  if (!str) return undefined;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000; // plain seconds
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    matched = true;
    const v = Number(m[1]);
    switch (m[2]) {
      case 'h':
        total += v * 3600_000;
        break;
      case 'm':
        total += v * 60_000;
        break;
      case 's':
        total += v * 1000;
        break;
      case 'ms':
        total += v;
        break;
    }
  }
  return matched ? Math.round(total) : undefined;
}

function headerGetter(headers: Headers | Record<string, string> | undefined) {
  return (name: string): string | undefined => {
    if (!headers) return undefined;
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
    const rec = headers as Record<string, string>;
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? rec[key] : undefined;
  };
}

/** Reads Retry-After style headers. */
export function retryAfterFromHeaders(headers: Headers | Record<string, string> | undefined): number | undefined {
  const get = headerGetter(headers);
  const ms = get('retry-after-ms');
  if (ms && !isNaN(Number(ms))) return Number(ms);
  const ra = get('retry-after');
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Number(ra) * 1000;
    const date = Date.parse(ra);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset);
    // OpenRouter uses epoch milliseconds; some use epoch seconds; others seconds-from-now.
    if (n > 1e12) return Math.max(0, n - Date.now());
    if (n > 1e9) return Math.max(0, n * 1000 - Date.now());
    return n * 1000;
  }
  return undefined;
}

/** Extracts remaining/reset counters from x-ratelimit-* headers (Groq, Cerebras, OpenAI, Mistral...). */
export function rateLimitFromHeaders(headers: Headers | Record<string, string> | undefined): RateLimitSnapshot | undefined {
  const get = headerGetter(headers);
  const num = (name: string) => {
    const v = get(name);
    return v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined;
  };
  const dur = (name: string) => {
    const v = get(name);
    return v ? parseDurationMs(v) : undefined;
  };
  const snap: RateLimitSnapshot = {
    remainingRequests: num('x-ratelimit-remaining-requests') ?? num('x-ratelimit-remaining-requests-minute') ?? num('x-ratelimit-remaining'),
    remainingTokens: num('x-ratelimit-remaining-tokens') ?? num('x-ratelimit-remaining-tokens-minute'),
    resetRequestsMs: dur('x-ratelimit-reset-requests') ?? dur('x-ratelimit-reset-requests-minute'),
    resetTokensMs: dur('x-ratelimit-reset-tokens') ?? dur('x-ratelimit-reset-tokens-minute'),
    remainingRequestsDay: num('x-ratelimit-remaining-requests-day'),
    resetRequestsDayMs: dur('x-ratelimit-reset-requests-day'),
    remainingTokensDay: num('x-ratelimit-remaining-tokens-day'),
    resetTokensDayMs: dur('x-ratelimit-reset-tokens-day'),
  };
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

/** Pulls a human readable message out of the many error body shapes providers use. */
export function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    let parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) parsed = parsed[0];
    const p = parsed as Record<string, unknown>;
    const err = (p?.error ?? p) as Record<string, unknown> | string;
    if (typeof err === 'string') return err;
    let msg = (err?.message ?? err?.detail ?? err?.msg ?? p?.message ?? p?.detail) as unknown;
    if (Array.isArray(msg)) msg = msg.map((m) => (typeof m === 'string' ? m : (m as { msg?: string }).msg ?? JSON.stringify(m))).join('; ');
    if (typeof msg === 'object' && msg) msg = JSON.stringify(msg);
    const meta = (err?.metadata as Record<string, unknown> | undefined)?.raw;
    let out = typeof msg === 'string' ? msg : text;
    if (typeof meta === 'string' && meta && !out.includes(meta)) out += ` (${meta.slice(0, 300)})`;
    return out;
  } catch {
    // HTML error pages etc.
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }
}

/** Retry delay embedded in an error message ("try again in 5.285s", "retry in 34.6s", "retryDelay": "34s"). */
export function retryDelayFromMessage(text: string): number | undefined {
  const patterns = [
    /try again in\s+([\d.]+\s*(?:ms|h|m|s)(?:[\d.]+\s*(?:ms|h|m|s))*)/i,
    /retry (?:in|after)\s+([\d.]+\s*(?:ms|h|m|s|seconds?|minutes?)(?:[\d.]+\s*(?:ms|h|m|s))*)/i,
    /"retryDelay"\s*:\s*"([\d.]+s)"/i,
    /wait\s+([\d.]+)\s*(?:seconds?|s)\b/i,
    /in\s+([\d.]+)\s*seconds?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const raw = m[1]!.replace(/seconds?/, 's').replace(/minutes?/, 'm');
      const ms = parseDurationMs(raw);
      if (ms !== undefined) return ms;
    }
  }
  // OpenRouter embeds X-RateLimit-Reset (epoch ms) in metadata.headers
  const reset = /"X-RateLimit-Reset"\s*:\s*"?(\d{12,})"?/i.exec(text);
  if (reset) return Math.max(0, Number(reset[1]) - Date.now());
  return undefined;
}

const DAILY_RE = /per[ -]?day|daily|\bRPD\b|\bTPD\b|PerDay|free-models-per-day|requests per day|tokens per day|day limit|24 ?hours/i;
const MONTHLY_RE = /per[ -]?month|monthly|\bmonth\b/i;
const CREDIT_RE = /insufficient[_ ]?(quota|credits?|balance|funds)|credit balance|out of credits|exceeded your current quota|billing|payment required|no credits|add credits|purchase credits|account balance|requires more credits|afford/i;
const CONTEXT_RE = /context[_ ]?(length|window)|maximum context|max(imum)? (context )?tokens?.*(exceed|limit)|too many tokens|prompt is too long|reduce the length|input.{0,20}too long|exceeds? the (model'?s? )?(context|maximum|limit)|input_too_long|string too long|maximum allowed (length|tokens)|token limit|too long for|is longer than the model|prompt tokens.{0,40}exceed|context size/i;
const TOOLS_RE = /(does not|doesn't|do not) support (tools|tool use|tool calling|function calling|functions)|tools? (are|is) not supported|tool[_ ]choice.{0,40}(not supported|unsupported|invalid)|function calling is not (enabled|supported)|tool use is not supported|not support tool|tools.{0,20}(not allowed|not permitted|unsupported)|unrecognized request argument.{0,30}tools|extra (inputs|fields).{0,40}tools|no endpoints found that support tool use/i;
const SYSTEM_ROLE_RE = /(developer|system) (instruction|message|role).{0,40}(not (enabled|supported|allowed))|system role.{0,30}not supported/i;

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retryAfterMs?: number;
  limitTokens?: number;
  systemRoleUnsupported?: boolean;
}

export function classifyHttpError(status: number, body: string, headers?: Headers | Record<string, string>): ClassifiedError {
  const message = extractErrorMessage(body) || `HTTP ${status}`;
  const hay = `${message} ${body.slice(0, 4000)}`;
  const retryAfterMs = retryAfterFromHeaders(headers) ?? retryDelayFromMessage(hay);
  const limitMatch = /Limit\s+(\d+),\s*(?:Used\s+\d+,\s*)?Requested\s+(\d+)/i.exec(hay);
  const limitTokens = limitMatch ? Number(limitMatch[1]) : undefined;

  const looksLimited = /rate.?limit|too many requests|RESOURCE_EXHAUSTED|quota/i.test(hay);
  if (status === 429 || (looksLimited && (status === 403 || status === 503))) {
    if (/request too large|reduce your message size/i.test(hay)) return { kind: 'too_large', message, retryAfterMs, limitTokens };
    // "limit: 0": this model has no free quota at all (e.g. Gemini Pro on a free key); waiting won't help.
    if (/\blimit:?\s*0\b/i.test(hay)) return { kind: 'quota', message, limitTokens };
    if (DAILY_RE.test(hay) || MONTHLY_RE.test(hay)) return { kind: 'quota', message, retryAfterMs, limitTokens };
    if (/PerMinute|per[ -]minute|\bRPM\b|\bTPM\b|per-min\b|temporarily rate-limited|retry shortly/i.test(hay)) {
      return { kind: 'rate_limit', message, retryAfterMs, limitTokens };
    }
    if (CREDIT_RE.test(hay)) return { kind: 'quota', message, retryAfterMs, limitTokens };
    return { kind: 'rate_limit', message, retryAfterMs, limitTokens };
  }
  if (status === 402 || (CREDIT_RE.test(hay) && status !== 400)) return { kind: 'quota', message, retryAfterMs };
  if (status === 413) {
    return { kind: /TPM|tokens per minute|rate limit/i.test(hay) ? 'too_large' : 'context_length', message, retryAfterMs, limitTokens };
  }
  if (status === 401) return { kind: 'auth', message };
  if (status === 403) {
    if (/model|not available|not allowed to access|access to model|region|country|unsupported_country/i.test(hay) && !/api key|token/i.test(message.toLowerCase())) {
      return { kind: 'forbidden_model', message };
    }
    return { kind: 'auth', message };
  }
  if (status === 404) return { kind: 'not_found', message };
  if (status === 408 || status === 504 || status === 524) return { kind: 'timeout', message, retryAfterMs };
  if (status >= 500) {
    if (CONTEXT_RE.test(hay)) return { kind: 'context_length', message };
    return { kind: 'server', message, retryAfterMs };
  }
  if (status === 400 || status === 422 || status === 409) {
    if (TOOLS_RE.test(hay)) return { kind: 'tools_unsupported', message };
    if (CONTEXT_RE.test(hay)) return { kind: 'context_length', message, limitTokens: parseContextLimit(hay) };
    if (SYSTEM_ROLE_RE.test(hay)) return { kind: 'bad_request', message, systemRoleUnsupported: true };
    if (/model.{0,40}(does not exist|not found|is not available|not supported|decommissioned|deprecated|no longer)|invalid model|unknown model|model_not_found/i.test(hay)) {
      return { kind: 'not_found', message };
    }
    if (/content.?(filter|policy|management)|safety|flagged|moderation/i.test(hay)) return { kind: 'content_filter', message };
    if (/rate.?limit/i.test(hay)) return { kind: 'rate_limit', message, retryAfterMs };
    return { kind: 'bad_request', message };
  }
  return { kind: 'unknown', message, retryAfterMs };
}

/** "maximum context length is 32768 tokens" -> 32768 */
export function parseContextLimit(text: string): number | undefined {
  const m =
    /maximum context length is\s+(\d+)/i.exec(text) ||
    /context (?:length|window) (?:of|is)\s+(\d+)/i.exec(text) ||
    /max(?:imum)?(?: input)? tokens?(?: is| of|:)?\s+(\d{4,})/i.exec(text) ||
    /limit (?:of |is )?(\d{4,}) tokens/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Maps low level fetch/network failures to an ErrorKind. */
export function classifyNetworkError(e: unknown): ClassifiedError {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'AbortError') return { kind: 'aborted', message: 'Aborted' };
  if (err?.name === 'TimeoutError') return { kind: 'timeout', message: 'Request timed out' };
  const code = err?.cause?.code || err?.code || '';
  const msg = err?.cause?.message || err?.message || String(e);
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/.test(code)) return { kind: 'timeout', message: `${code}: ${msg}` };
  return { kind: 'network', message: code ? `${code}: ${msg}` : msg };
}

/** Errors that should make the router try the request somewhere else. */
export function isFailoverKind(kind: ErrorKind): boolean {
  return kind !== 'aborted' && kind !== 'content_filter';
}

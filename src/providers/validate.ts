// Checks that an API key works, using the cheapest call each provider offers.
import type { ProviderDef, ProviderRuntime } from './types.js';
import { buildModel_forValidation } from './validateHelpers.js';
import { chatCompletion, fetchModelList } from './client.js';
import { ProviderError } from './errors.js';

export interface KeyCheck {
  ok: boolean;
  /** Key is valid but the provider is rate limiting right now. */
  limited?: boolean;
  message: string;
  models?: number;
}

function runtimeFor(def: ProviderDef, key: string, accountId?: string, baseURL?: string): ProviderRuntime {
  let url = (baseURL || def.baseURL).replace(/\/+$/, '');
  if (url.includes('{accountId}')) url = url.replace('{accountId}', accountId ?? '');
  return {
    def,
    id: def.id,
    name: def.name,
    baseURL: url,
    apiKeys: [key],
    headers: { ...(def.headers ?? {}) },
    configured: true,
    enabled: true,
    paid: def.kind === 'paid',
    kind: def.kind,
    priority: 0,
    limits: def.limits ?? {},
    models: [],
  };
}

function describe(e: unknown): KeyCheck {
  if (e instanceof ProviderError) {
    if (e.kind === 'auth' || e.status === 401) return { ok: false, message: 'The key was rejected (invalid or revoked).' };
    if (e.status === 403) return { ok: false, message: `Access denied: ${e.message.slice(0, 160)}` };
    if (e.kind === 'rate_limit' || e.kind === 'quota') return { ok: true, limited: true, message: 'Key accepted (the provider is rate limiting right now, FreeCode will retry later).' };
    if (e.kind === 'network' || e.kind === 'timeout') return { ok: false, message: `Could not reach the provider: ${e.message.slice(0, 160)}` };
    return { ok: false, message: e.message.slice(0, 200) };
  }
  return { ok: false, message: (e as Error)?.message ?? String(e) };
}

export async function checkKey(def: ProviderDef, key: string, opts: { accountId?: string; baseURL?: string } = {}): Promise<KeyCheck> {
  const rt = runtimeFor(def, key, opts.accountId, opts.baseURL);
  // OpenRouter's model list is public, so check the key endpoint instead.
  if (def.id === 'openrouter') {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'The key was rejected (invalid or revoked).' };
      if (!res.ok) return { ok: false, message: `OpenRouter answered HTTP ${res.status}` };
      return { ok: true, message: 'Key works.' };
    } catch (e) {
      return describe(e);
    }
  }
  if (def.api === 'ollama') {
    try {
      const root = rt.baseURL.replace(/\/v1$/, '');
      const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as { models?: unknown[] };
      return { ok: true, message: `Ollama is running with ${json.models?.length ?? 0} model(s).`, models: json.models?.length };
    } catch {
      return { ok: false, message: 'Ollama is not running (start it with `ollama serve`).' };
    }
  }
  try {
    const list = await fetchModelList(rt, key, 10000);
    if (list.length) return { ok: true, message: `Key works (${list.length} models available).`, models: list.length };
  } catch (e) {
    const err = e as ProviderError;
    if (err instanceof ProviderError && (err.kind === 'auth' || err.status === 401 || err.status === 403)) return describe(e);
    // Some providers have no /models endpoint: fall through to a tiny chat request.
  }
  const seed = def.models[0];
  if (!seed) return { ok: true, message: 'Saved (this provider has no cheap way to verify keys).' };
  try {
    await chatCompletion({
      provider: rt,
      model: buildModel_forValidation(def, seed.id),
      apiKey: key,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      toolMode: 'native',
      maxTokens: 5,
      stream: false,
      headersTimeoutMs: 20000,
      idleTimeoutMs: 20000,
    });
    return { ok: true, message: 'Key works.' };
  } catch (e) {
    const err = e as ProviderError;
    if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'bad_request' || err.kind === 'forbidden_model')) {
      return { ok: true, message: 'Key accepted (test model unavailable, other models will be tried).' };
    }
    return describe(e);
  }
}

// Live model discovery: asks each provider which models it currently offers (free model line-ups
// change constantly), caching the answer for a day.
import type { DiscoveredModel, ProviderRuntime } from './types.js';
import { estimateModel, isChatModelId } from './modelInfo.js';
import { fetchModelList } from './client.js';
import { type DiscoveryCache, loadDiscoveryCache, saveDiscoveryCache } from './registry.js';
import { mapLimit } from '../util/async.js';
import { debug } from '../util/log.js';

const DAY = 24 * 3600 * 1000;

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && isFinite(n) && n > 0 ? n : undefined;
}

/** Normalizes one entry of a /models response. */
export function normalizeModelEntry(raw: Record<string, unknown>, stripPrefix?: string): DiscoveredModel | null {
  let id = String(raw.id ?? raw.name ?? raw.model ?? '');
  if (!id) return null;
  if (stripPrefix && id.startsWith(stripPrefix)) id = id.slice(stripPrefix.length);
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
  const topProvider = (raw.top_provider ?? {}) as Record<string, unknown>;
  const context =
    num(raw.context_length) ??
    num(raw.context_window) ??
    num(raw.max_context_length) ??
    num(raw.max_model_len) ??
    num(raw.inputTokenLimit) ??
    num(raw.input_token_limit) ??
    num(topProvider.context_length) ??
    num((raw.limits as Record<string, unknown> | undefined)?.max_input_tokens);
  const maxOutput = num(topProvider.max_completion_tokens) ?? num(raw.max_output_tokens) ?? num(raw.outputTokenLimit) ?? num(raw.max_completion_tokens);
  let tools: boolean | undefined;
  if (typeof caps.function_calling === 'boolean') tools = caps.function_calling;
  else if (typeof caps.tool_calling === 'boolean') tools = caps.tool_calling;
  else if (Array.isArray(raw.supported_parameters)) tools = (raw.supported_parameters as string[]).includes('tools');
  else if (Array.isArray(raw.capabilities)) tools = (raw.capabilities as string[]).includes('tools');
  let vision: boolean | undefined;
  if (typeof caps.vision === 'boolean') vision = caps.vision;
  const arch = raw.architecture as { input_modalities?: string[]; output_modalities?: string[] } | undefined;
  if (arch?.input_modalities) vision = arch.input_modalities.includes('image');
  if (arch?.output_modalities && !arch.output_modalities.includes('text')) return null;
  if (caps.completion_chat === false) return null;
  // OpenRouter-style "pricing": { prompt, completion } or flat input_price / output_price fields.
  const pricing = raw.pricing as Record<string, unknown> | undefined;
  const inPrice = pricing ? (pricing.prompt ?? pricing.input) : raw.input_price;
  const outPrice = pricing ? (pricing.completion ?? pricing.output) : raw.output_price;
  let free: boolean | undefined;
  if (inPrice !== undefined || outPrice !== undefined) free = Number(inPrice ?? NaN) === 0 && Number(outPrice ?? NaN) === 0;
  if (id.endsWith(':free')) free = true;
  const deprecated = !!(raw.deprecation || raw.deprecated || raw.deprecation_date);
  return { id, name: typeof raw.name === 'string' && raw.name !== id ? String(raw.name) : undefined, context, maxOutput, tools, vision, free, deprecated };
}

async function discoverOllama(p: ProviderRuntime): Promise<DiscoveredModel[]> {
  const root = p.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
  // Ollama Cloud (ollama.com) needs the key and reports each model's real context; local servers answer fast.
  const cloud = p.kind !== 'local';
  const headers: Record<string, string> = cloud && p.apiKeys[0] ? { Authorization: `Bearer ${p.apiKeys[0]}` } : {};
  const tags = await fetch(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(cloud ? 10000 : 2500) });
  if (!tags.ok) throw new Error(`Ollama /api/tags HTTP ${tags.status}`);
  const json = (await tags.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
  let names = (json.models ?? []).map((m) => m.name).filter((n) => isChatModelId(n));
  // A cloud catalog is long: keep the strongest models that pass the bar, not the first ones listed.
  const min = p.def.discovery?.minQuality;
  if (min) names = names.filter((n) => estimateModel(n).quality >= min);
  if (cloud) names.sort((a, b) => estimateModel(b).quality - estimateModel(a).quality);
  const localCtx = Number(process.env.FREECODE_OLLAMA_CONTEXT || 32768);
  return mapLimit(names.slice(0, p.def.discovery?.limit ?? 30), 4, async (name) => {
    let tools: boolean | undefined;
    let vision: boolean | undefined;
    let context = localCtx;
    try {
      const show = await fetch(`${root}/api/show`, { method: 'POST', headers, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(cloud ? 10000 : 4000) });
      if (show.ok) {
        const info = (await show.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
        if (Array.isArray(info.capabilities)) {
          tools = info.capabilities.includes('tools');
          vision = info.capabilities.includes('vision');
        }
        const ctxKey = Object.keys(info.model_info ?? {}).find((k) => k.endsWith('.context_length'));
        const trained = ctxKey ? Number(info.model_info![ctxKey]) : undefined;
        if (trained && trained > 0) context = cloud ? trained : Math.min(trained, localCtx);
      }
    } catch {
      // keep defaults
    }
    return { id: name, context, tools, vision, maxOutput: cloud ? Math.min(32768, Math.floor(context / 4)) : Math.min(8192, Math.floor(context / 2)) };
  });
}

/** Queries one provider for its current models. */
export async function discoverProvider(p: ProviderRuntime): Promise<DiscoveredModel[]> {
  const d = p.def.discovery;
  if (!d || d.type === 'none') return [];
  if (d.type === 'ollama') return discoverOllama(p);
  const key = p.apiKeys[0] ?? '';
  let list: Record<string, unknown>[];
  if (d.type === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'FreeCode' } });
    if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Record<string, unknown>[] };
    list = json.data ?? [];
  } else {
    list = await fetchModelList(p, key, 10000);
  }
  let models = list.map((r) => normalizeModelEntry(r, p.def.quirks?.stripModelPrefix)).filter((m): m is DiscoveredModel => !!m);
  models = models.filter((m) => isChatModelId(m.id));
  if (d.freeOnly) models = models.filter((m) => m.free === true);
  if (d.filter) models = models.filter(d.filter);
  if (d.minQuality) models = models.filter((m) => estimateModel(m.id).quality >= d.minQuality!);
  // Prefer tool-capable, strong models when trimming.
  models.sort((a, b) => score(b) - score(a));
  if (d.limit) models = models.slice(0, d.limit);
  return models;
}

function score(m: DiscoveredModel): number {
  return estimateModel(m.id).quality + (m.tools === false ? -15 : 0) + (m.deprecated ? -30 : 0);
}

export interface DiscoveryReport {
  provider: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** Refreshes the discovery cache for providers that need it. */
export async function refreshDiscovery(
  providers: ProviderRuntime[],
  opts: { force?: boolean; maxAgeMs?: number; only?: string[] } = {},
): Promise<{ cache: DiscoveryCache; reports: DiscoveryReport[] }> {
  const cache = loadDiscoveryCache();
  const maxAge = opts.maxAgeMs ?? DAY;
  const targets = providers.filter((p) => {
    if (opts.only && !opts.only.includes(p.id)) return false;
    const d = p.def.discovery;
    if (!d || d.type === 'none') return false;
    if (!p.configured && !d.public) return false;
    if (p.unavailableReason && p.def.keyRequired) return false;
    if (p.def.kind === 'local') return true; // cheap: always refresh local servers
    if (p.def.keyRequired && !p.configured) return false;
    const entry = cache.providers[p.id];
    if (opts.force) return true;
    if (!entry) return true;
    const age = Date.now() - entry.fetchedAt;
    return entry.error ? age > 3600_000 : age > maxAge;
  });
  const reports = await mapLimit(targets, 6, async (p): Promise<DiscoveryReport> => {
    try {
      const models = await discoverProvider(p);
      cache.providers[p.id] = { fetchedAt: Date.now(), models };
      debug('discovery', `${p.id}: ${models.length} models`);
      return { provider: p.id, ok: true, count: models.length };
    } catch (e) {
      const msg = (e as Error).message;
      debug('discovery', `${p.id} failed: ${msg}`);
      const prev = cache.providers[p.id];
      // Keep the previous model list on failure; local servers that are down have no models.
      cache.providers[p.id] = { fetchedAt: Date.now(), models: p.def.kind === 'local' ? [] : prev?.models ?? [], error: msg };
      return { provider: p.id, ok: false, count: 0, error: msg };
    }
  });
  if (targets.length) saveDiscoveryCache(cache);
  return { cache, reports };
}

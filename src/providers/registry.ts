// Builds the live list of providers and models from the catalog, user settings, env keys and the
// discovery cache.
import type { DiscoveredModel, ModelInfo, ProviderDef, ProviderRuntime, SeedModel } from './types.js';
import type { ModelUserConfig, ProviderUserConfig, Settings } from '../config/config.js';
import { PROVIDERS } from './catalog.js';
import { estimateModel } from './modelInfo.js';
import { readJsonSync, writeJsonSync } from '../util/fs.js';
import { globalPaths } from '../config/paths.js';

export interface DiscoveryCacheEntry {
  fetchedAt: number;
  models: DiscoveredModel[];
  error?: string;
}

export interface DiscoveryCache {
  version: 1;
  providers: Record<string, DiscoveryCacheEntry>;
}

export function loadDiscoveryCache(): DiscoveryCache {
  const c = readJsonSync<DiscoveryCache>(globalPaths.modelsCacheFile, { version: 1, providers: {} });
  if (!c.providers) c.providers = {};
  return c;
}

export function saveDiscoveryCache(cache: DiscoveryCache): void {
  try {
    writeJsonSync(globalPaths.modelsCacheFile, cache);
  } catch {
    // cache is optional
  }
}

function envValue(names: string[] | undefined, dotenv: Record<string, string>): string | undefined {
  for (const n of names ?? []) {
    const v = process.env[n] ?? dotenv[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function resolveApiKeys(def: ProviderDef, cfg: ProviderUserConfig | undefined, dotenv: Record<string, string>): string[] {
  const keys: string[] = [];
  for (const k of cfg?.apiKeys ?? []) if (k && k.trim()) keys.push(k.trim());
  if (cfg?.apiKey && cfg.apiKey.trim()) keys.push(cfg.apiKey.trim());
  for (const n of def.keyEnv) {
    const v = process.env[n] ?? dotenv[n];
    if (v && v.trim()) keys.push(v.trim());
  }
  return [...new Set(keys)];
}

function normalizeBaseURL(def: ProviderDef, cfg: ProviderUserConfig | undefined, dotenv: Record<string, string>): string {
  let url = cfg?.baseURL || '';
  if (!url && def.baseURLEnv) {
    const env = envValue([def.baseURLEnv], dotenv);
    if (env) {
      url = /^https?:\/\//.test(env) ? env : `http://${env}`;
      if (def.id === 'ollama' && !/\/v1\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/v1';
    }
  }
  return (url || def.baseURL).replace(/\/+$/, '');
}

function userModelList(cfg: ProviderUserConfig | undefined): ModelUserConfig[] {
  if (!cfg?.models) return [];
  if (Array.isArray(cfg.models)) return cfg.models;
  return Object.entries(cfg.models).map(([id, v]) => ({ ...v, id }));
}

function buildModel(def: ProviderDef, seed: SeedModel | undefined, disc: DiscoveredModel | undefined, user: ModelUserConfig | undefined, paid: boolean, source: ModelInfo['source']): ModelInfo {
  const id = (user?.id ?? seed?.id ?? disc?.id)!;
  const est = estimateModel(id);
  const toolPref = user?.tools ?? seed?.tools;
  let toolMode: ModelInfo['toolMode'];
  if (toolPref === 'text' || toolPref === 'none') toolMode = 'text';
  else if (toolPref === 'native') toolMode = 'native';
  else if (disc?.tools === false) toolMode = 'text';
  else if (disc?.tools === true) toolMode = 'native';
  else toolMode = est.textTools ? 'text' : 'native';
  const context = user?.context ?? seed?.context ?? disc?.context ?? est.context;
  const maxOutput = user?.maxOutput ?? seed?.maxOutput ?? disc?.maxOutput ?? Math.min(16384, Math.max(2048, Math.floor(context / 4)));
  return {
    key: `${def.id}/${id}`,
    providerId: def.id,
    id,
    name: user?.name ?? seed?.name ?? disc?.name ?? id,
    context,
    maxOutput,
    toolMode,
    quality: user?.quality ?? seed?.quality ?? est.quality,
    speed: user?.speed ?? seed?.speed ?? def.speed ?? 50,
    reasoning: user?.reasoning ?? seed?.reasoning ?? est.reasoning,
    vision: user?.vision ?? seed?.vision ?? disc?.vision ?? est.vision,
    limits: { ...(seed?.limits ?? {}), ...(user?.limits ?? {}) },
    extraBody: user?.extraBody ?? seed?.extraBody,
    roles: seed?.roles ?? [],
    source,
    enabled: user?.enabled !== false,
    priority: user?.priority ?? 0,
    paid,
    noSystemRole: seed?.noSystemRole ?? /gemma-?3/i.test(id),
  };
}

function customProviderDef(id: string, cfg: ProviderUserConfig): ProviderDef {
  return {
    id,
    name: cfg.name ?? id,
    baseURL: cfg.baseURL ?? '',
    keyEnv: [],
    keyRequired: false,
    signupUrl: '',
    freeTier: cfg.paid ? 'Custom (paid)' : 'Custom provider',
    kind: cfg.paid ? 'paid' : 'free',
    models: [],
    discovery: { type: cfg.discover === false ? 'none' : 'openai', public: true, limit: 50 },
    speed: 50,
  };
}

/** Builds runtime provider objects. */
export function buildProviders(settings: Settings, dotenv: Record<string, string>, cache: DiscoveryCache = loadDiscoveryCache()): ProviderRuntime[] {
  const out: ProviderRuntime[] = [];
  const defs: ProviderDef[] = [...PROVIDERS];
  for (const [id, cfg] of Object.entries(settings.providers ?? {})) {
    if (!defs.some((d) => d.id === id) && cfg?.baseURL) defs.push(customProviderDef(id, cfg));
  }
  for (const def of defs) {
    const cfg = settings.providers?.[def.id];
    const keys = resolveApiKeys(def, cfg, dotenv);
    let baseURL = normalizeBaseURL(def, cfg, dotenv);
    let unavailableReason: string | undefined;
    if (baseURL.includes('{accountId}')) {
      const acct = cfg?.accountId || envValue(def.accountIdEnv, dotenv);
      if (acct) baseURL = baseURL.replace('{accountId}', acct);
      else unavailableReason = `needs an account id (${(def.accountIdEnv ?? []).join(' or ')})`;
    }
    const hasKey = keys.length > 0;
    const configured = !unavailableReason && (hasKey || !def.keyRequired);
    if (!hasKey && def.keyRequired && !unavailableReason) unavailableReason = `no API key (set ${def.keyEnv[0] ?? 'apiKey'} or run /setup)`;
    const apiKeys = hasKey ? keys : def.anonymousKey !== undefined ? [def.anonymousKey] : [''];
    const paid = cfg?.paid ?? def.kind === 'paid';

    // Models
    const disc = cache.providers[def.id];
    const discovered = disc?.models ?? [];
    const discById = new Map(discovered.map((m) => [m.id, m]));
    const userModels = userModelList(cfg);
    const userById = new Map(userModels.map((m) => [m.id, m]));
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    const discoveryAuthoritative = discovered.length > 0 && (def.discovery?.type === 'openrouter' || def.discovery?.freeOnly === true);
    for (const seed of def.models) {
      const m = buildModel(def, seed, discById.get(seed.id), userById.get(seed.id), paid, 'seed');
      if (discoveryAuthoritative && !discById.has(seed.id) && !userById.has(seed.id) && seed.id !== 'openrouter/free') {
        m.enabled = false; // no longer offered for free
      }
      if (discById.get(seed.id)?.deprecated) m.enabled = false;
      models.push(m);
      seen.add(seed.id);
    }
    for (const d of discovered) {
      if (seen.has(d.id)) continue;
      models.push(buildModel(def, undefined, d, userById.get(d.id), paid, 'discovered'));
      seen.add(d.id);
    }
    for (const u of userModels) {
      if (seen.has(u.id)) continue;
      models.push(buildModel(def, undefined, discById.get(u.id), u, paid, 'user'));
      seen.add(u.id);
    }
    out.push({
      def,
      id: def.id,
      name: cfg?.name ?? def.name,
      baseURL,
      apiKeys,
      headers: { ...(def.headers ?? {}), ...(cfg?.headers ?? {}) },
      configured,
      enabled: cfg?.enabled !== false && configured,
      paid,
      kind: def.kind,
      priority: cfg?.priority ?? 0,
      limits: { ...(def.limits ?? {}), ...(cfg?.limits ?? {}) },
      models,
      unavailableReason: cfg?.enabled === false ? 'disabled in config' : unavailableReason,
    });
  }
  return out;
}

/** Finds a model by "provider/model", by bare model id, or by a unique substring. */
export function findModel(providers: ProviderRuntime[], query: string): { provider: ProviderRuntime; model: ModelInfo } | null {
  const q = query.trim();
  const slash = q.indexOf('/');
  if (slash > 0) {
    const pid = q.slice(0, slash);
    const mid = q.slice(slash + 1);
    const p = providers.find((x) => x.id === pid);
    if (p) {
      const m = p.models.find((x) => x.id === mid) ?? p.models.find((x) => x.id.toLowerCase() === mid.toLowerCase());
      if (m) return { provider: p, model: m };
    }
  }
  for (const p of providers) {
    const m = p.models.find((x) => x.id === q || x.key === q);
    if (m) return { provider: p, model: m };
  }
  const lower = q.toLowerCase();
  const hits: { provider: ProviderRuntime; model: ModelInfo }[] = [];
  for (const p of providers) for (const m of p.models) if (m.key.toLowerCase().includes(lower)) hits.push({ provider: p, model: m });
  const usable = hits.filter((h) => h.provider.enabled && h.model.enabled);
  if (usable.length >= 1) return usable.sort((a, b) => b.model.quality - a.model.quality)[0]!;
  return hits[0] ?? null;
}

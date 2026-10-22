// Runtime knowledge about every model/provider: cooldowns, learned limits, quotas used today,
// speed, reliability. Persisted to ~/.freecode/state/health.json so limits survive restarts.
import type { ModelInfo, ProviderRuntime, RateLimitSnapshot, ToolMode, Usage } from '../providers/types.js';
import type { ErrorKind } from '../providers/errors.js';
import { globalPaths } from '../config/paths.js';
import { readJsonSync, writeJsonSync } from '../util/fs.js';
import { shortHash } from '../util/strings.js';

export interface ModelHealth {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastError?: string;
  lastErrorKind?: ErrorKind;
  lastErrorAt?: number;
  lastSuccessAt?: number;
  /** Requests above this many input tokens fail on this model. */
  learnedMaxInput?: number;
  /** Learned tool calling mode (native rejected -> text). */
  toolMode?: ToolMode;
  /** Model rejects optional request fields. */
  needsMinimal?: boolean;
  /** Model rejects the system role. */
  noSystemRole?: boolean;
  /** Model unusable until this time (not found / forbidden). */
  disabledUntil?: number;
  disabledReason?: string;
  avgLatencyMs?: number;
  avgTtftMs?: number;
  tokensPerSec?: number;
}

export interface Cooldown {
  until: number;
  reason: string;
  kind: ErrorKind;
  /** Consecutive cooldowns, used for exponential backoff. */
  strikes: number;
}

export interface UsageDay {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

interface PersistedState {
  version: 1;
  models: Record<string, ModelHealth>;
  /** keyed by `${modelKey}#${keyId}` or `provider:${providerId}#${keyId}` */
  cooldowns: Record<string, Cooldown>;
  usage: Record<string, UsageDay>;
  /** month-level counters per provider: `${providerId}#${keyId}` */
  monthly: Record<string, { month: string; requests: number }>;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
}

export function keyId(apiKey: string): string {
  return apiKey ? shortHash(apiKey, 6) : 'anon';
}

export interface WaitInfo {
  waitMs: number;
  keyIndex: number;
  reason?: string;
}

export class HealthStore {
  private state: PersistedState;
  /** Sliding windows of recent requests: key -> [timestamp, tokens][] */
  private windows = new Map<string, [number, number][]>();
  private saveTimer: NodeJS.Timeout | null = null;
  private persist: boolean;

  constructor(opts: { persist?: boolean; initial?: PersistedState } = {}) {
    this.persist = opts.persist ?? true;
    this.state =
      opts.initial ??
      (this.persist
        ? readJsonSync<PersistedState>(globalPaths.healthFile, { version: 1, models: {}, cooldowns: {}, usage: {}, monthly: {} })
        : { version: 1, models: {}, cooldowns: {}, usage: {}, monthly: {} });
    this.state.models ??= {};
    this.state.cooldowns ??= {};
    this.state.usage ??= {};
    this.state.monthly ??= {};
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, c] of Object.entries(this.state.cooldowns)) if (c.until < now - 3600_000) delete this.state.cooldowns[k];
    const t = today();
    for (const [k, u] of Object.entries(this.state.usage)) if (u.day !== t) delete this.state.usage[k];
  }

  model(key: string): ModelHealth {
    let h = this.state.models[key];
    if (!h) {
      h = { successes: 0, failures: 0, consecutiveFailures: 0 };
      this.state.models[key] = h;
    }
    return h;
  }

  peekModel(key: string): ModelHealth | undefined {
    return this.state.models[key];
  }

  scheduleSave(): void {
    if (!this.persist) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1500);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    if (!this.persist) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      this.prune();
      writeJsonSync(globalPaths.healthFile, this.state);
    } catch {
      // state is best effort
    }
  }

  // ------------------------------------------------------------------ availability

  isDisabled(m: ModelInfo): boolean {
    const h = this.state.models[m.key];
    return !!(h?.disabledUntil && h.disabledUntil > Date.now());
  }

  effectiveToolMode(m: ModelInfo): ToolMode {
    return this.state.models[m.key]?.toolMode ?? m.toolMode;
  }

  /** Max input tokens the model accepts, taking learned limits and per-minute token caps into account. */
  maxInputTokens(p: ProviderRuntime, m: ModelInfo): number {
    let cap = m.context;
    const learned = this.state.models[m.key]?.learnedMaxInput;
    if (learned) cap = Math.min(cap, learned);
    const tpm = m.limits.tpm ?? p.limits.tpm;
    if (tpm) cap = Math.min(cap, tpm);
    return cap;
  }

  private cooldownFor(key: string): Cooldown | undefined {
    const c = this.state.cooldowns[key];
    if (c && c.until > Date.now()) return c;
    return undefined;
  }

  /** Remaining wait before this model can be called with any of the provider's keys. */
  waitInfo(p: ProviderRuntime, m: ModelInfo, estTokens = 0): WaitInfo {
    let best: WaitInfo = { waitMs: Infinity, keyIndex: 0 };
    const now = Date.now();
    p.apiKeys.forEach((key, i) => {
      const kid = keyId(key);
      let wait = 0;
      let reason: string | undefined;
      const consider = (ms: number, r: string) => {
        if (ms > wait) {
          wait = ms;
          reason = r;
        }
      };
      const pc = this.cooldownFor(`provider:${p.id}#${kid}`);
      if (pc) consider(pc.until - now, pc.reason);
      const mc = this.cooldownFor(`${m.key}#${kid}`);
      if (mc) consider(mc.until - now, mc.reason);
      // Pacing by known per-minute limits
      const rpm = m.limits.rpm;
      if (rpm) consider(this.windowWait(`${m.key}#${kid}`, rpm, 0, 0), `pacing ${rpm} req/min`);
      const prpm = p.limits.rpm;
      if (prpm) consider(this.windowWait(`provider:${p.id}#${kid}`, prpm, 0, 0), `pacing ${prpm} req/min`);
      const tpm = m.limits.tpm ?? p.limits.tpm;
      if (tpm && estTokens) consider(this.windowWait(`${m.key}#${kid}`, Infinity, tpm, estTokens), `token pacing ${tpm}/min`);
      // Monthly request cap (e.g. Cohere trial)
      const monthCap = m.limits.rpmonth ?? p.limits.rpmonth;
      if (monthCap) {
        const mon = this.state.monthly[`${p.id}#${kid}`];
        if (mon && mon.month === thisMonth() && mon.requests >= monthCap) consider(30 * 24 * 3600_000, 'monthly quota used');
      }
      if (wait < best.waitMs) best = { waitMs: wait, keyIndex: i, reason };
    });
    if (best.waitMs === Infinity) best.waitMs = 0;
    return best;
  }

  private windowWait(key: string, maxReq: number, maxTokens: number, estTokens: number): number {
    const w = this.windows.get(key);
    if (!w || !w.length) return 0;
    const now = Date.now();
    const recent = w.filter(([t]) => now - t < 60_000);
    this.windows.set(key, recent);
    if (recent.length >= maxReq) return recent[recent.length - maxReq]![0] + 60_000 - now + 50;
    if (maxTokens && maxTokens !== Infinity) {
      let used = recent.reduce((a, [, n]) => a + n, 0);
      if (used + estTokens <= maxTokens) return 0;
      // wait until enough tokens age out
      for (const [t, n] of recent) {
        used -= n;
        if (used + estTokens <= maxTokens) return t + 60_000 - now + 50;
      }
    }
    return 0;
  }

  /** Fraction (0..1) of the known daily request quota already used. */
  dailyUsedFraction(p: ProviderRuntime, m: ModelInfo): number {
    let frac = 0;
    const kid = keyId(p.apiKeys[0] ?? '');
    const md = this.state.usage[`${m.key}#${kid}`];
    if (m.limits.rpd && md?.day === today()) frac = Math.max(frac, md.requests / m.limits.rpd);
    if (m.limits.tpd && md?.day === today()) frac = Math.max(frac, (md.promptTokens + md.completionTokens) / m.limits.tpd);
    const pd = this.state.usage[`provider:${p.id}#${kid}`];
    if (p.limits.rpd && pd?.day === today()) frac = Math.max(frac, pd.requests / p.limits.rpd);
    if (p.limits.tpd && pd?.day === today()) frac = Math.max(frac, (pd.promptTokens + pd.completionTokens) / p.limits.tpd);
    return Math.min(1, frac);
  }

  usageToday(key: string): UsageDay | undefined {
    const u = this.state.usage[key];
    return u?.day === today() ? u : undefined;
  }

  /** All usage rows for today, for /usage. */
  allUsageToday(): Record<string, UsageDay> {
    const t = today();
    const out: Record<string, UsageDay> = {};
    for (const [k, u] of Object.entries(this.state.usage)) if (u.day === t) out[k] = u;
    return out;
  }

  activeCooldowns(): { key: string; cooldown: Cooldown }[] {
    const now = Date.now();
    return Object.entries(this.state.cooldowns)
      .filter(([, c]) => c.until > now)
      .map(([key, cooldown]) => ({ key, cooldown }));
  }

  // ------------------------------------------------------------------ recording

  recordRequestStart(p: ProviderRuntime, m: ModelInfo, keyIndex: number, estTokens: number): void {
    const kid = keyId(p.apiKeys[keyIndex] ?? '');
    const now = Date.now();
    for (const k of [`${m.key}#${kid}`, `provider:${p.id}#${kid}`]) {
      const w = this.windows.get(k) ?? [];
      w.push([now, estTokens]);
      this.windows.set(k, w.slice(-200));
    }
  }

  recordSuccess(p: ProviderRuntime, m: ModelInfo, keyIndex: number, info: { usage?: Usage; estTokens: number; latencyMs: number; ttftMs?: number; outputChars: number; rateLimit?: RateLimitSnapshot }): void {
    const h = this.model(m.key);
    h.successes++;
    h.consecutiveFailures = 0;
    h.lastSuccessAt = Date.now();
    const ewma = (old: number | undefined, v: number) => (old === undefined ? v : old * 0.7 + v * 0.3);
    h.avgLatencyMs = ewma(h.avgLatencyMs, info.latencyMs);
    if (info.ttftMs !== undefined) h.avgTtftMs = ewma(h.avgTtftMs, info.ttftMs);
    const outTokens = info.usage?.completionTokens ?? Math.ceil(info.outputChars / 3.5);
    const genMs = info.latencyMs - (info.ttftMs ?? 0);
    if (outTokens > 50 && genMs > 200) h.tokensPerSec = ewma(h.tokensPerSec, (outTokens / genMs) * 1000);
    // A success proves the learned input limit is at least this big.
    if (h.learnedMaxInput && info.estTokens > h.learnedMaxInput) h.learnedMaxInput = Math.ceil(info.estTokens * 1.05);
    const kid = keyId(p.apiKeys[keyIndex] ?? '');
    // Clear backoff strikes after success
    for (const k of [`${m.key}#${kid}`, `provider:${p.id}#${kid}`]) {
      const c = this.state.cooldowns[k];
      if (c && c.until <= Date.now()) delete this.state.cooldowns[k];
    }
    // Usage
    const prompt = info.usage?.promptTokens ?? info.estTokens;
    const completion = info.usage?.completionTokens ?? outTokens;
    for (const k of [`${m.key}#${kid}`, `provider:${p.id}#${kid}`]) {
      let u = this.state.usage[k];
      if (!u || u.day !== today()) u = this.state.usage[k] = { day: today(), requests: 0, promptTokens: 0, completionTokens: 0 };
      u.requests++;
      u.promptTokens += prompt;
      u.completionTokens += completion;
    }
    const mk = `${p.id}#${kid}`;
    const mon = this.state.monthly[mk];
    if (!mon || mon.month !== thisMonth()) this.state.monthly[mk] = { month: thisMonth(), requests: 1 };
    else mon.requests++;
    // Proactive limits from headers
    const rl = info.rateLimit;
    if (rl) {
      if (rl.remainingRequests === 0 && rl.resetRequestsMs) this.setCooldown(`${m.key}#${kid}`, rl.resetRequestsMs, 'request limit reached (headers)', 'rate_limit');
      if (rl.remainingRequestsDay === 0 && rl.resetRequestsDayMs) this.setCooldown(`${m.key}#${kid}`, rl.resetRequestsDayMs, 'daily request limit reached', 'quota');
      if (rl.remainingTokensDay !== undefined && rl.remainingTokensDay < 2000 && rl.resetTokensDayMs) this.setCooldown(`${m.key}#${kid}`, rl.resetTokensDayMs, 'daily token limit reached', 'quota');
    }
    this.scheduleSave();
  }

  private setCooldown(key: string, ms: number, reason: string, kind: ErrorKind): Cooldown {
    const prev = this.state.cooldowns[key];
    const strikes = prev && prev.until > Date.now() - 10 * 60_000 ? prev.strikes + 1 : 1;
    const c: Cooldown = { until: Date.now() + Math.max(1000, ms), reason, kind, strikes };
    this.state.cooldowns[key] = c;
    return c;
  }

  /**
   * Records a failure and decides the cooldown. Returns a short description for the UI.
   */
  recordFailure(
    p: ProviderRuntime,
    m: ModelInfo,
    keyIndex: number,
    err: { kind: ErrorKind; message: string; retryAfterMs?: number; limitTokens?: number },
    estTokens: number,
  ): string {
    const h = this.model(m.key);
    h.failures++;
    h.consecutiveFailures++;
    h.lastError = err.message.slice(0, 300);
    h.lastErrorKind = err.kind;
    h.lastErrorAt = Date.now();
    const kid = keyId(p.apiKeys[keyIndex] ?? '');
    const modelKey = `${m.key}#${kid}`;
    const providerKey = `provider:${p.id}#${kid}`;
    // Our client prefixes messages with "<provider>/<model>: "; look at the provider's own words.
    const raw = err.message.startsWith(`${p.name}/${m.id}: `) ? err.message.slice(`${p.name}/${m.id}: `.length) : err.message;
    const providerWide = /free-models-per|per (account|organization|org|workspace|key|project)|organization/i.test(raw) || (!!(p.limits.rpm || p.limits.rpd) && !raw.includes(m.id));
    let desc = '';
    switch (err.kind) {
      case 'rate_limit': {
        const prev = this.state.cooldowns[providerWide ? providerKey : modelKey];
        const strikes = prev && prev.until > Date.now() - 10 * 60_000 ? prev.strikes : 0;
        const ms = err.retryAfterMs ?? Math.min(15 * 60_000, 20_000 * 2 ** strikes);
        this.setCooldown(providerWide ? providerKey : modelKey, Math.min(ms, 6 * 3600_000), 'rate limited', 'rate_limit');
        desc = `rate limited (${providerWide ? 'provider' : 'model'}, retry in ${Math.round(ms / 1000)}s)`;
        break;
      }
      case 'quota': {
        let ms = err.retryAfterMs ?? nextUtcMidnight() - Date.now();
        if (/month/i.test(err.message) && !err.retryAfterMs) ms = 24 * 3600_000;
        if (/credit|balance|billing|payment/i.test(err.message) && !err.retryAfterMs) ms = 12 * 3600_000;
        this.setCooldown(providerWide ? providerKey : modelKey, ms, 'quota exhausted', 'quota');
        desc = `free quota used up (back in ${humanMs(ms)})`;
        break;
      }
      case 'auth':
        this.setCooldown(providerKey, 6 * 3600_000, 'API key rejected', 'auth');
        desc = 'API key rejected';
        break;
      case 'not_found':
      case 'forbidden_model':
        h.disabledUntil = Date.now() + 24 * 3600_000;
        h.disabledReason = err.kind === 'not_found' ? 'model not available' : 'model not allowed for this key';
        desc = h.disabledReason;
        break;
      case 'context_length':
      case 'too_large': {
        const learned = err.limitTokens && err.limitTokens < estTokens ? err.limitTokens : Math.floor(estTokens * 0.85);
        h.learnedMaxInput = Math.max(1024, Math.min(h.learnedMaxInput ?? Infinity, learned));
        desc = `request too large for this model (limit ~${h.learnedMaxInput} tokens)`;
        break;
      }
      case 'tools_unsupported':
        h.toolMode = 'text';
        desc = 'no native tool calling: switched to text tool protocol';
        break;
      case 'server':
      case 'network':
      case 'timeout':
      case 'empty':
      case 'unknown': {
        const ms = Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, h.consecutiveFailures - 1));
        this.setCooldown(modelKey, ms, err.kind === 'empty' ? 'returned an empty answer' : err.kind, err.kind);
        desc = `${err.kind === 'empty' ? 'empty answer' : err.kind} (pausing ${humanMs(ms)})`;
        if (err.kind === 'network' && /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(err.message)) {
          this.setCooldown(providerKey, 5 * 60_000, 'unreachable', 'network');
          desc = 'provider unreachable';
        }
        break;
      }
      case 'bad_request': {
        const ms = Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, h.consecutiveFailures - 1));
        this.setCooldown(modelKey, ms, 'rejected the request', 'bad_request');
        desc = `rejected the request (pausing ${humanMs(ms)})`;
        break;
      }
      default:
        desc = err.kind;
    }
    this.scheduleSave();
    return desc;
  }

  setNeedsMinimal(m: ModelInfo, v = true): void {
    this.model(m.key).needsMinimal = v;
    this.scheduleSave();
  }

  setNoSystemRole(m: ModelInfo): void {
    this.model(m.key).noSystemRole = true;
    this.scheduleSave();
  }

  resetModel(key: string): void {
    delete this.state.models[key];
    for (const k of Object.keys(this.state.cooldowns)) if (k.startsWith(key + '#')) delete this.state.cooldowns[k];
    this.scheduleSave();
  }

  resetAllCooldowns(): void {
    this.state.cooldowns = {};
    for (const h of Object.values(this.state.models)) {
      delete h.disabledUntil;
      h.consecutiveFailures = 0;
    }
    this.scheduleSave();
  }

  /** Earliest time any of the given candidates becomes available. */
  soonestAvailable(items: { p: ProviderRuntime; m: ModelInfo }[]): number {
    let best = Infinity;
    for (const { p, m } of items) {
      if (this.isDisabled(m)) continue;
      best = Math.min(best, this.waitInfo(p, m).waitMs);
    }
    return best;
  }
}

export function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(ms < 36000_000 ? 1 : 0)}h`;
}

// The router: picks the best available free model for each request and fails over automatically
// when a model is rate limited, out of quota, too small, or broken. Callers never have to switch
// models by hand.
import type { ChatMessage, ChatResult, EffortLevel, ModelInfo, ProviderRuntime, ToolMode, ToolSchema } from '../providers/types.js';
import type { Settings } from '../config/config.js';
import { ProviderError } from '../providers/errors.js';
import { chatCompletion, type StreamHandlers } from '../providers/client.js';
import { parseToolCallsFromText } from '../providers/textTools.js';
import { HealthStore, humanMs } from './health.js';
import { type TaskProfile, CLASSIFIER_SYSTEM_PROMPT, buildClassifierInput, classifyHeuristic, parseClassifierReply } from './classifier.js';
import { estimateRequestTokens } from '../util/tokens.js';
import { sleep } from '../util/async.js';
import { debug } from '../util/log.js';

export type Purpose = 'agent' | 'subagent' | 'classify' | 'summarize' | 'title';

export interface Candidate {
  provider: ProviderRuntime;
  model: ModelInfo;
  score: number;
  waitMs: number;
  keyIndex: number;
  waitReason?: string;
  maxInput: number;
}

export interface RouteRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  profile?: TaskProfile;
  purpose: Purpose;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** How hard models that take an effort level should think (side jobs default to low). */
  effort?: EffortLevel;
  /** Model the conversation is currently using; kept unless something better is clearly needed. */
  stickyKey?: string;
  /** Explicit model choice ("provider/model"). */
  pinned?: string;
  /** Upper bound on total waiting for rate limits (ms). */
  maxTotalWaitMs?: number;
  /** Disable streaming (classifier, summaries). */
  stream?: boolean;
  /** Exclude these model keys. */
  exclude?: Set<string>;
}

export interface RouteEvents extends StreamHandlers {
  onAttempt?: (c: Candidate, info: { attempt: number; reason: string; toolMode: ToolMode }) => void;
  onFailover?: (info: { from: Candidate; error: ProviderError; description: string; willRetrySame: boolean }) => void;
  onWait?: (info: { ms: number; candidate: Candidate; reason: string }) => void;
}

export interface RouteResult extends ChatResult {
  candidate: Candidate;
  toolMode: ToolMode;
  attempts: number;
}

export class AllModelsUnavailableError extends Error {
  constructor(
    message: string,
    public readonly failures: { key: string; reason: string }[],
    public readonly retryInMs?: number,
  ) {
    super(message);
    this.name = 'AllModelsUnavailableError';
  }
}

const COMPLEXITY_WEIGHTS: Record<string, { q: number; s: number }> = {
  trivial: { q: 0.35, s: 0.65 },
  simple: { q: 0.6, s: 0.4 },
  moderate: { q: 0.85, s: 0.15 },
  complex: { q: 1.0, s: 0.04 },
};

/** Tool calls recovered from a provider's "failed_generation" (Groq's tool_use_failed errors). */
function salvageFailedGeneration(body: string | undefined, tools: ToolSchema[]): ChatResult | null {
  if (!body || !body.includes('failed_generation')) return null;
  let gen: unknown;
  try {
    gen = (JSON.parse(body) as { error?: { failed_generation?: unknown } }).error?.failed_generation;
  } catch {
    const m = /"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (m) {
      try {
        gen = JSON.parse(`"${m[1]}"`);
      } catch {
        gen = undefined;
      }
    }
  }
  if (typeof gen !== 'string' || !gen.trim()) return null;
  const parsed = parseToolCallsFromText(gen, new Set(tools.map((t) => t.name)));
  if (!parsed.toolCalls.length) return null;
  return { content: parsed.text, reasoning: '', toolCalls: parsed.toolCalls, finishReason: 'tool_calls', latencyMs: 0 };
}

/** Turns a non-provider exception (socket closed mid-stream, ...) into the closest ProviderError. */
function asProviderError(e: unknown): ProviderError {
  const msg = (e as Error)?.message ?? String(e);
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? '';
  if (/timeout|timed out/i.test(msg) || /TIMEOUT/.test(code)) return new ProviderError('timeout', msg);
  if (/terminated|other side closed|socket hang up|ECONNRESET|EPIPE|fetch failed|network|UND_ERR/i.test(`${msg} ${code}`)) return new ProviderError('network', `connection dropped (${msg})`);
  return new ProviderError('unknown', msg);
}

export class Router {
  /** Profile cache so identical requests are not classified twice. */
  private classifyCache = new Map<string, TaskProfile>();

  constructor(
    public providers: () => ProviderRuntime[],
    public health: HealthStore,
    public settings: () => Settings,
  ) {}

  /** All enabled (provider, model) pairs. */
  /** The provider and model behind a "provider/model" key. */
  lookup(key: string | undefined): { p: ProviderRuntime; m: ModelInfo } | undefined {
    if (!key) return undefined;
    return this.allModels().find(({ m }) => m.key === key);
  }

  /** Requests to this model are prompt-cached, so the conversation should stay append-only. */
  cachesPrompts(key: string | undefined): boolean {
    return this.lookup(key)?.p.def.api === 'anthropic';
  }

  allModels(): { p: ProviderRuntime; m: ModelInfo }[] {
    const out: { p: ProviderRuntime; m: ModelInfo }[] = [];
    for (const p of this.providers()) {
      if (!p.enabled) continue;
      for (const m of p.models) if (m.enabled) out.push({ p, m });
    }
    return out;
  }

  private isAvoided(p: ProviderRuntime, m: ModelInfo): boolean {
    const avoid = this.settings().router.avoid ?? [];
    return avoid.includes(p.id) || avoid.includes(m.key);
  }

  private preferBonus(p: ProviderRuntime, m: ModelInfo): number {
    const prefer = this.settings().router.prefer ?? [];
    const idx = prefer.findIndex((x) => x === m.key || x === p.id);
    return idx < 0 ? 0 : 20 - Math.min(10, idx * 2);
  }

  /** Scores and sorts usable candidates for a request (ready ones first). */
  rank(req: RouteRequest, estTokens = estimateRequestTokens(req.messages, req.tools)): Candidate[] {
    const s = this.settings();
    const profile = req.profile ?? { complexity: 'moderate', type: 'edit', needsReasoning: false, longContext: false, source: 'fixed' };
    const w = COMPLEXITY_WEIGHTS[profile.complexity] ?? COMPLEXITY_WEIGHTS.moderate!;
    const minOutput = req.purpose === 'classify' ? 64 : req.purpose === 'title' ? 32 : 1024;
    const needInput = Math.ceil(estTokens * 1.1) + minOutput;
    // Images in the recent messages (a pasted design, a Browser screenshot) need a model that can see them.
    const wantsVision = req.messages.slice(-6).some((msg) => msg.images?.length);
    const out: Candidate[] = [];
    for (const { p, m } of this.allModels()) {
      if (req.exclude?.has(m.key)) continue;
      const pinned = req.pinned === m.key;
      if (!pinned) {
        if (p.paid && !s.router.allowPaid) continue;
        if (this.isAvoided(p, m)) continue;
      }
      if (this.health.isDisabled(m)) continue;
      const maxInput = this.health.maxInputTokens(p, m);
      if (needInput > maxInput) continue;
      if ((req.purpose === 'agent' || req.purpose === 'subagent') && m.quality < 25 && !pinned) continue;
      const wait = this.health.waitInfo(p, m, estTokens);
      const h = this.health.peekModel(m.key);
      let score: number;
      if (req.purpose === 'classify' || req.purpose === 'title') {
        // Fast, plentiful, small models. Never burn scarce quotas on routing.
        score = m.speed * 0.8 + Math.min(m.quality, 60) * 0.3 + (m.roles.includes('router') ? 25 : 0);
        if (p.limits.rpd && p.limits.rpd < 500) score -= 40;
        if (m.limits.rpd && m.limits.rpd < 500) score -= 20;
        if (m.reasoning) score -= 15; // reasoning models are slow to answer
      } else if (req.purpose === 'summarize') {
        score = m.quality * 0.6 + m.speed * 0.3 + Math.log2(Math.max(1, m.context / 32768)) * 3 + (m.roles.includes('summarizer') ? 10 : 0);
      } else {
        let speed = m.speed;
        if (h?.tokensPerSec) speed = speed * 0.5 + Math.min(100, h.tokensPerSec / 2) * 0.5;
        score = m.quality * w.q + speed * w.s;
        if (profile.needsReasoning && m.reasoning) score += 4;
        if (wantsVision) score += m.vision ? 20 : -20;
        if (profile.longContext) score += Math.log2(Math.max(1, m.context / 65536)) * 3;
        if (req.purpose === 'subagent') score += speed * 0.1;
        // Keep scarce daily quotas for the hard tasks.
        const used = this.health.dailyUsedFraction(p, m);
        const scarce = (p.limits.rpd ?? m.limits.rpd ?? Infinity) < 200;
        if (profile.complexity === 'trivial' || profile.complexity === 'simple') score -= (scarce ? 8 : 0) + used * 6;
        else score -= used * 4;
      }
      if (h) {
        score -= Math.min(30, h.consecutiveFailures * 7);
        if (h.successes + h.failures >= 4) score += ((h.successes / (h.successes + h.failures)) - 0.7) * 10;
        if (this.health.effectiveToolMode(m) === 'text' && req.tools?.length) score -= 6;
      } else if (m.toolMode === 'text' && req.tools?.length) score -= 6;
      if (p.kind === 'trial') score -= 6;
      if (p.kind === 'keyless') score -= 10;
      if (p.paid) score -= 15;
      score += this.preferBonus(p, m) + m.priority + p.priority;
      if (req.stickyKey === m.key) score += req.purpose === 'agent' ? 14 : 6;
      if (pinned) score += 1000;
      out.push({ provider: p, model: m, score, waitMs: wait.waitMs, keyIndex: wait.keyIndex, waitReason: wait.reason, maxInput });
    }
    return out.sort((a, b) => {
      const ar = a.waitMs <= 0 ? 0 : 1;
      const br = b.waitMs <= 0 ? 0 : 1;
      if (ar !== br) return ar - br;
      if (ar === 1 && Math.abs(a.waitMs - b.waitMs) > 2000) return a.waitMs - b.waitMs;
      return b.score - a.score;
    });
  }

  /** The candidate that would be used right now (for UI previews). */
  preview(req: RouteRequest): Candidate | undefined {
    return this.choose(this.rank(req), req)?.candidate;
  }

  /** Decides between the best ready candidate and waiting briefly for a clearly better one. */
  private choose(list: Candidate[], req: RouteRequest): { candidate: Candidate; waitMs: number } | null {
    if (!list.length) return null;
    const maxWait = (this.settings().router.maxWaitSeconds ?? 20) * 1000;
    const ready = list.filter((c) => c.waitMs <= 0);
    const bestOverall = [...list].sort((a, b) => b.score - a.score)[0]!;
    if (ready.length) {
      const bestReady = ready[0]!;
      if (bestOverall.waitMs > 0 && bestOverall.waitMs <= maxWait && bestOverall.score - bestReady.score > (req.pinned === bestOverall.model.key ? -Infinity : 10)) {
        return { candidate: bestOverall, waitMs: bestOverall.waitMs };
      }
      return { candidate: bestReady, waitMs: 0 };
    }
    // Nobody is ready: take the soonest available (pinned models first).
    const pinned = list.find((c) => c.model.key === req.pinned);
    const soonest = pinned ?? [...list].sort((a, b) => a.waitMs - b.waitMs)[0]!;
    return { candidate: soonest, waitMs: soonest.waitMs };
  }

  private outputBudget(c: Candidate, estTokens: number, req: RouteRequest): number {
    const s = this.settings();
    let budget = req.maxTokens ?? s.maxOutputTokens ?? 16384;
    budget = Math.min(budget, c.model.maxOutput || budget);
    const room = c.model.context - Math.ceil(estTokens * 1.1) - 256;
    budget = Math.min(budget, room);
    const tpm = c.model.limits.tpm ?? c.provider.limits.tpm;
    if (tpm) budget = Math.min(budget, Math.max(512, tpm - Math.ceil(estTokens * 1.1) - 100));
    return Math.max(256, Math.floor(budget));
  }

  /**
   * Runs a chat request with automatic model selection and failover.
   */
  async complete(req: RouteRequest, events: RouteEvents = {}): Promise<RouteResult> {
    const s = this.settings();
    const estTokens = estimateRequestTokens(req.messages, req.tools);
    const failed = new Set<string>(); // keys that failed during this call
    const failures: { key: string; reason: string }[] = [];
    const sameRetries = new Map<string, number>();
    const minimalTried = new Set<string>();
    const noSysTried = new Set<string>();
    const textHistoryTried = new Set<string>();
    const hasToolHistory = req.messages.some((m) => m.role === 'tool' || !!m.toolCalls?.length);
    let attempts = 0;
    let waitedMs = 0;
    const maxTotalWait = req.maxTotalWaitMs ?? 5 * 60_000;
    let rounds = 0;
    const strict = !!req.pinned && s.router.strict;

    for (;;) {
      if (req.signal?.aborted) throw new ProviderError('aborted', 'Aborted');
      const exclude = new Set([...(req.exclude ?? []), ...failed]);
      let list = this.rank({ ...req, exclude }, estTokens);
      if (strict) list = list.filter((c) => c.model.key === req.pinned);
      const choice = this.choose(list, req);
      if (!choice) {
        // Everything failed this round. If something comes back soon, wait and try another round.
        const pool = this.allModels().filter(({ p, m }) => (!strict || m.key === req.pinned) && (!p.paid || s.router.allowPaid || m.key === req.pinned));
        const soon = this.health.soonestAvailable(pool);
        if (failed.size && rounds < 3 && soon !== Infinity && soon <= 120_000 && waitedMs + soon <= maxTotalWait) {
          rounds++;
          failed.clear();
          if (soon > 0) {
            const any = this.rank({ ...req, exclude: req.exclude }, estTokens)[0];
            if (any) events.onWait?.({ ms: soon, candidate: any, reason: 'all models are busy' });
            await sleep(soon, req.signal);
            waitedMs += soon;
          }
          continue;
        }
        throw this.unavailableError(req, estTokens, failures);
      }
      const { candidate: c } = choice;
      let waitMs = choice.waitMs;
      if (waitMs > 0) {
        if (waitedMs + waitMs > maxTotalWait) throw this.unavailableError(req, estTokens, failures);
        events.onWait?.({ ms: waitMs, candidate: c, reason: c.waitReason ?? 'rate limit' });
        await sleep(waitMs, req.signal);
        waitedMs += waitMs;
        // Re-evaluate key choice after waiting
        const wi = this.health.waitInfo(c.provider, c.model, estTokens);
        c.keyIndex = wi.keyIndex;
        waitMs = 0;
      }
      attempts++;
      const h = this.health.peekModel(c.model.key);
      const toolMode: ToolMode = req.tools?.length ? this.health.effectiveToolMode(c.model) : 'native';
      const minimal = !!h?.needsMinimal || minimalTried.has(c.model.key);
      const noSystemRole = !!h?.noSystemRole || noSysTried.has(c.model.key);
      const historyAsText = hasToolHistory && (textHistoryTried.has(c.model.key) || this.health.needsTextHistory(c.model));
      events.onAttempt?.(c, { attempt: attempts, reason: attempts === 1 ? 'selected' : 'failover', toolMode });
      const apiKey = c.provider.apiKeys[c.keyIndex] ?? c.provider.apiKeys[0] ?? '';
      this.health.recordRequestStart(c.provider, c.model, c.keyIndex, estTokens);
      let emitted = false;
      try {
        const result = await chatCompletion(
          {
            provider: c.provider,
            model: c.model,
            apiKey,
            messages: req.messages,
            tools: req.tools,
            toolMode,
            maxTokens: this.outputBudget(c, estTokens, req),
            temperature: req.temperature ?? s.temperature,
            effort: req.effort ?? (req.purpose === 'agent' || req.purpose === 'subagent' ? undefined : 'low'),
            purpose: req.purpose,
            signal: req.signal,
            minimal,
            strict: minimal,
            noSystemRole,
            historyAsText,
            stream: req.stream,
            headersTimeoutMs: req.purpose === 'classify' ? 8000 : undefined,
            idleTimeoutMs: req.purpose === 'classify' ? 15000 : undefined,
          },
          {
            onText: (t) => {
              emitted = true;
              events.onText?.(t);
            },
            onReasoning: (t) => {
              emitted = true;
              events.onReasoning?.(t);
            },
            onToolCallStart: (n) => {
              emitted = true;
              events.onToolCallStart?.(n);
            },
          },
        );
        if (!result.content.trim() && !result.toolCalls.length) {
          throw new ProviderError('empty', `${c.provider.name}/${c.model.id}: empty response${result.reasoning ? ' (only reasoning)' : ''}${result.finishReason ? `, finish_reason=${result.finishReason}` : ''}`);
        }
        this.health.recordSuccess(c.provider, c.model, c.keyIndex, {
          usage: result.usage,
          estTokens,
          latencyMs: result.latencyMs,
          ttftMs: result.ttftMs,
          outputChars: result.content.length + result.reasoning.length + result.toolCalls.reduce((a, t) => a + t.arguments.length, 0),
          rateLimit: result.rateLimit,
        });
        if (minimal && !h?.needsMinimal) this.health.setNeedsMinimal(c.model);
        if (noSystemRole && !h?.noSystemRole) this.health.setNoSystemRole(c.model);
        if (textHistoryTried.has(c.model.key)) this.health.setTextHistory(c.model);
        return { ...result, candidate: c, toolMode, attempts };
      } catch (e) {
        if (req.signal?.aborted) throw new ProviderError('aborted', 'Aborted');
        const err = e instanceof ProviderError ? e : asProviderError(e);
        if (err.kind === 'aborted') throw err;
        debug('router', `${c.model.key} failed: ${err.kind} ${err.message}`);
        // Groq rejects tool calls it can't parse ("tool_use_failed") but returns the model's attempt:
        // our own parser usually recovers the call.
        const salvaged = err.kind === 'bad_request' && req.tools?.length ? salvageFailedGeneration(err.body, req.tools) : null;
        if (salvaged) return { ...salvaged, candidate: c, toolMode, attempts };
        let retrySame = false;
        let retryNote = '';
        // A rejected tool history (e.g. Gemini 3 thought signatures): resend it as plain text.
        const historyProblem = err.kind === 'bad_request' && /thought.?signature|function.?call|tool.?call|tool_use|tool result|function response/i.test(err.message);
        // Recoverable on the same model with a different request shape.
        if (err.kind === 'tools_unsupported' && toolMode === 'native' && req.tools?.length) {
          retrySame = true;
        } else if (err.kind === 'bad_request' && hasToolHistory && !historyAsText && !textHistoryTried.has(c.model.key) && (historyProblem || minimalTried.has(c.model.key) || !!h?.needsMinimal)) {
          textHistoryTried.add(c.model.key);
          retrySame = true;
          retryNote = 'rejected the tool history, resending it as text';
        } else if (err.kind === 'bad_request' && !minimalTried.has(c.model.key) && !h?.needsMinimal) {
          minimalTried.add(c.model.key);
          retrySame = true;
        } else if (err.kind === 'bad_request' && /system|developer instruction/i.test(err.message) && !noSysTried.has(c.model.key)) {
          noSysTried.add(c.model.key);
          retrySame = true;
        } else if ((err.kind === 'server' || err.kind === 'network' || err.kind === 'timeout' || err.kind === 'empty') && (sameRetries.get(c.model.key) ?? 0) < 1 && !emitted) {
          sameRetries.set(c.model.key, (sameRetries.get(c.model.key) ?? 0) + 1);
          retrySame = true;
          await sleep(1200, req.signal);
        }
        let description: string;
        if (retrySame && err.kind !== 'tools_unsupported') {
          description = retryNote || (err.kind === 'bad_request' ? 'request rejected, retrying in compatibility mode' : err.kind === 'timeout' ? 'slow to answer, retrying' : `${err.kind}, retrying`);
        } else {
          description = this.health.recordFailure(c.provider, c.model, c.keyIndex, err, estTokens);
        }
        if (!retrySame) {
          failed.add(c.model.key);
          failures.push({ key: c.model.key, reason: `${description}: ${err.message.slice(0, 200)}` });
        }
        events.onFailover?.({ from: c, error: err, description, willRetrySame: retrySame });
        if (strict && !retrySame && err.kind !== 'rate_limit' && err.kind !== 'quota') throw err;
      }
    }
  }

  private unavailableError(req: RouteRequest, estTokens: number, failures: { key: string; reason: string }[]): AllModelsUnavailableError {
    const s = this.settings();
    const all = this.allModels().filter(({ p, m }) => !p.paid || s.router.allowPaid || m.key === req.pinned);
    if (!all.length) {
      return new AllModelsUnavailableError(
        'No AI provider is configured. Run /setup (or `freecode setup`) to add free API keys - Gemini, Groq, OpenRouter, Mistral, NVIDIA, Cerebras and more are free.',
        failures,
      );
    }
    const fits = all.filter(({ p, m }) => this.health.maxInputTokens(p, m) >= estTokens * 1.1 + 1024);
    if (!fits.length) {
      return new AllModelsUnavailableError(
        `The conversation (~${Math.round(estTokens / 1000)}k tokens) is too large for every available model. Use /compact to shrink it, or /clear to start fresh.`,
        failures,
      );
    }
    const soon = this.health.soonestAvailable(fits);
    const when = soon === Infinity ? '' : ` The next model frees up in about ${humanMs(soon)}.`;
    const lines = failures.slice(-6).map((f) => `  - ${f.key}: ${f.reason}`);
    return new AllModelsUnavailableError(
      `All usable models are rate limited or failing right now.${when}${lines.length ? '\n' + lines.join('\n') : ''}\nTip: add more free providers with /setup so FreeCode has more models to rotate through.`,
      failures,
      soon === Infinity ? undefined : soon,
    );
  }

  // ------------------------------------------------------------------ AI task classification

  /**
   * Rates the user's request with a small fast model (the "router AI"); falls back to heuristics.
   */
  async classify(text: string, ctx: { previous?: TaskProfile; previousRequest?: string; turns?: number; signal?: AbortSignal } = {}): Promise<TaskProfile> {
    const heur = classifyHeuristic(text, ctx.previous);
    const s = this.settings();
    if (!s.router.enabled || heur.confidence >= 0.9) return heur.profile;
    const cacheKey = text.slice(0, 500);
    const cached = this.classifyCache.get(cacheKey);
    if (cached) return cached;
    const messages: ChatMessage[] = [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: buildClassifierInput(text, { previousRequest: ctx.previousRequest, turns: ctx.turns }) },
    ];
    const req: RouteRequest = { messages, purpose: 'classify', maxTokens: 80, temperature: 0, stream: false, signal: ctx.signal, maxTotalWaitMs: 0, pinned: s.router.classifierModel };
    // Only spend at most two quick attempts on classification.
    const list = this.rank(req).filter((c) => c.waitMs <= 0).slice(0, 2);
    for (const c of list) {
      try {
        const res = await chatCompletion(
          {
            provider: c.provider,
            model: c.model,
            apiKey: c.provider.apiKeys[c.keyIndex] ?? '',
            messages,
            toolMode: 'native',
            maxTokens: c.model.reasoning ? 600 : 80,
            temperature: 0,
            effort: 'low',
            purpose: 'classify',
            stream: false,
            signal: ctx.signal,
            headersTimeoutMs: 6000,
            idleTimeoutMs: 8000,
            minimal: !!this.health.peekModel(c.model.key)?.needsMinimal,
          },
          {},
        );
        this.health.recordRequestStart(c.provider, c.model, c.keyIndex, 300);
        this.health.recordSuccess(c.provider, c.model, c.keyIndex, { usage: res.usage, estTokens: 300, latencyMs: res.latencyMs, ttftMs: res.ttftMs, outputChars: res.content.length });
        const prof = parseClassifierReply(res.content, c.model.key);
        if (prof) {
          this.classifyCache.set(cacheKey, prof);
          if (this.classifyCache.size > 200) this.classifyCache.delete(this.classifyCache.keys().next().value!);
          return prof;
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e));
        this.health.recordFailure(c.provider, c.model, c.keyIndex, err, 300);
      }
    }
    return heur.profile;
  }
}

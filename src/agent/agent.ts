// The agent loop: send conversation -> stream the answer -> run requested tools -> repeat until done.
import type { ChatMessage, ImageAttachment, ToolCall, Usage } from '../providers/types.js';
import type { PermissionMode, Settings } from '../config/config.js';
import { updateProjectSettings } from '../config/config.js';
import { type Candidate, type Router, AllModelsUnavailableError } from '../router/router.js';
import type { TaskProfile } from '../router/classifier.js';
import { ProviderError } from '../providers/errors.js';
import { mightContainToolCall, newToolCallId, parseToolCallsFromText } from '../providers/textTools.js';
import type { PermissionRequest, SessionState, Tool, ToolContext, ToolResult, ToolServices, Todo, UserQuestion, QuestionAnswer } from '../tools/types.js';
import { toolSchema } from '../tools/types.js';
import { aliasOf, findTool, selectTools } from '../tools/index.js';
import { loadSkillsCached } from '../skills/skills.js';
import type { FileTracker } from '../tools/fileTracker.js';
import { decide, type PermissionContext } from '../permissions/permissions.js';
import { parseToolArguments } from '../util/jsonRepair.js';
import { estimateRequestTokens } from '../util/tokens.js';
import { SUMMARY_INSTRUCTIONS, findCutIndex, hardTruncate, pruneToolOutputs, summaryMessage, transcript } from './compaction.js';
import { runHooks } from './hooks.js';
import type { McpManager } from '../mcp/manager.js';
import { debug } from '../util/log.js';
import { truncate } from '../util/strings.js';

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'profile'; profile: TaskProfile }
  | { type: 'model'; key: string; provider: string; model: string; toolMode: string; reason: string; attempt: number }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_streaming'; name: string }
  | { type: 'assistant'; message: ChatMessage }
  | { type: 'tool_start'; id: string; name: string; label: string; input: Record<string, unknown> }
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'tool_end'; id: string; name: string; label: string; result: ToolResult; durationMs: number; denied?: boolean }
  | { type: 'failover'; from: string; description: string; error: string; retrySame: boolean; hadOutput: boolean }
  | { type: 'wait'; ms: number; model: string; reason: string }
  | { type: 'compact'; beforeTokens: number; afterTokens: number; auto: boolean; method: 'prune' | 'summary' | 'truncate' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'usage'; usage: Usage; model: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'subagent'; id: string; description: string; event: AgentEvent }
  | { type: 'turn_end'; reason: 'done' | 'aborted' | 'error' | 'max_steps' | 'denied'; error?: string };

export interface PermissionAnswer {
  allow: boolean;
  /** Remember the suggested rule for the session or in the project settings. */
  remember?: 'session' | 'project';
  /** Switch permission mode (e.g. acceptEdits after "allow all edits"). */
  switchMode?: PermissionMode;
  /** Text the user typed to steer the agent instead. */
  feedback?: string;
}

export interface AgentUI {
  onEvent: (e: AgentEvent) => void;
  askPermission?: (req: PermissionRequest, meta: { toolCallId: string; subagent?: string }) => Promise<PermissionAnswer>;
  askUser?: (questions: UserQuestion[]) => Promise<QuestionAnswer[] | null>;
  approvePlan?: (plan: string) => Promise<'acceptEdits' | 'default' | null>;
}

export interface AgentOptions {
  router: Router;
  settings: () => Settings;
  projectRoot: string;
  session: SessionState;
  files: FileTracker;
  mcp?: McpManager;
  interactive: boolean;
  depth?: number;
  agentType?: string;
  permissions: PermissionContext;
  ui: AgentUI;
  /** Returns the system prompt for the next request. */
  systemPrompt: (ctx: { depth: number; mode: PermissionMode; agentType?: string }) => Promise<string>;
  /** Pinned model key ("provider/model") or undefined for automatic routing. */
  pinnedModel: () => string | undefined;
  disallowedTools?: string[];
  maxSteps?: number;
}

/** Serializes permission dialogs (parallel tools and sub-agents may ask at the same time). */
class Mutex {
  private p: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.p.then(fn, fn);
    this.p = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
const permissionMutex = new Mutex();

export class Agent {
  messages: ChatMessage[] = [];
  turn = 0;
  lastProfile?: TaskProfile;
  currentModelKey?: string;
  queued: string[] = [];
  totalUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  requestCount = 0;
  modelsUsed = new Map<string, number>();
  running = false;
  private abortCtrl: AbortController | null = null;
  private subagentCounter = 0;

  constructor(public opts: AgentOptions) {}

  get depth(): number {
    return this.opts.depth ?? 0;
  }

  systemPrompt(): Promise<string> {
    return this.opts.systemPrompt({ depth: this.depth, mode: this.opts.session.permissionMode, agentType: this.opts.agentType });
  }

  abort(): void {
    this.abortCtrl?.abort();
  }

  get isAborted(): boolean {
    return !!this.abortCtrl?.signal.aborted;
  }

  private emit(e: AgentEvent): void {
    try {
      this.opts.ui.onEvent(e);
    } catch (err) {
      debug('agent', 'ui error', err);
    }
  }

  /** Queue a message typed while the agent is working; it is delivered at the next step. */
  enqueue(text: string): void {
    this.queued.push(text);
  }

  currentTools(): Tool[] {
    return selectTools({
      depth: this.depth,
      planMode: this.opts.session.permissionMode === 'plan',
      agentType: this.opts.agentType,
      extra: this.opts.mcp?.tools() ?? [],
      disallowed: this.opts.disallowedTools,
      interactive: this.opts.interactive && !!this.opts.ui.askUser,
      hasSkills: loadSkillsCached(this.opts.projectRoot).length > 0,
    });
  }

  /** Estimated tokens of the next request. */
  async contextTokens(): Promise<{ total: number; system: number; tools: number; messages: number }> {
    const sys = await this.systemPrompt();
    const tools = this.currentTools().map(toolSchema);
    const system = estimateRequestTokens([{ role: 'system', content: sys }]);
    const toolsT = estimateRequestTokens([], tools);
    const msgs = estimateRequestTokens(this.messages);
    return { total: system + toolsT + msgs, system, tools: toolsT, messages: msgs };
  }

  /** Runs one user turn to completion. */
  async runTurn(input: string, opts: { images?: ImageAttachment[]; displayText?: string } = {}): Promise<{ text: string; reason: string }> {
    this.turn++;
    this.running = true;
    this.abortCtrl = new AbortController();
    const signal = this.abortCtrl.signal;
    this.opts.files.beginTurn(this.turn);
    this.emit({ type: 'turn_start', turn: this.turn });
    let finalText = '';
    let reason: 'done' | 'aborted' | 'error' | 'max_steps' | 'denied' = 'done';
    try {
      const settings = this.opts.settings();
      let content = input;
      if (this.depth === 0) {
        const hook = await runHooks(settings, 'UserPromptSubmit', { prompt: input, cwd: this.opts.session.cwd }, { cwd: this.opts.projectRoot, signal });
        for (const w of hook.warnings) this.emit({ type: 'notice', level: 'warn', text: w });
        if (hook.blocked) {
          this.emit({ type: 'notice', level: 'error', text: `Prompt blocked by hook: ${hook.message}` });
          this.turn--;
          return { text: '', reason: 'denied' };
        }
        if (hook.context.length) content += `\n\n<hook-context>\n${hook.context.join('\n')}\n</hook-context>`;
      }
      this.messages.push({ role: 'user', content, images: opts.images, meta: { turn: this.turn, ts: Date.now() } });

      // Decide how hard the task is (AI router) unless a model is pinned.
      let profile: TaskProfile;
      const pinned = this.opts.pinnedModel();
      if (pinned) profile = { complexity: 'moderate', type: 'edit', needsReasoning: false, longContext: false, source: 'fixed' };
      else {
        const prevUser = [...this.messages].reverse().find((m, i) => i > 0 && m.role === 'user' && !m.meta?.synthetic);
        try {
          profile = await this.opts.router.classify(input, { previous: this.lastProfile, previousRequest: prevUser?.content, turns: this.turn, signal });
        } catch (e) {
          if (signal.aborted) throw new ProviderError('aborted', 'Aborted');
          profile = { complexity: 'moderate', type: 'edit', needsReasoning: false, longContext: false, source: 'fixed' };
          debug('agent', 'classify failed', e);
        }
      }
      this.lastProfile = profile;
      this.emit({ type: 'profile', profile });

      const maxSteps = this.opts.maxSteps ?? settings.maxSteps ?? 200;
      let steps = 0;
      let continuations = 0;
      const recentSignatures: string[] = [];
      for (;;) {
        if (signal.aborted) throw new ProviderError('aborted', 'Aborted');
        if (steps >= maxSteps) {
          reason = 'max_steps';
          this.emit({ type: 'notice', level: 'warn', text: `Stopped after ${maxSteps} steps (maxSteps). Say "continue" to keep going.` });
          break;
        }
        if (this.queued.length && steps > 0) this.injectQueued();
        await this.maybeCompact(signal);
        const tools = this.currentTools();
        const sys = await this.systemPrompt();
        const requestMessages: ChatMessage[] = [{ role: 'system', content: sys }, ...this.messages];
        let hadOutput = false;
        const result = await this.opts.router.complete(
          {
            messages: requestMessages,
            tools: tools.map(toolSchema),
            profile,
            purpose: this.depth > 0 ? 'subagent' : 'agent',
            signal,
            stickyKey: this.currentModelKey,
            pinned,
          },
          {
            onAttempt: (c: Candidate, info) => {
              this.emit({ type: 'model', key: c.model.key, provider: c.provider.name, model: c.model.name, toolMode: info.toolMode, reason: info.reason, attempt: info.attempt });
            },
            onText: (t) => {
              hadOutput = true;
              this.emit({ type: 'text', delta: t });
            },
            onReasoning: (t) => this.emit({ type: 'reasoning', delta: t }),
            onToolCallStart: (n) => this.emit({ type: 'tool_call_streaming', name: n }),
            onFailover: (f) => {
              this.emit({ type: 'failover', from: f.from.model.key, description: f.description, error: f.error.message, retrySame: f.willRetrySame, hadOutput });
              hadOutput = false;
            },
            onWait: (w) => this.emit({ type: 'wait', ms: w.ms, model: w.candidate.model.key, reason: w.reason }),
          },
        );
        steps++;
        this.requestCount++;
        this.currentModelKey = result.candidate.model.key;
        this.modelsUsed.set(result.candidate.model.key, (this.modelsUsed.get(result.candidate.model.key) ?? 0) + 1);
        if (result.usage) {
          this.totalUsage.promptTokens += result.usage.promptTokens;
          this.totalUsage.completionTokens += result.usage.completionTokens;
          this.totalUsage.totalTokens += result.usage.totalTokens;
          this.emit({ type: 'usage', usage: result.usage, model: result.candidate.model.key });
        }

        // Tool calls: native, or salvaged from text (text-mode protocol / models that print calls).
        let text = result.content;
        let calls: ToolCall[] = result.toolCalls;
        const names = new Set(tools.map((t) => t.name));
        if (!calls.length && tools.length && mightContainToolCall(text)) {
          const parsed = parseToolCallsFromText(text, names);
          if (parsed.toolCalls.length) {
            calls = parsed.toolCalls;
            text = parsed.text;
          }
        }
        calls = calls.map((c) => {
          if (names.has(c.name)) return c;
          const alias = aliasOf(c.name);
          return alias && names.has(alias) ? { ...c, name: alias } : c;
        });
        // Tool call ids must be unique across the conversation; some providers reuse "call_0" every
        // step, and ids from different providers can collide after a failover.
        const usedIds = new Set<string>();
        for (const m of this.messages) for (const tc of m.toolCalls ?? []) usedIds.add(tc.id);
        calls = calls.map((c) => {
          let id = c.id && !usedIds.has(c.id) ? c.id : newToolCallId();
          while (usedIds.has(id)) id = newToolCallId();
          usedIds.add(id);
          return id === c.id ? c : { ...c, id };
        });
        const assistant: ChatMessage = {
          role: 'assistant',
          content: text,
          toolCalls: calls.length ? calls : undefined,
          reasoning: result.reasoning || undefined,
          meta: { provider: result.candidate.provider.id, model: result.candidate.model.key, turn: this.turn, ts: Date.now() },
        };
        this.messages.push(assistant);
        this.emit({ type: 'assistant', message: assistant });
        if (text.trim()) finalText = text;

        if (!calls.length) {
          if (result.finishReason === 'length' && continuations < 2) {
            continuations++;
            this.messages.push({ role: 'user', content: '[Your reply was cut off by the output length limit. Continue exactly where you stopped, without repeating.]', meta: { synthetic: true, kind: 'nudge', turn: this.turn } });
            continue;
          }
          if (this.depth === 0) {
            const stop = await runHooks(settings, 'Stop', { last_message: text }, { cwd: this.opts.projectRoot, signal });
            for (const w of stop.warnings) this.emit({ type: 'notice', level: 'warn', text: w });
            if (stop.blocked && stop.message) {
              this.messages.push({ role: 'user', content: `[Stop hook feedback] ${stop.message}`, meta: { synthetic: true, kind: 'nudge', turn: this.turn } });
              continue;
            }
          }
          if (this.queued.length) {
            this.injectQueued();
            continue;
          }
          break;
        }

        const outcome = await this.executeToolCalls(calls, signal);
        if (outcome === 'denied') {
          reason = 'denied';
          break;
        }

        // Loop detection: the same calls over and over means the model is stuck.
        const sig = calls.map((c) => `${c.name}:${c.arguments}`).join('|');
        recentSignatures.push(sig);
        if (recentSignatures.length > 6) recentSignatures.shift();
        const repeats = recentSignatures.filter((s) => s === sig).length;
        if (repeats === 3) {
          this.messages.push({ role: 'user', content: '[System note] You have made the same tool call 3 times with the same result. Do not repeat it again. Try a different approach, or explain to the user what is blocking you.', meta: { synthetic: true, kind: 'nudge', turn: this.turn } });
        } else if (repeats >= 5) {
          this.emit({ type: 'notice', level: 'warn', text: 'The model kept repeating the same action, so the turn was stopped.' });
          reason = 'error';
          break;
        }
      }
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'aborted') {
        reason = 'aborted';
        this.messages.push({ role: 'user', content: '[The user interrupted this response.]', meta: { synthetic: true, kind: 'interrupted', turn: this.turn } });
      } else if (signal.aborted) {
        reason = 'aborted';
        this.messages.push({ role: 'user', content: '[The user interrupted this response.]', meta: { synthetic: true, kind: 'interrupted', turn: this.turn } });
      } else {
        reason = 'error';
        const msg = e instanceof AllModelsUnavailableError ? e.message : `${(e as Error).message ?? e}`;
        debug('agent', 'turn error', e);
        this.running = false;
        this.emit({ type: 'turn_end', reason, error: msg });
        return { text: finalText, reason };
      }
    } finally {
      this.running = false;
      this.abortCtrl = null;
    }
    this.emit({ type: 'turn_end', reason });
    return { text: finalText, reason };
  }

  private injectQueued(): void {
    const text = this.queued.splice(0).join('\n\n');
    this.messages.push({ role: 'user', content: `[The user sent this message while you were working]\n${text}`, meta: { kind: 'queued', turn: this.turn, ts: Date.now() } });
  }

  // ------------------------------------------------------------------ tools

  private toolContext(signal: AbortSignal, toolCallId: string): ToolContext {
    const services: ToolServices = {
      progress: (text) => this.emit({ type: 'tool_progress', id: toolCallId, text }),
      askUser: this.opts.ui.askUser,
      approvePlan: this.opts.ui.approvePlan,
      runSubagent: this.depth === 0 ? (req) => this.runSubagent(req.description, req.prompt, req.agentType, req.signal) : undefined,
      summarize: (text, instruction, sig) => this.summarizeText(text, instruction, sig),
    };
    return {
      projectRoot: this.opts.projectRoot,
      session: this.opts.session,
      settings: this.opts.settings(),
      files: this.opts.files,
      signal,
      toolCallId,
      services,
      depth: this.depth,
    };
  }

  /** Executes tool calls; returns 'denied' if the user rejected one and wants to give new instructions. */
  private async executeToolCalls(calls: ToolCall[], signal: AbortSignal): Promise<'ok' | 'denied'> {
    const tools = this.currentTools();
    const results = new Map<string, ToolResult>();
    let denied = false;
    // Group consecutive parallel-safe calls.
    const batches: ToolCall[][] = [];
    for (const c of calls) {
      const t = findTool(tools, c.name);
      const last = batches[batches.length - 1];
      if (t?.parallelSafe && last && last.every((x) => findTool(tools, x.name)?.parallelSafe)) last.push(c);
      else batches.push([c]);
    }
    for (const batch of batches) {
      if (signal.aborted || denied) {
        for (const c of batch) results.set(c.id, { content: denied ? 'Skipped: the user rejected an earlier action in this step.' : 'Interrupted by the user before it ran.', isError: true });
        continue;
      }
      const run = async (c: ToolCall) => {
        const r = await this.executeOne(c, tools, signal);
        if (r.denied) denied = true;
        results.set(c.id, r.result);
      };
      if (batch.length > 1) await Promise.all(batch.map(run));
      else await run(batch[0]!);
    }
    for (const c of calls) {
      const r = results.get(c.id) ?? { content: 'No result.', isError: true };
      this.messages.push({ role: 'tool', toolCallId: c.id, toolName: c.name, content: r.content, isError: r.isError, meta: { turn: this.turn, display: compactDisplay(r.display) } });
    }
    if (signal.aborted) throw new ProviderError('aborted', 'Aborted');
    return denied ? 'denied' : 'ok';
  }

  private async executeOne(call: ToolCall, tools: Tool[], signal: AbortSignal): Promise<{ result: ToolResult; denied?: boolean }> {
    const started = Date.now();
    const tool = findTool(tools, call.name);
    const parsed = parseToolArguments(call.arguments);
    const input = parsed.value;
    const label = tool ? safeLabel(tool, input, this.opts.session.cwd, this.opts.projectRoot) : call.name;
    this.emit({ type: 'tool_start', id: call.id, name: call.name, label, input });
    const finish = (result: ToolResult, denied = false) => {
      this.emit({ type: 'tool_end', id: call.id, name: call.name, label, result, durationMs: Date.now() - started, denied });
      if (result.display?.kind === 'todos') this.emit({ type: 'todos', todos: result.display.todos });
      return { result, denied };
    };
    if (!tool) {
      const available = tools.map((t) => t.name).join(', ');
      return finish({ content: `Unknown tool "${call.name}". Available tools: ${available}`, isError: true });
    }
    if (parsed.error) {
      return finish({ content: `Could not parse the arguments as JSON (${parsed.error}). Send the tool call again with valid JSON arguments. Received: ${truncate(call.arguments, 500)}`, isError: true });
    }
    const ctx = this.toolContext(signal, call.id);
    let prepared;
    try {
      prepared = await tool.prepare(input, ctx);
    } catch (e) {
      return finish({ content: `Tool error: ${(e as Error).message}`, isError: true });
    }
    if (prepared.error) return finish(prepared.error);
    const settings = this.opts.settings();

    if (prepared.permission) {
      const req = prepared.permission;
      // PreToolUse hooks can veto the call.
      const pre = await runHooks(settings, 'PreToolUse', { tool_name: tool.name, tool_input: input, cwd: this.opts.session.cwd }, { cwd: this.opts.projectRoot, matchValue: tool.name, signal });
      for (const w of pre.warnings) this.emit({ type: 'notice', level: 'warn', text: w });
      if (pre.blocked) return finish({ content: `Blocked by PreToolUse hook: ${pre.message}`, isError: true });
      const permCtx: PermissionContext = { ...this.opts.permissions, mode: this.opts.session.permissionMode };
      const d = decide(req, permCtx);
      if (d.action === 'deny') return finish({ content: `Permission denied: ${d.reason ?? 'not allowed'}.`, isError: true }, false);
      if (d.action === 'ask') {
        if (!this.opts.ui.askPermission) return finish({ content: `Permission denied: ${d.reason ?? 'this action needs approval and no user is available'}.`, isError: true });
        const answer = await permissionMutex.run(async () => {
          // Another call may have granted a matching rule while we waited.
          const again = decide(req, { ...this.opts.permissions, mode: this.opts.session.permissionMode });
          if (again.action === 'allow') return { allow: true } as PermissionAnswer;
          if (signal.aborted) return { allow: false } as PermissionAnswer;
          return this.opts.ui.askPermission!({ ...req, danger: req.danger ?? (d.reason && d.reason.startsWith('this command') ? d.reason : req.danger) }, { toolCallId: call.id, subagent: this.depth > 0 ? this.opts.agentType ?? 'sub-agent' : undefined });
        });
        if (signal.aborted) return finish({ content: 'Interrupted by the user.', isError: true });
        if (!answer.allow) {
          if (answer.feedback) {
            return finish({ content: `The user rejected this action and said: ${answer.feedback}`, isError: true }, false);
          }
          return finish({ content: 'The user rejected this action. Wait for their instructions.', isError: true, display: { kind: 'summary', text: 'Rejected by user' } }, true);
        }
        if (answer.switchMode) this.opts.session.permissionMode = answer.switchMode;
        if (answer.remember && req.ruleSuggestion) {
          this.opts.permissions.sessionAllow.add(req.ruleSuggestion);
          if (answer.remember === 'project') {
            try {
              updateProjectSettings(this.opts.projectRoot, (cfg) => {
                cfg.permissions = cfg.permissions ?? ({ allow: [], deny: [], ask: [] } as unknown as Settings['permissions']);
                cfg.permissions.allow = [...new Set([...(cfg.permissions.allow ?? []), req.ruleSuggestion!])];
              });
            } catch (e) {
              this.emit({ type: 'notice', level: 'warn', text: `Could not save permission rule: ${(e as Error).message}` });
            }
          }
        }
      }
    }

    let result: ToolResult;
    try {
      result = await prepared.execute();
    } catch (e) {
      if (signal.aborted) result = { content: 'Interrupted by the user.', isError: true };
      else result = { content: `Tool error: ${(e as Error).message}`, isError: true };
    }
    const post = await runHooks(settings, 'PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: result.content.slice(0, 20000), cwd: this.opts.session.cwd }, { cwd: this.opts.projectRoot, matchValue: tool.name });
    for (const w of post.warnings) this.emit({ type: 'notice', level: 'warn', text: w });
    if (post.blocked && post.message) result = { ...result, content: `${result.content}\n\n[PostToolUse hook feedback] ${post.message}` };
    return finish(result);
  }

  // ------------------------------------------------------------------ compaction

  /** Effective context budget given the models that are currently usable. */
  contextBudget(): number {
    const s = this.opts.settings();
    let best = 0;
    for (const { p, m } of this.opts.router.allModels()) {
      if (p.paid && !s.router.allowPaid) continue;
      if (m.quality < 45) continue;
      best = Math.max(best, this.opts.router.health.maxInputTokens(p, m));
    }
    if (!best) best = 32768;
    return Math.max(6000, Math.min(s.contextBudget ?? 64000, Math.floor(best * 0.8)));
  }

  private async maybeCompact(signal: AbortSignal): Promise<void> {
    const s = this.opts.settings();
    if (!s.autoCompact) return;
    const budget = this.contextBudget();
    const tokens = (await this.contextTokens()).total;
    if (tokens <= budget) return;
    const before = tokens;
    pruneToolOutputs(this.messages);
    let after = (await this.contextTokens()).total;
    if (after <= budget * 0.9) {
      this.emit({ type: 'compact', beforeTokens: before, afterTokens: after, auto: true, method: 'prune' });
      return;
    }
    await this.compact({ auto: true, signal, budget });
    after = (await this.contextTokens()).total;
    if (after > budget) {
      // Last resort: drop old messages.
      const fixed = (await this.contextTokens()).system + (await this.contextTokens()).tools;
      this.messages = hardTruncate(this.messages, Math.max(2000, budget - fixed - 1000));
      after = (await this.contextTokens()).total;
      this.emit({ type: 'compact', beforeTokens: before, afterTokens: after, auto: true, method: 'truncate' });
    }
  }

  /** Summarizes older conversation into a single message. */
  async compact(opts: { auto: boolean; signal?: AbortSignal; budget?: number; instructions?: string; all?: boolean }): Promise<boolean> {
    if (this.messages.length < 2) return false;
    const before = (await this.contextTokens()).total;
    const budget = opts.budget ?? this.contextBudget();
    const cut = opts.all ? this.messages.length : findCutIndex(this.messages, Math.floor(budget * 0.3));
    if (cut <= 0) return false;
    const old = this.messages.slice(0, cut);
    const keep = this.messages.slice(cut);
    try {
      const summary = await this.summarizeText(transcript(old, 120_000), SUMMARY_INSTRUCTIONS + (opts.instructions ? `\n\nAlso: ${opts.instructions}` : ''), opts.signal);
      if (!summary.trim()) throw new Error('empty summary');
      this.messages = [summaryMessage(summary), ...keep];
      const after = (await this.contextTokens()).total;
      this.emit({ type: 'compact', beforeTokens: before, afterTokens: after, auto: opts.auto, method: 'summary' });
      return true;
    } catch (e) {
      if (opts.signal?.aborted) throw new ProviderError('aborted', 'Aborted');
      this.emit({ type: 'notice', level: 'warn', text: `Could not summarize the conversation (${(e as Error).message}).` });
      return false;
    }
  }

  /** Uses a model (picked by the router) to condense text. */
  async summarizeText(text: string, instruction: string, signal?: AbortSignal): Promise<string> {
    const res = await this.opts.router.complete({
      messages: [
        { role: 'system', content: 'You condense information accurately and completely. Output only the requested content.' },
        { role: 'user', content: `${instruction}\n\n<content>\n${text}\n</content>` },
      ],
      purpose: 'summarize',
      signal,
      maxTokens: 4096,
      stream: true,
      maxTotalWaitMs: 60_000,
    });
    return res.content.trim();
  }

  // ------------------------------------------------------------------ sub-agents

  async runSubagent(description: string, prompt: string, agentType: string | undefined, signal: AbortSignal): Promise<string> {
    const id = `sub_${++this.subagentCounter}`;
    const sub = new Agent({
      ...this.opts,
      depth: 1,
      agentType: agentType ?? 'general-purpose',
      session: { ...this.opts.session, todos: [] },
      maxSteps: 60,
      pinnedModel: () => undefined,
      ui: {
        onEvent: (e) => this.emit({ type: 'subagent', id, description, event: e }),
        askPermission: this.opts.ui.askPermission,
      },
    });
    sub.currentModelKey = undefined;
    const onAbort = () => sub.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await sub.runTurn(prompt);
      this.requestCount += sub.requestCount;
      this.totalUsage.promptTokens += sub.totalUsage.promptTokens;
      this.totalUsage.completionTokens += sub.totalUsage.completionTokens;
      this.totalUsage.totalTokens += sub.totalUsage.totalTokens;
      if (r.reason === 'aborted') return 'The sub-agent was interrupted.';
      const last = [...sub.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
      return last?.content ?? r.text ?? '(no report)';
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ------------------------------------------------------------------ misc

  clear(): void {
    this.messages = [];
    this.lastProfile = undefined;
    this.currentModelKey = undefined;
    this.queued = [];
  }

  /** Adds a note to the conversation without running the model (e.g. output of a ! command). */
  addContext(content: string, kind: 'bash' | 'memory' | 'command' | 'attachment' = 'command'): void {
    this.messages.push({ role: 'user', content, meta: { synthetic: true, kind, ts: Date.now() } });
  }
}

/** Keeps stored diff previews small. */
function compactDisplay(d: ToolResult['display']): ToolResult['display'] {
  if (!d) return undefined;
  if (d.kind === 'diff') {
    let budget = 400;
    const hunks = [];
    for (const h of d.hunks) {
      if (budget <= 0) break;
      const lines = h.lines.slice(0, budget);
      budget -= lines.length;
      hunks.push({ ...h, lines });
    }
    return { ...d, hunks };
  }
  if (d.kind === 'text' && d.text.length > 20000) return { ...d, text: d.text.slice(0, 20000) };
  return d;
}

export function safeLabel(tool: Tool, input: Record<string, unknown>, cwd: string, projectRoot: string): string {
  try {
    return tool.label(input, { cwd, projectRoot });
  } catch {
    return tool.name;
  }
}

// Drives the agent for the graphical app: turns, pending approvals, transcript, settings and providers.
import * as path from 'node:path';
import { promises as fsp, existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import { App } from '../app.js';
import type { AgentEvent, PermissionAnswer } from '../agent/agent.js';
import { safeLabel } from '../agent/agent.js';
import type { PermissionRequest, Todo, ToolDisplay, UserQuestion, QuestionAnswer } from '../tools/types.js';
import { findTool } from '../tools/index.js';
import type { PermissionMode, Settings } from '../config/config.js';
import { isTrustedFolder, loadConfig, projectHasRiskySettings, readGlobalConfig, setByPath, updateGlobalConfig, updateProjectSettings } from '../config/config.js';
import { getProviderDef } from '../providers/catalog.js';
import { checkKey } from '../providers/validate.js';
import { findModel } from '../providers/registry.js';
import { qualityTier } from '../providers/modelInfo.js';
import { providerInfos } from './providersInfo.js';
import { listSessions, loadSession } from '../session/session.js';
import { expandMentions, mentionCompletions, projectFileList } from '../ui/mentions.js';
import { buildHunks, diffStats } from '../tools/diff.js';
import { runUserShellCommand, cleanOutput } from '../tools/bash.js';
import { appendMemory } from '../agent/memory.js';
import { expandCommand } from '../agent/customCommands.js';
import { parseMode } from '../permissions/permissions.js';
import { gitRoot } from '../util/git.js';
import { truncate } from '../util/strings.js';
import { debug } from '../util/log.js';
import { VERSION } from '../version.js';
import { getIndex } from '../codeindex/index.js';

export type UIItem =
  | { kind: 'user'; id: string; text: string; ts?: number; queued?: boolean }
  | { kind: 'assistant'; id: string; text: string; model?: string; reasoning?: string }
  | { kind: 'tool'; id: string; name: string; label: string; input: Record<string, unknown>; status: 'running' | 'ok' | 'error' | 'denied'; result?: { content: string; display?: ToolDisplay }; durationMs?: number }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'shell'; id: string; command: string; output: string; exitCode: number | null };

export type Pending =
  | { id: string; kind: 'permission'; request: PermissionRequest; subagent?: string; toolCallId?: string }
  | { id: string; kind: 'question'; questions: UserQuestion[] }
  | { id: string; kind: 'plan'; plan: string };

type PendingEntry = { item: Pending; resolve: (v: unknown) => void };

export interface Broadcast {
  (msg: Record<string, unknown>): void;
}

const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file in the project root that will help AI coding agents work in this repository. Include: how to build, run, lint and test (including a single test); code style and conventions actually used; a short architecture overview (important directories, entry points); gotchas and project-specific rules. Keep it concise (about 40-80 lines) and specific; if AGENTS.md or CLAUDE.md already exist, improve AGENTS.md instead of duplicating.`;
const REVIEW_PROMPT = `Review the current uncommitted changes in this repository (git status and git diff, including untracked files). Look for bugs, logic errors, security problems, missing error handling and tests. Report findings by severity with file:line references and concrete suggestions. Do not modify files.`;
const COMMIT_PROMPT = `Create a git commit for the current changes: check git status and git diff, stage the relevant files (never secrets like .env), and commit with a concise message in the repository's style explaining what and why. Do not push. Show the resulting commit.`;

export const GUI_COMMANDS: { name: string; description: string; args?: string }[] = [
  { name: 'new', description: 'Start a new task (conversation)' },
  { name: 'compact', description: 'Summarize the conversation to free up context', args: '[focus]' },
  { name: 'undo', description: "Revert the file changes of the agent's last turn" },
  { name: 'init', description: 'Create an AGENTS.md describing this project for the agent' },
  { name: 'review', description: 'Review uncommitted changes for bugs' },
  { name: 'commit', description: 'Commit the current changes with a good message' },
  { name: 'plan', description: 'Switch to plan mode (plan before editing)' },
  { name: 'model', description: 'Pick a model or "auto"', args: '[auto|provider/model]' },
  { name: 'memory', description: 'Save a note to AGENTS.md', args: '<note>' },
  { name: 'reset-limits', description: 'Forget rate-limit cooldowns and retry every model' },
  { name: 'setup', description: 'Open provider setup' },
  { name: 'help', description: 'Show tips and shortcuts' },
];

let idCounter = 0;
const nextId = (p: string) => `${p}${++idCounter}`;

export class Controller {
  app!: App;
  busy = false;
  private pending = new Map<string, PendingEntry>();
  private liveEvents: Record<string, unknown>[] = [];
  private turnStartIndex = 0;
  private turnUser: UIItem | null = null;
  private extraItems: UIItem[] = [];
  initialPrompt?: string;

  constructor(
    private broadcast: Broadcast,
    private baseOpts: { cwd: string; permissionMode?: PermissionMode; model?: string; allowedTools?: string[]; disallowedTools?: string[]; trusted?: boolean; overrides?: Partial<Settings> },
  ) {
    // Code index progress for the UI (throttled by the index).
    getIndex().subscribe((status) => this.broadcast({ type: 'index', status }));
  }

  // ------------------------------------------------------------------ lifecycle

  async open(cwd: string, trusted?: boolean): Promise<void> {
    if (this.app) {
      await this.app.save();
      this.app.shutdown();
    }
    this.pending.clear();
    this.extraItems = [];
    const app = new App({ ...this.baseOpts, cwd, interactive: true, trusted: trusted ?? this.baseOpts.trusted });
    await app.init({
      onEvent: (e) => this.onAgentEvent(e),
      askPermission: (req, meta) => this.ask<PermissionAnswer>({ id: nextId('perm'), kind: 'permission', request: req, subagent: meta.subagent, toolCallId: meta.toolCallId }),
      askUser: (questions) => this.ask<QuestionAnswer[] | null>({ id: nextId('q'), kind: 'question', questions }),
      approvePlan: (plan) => this.ask<'acceptEdits' | 'default' | null>({ id: nextId('plan'), kind: 'plan', plan }),
    });
    this.app = app;
    void app.startDiscovery().then(() => this.pushState());
    void app.startMcp().then(() => {
      for (const cl of app.mcp.clients.values()) if (cl.status === 'failed') this.toast('warn', `MCP server "${cl.name}" failed: ${truncate(cl.error ?? '', 160)}`);
      this.pushState();
    });
    updateGlobalConfig((g) => {
      const list = ((g as Record<string, unknown>).recentProjects as string[] | undefined) ?? [];
      (g as Record<string, unknown>).recentProjects = [app.projectRoot, ...list.filter((p) => p !== app.projectRoot)].slice(0, 12);
    });
  }

  /** Whether opening `dir` needs a trust decision first. */
  async trustCheck(dir: string): Promise<{ needsTrust: boolean; root: string }> {
    const root = (await gitRoot(dir)) ?? path.resolve(dir);
    if (!projectHasRiskySettings(root)) return { needsTrust: false, root };
    const s = loadConfig(root, undefined, { trusted: false }).settings;
    return { needsTrust: !isTrustedFolder(s, root), root };
  }

  shutdown(): void {
    this.app?.shutdown();
  }

  private ask<T>(item: Pending): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pending.set(item.id, { item, resolve: resolve as (v: unknown) => void });
      this.broadcast({ type: 'pending', item });
    });
  }

  respond(id: string, payload: Record<string, unknown>): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.item.kind === 'permission') {
      const d = String(payload.decision ?? 'deny');
      let ans: PermissionAnswer;
      if (d === 'allow') ans = { allow: true };
      else if (d === 'always') ans = { allow: true, remember: 'project' };
      else if (d === 'all_edits') ans = { allow: true, switchMode: 'acceptEdits' };
      else ans = { allow: false, feedback: typeof payload.feedback === 'string' && payload.feedback.trim() ? payload.feedback.trim() : undefined };
      p.resolve(ans);
      if (ans.switchMode) setTimeout(() => this.pushState(), 10);
    } else if (p.item.kind === 'question') {
      const raw = payload.answers;
      if (!Array.isArray(raw)) p.resolve(null);
      else {
        p.resolve(
          p.item.questions.map((q, i): QuestionAnswer => {
            const a = (raw[i] ?? {}) as { selected?: unknown; other?: unknown };
            const allowed = new Set(q.options.map((o) => o.label));
            const selected = Array.isArray(a.selected) ? a.selected.map(String).filter((l) => allowed.has(l)) : [];
            const other = typeof a.other === 'string' && a.other.trim() ? a.other.trim().slice(0, 4000) : undefined;
            return { question: q.question, header: q.header, selected: q.multiSelect ? selected : selected.slice(0, 1), other };
          }),
        );
      }
    } else {
      const d = payload.decision;
      p.resolve(d === 'acceptEdits' || d === 'default' ? d : null);
      setTimeout(() => this.pushState(), 10);
    }
    this.broadcast({ type: 'pending_resolved', id });
    return true;
  }

  // ------------------------------------------------------------------ events

  /**
   * Keeps the events of the running turn for windows that connect mid-turn. Streamed text arrives in
   * thousands of tiny pieces, so consecutive pieces are merged, and only the latest progress line of
   * a tool is kept.
   */
  private bufferLive(msg: { type: string; event: AgentEvent }): void {
    const e = msg.event;
    const last = this.liveEvents[this.liveEvents.length - 1] as { type: string; event: AgentEvent } | undefined;
    if (last && (e.type === 'text' || e.type === 'reasoning') && last.event.type === e.type) {
      last.event = { ...e, delta: (last.event as typeof e).delta + e.delta };
      return;
    }
    if (last && e.type === 'tool_progress' && last.event.type === 'tool_progress' && last.event.id === e.id) {
      last.event = e;
      return;
    }
    this.liveEvents.push(msg);
  }

  private onAgentEvent(e: AgentEvent): void {
    const msg = { type: 'agent', event: e };
    if (this.busy) this.bufferLive(msg);
    this.broadcast(msg);
    if (e.type === 'todos' || e.type === 'usage' || e.type === 'compact') this.pushState();
  }

  toast(level: 'info' | 'warn' | 'error', text: string): void {
    const item: UIItem = { kind: 'notice', id: nextId('n'), level, text };
    this.extraItems.push(item);
    this.broadcast({ type: 'item', item });
  }

  pushState(): void {
    if (!this.app) return;
    void this.state(false).then((state) => {
      // Re-read the fast-changing fields right before sending so a slow snapshot can never
      // overwrite newer information the client already received (e.g. a fresh approval request).
      state.pending = [...this.pending.values()].map((p) => p.item);
      state.busy = this.busy;
      state.mode = this.app.session.permissionMode;
      state.queued = this.app.agent.queued;
      state.todos = this.app.session.todos;
      this.broadcast({ type: 'state', state });
    });
  }

  // ------------------------------------------------------------------ state

  async state(full = true): Promise<Record<string, unknown>> {
    const app = this.app;
    const ctx = await app.agent.contextTokens().catch(() => ({ total: 0 }));
    const s = app.settings;
    const out: Record<string, unknown> = {
      version: VERSION,
      setupCompleted: !!readGlobalConfig().setupCompleted,
      project: { root: app.projectRoot, cwd: app.session.cwd, name: path.basename(app.projectRoot) || app.projectRoot, trusted: app.loaded.trusted },
      session: { id: app.sessionId, title: this.sessionTitle(), createdAt: app.createdAt },
      busy: this.busy,
      mode: app.session.permissionMode,
      model: { pinned: app.pinnedModel ?? null, current: app.agent.currentModelKey ?? null },
      pool: app.usableModelCount(),
      usage: { requests: app.agent.requestCount, ...app.agent.totalUsage },
      todos: app.session.todos as Todo[],
      queued: app.agent.queued,
      context: { tokens: (ctx as { total: number }).total, budget: app.agent.contextBudget() },
      pending: [...this.pending.values()].map((p) => p.item),
      settings: {
        router: s.router,
        contextBudget: s.contextBudget,
        autoCompact: s.autoCompact,
        maxSteps: s.maxSteps,
        showReasoning: s.showReasoning,
        bashTimeoutMs: s.bashTimeoutMs,
        webSearch: { provider: s.webSearch.provider, hasBrave: !!s.webSearch.braveApiKey, hasTavily: !!s.webSearch.tavilyApiKey, searxngUrl: s.webSearch.searxngUrl ?? '' },
        permissions: { allow: s.permissions.allow, deny: s.permissions.deny, defaultMode: s.permissions.mode },
        saveSessions: s.saveSessions,
        autoUpdate: s.autoUpdate !== false,
        plainPunctuation: s.plainPunctuation !== false,
      },
      mcp: [...app.mcp.entries].map((e) => {
        const cl = app.mcp.clients.get(e.name);
        return { name: e.name, transport: e.config.url ? 'http' : 'stdio', status: e.needsApproval ? 'needs-trust' : cl?.status ?? 'stopped', tools: cl?.tools.map((t) => t.name) ?? [], error: cl?.error };
      }),
      memory: app.memory.map((m) => ({ path: m.path, scope: m.scope })),
      commands: [...GUI_COMMANDS, ...app.customCommands.map((c) => ({ name: c.name, description: c.description, args: c.argumentHint, custom: true }))],
      recentProjects: ((readGlobalConfig() as Record<string, unknown>).recentProjects as string[] | undefined) ?? [],
      home: os.homedir(),
      index: { ...getIndex().status(), configuredRoots: readGlobalConfig().index?.roots ?? [] },
    };
    if (full) {
      out.transcript = this.transcript();
      out.liveEvents = this.busy ? this.liveEvents : [];
      if (this.initialPrompt) {
        out.initialPrompt = this.initialPrompt;
        this.initialPrompt = undefined;
      }
    }
    return out;
  }

  private sessionTitle(): string {
    const first = this.app.agent.messages.find((m) => m.role === 'user' && !m.meta?.synthetic);
    return first ? truncate(first.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<attached-[\s\S]*$/, '').replace(/\s+/g, ' ').trim(), 80) : 'New task';
  }

  /** Builds displayable items from the conversation history. */
  transcript(): UIItem[] {
    const msgs = this.busy ? this.app.agent.messages.slice(0, this.turnStartIndex) : this.app.agent.messages;
    const items: UIItem[] = [];
    const tools = this.app.agent.currentTools();
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role === 'user') {
        const k = m.meta?.kind;
        if (k === 'summary') items.push({ kind: 'notice', id: `h${i}`, level: 'info', text: 'Earlier conversation was compacted into a summary.' });
        else if (k === 'interrupted') items.push({ kind: 'notice', id: `h${i}`, level: 'warn', text: 'Interrupted by you.' });
        else if (k === 'bash') {
          const firstLine = m.content.split('\n')[0] ?? '';
          const cmd = /^\[The user ran a shell command: ([\s\S]*?)\]$/.exec(firstLine)?.[1] ?? firstLine;
          items.push({ kind: 'shell', id: `h${i}`, command: cmd, output: m.content.split('\n').slice(1).join('\n'), exitCode: null });
        } else if (m.meta?.synthetic) continue;
        else {
          const text = m.content
            .replace(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .replace(/\n\n<attached-(file|folder)[\s\S]*$/, '')
            .replace(/^\[The user sent this message while you were working\]\n/, '');
          items.push({ kind: 'user', id: `h${i}`, text, ts: m.meta?.ts, queued: k === 'queued' });
        }
      } else if (m.role === 'assistant') {
        if (m.content.trim() || m.reasoning) items.push({ kind: 'assistant', id: `h${i}`, text: m.content, model: m.meta?.model, reasoning: m.reasoning });
        for (const tc of m.toolCalls ?? []) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments || '{}');
          } catch {
            input = {};
          }
          const res = msgs.slice(i + 1).find((x) => x.role === 'tool' && x.toolCallId === tc.id);
          const tool = findTool(tools, tc.name);
          const label = tool ? safeLabel(tool, input, this.app.session.cwd, this.app.projectRoot) : tc.name;
          items.push({
            kind: 'tool',
            id: tc.id,
            name: tc.name,
            label,
            input,
            status: !res ? 'error' : res.isError ? (/rejected this action|Permission denied/.test(res.content) ? 'denied' : 'error') : 'ok',
            result: res ? { content: truncate(res.content, 6000), display: res.meta?.display as ToolDisplay | undefined } : undefined,
          });
        }
      }
    }
    items.push(...this.extraItems);
    if (this.busy && this.turnUser) items.push(this.turnUser);
    return items;
  }

  // ------------------------------------------------------------------ prompts

  async prompt(text: string): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
    const t = text.trim();
    if (!t) return { ok: false, error: 'empty' };
    if (this.busy) {
      if (t.startsWith('/')) return { ok: false, error: 'Wait for the current task to finish (or stop it) before running commands.' };
      this.app.agent.enqueue(t);
      this.pushState();
      return { ok: true, queued: true };
    }
    if (t.startsWith('/')) {
      const m = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(t);
      if (m) return this.command(m[1]!, m[2] ?? '');
    }
    if (t.startsWith('!')) {
      void this.shell(t.slice(1).trim());
      return { ok: true };
    }
    if (t.startsWith('#') && t.length > 1 && !t.startsWith('##')) {
      await appendMemory(path.join(this.app.projectRoot, 'AGENTS.md'), t.slice(1).trim());
      await this.app.reloadMemory();
      this.toast('info', `Saved note to AGENTS.md: ${t.slice(1).trim()}`);
      return { ok: true };
    }
    void this.runTurn(text, text);
    return { ok: true };
  }

  private async runTurn(text: string, display: string): Promise<void> {
    if (!this.app.usableModelCount().models) {
      this.toast('error', 'No AI model is available yet. Open Settings → Providers and add a free API key (Gemini, Groq, OpenRouter, Mistral, NVIDIA...).');
      return;
    }
    this.extraItems = [];
    this.turnStartIndex = this.app.agent.messages.length;
    const user: UIItem = { kind: 'user', id: nextId('u'), text: display, ts: Date.now() };
    this.turnUser = user;
    this.busy = true;
    this.liveEvents = [];
    this.broadcast({ type: 'item', item: user });
    this.pushState();
    try {
      const exp = await expandMentions(text, this.app.session.cwd, this.app.files);
      for (const a of exp.attached) {
        const note: Record<string, unknown> = { type: 'item', item: { kind: 'notice', id: nextId('n'), level: 'info', text: `Attached ${a.path}${a.lines ? ` (${a.lines} lines)` : a.kind === 'dir' ? ' (folder listing)' : ' (image)'}` } };
        this.liveEvents.push(note);
        this.broadcast(note);
      }
      await this.app.agent.runTurn(exp.content, { images: exp.images.length ? exp.images : undefined });
    } catch (e) {
      debug('controller', 'turn failed', e);
      this.toast('error', `Unexpected error: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.turnUser = null;
      this.liveEvents = [];
      // Resolve any approvals still open (e.g. after interrupt).
      for (const [id, p] of this.pending) {
        if (p.item.kind === 'permission') p.resolve({ allow: false });
        else p.resolve(null);
        this.pending.delete(id);
        this.broadcast({ type: 'pending_resolved', id });
      }
      await this.app.save();
      this.broadcast({ type: 'turn_done' });
      this.pushState();
    }
    const leftover = this.app.agent.queued.splice(0);
    if (leftover.length) void this.runTurn(leftover.join('\n\n'), leftover.join('\n\n'));
  }

  stop(): void {
    if (this.busy) this.app.agent.abort();
    for (const [id, p] of this.pending) {
      if (p.item.kind === 'permission') p.resolve({ allow: false });
      else p.resolve(null);
      this.pending.delete(id);
      this.broadcast({ type: 'pending_resolved', id });
    }
  }

  private async shell(cmd: string): Promise<void> {
    if (!cmd) return;
    this.busy = true;
    this.pushState();
    const ctrl = new AbortController();
    try {
      const res = await runUserShellCommand(
        cmd,
        { projectRoot: this.app.projectRoot, session: this.app.session, settings: this.app.settings, files: this.app.files, signal: ctrl.signal, toolCallId: 'user-shell', services: { progress: () => undefined }, depth: 0 },
        () => undefined,
      );
      const out = cleanOutput(res.output).trimEnd();
      const item: UIItem = { kind: 'shell', id: nextId('s'), command: cmd, output: truncate(out, 20000), exitCode: res.exitCode };
      this.extraItems.push(item);
      this.broadcast({ type: 'item', item });
      this.app.agent.addContext(`[The user ran a shell command: ${cmd}]\n${truncate(out, 20000) || '(no output)'}${res.exitCode ? `\n[exit code ${res.exitCode}]` : ''}`, 'bash');
      if (res.newCwd) this.app.invalidatePromptCache();
    } finally {
      this.busy = false;
      this.pushState();
    }
  }

  async command(name: string, args: string): Promise<{ ok: boolean; error?: string; action?: string }> {
    const app = this.app;
    switch (name.toLowerCase()) {
      case 'new':
      case 'clear':
      case 'reset':
        await app.save();
        app.newSession();
        this.extraItems = [];
        this.broadcast({ type: 'transcript', transcript: [] });
        this.pushState();
        return { ok: true };
      case 'compact': {
        const ok = await app.agent.compact({ auto: false, all: true, instructions: args.trim() || undefined });
        if (!ok) return { ok: false, error: 'Compaction failed: no model available right now.' };
        await app.save();
        this.broadcast({ type: 'transcript', transcript: this.transcript() });
        this.pushState();
        return { ok: true };
      }
      case 'undo':
      case 'rewind': {
        const res = await app.files.undoLast();
        if (!res) return { ok: false, error: 'Nothing to undo.' };
        const files = [...res.restored.map((f) => `restored ${path.relative(app.projectRoot, f)}`), ...res.deleted.map((f) => `deleted ${path.relative(app.projectRoot, f)}`)];
        app.agent.addContext(`[The user reverted the file changes from an earlier turn: ${files.join('; ')}. Re-read files before editing them again.]`, 'command');
        this.toast('info', `Undid the last changes: ${files.join(', ')}`);
        this.broadcast({ type: 'changes' });
        return { ok: true };
      }
      case 'init':
        void this.runTurn(INIT_PROMPT, '/init').then(() => app.reloadMemory().then(() => this.pushState()));
        return { ok: true };
      case 'review':
        void this.runTurn(REVIEW_PROMPT, '/review');
        return { ok: true };
      case 'commit':
        void this.runTurn(COMMIT_PROMPT, '/commit');
        return { ok: true };
      case 'plan':
        this.setMode('plan');
        return { ok: true };
      case 'yolo':
        this.setMode('bypassPermissions');
        return { ok: true };
      case 'mode': {
        const m = parseMode(args || 'default');
        if (!m) return { ok: false, error: 'Unknown mode' };
        this.setMode(m);
        return { ok: true };
      }
      case 'model':
        return this.setModel(args.trim() || 'auto');
      case 'memory': {
        const note = args.replace(/^add\s+/, '').trim();
        if (!note) return { ok: false, error: 'Usage: /memory <note>' };
        await appendMemory(path.join(app.projectRoot, 'AGENTS.md'), note);
        await app.reloadMemory();
        this.toast('info', `Saved note to AGENTS.md`);
        return { ok: true };
      }
      case 'reset-limits':
        app.health.resetAllCooldowns();
        this.toast('info', 'Cleared all cooldowns; every model will be tried again.');
        return { ok: true };
      case 'setup':
      case 'help':
      case 'settings':
        return { ok: true, action: name.toLowerCase() };
    }
    const custom = app.customCommands.find((c) => c.name === name.toLowerCase());
    if (custom) {
      void this.runTurn(expandCommand(custom, args), `/${name} ${args}`.trim());
      return { ok: true };
    }
    return { ok: false, error: `Unknown command /${name}` };
  }

  setMode(mode: PermissionMode): void {
    this.app.session.permissionMode = mode;
    this.pushState();
  }

  setModel(model: string): { ok: boolean; error?: string } {
    if (model === 'auto') {
      this.app.pinnedModel = undefined;
      this.pushState();
      return { ok: true };
    }
    const hit = findModel(this.app.providers, model);
    if (!hit) return { ok: false, error: `No model matches "${model}"` };
    this.app.pinnedModel = hit.model.key;
    this.pushState();
    return { ok: true };
  }

  // ------------------------------------------------------------------ sessions

  async sessions(): Promise<unknown[]> {
    return listSessions(this.app.projectRoot, 60);
  }

  async resume(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: 'Stop the current task first.' };
    const s = await loadSession(this.app.projectRoot, id);
    if (!s) return { ok: false, error: 'Session not found' };
    await this.app.save();
    this.app.loadSaved(s);
    this.extraItems = [];
    this.broadcast({ type: 'transcript', transcript: this.transcript() });
    this.pushState();
    return { ok: true };
  }

  // ------------------------------------------------------------------ providers & models

  async providers(): Promise<unknown[]> {
    return providerInfos(this.app.providers);
  }

  async saveKey(id: string, key: string, accountId?: string): Promise<{ ok: boolean; saved: boolean; message: string }> {
    const def = getProviderDef(id);
    if (!def) return { ok: false, saved: false, message: 'Unknown provider' };
    const k = key.trim();
    if (!k) return { ok: false, saved: false, message: 'Paste a key first.' };
    const check = await checkKey(def, k, { accountId });
    if (!check.ok && !/Could not reach/.test(check.message)) return { ok: false, saved: false, message: check.message };
    updateGlobalConfig((g) => {
      g.providers = g.providers ?? {};
      const p = { ...(g.providers[id] ?? {}) };
      p.apiKey = k;
      if (accountId) p.accountId = accountId;
      delete p.enabled;
      g.providers[id] = p;
    });
    this.app.reloadConfig();
    this.app.reloadProviders();
    void this.app.startDiscovery(true).then(() => this.pushState());
    this.pushState();
    return { ok: check.ok, saved: true, message: check.ok ? check.message : `Saved, but: ${check.message}` };
  }

  removeKey(id: string): void {
    updateGlobalConfig((g) => {
      const p = g.providers?.[id];
      if (p) {
        delete p.apiKey;
        delete p.apiKeys;
      }
    });
    this.app.reloadConfig();
    this.app.reloadProviders();
    this.pushState();
  }

  setProviderEnabled(id: string, enabled: boolean): void {
    updateGlobalConfig((g) => {
      g.providers = g.providers ?? {};
      g.providers[id] = { ...(g.providers[id] ?? {}), enabled: enabled ? undefined : false };
    });
    this.app.reloadConfig();
    this.app.reloadProviders();
    this.pushState();
  }

  async testProvider(id: string): Promise<{ ok: boolean; message: string }> {
    const p = this.app.providers.find((x) => x.id === id);
    if (!p) return { ok: false, message: 'Unknown provider' };
    return checkKey(p.def, p.apiKeys[0] ?? '', { baseURL: p.baseURL });
  }

  models(): unknown[] {
    const h = this.app.health;
    return this.app.router
      .allModels()
      .filter(({ p }) => !p.paid || this.app.settings.router.allowPaid)
      .sort((a, b) => b.m.quality - a.m.quality)
      .map(({ p, m }) => {
        const wait = h.waitInfo(p, m);
        const disabled = h.isDisabled(m);
        const hm = h.peekModel(m.key);
        return {
          key: m.key,
          id: m.id,
          name: m.name,
          provider: p.id,
          providerName: p.name,
          quality: m.quality,
          tier: qualityTier(m.quality),
          context: h.maxInputTokens(p, m),
          toolMode: h.effectiveToolMode(m),
          reasoning: m.reasoning,
          vision: m.vision,
          paid: p.paid,
          status: disabled ? 'unavailable' : wait.waitMs > 0 ? 'busy' : 'ready',
          waitMs: wait.waitMs,
          reason: disabled ? hm?.disabledReason : wait.reason,
          speed: hm?.tokensPerSec ? Math.round(hm.tokensPerSec) : undefined,
        };
      });
  }

  async refreshModels(): Promise<unknown> {
    const reports = await this.app.startDiscovery(true);
    this.pushState();
    return reports;
  }

  // ------------------------------------------------------------------ settings

  updateSettings(patch: Record<string, unknown>): void {
    const allowed = ['router.enabled', 'router.allowPaid', 'router.maxWaitSeconds', 'router.showDecisions', 'router.prefer', 'router.avoid', 'router.strict', 'contextBudget', 'autoCompact', 'maxSteps', 'showReasoning', 'bashTimeoutMs', 'webSearch.provider', 'webSearch.braveApiKey', 'webSearch.tavilyApiKey', 'webSearch.searxngUrl', 'permissions.mode', 'saveSessions', 'model', 'autoUpdate', 'plainPunctuation', 'index.enabled', 'index.roots'];
    updateGlobalConfig((g) => {
      for (const [k, v] of Object.entries(patch)) if (allowed.includes(k)) setByPath(g as Record<string, unknown>, k, v);
    });
    this.app.reloadConfig();
    this.app.reloadProviders();
    this.pushState();
  }

  editRule(list: 'allow' | 'deny', rule: string, remove: boolean): void {
    updateProjectSettings(this.app.projectRoot, (cfg) => {
      const p = (cfg.permissions ?? { allow: [], deny: [], ask: [] }) as { allow: string[]; deny: string[]; ask: string[] };
      p.allow = (p.allow ?? []).filter((x) => x !== rule);
      p.deny = (p.deny ?? []).filter((x) => x !== rule);
      if (!remove) p[list].push(rule);
      cfg.permissions = p as never;
    });
    this.app.sessionAllow.delete(rule);
    this.app.reloadConfig();
    this.pushState();
  }

  completeSetup(): void {
    updateGlobalConfig((g) => {
      g.setupCompleted = true;
    });
    this.pushState();
  }

  // ------------------------------------------------------------------ files, changes, folders

  async files(q: string): Promise<{ path: string; dir: boolean }[]> {
    const list = await projectFileList(this.app.session.cwd);
    return mentionCompletions(q, list).map((i) => ({ path: i.label, dir: i.label.endsWith('/') }));
  }

  async changes(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const [file, before] of this.app.files.sessionChanges()) {
      let after: string | null;
      try {
        after = await fsp.readFile(file, 'utf8');
      } catch {
        after = null;
      }
      if (after === before) continue;
      const hunks = buildHunks(before ?? '', after ?? '');
      const { added, removed } = diffStats(hunks);
      out.push({ path: file, rel: path.relative(this.app.projectRoot, file) || file, added, removed, created: before === null, deleted: after === null, hunks: hunks.slice(0, 50) });
    }
    return out;
  }

  async listDir(p: string | undefined): Promise<{ path: string; parent: string | null; dirs: { name: string; path: string; isGit: boolean }[]; isGit: boolean }> {
    const dir = path.resolve(p && p.trim() ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : this.app?.projectRoot ?? os.homedir());
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 300)
      .map((e) => {
        const full = path.join(dir, e.name);
        return { name: e.name, path: full, isGit: existsSync(path.join(full, '.git')) };
      });
    const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
    return { path: dir, parent, dirs, isGit: existsSync(path.join(dir, '.git')) };
  }

  async openProject(dir: string, trust?: boolean): Promise<{ ok: boolean; needsTrust?: boolean; root?: string; error?: string }> {
    if (this.busy) return { ok: false, error: 'Stop the current task before switching projects.' };
    const abs = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
    try {
      if (!statSync(abs).isDirectory()) return { ok: false, error: 'Not a folder' };
    } catch {
      return { ok: false, error: 'Folder not found' };
    }
    const tc = await this.trustCheck(abs);
    if (tc.needsTrust && trust === undefined) return { ok: false, needsTrust: true, root: tc.root };
    if (tc.needsTrust && trust) {
      updateGlobalConfig((g) => {
        g.trustedFolders = [...new Set([...(g.trustedFolders ?? []), tc.root])];
      });
    }
    await this.open(abs, tc.needsTrust ? !!trust : undefined);
    this.broadcast({ type: 'reload' });
    return { ok: true };
  }
}

// Application core shared by the interactive REPL and print mode: config, providers, router, agent.
import * as path from 'node:path';
import { loadSkillsCached, skillsPromptSection } from './skills/skills.js';
import { type LoadedConfig, type PermissionMode, type Settings, loadConfig } from './config/config.js';
import { buildProviders, loadDiscoveryCache } from './providers/registry.js';
import { refreshDiscovery, type DiscoveryReport } from './providers/discovery.js';
import type { ProviderRuntime } from './providers/types.js';
import { HealthStore } from './router/health.js';
import { Router } from './router/router.js';
import { Agent, type AgentUI } from './agent/agent.js';
import { FileTracker } from './tools/fileTracker.js';
import type { SessionState } from './tools/types.js';
import { killAllShells } from './tools/bash.js';
import { stopReplRuntimes } from './tools/repl.js';
import { stopDebugSession } from './tools/debugger.js';
import { McpManager, loadMcpConfigs } from './mcp/manager.js';
import { loadMemoryFiles, type MemoryFile } from './agent/memory.js';
import { buildSystemPrompt, environmentSection } from './agent/systemPrompt.js';
import { loadCustomCommands, type CustomCommand } from './agent/customCommands.js';
import { type SavedSession, newSessionId, saveSession, sessionTitle } from './session/session.js';
import { gitRoot } from './util/git.js';
import { runHooks } from './agent/hooks.js';
import { debug } from './util/log.js';
import { refreshToolchain } from './util/toolchain.js';

export interface AppOptions {
  cwd: string;
  interactive: boolean;
  overrides?: Partial<Settings>;
  permissionMode?: PermissionMode;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  trusted?: boolean;
  maxSteps?: number;
}

export class App {
  cwd: string;
  projectRoot!: string;
  loaded!: LoadedConfig;
  providers: ProviderRuntime[] = [];
  health!: HealthStore;
  router!: Router;
  session!: SessionState;
  files!: FileTracker;
  mcp!: McpManager;
  agent!: Agent;
  sessionId = newSessionId();
  createdAt = Date.now();
  memory: MemoryFile[] = [];
  customCommands: CustomCommand[] = [];
  pinnedModel: string | undefined;
  sessionAllow = new Set<string>();
  private envCache: { at: number; cwd: string; text: string } | null = null;
  discoveryPromise: Promise<DiscoveryReport[]> | null = null;

  constructor(public opts: AppOptions) {
    this.cwd = path.resolve(opts.cwd);
  }

  get settings(): Settings {
    return this.loaded.settings;
  }

  async init(ui: AgentUI): Promise<void> {
    void refreshToolchain();
    this.projectRoot = (await gitRoot(this.cwd)) ?? this.cwd;
    this.reloadConfig();
    this.health = new HealthStore();
    this.reloadProviders();
    this.router = new Router(
      () => this.providers,
      this.health,
      () => this.settings,
    );
    this.files = new FileTracker(this.settings.checkpoints);
    this.session = {
      cwd: this.cwd,
      todos: [],
      shells: new Map(),
      shellCounter: 0,
      toolSeq: 0,
      permissionMode: this.opts.permissionMode ?? this.settings.permissions.mode ?? 'default',
    };
    if (this.opts.model && this.opts.model !== 'auto') this.pinnedModel = this.opts.model;
    else if (!this.opts.model && this.settings.model && this.settings.model !== 'auto') this.pinnedModel = this.settings.model;
    this.mcp = new McpManager(this.projectRoot);
    this.agent = this.createAgent(ui);
    [this.memory, this.customCommands] = await Promise.all([loadMemoryFiles(this.projectRoot, this.cwd), loadCustomCommands(this.projectRoot)]);
    const hook = await runHooks(this.settings, 'SessionStart', { session_id: this.sessionId, cwd: this.cwd }, { cwd: this.projectRoot });
    if (hook.context.length) this.agent.addContext(`<session-start-context>\n${hook.context.join('\n')}\n</session-start-context>`, 'command');
  }

  createAgent(ui: AgentUI): Agent {
    return new Agent({
      router: this.router,
      settings: () => this.settings,
      projectRoot: this.projectRoot,
      session: this.session,
      files: this.files,
      mcp: this.mcp,
      interactive: this.opts.interactive,
      permissions: {
        mode: this.session.permissionMode,
        allow: [...this.settings.permissions.allow, ...(this.opts.allowedTools ?? [])],
        deny: [...this.settings.permissions.deny, ...(this.opts.disallowedTools ?? []).filter((d) => d.includes('('))],
        ask: this.settings.permissions.ask,
        projectRoot: this.projectRoot,
        additionalDirectories: this.settings.permissions.additionalDirectories,
        sessionAllow: this.sessionAllow,
        interactive: this.opts.interactive,
      },
      ui,
      systemPrompt: (ctx) => this.systemPrompt(ctx),
      pinnedModel: () => this.pinnedModel,
      disallowedTools: (this.opts.disallowedTools ?? []).filter((d) => !d.includes('(')),
      maxSteps: this.opts.maxSteps,
    });
  }

  reloadConfig(): void {
    this.loaded = loadConfig(this.projectRoot ?? this.cwd, this.opts.overrides, { trusted: this.opts.trusted });
    if (this.agent) {
      const p = this.agent.opts.permissions;
      p.allow = [...this.settings.permissions.allow, ...(this.opts.allowedTools ?? [])];
      p.deny = [...this.settings.permissions.deny];
      p.ask = this.settings.permissions.ask;
      p.additionalDirectories = this.settings.permissions.additionalDirectories;
    }
  }

  reloadProviders(): void {
    this.providers = buildProviders(this.settings, this.loaded.dotenv, loadDiscoveryCache());
  }

  /** Refreshes live model lists in the background (cached for a day). */
  startDiscovery(force = false): Promise<DiscoveryReport[]> {
    const p = refreshDiscovery(this.providers, { force })
      .then(({ reports }) => {
        this.reloadProviders();
        return reports;
      })
      .catch((e) => {
        debug('app', 'discovery failed', e);
        return [] as DiscoveryReport[];
      });
    this.discoveryPromise = p;
    return p;
  }

  startMcp(): Promise<void> {
    const entries = loadMcpConfigs(this.settings, this.projectRoot, this.loaded.trusted);
    return this.mcp.start(entries);
  }

  async systemPrompt(ctx: { depth: number; mode: PermissionMode; agentType?: string }): Promise<string> {
    const cwd = this.session.cwd;
    if (!this.envCache || this.envCache.cwd !== cwd || Date.now() - this.envCache.at > 60_000) {
      this.envCache = { at: Date.now(), cwd, text: await environmentSection(this.projectRoot, cwd) };
    }
    return buildSystemPrompt(
      {
        projectRoot: this.projectRoot,
        cwd,
        mode: ctx.mode,
        memory: this.memory,
        depth: ctx.depth,
        mcpInstructions: this.mcp.instructions(),
        skillsSection: skillsPromptSection(loadSkillsCached(this.projectRoot)),
      },
      this.envCache.text,
    );
  }

  invalidatePromptCache(): void {
    this.envCache = null;
  }

  async reloadMemory(): Promise<void> {
    this.memory = await loadMemoryFiles(this.projectRoot, this.session.cwd);
    this.customCommands = await loadCustomCommands(this.projectRoot);
  }

  usableModelCount(): { models: number; providers: number } {
    const all = this.router.allModels().filter(({ p }) => !p.paid || this.settings.router.allowPaid);
    return { models: all.length, providers: new Set(all.map((x) => x.p.id)).size };
  }

  toSaved(): SavedSession {
    return {
      version: 1,
      id: this.sessionId,
      projectRoot: this.projectRoot,
      title: sessionTitle(this.agent.messages),
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      messages: this.agent.messages,
      todos: this.session.todos,
      modelKey: this.agent.currentModelKey,
      usage: this.agent.totalUsage,
      requests: this.agent.requestCount,
      permissionMode: this.session.permissionMode,
    };
  }

  async save(): Promise<void> {
    if (!this.settings.saveSessions) return;
    if (!this.agent.messages.some((m) => m.role === 'user' && !m.meta?.synthetic)) return;
    try {
      await saveSession(this.toSaved());
    } catch (e) {
      debug('app', 'save failed', e);
    }
  }

  loadSaved(s: SavedSession): void {
    this.sessionId = s.id;
    this.createdAt = s.createdAt;
    this.agent.messages = s.messages;
    this.agent.turn = s.messages.filter((m) => m.role === 'user' && !m.meta?.synthetic).length;
    this.session.todos = s.todos ?? [];
    this.agent.currentModelKey = s.modelKey;
    this.agent.totalUsage = s.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.agent.requestCount = s.requests ?? 0;
    this.stopRuntimes();
  }

  newSession(): void {
    this.sessionId = newSessionId();
    this.createdAt = Date.now();
    this.agent.clear();
    this.session.todos = [];
    this.files.reset();
    this.stopRuntimes();
  }

  /** REPL variables and a paused debugger belong to one conversation. */
  private stopRuntimes(): void {
    stopReplRuntimes(this.session);
    stopDebugSession(this.session);
  }

  shutdown(): void {
    killAllShells(this.session.shells);
    this.stopRuntimes();
    this.mcp.closeAll();
    this.health.saveNow();
  }
}

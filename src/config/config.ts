// Settings: defaults <- ~/.freecode/config.json <- .freecode/settings.json <- .freecode/settings.local.json <- CLI flags.
import * as path from 'node:path';
import { chmodSync } from 'node:fs';
import { globalPaths, projectPaths } from './paths.js';
import { loadDotenvFile } from './dotenv.js';
import { readJsonSync, writeJsonSync } from '../util/fs.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type ToolMode = 'native' | 'text';

export interface RateLimits {
  /** requests per minute */
  rpm?: number;
  /** requests per day */
  rpd?: number;
  /** tokens per minute */
  tpm?: number;
  /** tokens per day */
  tpd?: number;
  /** requests per month */
  rpmonth?: number;
}

export interface ModelUserConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  context?: number;
  maxOutput?: number;
  tools?: ToolMode | 'none';
  quality?: number;
  speed?: number;
  reasoning?: boolean;
  vision?: boolean;
  extraBody?: Record<string, unknown>;
  priority?: number;
  limits?: RateLimits;
}

export interface ProviderUserConfig {
  apiKey?: string;
  /** Several keys may be given; they are rotated when one hits its limits. */
  apiKeys?: string[];
  baseURL?: string;
  enabled?: boolean;
  accountId?: string;
  headers?: Record<string, string>;
  models?: ModelUserConfig[] | Record<string, Partial<ModelUserConfig>>;
  discover?: boolean;
  priority?: number;
  name?: string;
  paid?: boolean;
  limits?: RateLimits;
}

export interface HookConfig {
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';

export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  timeoutMs?: number;
}

export interface Settings {
  /** "auto" (AI router picks) or "provider/model" */
  model: string;
  providers: Record<string, ProviderUserConfig>;
  router: {
    /** Use a small fast model to classify each task before choosing a model. */
    enabled: boolean;
    /** Optional fixed classifier model "provider/model". */
    classifierModel?: string;
    /** Allow paid providers (OpenAI, Anthropic, DeepSeek, ...) in automatic routing. */
    allowPaid: boolean;
    /** Providers or provider/model keys to favour. */
    prefer: string[];
    /** Providers or provider/model keys to never use automatically. */
    avoid: string[];
    /** When a model is pinned, never fall back to others. */
    strict: boolean;
    /** Show the router's decision line in the UI. */
    showDecisions: boolean;
    /** Max seconds to wait for a rate-limited model before switching away from it. */
    maxWaitSeconds: number;
  };
  /** Soft cap for the conversation context in tokens; older content is compacted above it. */
  contextBudget: number;
  autoCompact: boolean;
  maxSteps: number;
  maxOutputTokens?: number;
  temperature?: number;
  permissions: {
    mode: PermissionMode;
    allow: string[];
    deny: string[];
    ask: string[];
    additionalDirectories: string[];
  };
  webSearch: {
    provider: 'auto' | 'duckduckgo' | 'brave' | 'tavily' | 'searxng';
    braveApiKey?: string;
    tavilyApiKey?: string;
    searxngUrl?: string;
  };
  hooks: Partial<Record<HookEvent, HookConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
  /** Approved project MCP servers (from .mcp.json) */
  approvedMcpServers: string[];
  showReasoning: boolean;
  bashTimeoutMs: number;
  /** Extra environment variables for commands run by the agent. */
  env: Record<string, string>;
  /** Auto-save sessions to ~/.freecode/projects */
  saveSessions: boolean;
  /** Keep file snapshots so /undo can revert the agent's edits. */
  checkpoints: boolean;
  /** Folders whose project settings (hooks, MCP servers, permission rules) are trusted. Global only. */
  trustedFolders: string[];
  /** Set after the first-run setup screen was completed. Global only. */
  setupCompleted?: boolean;
}

export function defaultSettings(): Settings {
  return {
    model: 'auto',
    providers: {},
    router: {
      enabled: true,
      allowPaid: false,
      prefer: [],
      avoid: [],
      strict: false,
      showDecisions: true,
      maxWaitSeconds: 20,
    },
    contextBudget: 64000,
    autoCompact: true,
    maxSteps: 200,
    permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [] },
    webSearch: { provider: 'auto' },
    hooks: {},
    mcpServers: {},
    approvedMcpServers: [],
    showReasoning: true,
    bashTimeoutMs: 120_000,
    env: {},
    saveSessions: true,
    checkpoints: true,
    trustedFolders: [],
  };
}

/**
 * Project settings come from the repository and may be hostile. Unless the folder is trusted,
 * drop everything that could run commands, redirect API keys, spend money or widen permissions.
 */
export function sanitizeUntrustedSettings(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = { ...s };
  delete out.providers;
  delete out.hooks;
  delete out.mcpServers;
  delete out.env;
  delete out.model;
  delete out.approvedMcpServers;
  delete out.trustedFolders;
  if (out.router) {
    const r = { ...out.router };
    delete (r as Partial<Settings['router']>).allowPaid;
    delete (r as Partial<Settings['router']>).classifierModel;
    out.router = r;
  }
  if (out.permissions) {
    out.permissions = { deny: out.permissions.deny, ask: out.permissions.ask } as Settings['permissions'];
  }
  if (out.webSearch) delete out.webSearch;
  return out;
}

/** True when the folder (or a parent) was marked as trusted. */
export function isTrustedFolder(settings: Pick<Settings, 'trustedFolders'>, dir: string): boolean {
  const norm = path.resolve(dir);
  return (settings.trustedFolders || []).some((t) => {
    const tt = path.resolve(t);
    return norm === tt || norm.startsWith(tt + path.sep);
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays from `over` are concatenated for permission lists, replaced otherwise. */
export function mergeSettings<T>(base: T, over: Partial<T> | undefined, concatKeys = new Set(['allow', 'deny', 'ask', 'additionalDirectories', 'approvedMcpServers'])): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (Array.isArray(v) && Array.isArray(cur) && concatKeys.has(k)) {
      out[k] = [...new Set([...cur, ...v])];
    } else if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = mergeSettings(cur, v as Partial<typeof cur>, concatKeys);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface LoadedConfig {
  settings: Settings;
  /** Global config as stored on disk (for saving back). */
  global: Partial<Settings>;
  projectRoot: string;
  sources: string[];
  /** Whether project-level settings were applied without restrictions. */
  trusted: boolean;
  /** Variables from ~/.freecode/.env and ./.env (only consulted for API keys). */
  dotenv: Record<string, string>;
}

/** True when the project carries settings that only apply once the folder is trusted. */
export function projectHasRiskySettings(projectRoot: string): boolean {
  const pp = projectPaths(projectRoot);
  for (const f of [pp.settings, pp.localSettings]) {
    const s = readJsonSync<Partial<Settings>>(f, {});
    if (s.hooks || s.mcpServers || s.providers || s.env || s.permissions?.allow?.length || s.permissions?.mode) return true;
  }
  const mcp = readJsonSync<{ mcpServers?: object }>(pp.mcpJson, {});
  return !!(mcp.mcpServers && Object.keys(mcp.mcpServers).length);
}

export function loadConfig(projectRoot: string, overrides?: Partial<Settings>, opts: { trusted?: boolean } = {}): LoadedConfig {
  const sources: string[] = [];
  let settings = defaultSettings();
  const global = readJsonSync<Partial<Settings>>(globalPaths.configFile, {});
  if (Object.keys(global).length) sources.push(globalPaths.configFile);
  settings = mergeSettings(settings, global);
  const trusted = opts.trusted ?? isTrustedFolder(settings, projectRoot);
  const pp = projectPaths(projectRoot);
  for (const file of [pp.settings, pp.localSettings]) {
    const raw = readJsonSync<Partial<Settings>>(file, {});
    if (!Object.keys(raw).length) continue;
    sources.push(file);
    settings = mergeSettings(settings, trusted ? raw : sanitizeUntrustedSettings(raw));
  }
  if (overrides) settings = mergeSettings(settings, overrides);
  const dotenv = { ...loadDotenvFile(path.join(projectRoot, '.env')), ...loadDotenvFile(globalPaths.envFile) };
  return { settings, global, projectRoot, sources, trusted, dotenv };
}

/** Reads the raw global config file. */
export function readGlobalConfig(): Partial<Settings> {
  return readJsonSync<Partial<Settings>>(globalPaths.configFile, {});
}

/** Applies a mutation to the global config file and saves it with private permissions. */
export function updateGlobalConfig(mutate: (cfg: Partial<Settings>) => void): Partial<Settings> {
  const cfg = readGlobalConfig();
  mutate(cfg);
  writeJsonSync(globalPaths.configFile, cfg, 0o600);
  try {
    chmodSync(globalPaths.configFile, 0o600);
  } catch {
    // best effort (Windows)
  }
  return cfg;
}

/** Applies a mutation to a project settings file (.freecode/settings.local.json by default). */
export function updateProjectSettings(projectRoot: string, mutate: (cfg: Partial<Settings>) => void, local = true): void {
  const pp = projectPaths(projectRoot);
  const file = local ? pp.localSettings : pp.settings;
  const cfg = readJsonSync<Partial<Settings>>(file, {});
  mutate(cfg);
  writeJsonSync(file, cfg);
}

/** Gets a value by dotted path, e.g. "router.enabled". */
export function getByPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Parses a CLI string into a JSON value when possible ("true" -> true, "12" -> 12). */
export function parseConfigValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      // fall through
    }
  }
  return raw;
}

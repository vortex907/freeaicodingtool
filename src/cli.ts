// FreeCode CLI entry: argument parsing, interactive mode, print mode and subcommands.
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { VERSION } from './version.js';
import { App } from './app.js';
import type { AgentEvent } from './agent/agent.js';
import { runRepl } from './ui/repl.js';
import { UIHost } from './ui/host.js';
import { runSetupWizard } from './ui/setup.js';
import { parseMode } from './permissions/permissions.js';
import { type PermissionMode, type Settings, getByPath, loadConfig, parseConfigValue, readGlobalConfig, setByPath, updateGlobalConfig } from './config/config.js';
import { globalPaths } from './config/paths.js';
import { buildProviders, loadDiscoveryCache } from './providers/registry.js';
import { refreshDiscovery } from './providers/discovery.js';
import { checkKey } from './providers/validate.js';
import { qualityTier } from './providers/modelInfo.js';
import { HealthStore, humanMs } from './router/health.js';
import { listSessions } from './session/session.js';
import { c, setColorLevel, theme } from './util/ansi.js';
import { enableDebug } from './util/log.js';
import { formatTokens, truncate } from './util/strings.js';
import { gitRoot } from './util/git.js';
import { readJsonSync, writeJsonSync } from './util/fs.js';
import { detectShell, ripgrepPath } from './util/platform.js';

interface CliArgs {
  prompt: string[];
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  model?: string;
  continueLast: boolean;
  resume?: string | true;
  permissionMode?: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  cwd: string;
  noRouter: boolean;
  allowPaid: boolean;
  forceSetup: boolean;
  skipSetup: boolean;
  trust?: boolean;
  debug: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
  noColor: boolean;
  tui: boolean;
  noOpen: boolean;
  port?: number;
  command?: string;
  commandArgs: string[];
}

const SUBCOMMANDS = new Set(['setup', 'providers', 'models', 'doctor', 'config', 'mcp', 'sessions', 'help', 'version', 'app', 'gui', 'web', 'tui']);

function splitList(v: string): string[] {
  return v
    .split(/,(?![^(]*\))|\s+(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    prompt: [],
    print: false,
    outputFormat: 'text',
    continueLast: false,
    allowedTools: [],
    disallowedTools: [],
    cwd: process.cwd(),
    noRouter: false,
    allowPaid: false,
    forceSetup: false,
    skipSetup: false,
    debug: false,
    verbose: false,
    version: false,
    help: false,
    noColor: false,
    tui: false,
    noOpen: false,
    commandArgs: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const val = () => inline ?? next();
    switch (flag) {
      case '-p':
      case '--print':
        a.print = true;
        break;
      case '--output-format':
        a.outputFormat = val() as CliArgs['outputFormat'];
        break;
      case '-m':
      case '--model':
        a.model = val();
        break;
      case '-c':
      case '--continue':
        a.continueLast = true;
        break;
      case '-r':
      case '--resume': {
        const peek = inline ?? argv[i + 1];
        if (peek && !peek.startsWith('-') && /^\d{8}-\d{4}-|^[\w-]{6,}$/.test(peek) && !SUBCOMMANDS.has(peek)) {
          a.resume = inline ?? next();
        } else a.resume = true;
        break;
      }
      case '--permission-mode':
      case '--mode': {
        const m = parseMode(val());
        if (!m) throw new Error('Invalid --permission-mode (use default, acceptEdits, plan or bypassPermissions)');
        a.permissionMode = m;
        break;
      }
      case '--yolo':
      case '--dangerously-skip-permissions':
        a.permissionMode = 'bypassPermissions';
        break;
      case '--plan':
        a.permissionMode = 'plan';
        break;
      case '--accept-edits':
        a.permissionMode = 'acceptEdits';
        break;
      case '--allowedTools':
      case '--allowed-tools':
        a.allowedTools.push(...splitList(val()));
        break;
      case '--disallowedTools':
      case '--disallowed-tools':
        a.disallowedTools.push(...splitList(val()));
        break;
      case '--max-turns':
      case '--max-steps':
        a.maxTurns = Number(val());
        break;
      case '--cwd':
      case '-C':
        a.cwd = path.resolve(val());
        break;
      case '--no-router':
        a.noRouter = true;
        break;
      case '--allow-paid':
        a.allowPaid = true;
        break;
      case '--setup':
        a.forceSetup = true;
        break;
      case '--skip-setup':
      case '--no-setup':
        a.skipSetup = true;
        break;
      case '--trust':
        a.trust = true;
        break;
      case '--debug':
        a.debug = true;
        break;
      case '--verbose':
        a.verbose = true;
        break;
      case '-v':
      case '--version':
        a.version = true;
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '--no-color':
        a.noColor = true;
        break;
      case '--tui':
      case '--terminal':
        a.tui = true;
        break;
      case '--app':
      case '--gui':
        a.tui = false;
        break;
      case '--no-open':
        a.noOpen = true;
        break;
      case '--port':
        a.port = Number(val());
        break;
      default:
        if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) throw new Error(`Unknown option: ${arg} (see freecode --help)`);
        rest.push(arg);
    }
  }
  if (rest.length && SUBCOMMANDS.has(rest[0]!) && !a.print) {
    a.command = rest[0];
    a.commandArgs = rest.slice(1);
  } else a.prompt = rest;
  return a;
}

const HELP = `${'FreeCode'} ${VERSION} - free AI coding agent for your terminal

Usage:
  freecode [options] [prompt]        open the FreeCode app window (optionally with a first prompt)
  freecode --tui [prompt]            use the terminal interface instead of the app window
  freecode -p "prompt" [options]     run once and print the answer (non-interactive)
  cat file | freecode -p "explain"   pipe input into the prompt

Commands:
  freecode setup                     add/change free provider API keys (shown on first run)
  freecode providers                 list providers and whether they are configured
  freecode models [--refresh]        list the models in your pool (--refresh re-discovers them)
  freecode doctor                    check the installation and test every API key
  freecode config get|set|path       read or change settings (e.g. config set router.allowPaid true)
  freecode mcp list|add|remove       manage MCP servers
  freecode sessions                  list saved conversations for this project

Options:
  -p, --print                 non-interactive: run the prompt, print the result, exit
  --output-format <f>         text (default), json or stream-json (with --print)
  -m, --model <model>         "auto" (default: AI router) or provider/model, e.g. groq/openai/gpt-oss-120b
  -c, --continue              continue the most recent conversation in this folder
  -r, --resume [id]           resume a conversation (picker when no id)
  --permission-mode <mode>    default | acceptEdits | plan | bypassPermissions
  --plan / --accept-edits     shortcuts for those modes
  --yolo                      never ask for permission (same as --dangerously-skip-permissions)
  --allowedTools <rules>      e.g. "Bash(npm test:*),Edit"   (allow without asking)
  --disallowedTools <rules>   e.g. "Bash(git push:*),WebFetch"
  --max-turns <n>             limit agent steps for this run
  --cwd <dir>                 work in another directory
  --tui                       terminal interface instead of the app window
  --port <n>                  port for the app (default 7720)
  --no-open                   start the app server without opening a window
  --no-router                 rate tasks with the keyword heuristic instead of the router AI
  --allow-paid                allow paid providers in automatic routing
  --setup / --skip-setup      force or skip the provider setup screen
  --trust                     trust this folder's project settings for this run
  --debug                     write a debug log to ~/.freecode/logs/debug.log
  --verbose                   show progress on stderr in --print mode
  -v, --version               print the version
  -h, --help                  show this help

Inside the app type /help for commands. Docs: https://github.com/vortex907/freeaicodingtool`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function overridesFrom(a: CliArgs): Partial<Settings> {
  const o: Partial<Settings> = {};
  if (a.noRouter || a.allowPaid) o.router = { ...(a.noRouter ? { enabled: false } : {}), ...(a.allowPaid ? { allowPaid: true } : {}) } as Settings['router'];
  return o;
}

// ------------------------------------------------------------------ print mode

function eventJson(e: AgentEvent): Record<string, unknown> {
  switch (e.type) {
    case 'assistant':
      return { type: 'assistant', content: e.message.content, tool_calls: e.message.toolCalls, model: e.message.meta?.model };
    case 'tool_end':
      return { type: 'tool_result', name: e.name, label: e.label, is_error: !!e.result.isError, content: truncate(e.result.content, 4000), duration_ms: e.durationMs };
    case 'tool_start':
      return { type: 'tool_use', id: e.id, name: e.name, input: e.input };
    case 'subagent':
      return { type: 'subagent', id: e.id, description: e.description, event: eventJson(e.event) };
    default:
      return e as unknown as Record<string, unknown>;
  }
}

async function runPrint(a: CliArgs): Promise<number> {
  const stdin = await readStdin();
  let prompt = a.prompt.join(' ').trim();
  if (stdin.trim()) prompt = prompt ? `${prompt}\n\n<stdin>\n${stdin}\n</stdin>` : stdin;
  if (!prompt) {
    process.stderr.write('No prompt given. Usage: freecode -p "your prompt"\n');
    return 2;
  }
  const verbose = a.verbose;
  const fmt = a.outputFormat;
  const err = (s: string) => process.stderr.write(s + '\n');
  const app = new App({
    cwd: a.cwd,
    interactive: false,
    overrides: overridesFrom(a),
    permissionMode: a.permissionMode,
    model: a.model,
    allowedTools: a.allowedTools,
    disallowedTools: a.disallowedTools,
    trusted: a.trust,
    maxSteps: a.maxTurns,
  });
  let lastError: string | undefined;
  await app.init({
    onEvent: (e) => {
      if (fmt === 'stream-json') process.stdout.write(JSON.stringify(eventJson(e)) + '\n');
      if (e.type === 'turn_end' && e.error) lastError = e.error;
      if (!verbose) {
        if (e.type === 'turn_end' && e.error && fmt === 'text') err(`Error: ${e.error}`);
        return;
      }
      switch (e.type) {
        case 'model':
          err(c.dim(`◆ ${e.key}${e.reason !== 'selected' ? ` (${e.reason})` : ''}`));
          break;
        case 'tool_start':
          err(c.dim(`⏺ ${e.label}`));
          break;
        case 'tool_end':
          if (e.result.isError) err(theme.error(`  ⎿  ${truncate(e.result.content.split('\n')[0] ?? '', 200)}`));
          break;
        case 'failover':
          err(theme.warn(`⚠ ${e.from}: ${e.description}`));
          break;
        case 'wait':
          err(c.dim(`⏳ waiting ${humanMs(e.ms)} for ${e.model}`));
          break;
        case 'notice':
          err(`${e.level}: ${e.text}`);
          break;
        case 'turn_end':
          if (e.error) err(theme.error(`Error: ${e.error}`));
          break;
      }
    },
  });
  // Make sure we know the current free models before the first request.
  const cache = loadDiscoveryCache();
  const needsDiscovery = app.providers.some((p) => p.configured && p.def.discovery && p.def.discovery.type !== 'none' && !cache.providers[p.id]);
  if (needsDiscovery) await Promise.race([app.startDiscovery(), new Promise((r) => setTimeout(r, 8000))]);
  else void app.startDiscovery();
  await Promise.race([app.startMcp(), new Promise((r) => setTimeout(r, 15000))]);
  if (a.continueLast || typeof a.resume === 'string') {
    const { latestSession, loadSession } = await import('./session/session.js');
    const s = a.continueLast ? await latestSession(app.projectRoot) : await loadSession(app.projectRoot, a.resume as string);
    if (s) app.loadSaved(s);
  }
  if (!app.usableModelCount().models) {
    err('No AI provider is configured. Run `freecode setup` to add free API keys.');
    app.shutdown();
    return 1;
  }
  const started = Date.now();
  const res = await app.agent.runTurn(prompt);
  await app.save();
  app.shutdown();
  const ok = res.reason === 'done' || res.reason === 'max_steps';
  if (fmt === 'text') {
    if (res.text) process.stdout.write(res.text.trimEnd() + '\n');
  } else if (fmt === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          type: 'result',
          subtype: ok ? 'success' : res.reason,
          is_error: !ok,
          result: res.text,
          error: lastError,
          session_id: app.sessionId,
          num_requests: app.agent.requestCount,
          duration_ms: Date.now() - started,
          usage: app.agent.totalUsage,
          models: Object.fromEntries(app.agent.modelsUsed),
          total_cost_usd: 0,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(JSON.stringify({ type: 'result', is_error: !ok, result: res.text, session_id: app.sessionId, usage: app.agent.totalUsage }) + '\n');
  }
  return ok ? 0 : 1;
}

// ------------------------------------------------------------------ subcommands

async function cmdSetup(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error('`freecode setup` needs an interactive terminal. You can also set keys in ~/.freecode/config.json or environment variables (see README).');
    return 1;
  }
  const host = new UIHost();
  host.start();
  try {
    const res = await runSetupWizard(host, { firstRun: false });
    host.print(`\n${theme.success('✓')} ${res.configured} provider(s) ready. Start coding with: ${theme.accent('freecode')}\n`);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    host.stop();
  }
  return 0;
}

async function loadRuntime(cwd: string) {
  const root = (await gitRoot(cwd)) ?? cwd;
  const loaded = loadConfig(root);
  return { root, loaded, providers: buildProviders(loaded.settings, loaded.dotenv, loadDiscoveryCache()) };
}

async function cmdProviders(cwd: string): Promise<number> {
  const { providers } = await loadRuntime(cwd);
  console.log('');
  for (const p of providers) {
    const status = p.configured ? (p.enabled ? theme.success('ready  ') : c.dim('off    ')) : theme.warn('no key ');
    console.log(`  ${status} ${c.bold(p.name.padEnd(36))} ${c.dim(truncate(p.def.freeTier, 80))}`);
    if (!p.configured) console.log(c.dim(`           get a free key: ${p.def.signupUrl}  (or set ${p.def.keyEnv[0] ?? ''})`));
  }
  console.log(`\n  Run ${theme.accent('freecode setup')} to add keys.\n`);
  return 0;
}

async function cmdModels(cwd: string, args: string[]): Promise<number> {
  let { providers, loaded } = await loadRuntime(cwd);
  if (args.includes('--refresh') || args.includes('refresh')) {
    process.stderr.write('Refreshing model lists…\n');
    const { reports } = await refreshDiscovery(providers, { force: true });
    for (const r of reports) process.stderr.write(`  ${r.ok ? '✓' : '✗'} ${r.provider}: ${r.ok ? `${r.count} models` : r.error}\n`);
    providers = buildProviders(loaded.settings, loaded.dotenv, loadDiscoveryCache());
  }
  const health = new HealthStore();
  const rows = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ p, m })))
    .sort((x, y) => y.m.quality - x.m.quality);
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows.map(({ p, m }) => ({ key: m.key, provider: p.id, id: m.id, quality: m.quality, context: m.context, toolMode: m.toolMode, paid: p.paid })), null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log('No models available. Run `freecode setup` to add free provider keys.');
    return 1;
  }
  for (const { p, m } of rows) {
    const wait = health.waitInfo(p, m).waitMs;
    const st = health.isDisabled(m) ? theme.error('unavailable') : wait > 0 ? theme.warn(`busy ${humanMs(wait)}`) : theme.success('ready');
    console.log(`  ${qualityTier(m.quality)}  ${m.key.padEnd(58)} ${c.dim(`${formatTokens(m.context).padStart(5)} ctx  ${m.toolMode.padEnd(6)}${p.paid ? ' paid' : ''}`)}  ${st}`);
  }
  console.log(c.dim(`\n  ${rows.length} models. Tier = estimated coding strength (S best). Pick one with: freecode -m <key>`));
  return 0;
}

async function cmdDoctor(cwd: string): Promise<number> {
  const { providers } = await loadRuntime(cwd);
  console.log(`\n${c.bold('FreeCode doctor')} ${VERSION}`);
  console.log(`  Node.js ${process.version} ${Number(process.versions.node.split('.')[0]) >= 20 ? theme.success('ok') : theme.error('too old, need 20+')}`);
  console.log(`  Shell: ${detectShell().name} (${detectShell().path})`);
  console.log(`  ripgrep: ${ripgrepPath() ?? 'not found (built-in search is used)'}`);
  console.log(`  Config: ${globalPaths.configFile}`);
  let okCount = 0;
  for (const p of providers.filter((x) => x.configured && x.enabled)) {
    if (!p.def.keyRequired && p.def.kind !== 'local') {
      console.log(`  ${theme.success('✓')} ${p.name}: no key needed`);
      okCount++;
      continue;
    }
    const r = await checkKey(p.def, p.apiKeys[0] ?? '', { baseURL: p.baseURL });
    if (r.ok) okCount++;
    console.log(`  ${r.ok ? theme.success('✓') : theme.error('✗')} ${p.name}: ${r.message}`);
  }
  if (!okCount) console.log(theme.warn('\n  No working providers. Run `freecode setup`.'));
  console.log('');
  return 0;
}

async function cmdConfig(args: string[]): Promise<number> {
  const [verb, key, ...rest] = args;
  if (!verb || verb === 'path') {
    console.log(globalPaths.configFile);
    return 0;
  }
  if (verb === 'get') {
    const cfg = readGlobalConfig();
    console.log(JSON.stringify(key ? getByPath(cfg, key) : cfg, (k, v) => (k === 'apiKey' && typeof v === 'string' ? v.slice(0, 4) + '…' : v), 2));
    return 0;
  }
  if (verb === 'set' && key) {
    const value = parseConfigValue(rest.join(' '));
    updateGlobalConfig((g) => setByPath(g as Record<string, unknown>, key, value));
    console.log(`Set ${key} = ${JSON.stringify(value)}`);
    return 0;
  }
  console.error('Usage: freecode config path | get [key] | set <key> <value>');
  return 1;
}

async function cmdMcp(args: string[]): Promise<number> {
  const [verb, name, ...rest] = args;
  const file = globalPaths.mcpFile;
  const data = readJsonSync<{ mcpServers?: Record<string, unknown> }>(file, {});
  data.mcpServers = data.mcpServers ?? {};
  if (!verb || verb === 'list') {
    const entries = Object.entries(data.mcpServers);
    if (!entries.length) console.log(`No MCP servers in ${file}. Add one: freecode mcp add <name> <command> [args...]  or  freecode mcp add <name> https://url`);
    for (const [n, cfg] of entries) console.log(`  ${c.bold(n)}  ${JSON.stringify(cfg)}`);
    return 0;
  }
  if (verb === 'add' && name && rest.length) {
    const target = rest[0]!;
    data.mcpServers[name] = /^https?:\/\//.test(target) ? { type: 'http', url: target } : { command: target, args: rest.slice(1) };
    writeJsonSync(file, data);
    console.log(`Added MCP server "${name}" to ${file}`);
    return 0;
  }
  if ((verb === 'remove' || verb === 'rm') && name) {
    delete data.mcpServers[name];
    writeJsonSync(file, data);
    console.log(`Removed MCP server "${name}"`);
    return 0;
  }
  console.error('Usage: freecode mcp list | add <name> <command|url> [args...] | remove <name>');
  return 1;
}

async function cmdSessions(cwd: string): Promise<number> {
  const root = (await gitRoot(cwd)) ?? cwd;
  const list = await listSessions(root, 50);
  if (!list.length) {
    console.log('No saved conversations for this project.');
    return 0;
  }
  for (const s of list) console.log(`  ${c.dim(s.id)}  ${truncate(s.title, 70)}  ${c.dim(new Date(s.updatedAt).toLocaleString())}`);
  console.log(c.dim('\n  Resume with: freecode --resume <id>'));
  return 0;
}

// ------------------------------------------------------------------ app window (GUI)

async function runGui(a: CliArgs): Promise<number> {
  const { startServer } = await import('./server/server.js');
  const { launchApp } = await import('./server/launch.js');
  process.stdout.write(`${theme.brand('✻ FreeCode')} ${c.dim(VERSION)} starting…\n`);
  const srv = await startServer({
    cwd: a.cwd,
    port: a.port,
    permissionMode: a.permissionMode,
    model: a.model,
    allowedTools: a.allowedTools,
    disallowedTools: a.disallowedTools,
    trusted: a.trust,
    overrides: overridesFrom(a),
    initialPrompt: a.prompt.join(' ').trim() || undefined,
  });
  let resolveExit: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveExit = r));
  const launched = a.noOpen ? { mode: 'none' as const } : launchApp(srv.url);
  if (launched.mode === 'app-window') {
    process.stdout.write(`${theme.success('✓')} App window opened. ${c.dim('Closing the window quits FreeCode. Press Ctrl+C here to quit too.')}\n`);
    const started = Date.now();
    launched.child?.on('exit', () => {
      if (Date.now() - started < 4000) {
        process.stdout.write(c.dim('The app window was handed to an already running browser. Close it or press Ctrl+C here to quit.\n'));
        return;
      }
      resolveExit();
    });
  } else if (launched.mode === 'browser') {
    process.stdout.write(`${theme.success('✓')} Opened FreeCode in your browser. ${c.dim('Press Ctrl+C here to quit.')}\n`);
  } else {
    process.stdout.write(`Open this address in your browser to use FreeCode:\n\n  ${theme.accent(srv.url)}\n\n${c.dim(`(Over SSH: ssh -L ${srv.port}:127.0.0.1:${srv.port} <host>, then open the address locally.)  Ctrl+C quits.`)}\n`);
  }
  if (a.noOpen && launched.mode === 'none') process.stdout.write(c.dim(`App address: ${srv.url}\n`));
  const onSignal = () => resolveExit();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await done;
  process.stdout.write(c.dim('Shutting down…\n'));
  await srv.close();
  return 0;
}

// ------------------------------------------------------------------ main

export async function main(argv: string[]): Promise<number> {
  let a: CliArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (a.noColor) setColorLevel(0);
  if (a.debug) enableDebug();
  if (a.version) {
    console.log(VERSION);
    return 0;
  }
  if (a.help || a.command === 'help') {
    console.log(HELP);
    return 0;
  }
  try {
    await fsp.access(a.cwd);
  } catch {
    console.error(`Directory not found: ${a.cwd}`);
    return 2;
  }
  switch (a.command) {
    case 'app':
    case 'gui':
    case 'web':
      return runGui(a);
    case 'tui':
      a.tui = true;
      a.prompt = a.commandArgs;
      break;
    case 'version':
      console.log(VERSION);
      return 0;
    case 'setup':
      return cmdSetup();
    case 'providers':
      return cmdProviders(a.cwd);
    case 'models':
      return cmdModels(a.cwd, a.commandArgs);
    case 'doctor':
      return cmdDoctor(a.cwd);
    case 'config':
      return cmdConfig(a.commandArgs);
    case 'mcp':
      return cmdMcp(a.commandArgs);
    case 'sessions':
      return cmdSessions(a.cwd);
  }
  if (a.print || (!process.stdin.isTTY && (a.prompt.length || a.tui))) return runPrint(a);
  if (!a.tui) return runGui(a);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('The terminal interface needs an interactive terminal. Use the app (freecode) or -p "prompt".');
    return 2;
  }
  return runRepl({
    cwd: a.cwd,
    interactive: true,
    overrides: overridesFrom(a),
    permissionMode: a.permissionMode,
    model: a.model,
    allowedTools: a.allowedTools,
    disallowedTools: a.disallowedTools,
    trusted: a.trust,
    maxSteps: a.maxTurns,
    initialPrompt: a.prompt.join(' ').trim() || undefined,
    resume: a.resume,
    continueLast: a.continueLast,
    skipSetup: a.skipSetup,
    forceSetup: a.forceSetup,
  });
}

// Silence unhandled rejections from background tasks (they are logged in debug mode).
process.on('unhandledRejection', (e) => {
  if (process.env.FREECODE_DEBUG) console.error('Unhandled rejection:', e);
});

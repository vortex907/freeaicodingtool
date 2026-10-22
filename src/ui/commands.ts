// Slash commands for the interactive REPL.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { App } from '../app.js';
import type { UIHost } from './host.js';
import type { InputEditor } from './inputEditor.js';
import type { PermissionMode } from '../config/config.js';
import { getByPath, parseConfigValue, readGlobalConfig, setByPath, updateGlobalConfig, updateProjectSettings } from '../config/config.js';
import { globalPaths, projectPaths } from '../config/paths.js';
import { SelectList, TextPrompt, type SelectOption } from './widgets.js';
import { runSetupWizard } from './setup.js';
import { c, padEndWidth, stringWidth, theme, truncateToWidth } from '../util/ansi.js';
import { formatDuration, formatTokens, pluralize, truncate } from '../util/strings.js';
import { findModel } from '../providers/registry.js';
import { qualityTier } from '../providers/modelInfo.js';
import { humanMs, keyId, today } from '../router/health.js';
import { listSessions, loadSession } from '../session/session.js';
import { MODE_CYCLE, modeLabel, parseMode } from '../permissions/permissions.js';
import { renderTodos, renderToolResult, boxLines } from './render.js';
import { unifiedDiff } from '../tools/diff.js';
import { renderMarkdown } from './markdown.js';
import { appendMemory } from '../agent/memory.js';
import { expandCommand } from '../agent/customCommands.js';
import { displayPath } from '../util/fs.js';
import { git } from '../util/git.js';
import { ripgrepPath, detectShell } from '../util/platform.js';
import { VERSION } from '../version.js';
import { debugLogPath, isDebug } from '../util/log.js';

export interface ReplApi {
  app: App;
  host: UIHost;
  editor: InputEditor;
  width(): number;
  print(text: string): void;
  printLines(lines: string[]): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  runPrompt(text: string, opts?: { display?: string }): Promise<void>;
  setMode(mode: PermissionMode): void;
  exit(): void;
  refreshAfterConfigChange(): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  run: (r: ReplApi, args: string) => Promise<void> | void;
}

const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file in the project root that will help AI coding agents work in this repository. Include:
- How to build, run, lint and test (including how to run a single test)
- Code style and conventions actually used in the project
- A short architecture overview: important directories, entry points, how the pieces fit together
- Gotchas and project-specific rules
Keep it concise (about 40-80 lines) and specific to this project; don't pad it with generic advice. If AGENTS.md, CLAUDE.md or similar instruction files already exist, read them and improve AGENTS.md instead of duplicating.`;

const REVIEW_PROMPT = `Review the current uncommitted changes in this repository (use git status and git diff, including untracked files). Look for bugs, logic errors, security problems, missing error handling, missing tests and inconsistencies with the surrounding code. Report the findings ordered by severity with file:line references and concrete suggestions. Do not modify any files.`;

const COMMIT_PROMPT = `Create a git commit for the current changes. Run git status and git diff to see what changed, stage the relevant files (not unrelated or generated files, never secrets like .env), and commit with a concise message in the style of the repository's recent commits that explains what and why. Do not push. Show the resulting commit.`;

function modelLine(r: ReplApi, p: { id: string; name: string; paid: boolean; kind: string }, m: { key: string; id: string; quality: number; context: number; toolMode: string }, width: number): SelectOption<string> {
  const health = r.app.health;
  const wait = health.waitInfo(r.app.providers.find((x) => x.id === p.id)!, m as never);
  const disabled = health.isDisabled(m as never);
  let status = theme.success('ready');
  if (disabled) status = theme.error('unavailable');
  else if (wait.waitMs > 0) status = theme.warn(`busy ${humanMs(wait.waitMs)}`);
  const desc = `${qualityTier(m.quality)} · ${formatTokens(m.context)} ctx${m.toolMode === 'text' ? ' · text tools' : ''}${p.paid ? ' · paid' : ''}`;
  void width;
  return { label: m.key, value: m.key, description: desc, status };
}

export function builtinCommands(): SlashCommand[] {
  const cmds: SlashCommand[] = [
    {
      name: 'help',
      aliases: ['?'],
      description: 'Show commands and keyboard shortcuts',
      run: (r) => {
        const w = r.width();
        const all = [...builtinCommands(), ...r.app.customCommands.map((cc) => ({ name: cc.name, description: `${cc.description} (${cc.source})`, args: cc.argumentHint }))];
        const nameW = Math.min(24, Math.max(...all.map((x) => x.name.length + (x.args ? x.args.length + 1 : 0))) + 3);
        const lines = [
          '',
          theme.brand(`FreeCode ${VERSION}`) + c.dim(' - free AI coding agent with automatic model routing'),
          '',
          c.bold('Commands'),
          ...all.map((x) => `  ${theme.accent(padEndWidth('/' + x.name + (x.args ? ' ' + c.dim(x.args) : ''), nameW + 1))} ${truncateToWidth(x.description, Math.max(20, w - nameW - 6))}`),
          '',
          c.bold('Shortcuts'),
          `  ${theme.accent('enter')}            send        ${theme.accent('\\ + enter')} / ${theme.accent('ctrl+j')} / ${theme.accent('alt+enter')}  new line`,
          `  ${theme.accent('esc')}              interrupt the agent (or clear input with esc esc)`,
          `  ${theme.accent('shift+tab')}        cycle modes: default → accept edits → plan`,
          `  ${theme.accent('ctrl+c')}           interrupt / clear input / exit (twice)`,
          `  ${theme.accent('↑ ↓')}              history      ${theme.accent('ctrl+l')} clear screen   ${theme.accent('ctrl+t')} show todos`,
          `  ${theme.accent('@path')}            attach a file or folder   ${theme.accent('!cmd')} run a shell command   ${theme.accent('#note')} save a memory`,
          `  ${c.dim('Type while the agent works: your message is delivered at its next step.')}`,
          '',
        ];
        r.printLines(lines);
      },
    },
    {
      name: 'setup',
      aliases: ['login', 'keys', 'providers-setup'],
      description: 'Add or change free provider API keys',
      run: async (r) => {
        const res = await runSetupWizard(r.host, { firstRun: false });
        r.refreshAfterConfigChange();
        if (res.changed) {
          r.info(`${res.configured} provider(s) ready. Refreshing model lists…`);
          void r.app.startDiscovery(true).then(() => {
            const n = r.app.usableModelCount();
            r.info(`Model pool updated: ${n.models} models from ${n.providers} providers.`);
          });
        }
      },
    },
    {
      name: 'model',
      description: 'Pick a model, or "auto" to let the router choose',
      args: '[auto|provider/model]',
      run: async (r, args) => {
        const a = args.trim();
        if (a === 'auto' || a === 'default') {
          r.app.pinnedModel = undefined;
          r.info('Model: auto (the router picks the best available free model for each task).');
          return;
        }
        if (a) {
          const hit = findModel(r.app.providers, a);
          if (!hit) return r.error(`No model matches "${a}". Use /models to list them.`);
          r.app.pinnedModel = hit.model.key;
          r.info(`Model pinned to ${hit.model.key}. FreeCode still falls back to other models if it is unavailable (set router.strict to prevent that).`);
          return;
        }
        const options: SelectOption<string>[] = [{ label: 'auto', value: 'auto', description: 'AI router picks the best available model for every task (recommended)', status: r.app.pinnedModel ? '' : theme.success('current') }];
        const models = r.app.router
          .allModels()
          .filter(({ p }) => !p.paid || r.app.settings.router.allowPaid)
          .sort((x, y) => y.m.quality - x.m.quality);
        for (const { p, m } of models) {
          const o = modelLine(r, p, m, r.width());
          if (r.app.pinnedModel === m.key) o.status = theme.success('current');
          options.push(o);
        }
        const choice = await r.host.showWidget(new SelectList([c.bold('Select a model'), c.dim('Tier S/A/B/C = estimated coding strength. "busy" models are rate limited right now.')], options, { numbered: false, maxVisible: 15, footer: '↑/↓ select · enter confirm · esc cancel' }));
        if (!choice) return;
        if (choice === 'auto') {
          r.app.pinnedModel = undefined;
          r.info('Model: auto');
        } else {
          r.app.pinnedModel = choice;
          r.info(`Model pinned to ${choice}.`);
        }
      },
    },
    {
      name: 'models',
      description: 'List all models in your pool (use "refresh" to re-discover)',
      args: '[refresh]',
      run: async (r, args) => {
        if (args.trim() === 'refresh') {
          const reports = await r.host.withSpinner('Asking providers for their current models…', () => r.app.startDiscovery(true));
          for (const rep of reports) r.print(`  ${rep.ok ? theme.success('✓') : theme.error('✗')} ${rep.provider}: ${rep.ok ? `${rep.count} models` : rep.error}`);
        }
        const w = r.width();
        const lines: string[] = [''];
        for (const p of r.app.providers) {
          if (!p.enabled) continue;
          const usable = p.models.filter((m) => m.enabled);
          if (!usable.length) continue;
          lines.push(`${c.bold(p.name)} ${c.dim(`(${p.id}${p.paid ? ', paid' : ''})`)}`);
          for (const m of usable.sort((a, b) => b.quality - a.quality)) {
            const h = r.app.health;
            const wait = h.waitInfo(p, m);
            const status = h.isDisabled(m) ? theme.error('unavailable') : wait.waitMs > 0 ? theme.warn(`busy ${humanMs(wait.waitMs)}`) : theme.success('ready');
            const left = `  ${qualityTier(m.quality)} ${m.id}`;
            const right = `${formatTokens(m.context)} ctx · ${m.toolMode}${m.reasoning ? ' · reasoning' : ''} · ${status}`;
            lines.push(padEndWidth(truncateToWidth(left, w - stringWidth(right) - 4), w - stringWidth(right) - 2) + c.dim(right));
          }
        }
        const n = r.app.usableModelCount();
        lines.push('', c.dim(`${n.models} models from ${n.providers} providers. Tier = estimated coding strength (S best). /model to pin one.`), '');
        r.printLines(lines);
      },
    },
    {
      name: 'providers',
      description: 'Show providers, keys, quota used today and cooldowns',
      run: (r) => {
        const lines: string[] = [''];
        const usage = r.app.health.allUsageToday();
        for (const p of r.app.providers) {
          if (!p.configured && p.kind !== 'free') continue;
          const used = Object.entries(usage)
            .filter(([k]) => k.startsWith(`provider:${p.id}#`))
            .reduce((a, [, u]) => ({ req: a.req + u.requests, tok: a.tok + u.promptTokens + u.completionTokens }), { req: 0, tok: 0 });
          const status = !p.configured ? theme.warn('no key') : !p.enabled ? c.dim('disabled') : theme.success('ready');
          const cool = r.app.health.activeCooldowns().filter((x) => x.key.startsWith(`provider:${p.id}#`) || x.key.startsWith(`${p.id}/`));
          lines.push(`${padEndWidth(c.bold(p.name), 36)} ${padEndWidth(status, 12)} ${c.dim(`${p.models.filter((m) => m.enabled).length} models · today: ${used.req} req, ${formatTokens(used.tok)} tokens`)}`);
          for (const cd of cool.slice(0, 3)) lines.push(c.dim(`    ⏳ ${cd.key.split('#')[0]}: ${cd.cooldown.reason} (${humanMs(cd.cooldown.until - Date.now())})`));
          if (!p.configured && p.unavailableReason) lines.push(c.dim(`    ${p.unavailableReason} - ${p.def.signupUrl}`));
        }
        lines.push('', c.dim('Add keys with /setup. Reset cooldowns with /reset-limits.'), '');
        r.printLines(lines);
      },
    },
    {
      name: 'router',
      description: 'Router settings: on/off (AI task classification), status, paid on/off',
      args: '[on|off|status|paid on|paid off]',
      run: (r, args) => {
        const a = args.trim().toLowerCase();
        if (a === 'on' || a === 'off') {
          updateGlobalConfig((g) => {
            g.router = { ...(g.router ?? {}), enabled: a === 'on' } as never;
          });
          r.refreshAfterConfigChange();
          r.info(`AI router ${a === 'on' ? 'enabled: a small fast model rates each task' : 'disabled: tasks are rated with a fast keyword heuristic'}.`);
          return;
        }
        if (a.startsWith('paid')) {
          const on = a.endsWith('on');
          updateGlobalConfig((g) => {
            g.router = { ...(g.router ?? {}), allowPaid: on } as never;
          });
          r.refreshAfterConfigChange();
          r.info(on ? 'Paid models may now be used automatically (they are still ranked after free ones).' : 'Paid models are only used when you pin them with /model.');
          return;
        }
        const s = r.app.settings.router;
        const prof = r.app.agent.lastProfile;
        r.printLines([
          '',
          `${c.bold('Router')}: ${s.enabled ? theme.success('AI classification on') : c.dim('heuristic only')} · paid models ${s.allowPaid ? 'allowed' : 'off'} · max wait ${s.maxWaitSeconds}s`,
          prof ? `Last task: ${prof.complexity} ${prof.type}${prof.needsReasoning ? ', needs reasoning' : ''} (${prof.source}${prof.classifier ? ` via ${prof.classifier}` : ''})` : '',
          `Current model: ${r.app.agent.currentModelKey ?? '(none yet)'}${r.app.pinnedModel ? ` · pinned: ${r.app.pinnedModel}` : ''}`,
          c.dim('The router scores every free model by strength, speed, context size, remaining quota and recent errors,'),
          c.dim('keeps using the same model while it works, and switches automatically when one is rate limited or fails.'),
          '',
        ].filter((l) => l !== ''));
      },
    },
    {
      name: 'usage',
      aliases: ['cost', 'stats'],
      description: 'Requests and tokens used (session and today)',
      run: (r) => {
        const a = r.app.agent;
        const lines = ['', c.bold('This session'), `  ${a.requestCount} requests · ${formatTokens(a.totalUsage.promptTokens)} tokens in · ${formatTokens(a.totalUsage.completionTokens)} out · cost $0.00 (free models)`];
        if (a.modelsUsed.size) lines.push(`  models: ${[...a.modelsUsed.entries()].map(([k, n]) => `${k} (${n})`).join(', ')}`);
        lines.push('', c.bold(`Today (${today()})`));
        const usage = r.app.health.allUsageToday();
        const rows = Object.entries(usage)
          .filter(([k]) => !k.startsWith('provider:'))
          .sort((x, y) => y[1].requests - x[1].requests);
        if (!rows.length) lines.push(c.dim('  no requests yet'));
        for (const [k, u] of rows.slice(0, 25)) lines.push(`  ${padEndWidth(k.split('#')[0]!, 50)} ${String(u.requests).padStart(5)} req  ${formatTokens(u.promptTokens + u.completionTokens).padStart(7)} tokens`);
        lines.push('');
        r.printLines(lines);
      },
    },
    {
      name: 'status',
      description: 'Session, project and configuration status',
      run: async (r) => {
        const app = r.app;
        const ctx = await app.agent.contextTokens();
        const budget = app.agent.contextBudget();
        const n = app.usableModelCount();
        r.printLines([
          '',
          `${c.bold('FreeCode')} ${VERSION}  ·  session ${app.sessionId}`,
          `  Project:   ${app.projectRoot}`,
          `  Directory: ${app.session.cwd}`,
          `  Mode:      ${modeLabel(app.session.permissionMode)}`,
          `  Model:     ${app.pinnedModel ?? 'auto'}${app.agent.currentModelKey ? ` (last used ${app.agent.currentModelKey})` : ''}`,
          `  Pool:      ${n.models} models from ${n.providers} providers`,
          `  Context:   ~${formatTokens(ctx.total)} of ${formatTokens(budget)} budget (${Math.round((ctx.total / budget) * 100)}%)`,
          `  Memory:    ${app.memory.length ? app.memory.map((m) => displayPath(m.path, app.projectRoot)).join(', ') : 'none (create one with /init)'}`,
          `  MCP:       ${app.mcp.clients.size ? [...app.mcp.clients.values()].map((cl) => `${cl.name} (${cl.status})`).join(', ') : 'none'}`,
          `  Config:    ${app.loaded.sources.join(', ') || 'defaults'}${app.loaded.trusted ? '' : ' (project settings restricted: folder not trusted)'}`,
          `  Shell:     ${detectShell().name} · ripgrep ${ripgrepPath() ? 'yes' : 'no (using built-in search)'}`,
          isDebug() ? `  Debug log: ${debugLogPath()}` : '',
          '',
        ].filter((l) => l !== ''));
      },
    },
    {
      name: 'context',
      description: 'Show how the context window is used',
      run: async (r) => {
        const t = await r.app.agent.contextTokens();
        const budget = r.app.agent.contextBudget();
        const bar = (n: number) => {
          const w = 30;
          const filled = Math.min(w, Math.round((n / budget) * w));
          return theme.accent('█'.repeat(filled)) + c.dim('░'.repeat(w - filled));
        };
        r.printLines([
          '',
          `${c.bold('Context')} ~${formatTokens(t.total)} / ${formatTokens(budget)} tokens  ${bar(t.total)}`,
          `  System prompt  ${formatTokens(t.system).padStart(6)}`,
          `  Tools          ${formatTokens(t.tools).padStart(6)}`,
          `  Conversation   ${formatTokens(t.messages).padStart(6)}  (${r.app.agent.messages.length} messages)`,
          c.dim('  Older content is compacted automatically above the budget. /compact to do it now.'),
          '',
        ]);
      },
    },
    {
      name: 'compact',
      description: 'Summarize the conversation to free up context',
      args: '[focus instructions]',
      run: async (r, args) => {
        if (r.app.agent.messages.length < 2) return r.info('Nothing to compact yet.');
        const ok = await r.host.withSpinner('Compacting conversation…', () => r.app.agent.compact({ auto: false, all: true, instructions: args.trim() || undefined }));
        if (!ok) r.warn('Compaction failed (no model available). Try again later or use /clear.');
        else await r.app.save();
      },
    },
    {
      name: 'clear',
      aliases: ['reset', 'new'],
      description: 'Start a new conversation (the old one stays in /resume)',
      run: async (r) => {
        await r.app.save();
        r.app.newSession();
        r.info('Started a new conversation.');
      },
    },
    {
      name: 'resume',
      description: 'Resume a previous conversation in this project',
      args: '[session id]',
      run: async (r, args) => {
        let id = args.trim();
        if (!id) {
          const list = await listSessions(r.app.projectRoot, 40);
          if (!list.length) return r.info('No saved sessions for this project yet.');
          const choice = await r.host.showWidget(
            new SelectList(
              [c.bold('Resume a conversation')],
              list.map((s) => ({ label: truncate(s.title, 60), value: s.id, description: `${new Date(s.updatedAt).toLocaleString()} · ${pluralize(s.messages, 'prompt')}` })),
              { numbered: false, maxVisible: 12, footer: 'enter resume · esc cancel' },
            ),
          );
          if (!choice) return;
          id = choice;
        }
        const s = await loadSession(r.app.projectRoot, id);
        if (!s) return r.error(`Session ${id} not found.`);
        await r.app.save();
        r.app.loadSaved(s);
        r.info(`Resumed "${s.title}" (${s.messages.length} messages). Continue where you left off.`);
        const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
        if (lastAssistant) r.printLines(renderMarkdown(truncate(lastAssistant.content, 1500), r.width() - 2).map((l) => c.dim('  ' + l)));
      },
    },
    {
      name: 'undo',
      aliases: ['rewind'],
      description: "Revert the file changes made in the agent's last turn",
      run: async (r) => {
        const res = await r.app.files.undoLast();
        if (!res) return r.info('Nothing to undo.');
        const files = [...res.restored.map((f) => `restored ${displayPath(f, r.app.projectRoot)}`), ...res.deleted.map((f) => `deleted ${displayPath(f, r.app.projectRoot)}`)];
        r.info(`Undid turn ${res.turn}: ${files.join(', ')}`);
        r.app.agent.addContext(`[The user reverted the file changes from an earlier turn: ${files.join('; ')}. Re-read files before editing them again.]`, 'command');
      },
    },
    {
      name: 'diff',
      description: 'Show changes made to files in this session (or git diff)',
      run: async (r) => {
        const changes = r.app.files.sessionChanges();
        if (!changes.size) {
          const g = await git(['diff', '--stat'], r.app.projectRoot);
          return r.info(g.stdout.trim() ? `No FreeCode edits this session. git diff --stat:\n${g.stdout}` : 'No changes in this session.');
        }
        const lines: string[] = [];
        for (const [file, before] of changes) {
          let after = '';
          try {
            after = await fsp.readFile(file, 'utf8');
          } catch {
            after = '';
          }
          const d = unifiedDiff(displayPath(file, r.app.projectRoot), before ?? '', after);
          if (d) lines.push(...d.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? c.green(l) : l.startsWith('-') && !l.startsWith('---') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : l)));
        }
        r.printLines(lines.length ? ['', ...lines, ''] : ['No net changes.']);
      },
    },
    {
      name: 'todos',
      description: "Show the agent's current task list",
      run: (r) => {
        const t = r.app.session.todos;
        if (!t.length) return r.info('No tasks right now.');
        r.printLines(['', ...renderTodos(t, r.width() - 4).map((l) => '  ' + l), '']);
      },
    },
    {
      name: 'mode',
      aliases: ['permissions-mode'],
      description: 'Permission mode: default, acceptEdits, plan, yolo',
      args: '[default|acceptEdits|plan|yolo]',
      run: (r, args) => {
        const m = parseMode(args || 'default');
        if (!m) return r.error('Unknown mode. Use default, acceptEdits, plan or yolo.');
        r.setMode(m);
      },
    },
    {
      name: 'plan',
      description: 'Switch to plan mode (research and plan before editing)',
      run: (r) => r.setMode('plan'),
    },
    {
      name: 'yolo',
      description: 'Run everything without asking (bypass permissions)',
      run: (r) => r.setMode('bypassPermissions'),
    },
    {
      name: 'permissions',
      aliases: ['allowed-tools'],
      description: 'Show permission rules; add/remove with allow|deny|remove <rule>',
      args: '[allow|deny|remove <rule>]',
      run: (r, args) => {
        const [verb, ...rest] = args.trim().split(/\s+/);
        const rule = rest.join(' ');
        if (verb && rule && ['allow', 'deny', 'remove'].includes(verb)) {
          updateProjectSettings(r.app.projectRoot, (cfg) => {
            const p = (cfg.permissions ?? { allow: [], deny: [], ask: [] }) as { allow: string[]; deny: string[]; ask: string[] };
            p.allow = (p.allow ?? []).filter((x) => x !== rule);
            p.deny = (p.deny ?? []).filter((x) => x !== rule);
            if (verb === 'allow') p.allow.push(rule);
            if (verb === 'deny') p.deny.push(rule);
            cfg.permissions = p as never;
          });
          r.app.sessionAllow.delete(rule);
          r.refreshAfterConfigChange();
          return r.info(`${verb === 'remove' ? 'Removed' : verb === 'allow' ? 'Allowed' : 'Denied'}: ${rule} (saved in ${projectPaths(r.app.projectRoot).localSettings})`);
        }
        const s = r.app.settings.permissions;
        r.printLines([
          '',
          `${c.bold('Mode')}: ${modeLabel(r.app.session.permissionMode)}`,
          `${c.bold('Allow')}: ${[...s.allow, ...r.app.sessionAllow].join(', ') || c.dim('(none)')}`,
          `${c.bold('Deny')}:  ${s.deny.join(', ') || c.dim('(none)')}`,
          c.dim('Rules: Bash(npm test), Bash(npm run:*), Edit(src/**), WebFetch(domain:github.com), mcp__server'),
          c.dim('Usage: /permissions allow Bash(npm test:*) · /permissions remove <rule>'),
          '',
        ]);
      },
    },
    {
      name: 'init',
      description: 'Create an AGENTS.md with project instructions for the agent',
      run: async (r) => {
        await r.runPrompt(INIT_PROMPT, { display: '/init' });
        await r.app.reloadMemory();
      },
    },
    {
      name: 'memory',
      description: 'Show loaded memory files; "/memory add <note>" saves a note',
      args: '[add <note>]',
      run: async (r, args) => {
        const m = /^add\s+([\s\S]+)/.exec(args.trim());
        if (m) {
          const file = path.join(r.app.projectRoot, 'AGENTS.md');
          await appendMemory(file, m[1]!);
          await r.app.reloadMemory();
          return r.info(`Saved to ${displayPath(file, r.app.projectRoot)}.`);
        }
        if (!r.app.memory.length) return r.info('No memory files loaded. Create AGENTS.md with /init, or add notes with "#note".');
        r.printLines(['', ...r.app.memory.map((f) => `  ${displayPath(f.path, r.app.projectRoot)} ${c.dim(`(${f.content.split('\n').length} lines, ${f.scope})`)}`), '']);
      },
    },
    {
      name: 'tools',
      description: 'List the tools available to the agent',
      run: (r) => {
        const tools = r.app.agent.currentTools();
        r.printLines(['', ...tools.map((t) => `  ${theme.accent(padEndWidth(t.name, 28))} ${c.dim(truncate(t.description.split('. ')[0]!, r.width() - 34))}`), '']);
      },
    },
    {
      name: 'mcp',
      description: 'Show MCP servers and their tools',
      run: (r) => {
        const entries = r.app.mcp.entries;
        if (!entries.length) return r.info(`No MCP servers configured. Add them to ${globalPaths.mcpFile} or .mcp.json ({"mcpServers": {...}}).`);
        const lines = [''];
        for (const e of entries) {
          const cl = r.app.mcp.clients.get(e.name);
          const st = e.needsApproval ? theme.warn('needs approval (trust the folder)') : !cl ? c.dim('not started') : cl.status === 'ready' ? theme.success(`ready · ${cl.tools.length} tools`) : cl.status === 'failed' ? theme.error(`failed: ${truncate(cl.error ?? '', 80)}`) : c.dim(cl.status);
          lines.push(`  ${c.bold(e.name)} ${c.dim(`(${e.config.url ? 'http' : 'stdio'}, ${displayPath(e.source, r.app.projectRoot)})`)}  ${st}`);
          if (cl?.status === 'ready') lines.push(c.dim(`    ${cl.tools.map((t) => t.name).join(', ')}`));
        }
        lines.push('');
        r.printLines(lines);
      },
    },
    {
      name: 'bashes',
      description: 'List background shells',
      run: (r) => {
        const shells = [...r.app.session.shells.values()];
        if (!shells.length) return r.info('No background shells.');
        r.printLines(['', ...shells.map((s) => `  ${s.id}  ${s.running ? theme.success('running') : c.dim(`exited ${s.exitCode}`)}  ${truncate(s.command, 70)}  ${c.dim(formatDuration(Date.now() - s.startedAt))}`), '']);
      },
    },
    {
      name: 'config',
      description: 'Show or change settings: /config [get|set] key [value]',
      args: '[get|set key value]',
      run: (r, args) => {
        const [verb, key, ...rest] = args.trim().split(/\s+/);
        if (verb === 'set' && key) {
          const value = parseConfigValue(rest.join(' '));
          updateGlobalConfig((g) => setByPath(g as Record<string, unknown>, key, value));
          r.refreshAfterConfigChange();
          return r.info(`Set ${key} = ${JSON.stringify(value)} in ${globalPaths.configFile}`);
        }
        if (verb === 'get' && key) return r.info(`${key} = ${JSON.stringify(getByPath(r.app.settings, key))}`);
        const s = r.app.settings;
        r.printLines([
          '',
          `${c.bold('Config file')}: ${globalPaths.configFile}`,
          `  model: ${s.model}   contextBudget: ${s.contextBudget}   maxSteps: ${s.maxSteps}   autoCompact: ${s.autoCompact}`,
          `  router.enabled: ${s.router.enabled}   router.allowPaid: ${s.router.allowPaid}   router.maxWaitSeconds: ${s.router.maxWaitSeconds}`,
          `  router.prefer: ${JSON.stringify(s.router.prefer)}   router.avoid: ${JSON.stringify(s.router.avoid)}`,
          `  permissions.mode: ${s.permissions.mode}   bashTimeoutMs: ${s.bashTimeoutMs}   webSearch.provider: ${s.webSearch.provider}`,
          c.dim('Change with: /config set router.prefer ["groq","gemini"]  ·  /config set contextBudget 48000'),
          '',
        ]);
      },
    },
    {
      name: 'reset-limits',
      description: 'Forget rate-limit cooldowns and disabled models',
      run: (r) => {
        r.app.health.resetAllCooldowns();
        r.info('Cleared all cooldowns. Every model will be tried again.');
      },
    },
    {
      name: 'export',
      description: 'Save the conversation as Markdown',
      args: '[file]',
      run: async (r, args) => {
        const file = path.resolve(r.app.session.cwd, args.trim() || `freecode-${r.app.sessionId}.md`);
        const out: string[] = [`# FreeCode conversation ${r.app.sessionId}`, ''];
        for (const m of r.app.agent.messages) {
          if (m.role === 'user') out.push(`## ${m.meta?.synthetic ? 'Note' : 'User'}`, '', m.content, '');
          else if (m.role === 'assistant') {
            out.push(`## Assistant${m.meta?.model ? ` (${m.meta.model})` : ''}`, '', m.content, '');
            for (const tc of m.toolCalls ?? []) out.push('```json', `${tc.name} ${tc.arguments}`, '```', '');
          } else if (m.role === 'tool') out.push(`<details><summary>${m.toolName} result</summary>`, '', '```', truncate(m.content, 4000), '```', '</details>', '');
        }
        await fsp.writeFile(file, out.join('\n'), 'utf8');
        r.info(`Exported to ${file}`);
      },
    },
    {
      name: 'review',
      description: 'Review uncommitted changes for bugs',
      run: (r) => r.runPrompt(REVIEW_PROMPT, { display: '/review' }),
    },
    {
      name: 'commit',
      description: 'Commit the current changes with a good message',
      run: (r) => r.runPrompt(COMMIT_PROMPT, { display: '/commit' }),
    },
    {
      name: 'doctor',
      description: 'Check the installation and test every configured provider',
      run: async (r) => {
        const lines = ['', c.bold('FreeCode doctor'), `  Node.js ${process.version} ${Number(process.versions.node.split('.')[0]) >= 20 ? theme.success('ok') : theme.error('too old (need 20+)')}`, `  Shell: ${detectShell().name} (${detectShell().path})`, `  ripgrep: ${ripgrepPath() ?? c.dim('not found (built-in search is used)')}`, `  git: ${(await git(['--version'], r.app.projectRoot)).stdout.trim() || c.dim('not found')}`];
        r.printLines(lines);
        const providers = r.app.providers.filter((p) => p.configured && p.enabled && p.def.keyRequired);
        if (!providers.length) r.warn('No providers with keys. Run /setup.');
        const { checkKey } = await import('../providers/validate.js');
        for (const p of providers) {
          const res = await r.host.withSpinner(`Testing ${p.name}…`, () => checkKey(p.def, p.apiKeys[0]!, { baseURL: p.baseURL }));
          r.print(`  ${res.ok ? theme.success('✓') : theme.error('✗')} ${p.name}: ${res.message}`);
        }
        const n = r.app.usableModelCount();
        r.print(c.dim(`  ${n.models} models from ${n.providers} providers in the pool.`));
      },
    },
    {
      name: 'exit',
      aliases: ['quit', 'q'],
      description: 'Exit FreeCode',
      run: (r) => r.exit(),
    },
  ];
  return cmds;
}

export function findCommand(cmds: SlashCommand[], name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return cmds.find((x) => x.name === n) ?? cmds.find((x) => x.aliases?.includes(n));
}

/** Handles "/name args" (built-in or custom). Returns false when the command is unknown. */
export async function runSlashCommand(r: ReplApi, input: string): Promise<boolean> {
  const m = /^\/([\w:.-]+|\?)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) return false;
  const [, name, args] = m;
  const cmd = findCommand(builtinCommands(), name!);
  if (cmd) {
    try {
      await cmd.run(r, args ?? '');
    } catch (e) {
      r.error(`/${name} failed: ${(e as Error).message}`);
    }
    return true;
  }
  const custom = r.app.customCommands.find((cc) => cc.name === name!.toLowerCase());
  if (custom) {
    await r.runPrompt(expandCommand(custom, args ?? ''), { display: input.trim() });
    return true;
  }
  return false;
}

export { boxLines, renderToolResult, keyId, readGlobalConfig, TextPrompt, MODE_CYCLE };

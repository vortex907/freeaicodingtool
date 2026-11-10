// Interactive terminal session.
import * as path from 'node:path';
import { App, type AppOptions } from '../app.js';
import { UIHost } from './host.js';
import { InputEditor, type CompletionResult } from './inputEditor.js';
import type { Key, LiveFrame } from './screen.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import { BULLET, INDENT, boxLines, formatToolHeader, formatToolLabel, indentLines, renderDiff, renderToolResult } from './render.js';
import { SelectList, TextPrompt, type SelectOption } from './widgets.js';
import { builtinCommands, runSlashCommand, type ReplApi } from './commands.js';
import { mentionCompletions, expandMentions, projectFileList } from './mentions.js';
import { needsFirstRunSetup, runSetupWizard } from './setup.js';
import type { AgentEvent, PermissionAnswer } from '../agent/agent.js';
import type { PermissionRequest, ToolResult, UserQuestion, QuestionAnswer } from '../tools/types.js';
import type { PermissionMode } from '../config/config.js';
import { isTrustedFolder, loadConfig, projectHasRiskySettings, updateGlobalConfig } from '../config/config.js';
import { MODE_CYCLE, modeLabel } from '../permissions/permissions.js';
import { appendHistory, latestSession, loadHistory, loadSession, listSessions } from '../session/session.js';
import { appendMemory } from '../agent/memory.js';
import { runUserShellCommand, cleanOutput } from '../tools/bash.js';
import { c, stringWidth, theme, truncateToWidth, wrapAnsi } from '../util/ansi.js';
import { formatDuration, formatTokens, truncate } from '../util/strings.js';
import { humanMs } from '../router/health.js';
import { gitRoot } from '../util/git.js';
import { displayPath } from '../util/fs.js';
import { globalPaths } from '../config/paths.js';
import { VERSION } from '../version.js';
import { debug } from '../util/log.js';

const VERBS = ['Thinking', 'Working', 'Coding', 'Pondering', 'Crafting', 'Reasoning', 'Computing', 'Tinkering', 'Brewing', 'Cooking', 'Hacking', 'Building'];

export interface ReplOptions extends AppOptions {
  initialPrompt?: string;
  resume?: string | true;
  continueLast?: boolean;
  skipSetup?: boolean;
  forceSetup?: boolean;
}

interface RunningTool {
  label: string;
  started: number;
  progress: string;
  sub?: string;
}

export class Repl implements ReplApi {
  host = new UIHost();
  app!: App;
  editor = new InputEditor();
  private busy = false;
  private turnStarted = 0;
  private verb = 'Thinking';
  private stream: MarkdownStream | null = null;
  private streamFirst = true;
  private reasoning = '';
  private reasoningStarted = 0;
  private running = new Map<string, RunningTool>();
  private subagents = new Map<string, { description: string; activity: string; tools: number }>();
  private wait: { until: number; model: string; reason: string } | null = null;
  private lastAnnouncedModel: string | undefined;
  private turnOut = 0;
  private turnIn = 0;
  private turnRequests = 0;
  private turnModels = new Set<string>();
  private lastCtrlC = 0;
  private lastEsc = 0;
  private hint: { text: string; until: number } | null = null;
  private exitResolve: (() => void) | null = null;
  private files: string[] = [];
  private filesAt = 0;
  private streamingToolName: string | null = null;
  private statusText: string | null = null;

  constructor(private opts: ReplOptions) {}

  width(): number {
    return Math.max(30, this.host.width - 1);
  }

  print(text: string): void {
    this.host.print(text);
  }

  printLines(lines: string[]): void {
    this.host.printLines(lines);
  }

  info(text: string): void {
    this.print(indentLines(wrapAnsi(text, this.width() - 4, { hard: false }), c.dim('  ⎿  '), '     ').join('\n'));
  }

  warn(text: string): void {
    this.print(theme.warn(`  ⚠ ${text}`));
  }

  error(text: string): void {
    this.print(indentLines(wrapAnsi(text, this.width() - 4, { hard: false }), theme.error('  ✗ '), '    ').map((l) => theme.error(l)).join('\n'));
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<number> {
    this.host.start();
    this.host.baseFrame = () => this.frame();
    this.host.baseKey = (s, k) => this.onKey(s, k);
    try {
      await this.preflight();
      this.app = new App(this.opts);
      await this.app.init({
        onEvent: (e) => this.onEvent(e),
        askPermission: (req, meta) => this.askPermission(req, meta),
        askUser: (qs) => this.askUser(qs),
        approvePlan: (plan) => this.approvePlan(plan),
      });
      this.editor.history = loadHistory(this.app.projectRoot);
      this.editor.completer = (v, cur) => this.complete(v, cur);
      this.editor.onSubmit = (t) => void this.submit(t);
      this.editor.onChange = () => this.host.screen.requestRender();
      void this.app.startDiscovery().then(() => this.host.screen.requestRender(true));
      void this.app.startMcp().then(() => {
        for (const cl of this.app.mcp.clients.values()) if (cl.status === 'failed') this.warn(`MCP server "${cl.name}" failed to start: ${truncate(cl.error ?? '', 200)}`);
        this.host.screen.requestRender(true);
      });
      void this.refreshFiles();
      await this.handleResume();
      this.printWelcome();
      if (this.opts.initialPrompt) void this.submit(this.opts.initialPrompt);
      await new Promise<void>((resolve) => (this.exitResolve = resolve));
    } catch (e) {
      this.host.stop();
      throw e;
    }
    await this.shutdown();
    return 0;
  }

  private async preflight(): Promise<void> {
    const root = (await gitRoot(this.opts.cwd)) ?? path.resolve(this.opts.cwd);
    // Folder trust for project settings that can run commands.
    if (this.opts.trusted === undefined && projectHasRiskySettings(root)) {
      const global = loadConfig(root, undefined, { trusted: false }).settings;
      if (!isTrustedFolder(global, root)) {
        const choice = await this.host.showWidget(
          new SelectList(
            [
              theme.warn('⚠ Do you trust the files in this folder?'),
              '',
              `  ${root}`,
              '',
              'This project contains FreeCode/Claude settings (hooks, MCP servers or permission rules) that can run',
              'commands on your computer. Only trust folders whose contents you trust.',
              '',
            ],
            [
              { label: 'Yes, trust this folder', value: 'yes' },
              { label: 'No, ignore the project settings', value: 'no' },
            ],
            { border: theme.warn },
          ),
        );
        if (choice === 'yes') {
          updateGlobalConfig((g) => {
            g.trustedFolders = [...new Set([...(g.trustedFolders ?? []), root])];
          });
          this.opts.trusted = true;
        } else this.opts.trusted = false;
      }
    }
    if (this.opts.forceSetup || (!this.opts.skipSetup && needsFirstRunSetup())) {
      await runSetupWizard(this.host, { firstRun: !this.opts.forceSetup });
    }
  }

  private async handleResume(): Promise<void> {
    let session = null;
    if (this.opts.continueLast) session = await latestSession(this.app.projectRoot);
    else if (typeof this.opts.resume === 'string') session = await loadSession(this.app.projectRoot, this.opts.resume);
    else if (this.opts.resume === true) {
      const list = await listSessions(this.app.projectRoot, 40);
      if (list.length) {
        const choice = await this.host.showWidget(
          new SelectList([c.bold('Resume a conversation')], list.map((s) => ({ label: truncate(s.title, 60), value: s.id, description: new Date(s.updatedAt).toLocaleString() })), { numbered: false, maxVisible: 12 }),
        );
        if (choice) session = await loadSession(this.app.projectRoot, choice);
      }
    }
    if (session) {
      this.app.loadSaved(session);
      this.info(`Resumed "${session.title}" (${session.messages.length} messages).`);
    } else if (this.opts.continueLast || this.opts.resume) this.info('No previous conversation found; starting a new one.');
  }

  private printWelcome(): void {
    const w = Math.min(this.width(), 100);
    const n = this.app.usableModelCount();
    const cwd = displayPath(this.app.session.cwd, '/');
    const lines = [
      `${theme.brand('✻ FreeCode')} ${c.dim(`v${VERSION}`)}  ${c.dim('free AI coding agent')}`,
      '',
      `${c.dim('cwd:')} ${cwd}`,
      n.models
        ? `${c.dim('models:')} ${theme.accent(String(n.models))} free models from ${theme.accent(String(n.providers))} providers ${c.dim('· AI router picks the best one, auto-switches on limits')}`
        : `${theme.warn('No AI provider is configured yet.')} Run ${theme.accent('/setup')} to add free keys.`,
      '',
      c.dim('/help commands · /setup add providers · /model choose model · @ attach files · ! shell · shift+tab modes'),
    ];
    this.printLines(['', ...boxLines(lines, w, theme.accent), '']);
    if (n.providers > 0 && n.providers < 3) {
      this.print(c.dim(`  Tip: you have ${n.providers} provider${n.providers === 1 ? '' : 's'}. Add more free providers with /setup so FreeCode can keep going when one hits its limit.`));
      this.print('');
    }
    if (this.app.memory.length === 0 && this.app.agent.messages.length === 0) {
      this.print(c.dim('  Tip: run /init to create an AGENTS.md that teaches the agent about this project.'));
      this.print('');
    }
  }

  exit(): void {
    if (this.busy) this.app.agent.abort();
    this.exitResolve?.();
  }

  private async shutdown(): Promise<void> {
    try {
      await this.app.save();
    } catch {
      // ignore
    }
    this.app.shutdown();
    const hadConversation = this.app.agent.messages.some((m) => m.role === 'user' && !m.meta?.synthetic);
    this.host.stop();
    if (hadConversation) process.stdout.write(c.dim(`\nResume this conversation with: freecode --resume ${this.app.sessionId}\n`));
  }

  refreshAfterConfigChange(): void {
    this.app.reloadConfig();
    this.app.reloadProviders();
    this.host.screen.requestRender(true);
  }

  private async refreshFiles(): Promise<void> {
    if (Date.now() - this.filesAt < 5000) return;
    this.filesAt = Date.now();
    this.files = await projectFileList(this.app.session.cwd);
  }

  // ------------------------------------------------------------------ input

  private complete(value: string, cursor: number): CompletionResult | null {
    // Slash commands
    if (value.startsWith('/') && !value.slice(0, cursor).includes(' ')) {
      const q = value.slice(1, cursor).toLowerCase();
      const all = [
        ...builtinCommands().map((cmd) => ({ name: cmd.name, description: cmd.description, args: cmd.args })),
        ...this.app.customCommands.map((cc) => ({ name: cc.name, description: `${cc.description} (custom)`, args: cc.argumentHint })),
      ];
      const items = all
        .filter((x) => x.name.startsWith(q) || (q.length > 1 && x.name.includes(q)))
        .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
        .map((x) => ({ label: `/${x.name}${x.args ? ' ' + x.args : ''}`, description: x.description, insert: x.args ? `/${x.name} ` : `/${x.name}`, submit: !x.args }));
      if (!items.length || (items.length === 1 && items[0]!.insert.trim() === value.trim())) return null;
      return { items, from: 0, to: cursor };
    }
    // /model argument completion
    const mm = /^\/model\s+(\S*)$/.exec(value.slice(0, cursor));
    if (mm) {
      const q = mm[1]!.toLowerCase();
      const items = ['auto', ...this.app.router.allModels().map(({ m }) => m.key)]
        .filter((k) => k.toLowerCase().includes(q))
        .slice(0, 12)
        .map((k) => ({ label: k, insert: k, submit: true }));
      return items.length ? { items, from: cursor - mm[1]!.length, to: cursor } : null;
    }
    // @file mentions
    const before = value.slice(0, cursor);
    const at = /(^|\s)@((?:\\ |[^\s])*)$/.exec(before);
    if (at) {
      void this.refreshFiles();
      const q = at[2]!.replace(/\\ /g, ' ');
      const items = mentionCompletions(q, this.files);
      if (!items.length) return null;
      return { items, from: cursor - at[2]!.length - 1, to: cursor };
    }
    return null;
  }

  private onKey(str: string | undefined, key: Key): void {
    const now = Date.now();
    if (key.ctrl && key.name === 'c') {
      if (this.busy) {
        this.app.agent.abort();
        this.setHint('Interrupting…');
        return;
      }
      if (!this.editor.isEmpty) {
        this.editor.clear();
        return;
      }
      if (now - this.lastCtrlC < 2000) {
        this.exit();
        return;
      }
      this.lastCtrlC = now;
      this.setHint('Press Ctrl+C again to exit');
      return;
    }
    if (key.ctrl && key.name === 'd') {
      if (this.editor.isEmpty && !this.busy) this.exit();
      return;
    }
    if (key.name === 'escape' && !this.editor.menu) {
      if (this.busy) {
        this.app.agent.abort();
        this.setHint('Interrupting…');
        return;
      }
      if (!this.editor.isEmpty && now - this.lastEsc < 700) this.editor.clear();
      this.lastEsc = now;
      return;
    }
    if (key.name === 'tab' && key.shift) {
      const cur = this.app.session.permissionMode;
      const idx = MODE_CYCLE.indexOf(cur);
      this.setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!, true);
      return;
    }
    if (key.ctrl && key.name === 'l') {
      this.host.screen.clearScreen();
      return;
    }
    if (key.ctrl && key.name === 't') {
      void runSlashCommand(this, '/todos');
      return;
    }
    this.editor.handleKey(str, key);
  }

  private setHint(text: string, ms = 2000): void {
    this.hint = { text, until: Date.now() + ms };
    setTimeout(() => this.host.screen.requestRender(true), ms + 50).unref?.();
  }

  setMode(mode: PermissionMode, quiet = false): void {
    this.app.session.permissionMode = mode;
    if (!quiet || mode === 'bypassPermissions') {
      if (mode === 'bypassPermissions') this.warn('Bypass mode: the agent runs every command and edit without asking (dangerous commands still ask).');
      else this.info(`Mode: ${modeLabel(mode)}`);
    }
    this.host.screen.requestRender(true);
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed === '?') {
      await runSlashCommand(this, '/help');
      return;
    }
    if (this.busy) {
      if (trimmed.startsWith('/')) {
        this.warn('Wait for the current task to finish (or press Esc to interrupt) before running commands.');
        return;
      }
      this.app.agent.enqueue(trimmed);
      this.host.screen.requestRender(true);
      return;
    }
    appendHistory(text, this.app.projectRoot);
    if (trimmed.startsWith('/')) {
      this.print(c.dim(`> ${trimmed}`));
      const handled = await runSlashCommand(this, trimmed);
      if (!handled) this.error(`Unknown command ${trimmed.split(/\s/)[0]}. Type /help for the list.`);
      this.host.screen.requestRender(true);
      return;
    }
    if (trimmed.startsWith('!')) {
      await this.runShell(trimmed.slice(1).trim());
      return;
    }
    if (trimmed.startsWith('#') && trimmed.length > 1 && !trimmed.startsWith('##')) {
      await this.saveMemory(trimmed.slice(1).trim());
      return;
    }
    await this.runPrompt(text);
  }

  private async runShell(cmd: string): Promise<void> {
    if (!cmd) return;
    this.print(theme.warn(`! ${cmd}`));
    this.busy = true;
    this.turnStarted = Date.now();
    this.verb = 'Running';
    this.host.startAnimation();
    try {
      const ctrl = new AbortController();
      const ctx = {
        projectRoot: this.app.projectRoot,
        session: this.app.session,
        settings: this.app.settings,
        files: this.app.files,
        signal: ctrl.signal,
        toolCallId: 'user-shell',
        services: { progress: () => undefined },
        depth: 0,
      };
      const res = await runUserShellCommand(cmd, ctx, () => this.host.screen.requestRender());
      const out = cleanOutput(res.output).trimEnd();
      const lines = out ? out.split('\n') : ['(no output)'];
      this.printLines(indentLines(lines.slice(0, 40).map((l) => truncateToWidth(l, this.width() - 6)), c.dim('  ⎿  '), '     '));
      if (lines.length > 40) this.print(c.dim(`     … +${lines.length - 40} lines (full output was added to the conversation)`));
      if (res.exitCode) this.print(theme.error(`     exit code ${res.exitCode}`));
      this.app.agent.addContext(`[The user ran a shell command: ${cmd}]\n${truncate(out, 20000) || '(no output)'}${res.exitCode ? `\n[exit code ${res.exitCode}]` : ''}`, 'bash');
      if (res.newCwd) this.app.invalidatePromptCache();
    } finally {
      this.busy = false;
      this.host.stopAnimation();
    }
  }

  private async saveMemory(note: string): Promise<void> {
    const projectFile = path.join(this.app.projectRoot, 'AGENTS.md');
    const choice = await this.host.showWidget(
      new SelectList([c.bold('Save this note where?'), c.dim(`  ${note}`)], [
        { label: `Project memory (${displayPath(projectFile, this.app.projectRoot)})`, value: projectFile, description: 'shared with the project' },
        { label: `User memory (${displayPath(globalPaths.memoryFile, process.env.HOME ?? '/')})`, value: globalPaths.memoryFile, description: 'all your projects' },
      ]),
    );
    if (!choice) return;
    await appendMemory(choice, note);
    await this.app.reloadMemory();
    this.info(`Saved to ${choice}`);
  }

  async runPrompt(text: string, opts: { display?: string } = {}): Promise<void> {
    const shown = opts.display ?? text;
    const w = this.width();
    const echo = wrapAnsi(shown.length > 2000 ? shown.slice(0, 2000) + '…' : shown, w - 2, { hard: true });
    this.printLines(echo.map((l, i) => theme.user((i === 0 ? '> ' : '  ') + l)));
    let content = text;
    let images;
    try {
      const exp = await expandMentions(text, this.app.session.cwd, this.app.files);
      content = exp.content;
      images = exp.images.length ? exp.images : undefined;
      for (const a of exp.attached) this.print(c.dim(`  ⎿  Attached ${a.path}${a.lines ? ` (${a.lines} lines)` : a.kind === 'dir' ? ' (folder listing)' : ' (image)'}`));
    } catch (e) {
      debug('repl', 'mention expansion failed', e);
    }
    await this.runAgentTurn(content, images);
  }

  private async runAgentTurn(content: string, images?: { mediaType: string; data: string }[]): Promise<void> {
    if (!this.app.hasUsableModel()) {
      this.error('No AI model is available. Run /setup to add free provider keys (Gemini, Groq, OpenRouter, Mistral, NVIDIA, ...).');
      return;
    }
    this.busy = true;
    this.turnStarted = Date.now();
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
    this.turnIn = 0;
    this.turnOut = 0;
    this.turnRequests = 0;
    this.turnModels.clear();
    this.host.startAnimation();
    try {
      await this.app.agent.runTurn(content, { images });
    } catch (e) {
      this.error(`Unexpected error: ${(e as Error).message}`);
      debug('repl', 'turn crashed', e);
    } finally {
      this.endStream();
      this.busy = false;
      this.running.clear();
      this.subagents.clear();
      this.wait = null;
      this.host.stopAnimation();
      this.host.screen.requestRender(true);
      void this.app.save();
    }
    const leftover = this.app.agent.queued.splice(0);
    if (leftover.length) await this.runPrompt(leftover.join('\n\n'));
  }

  // ------------------------------------------------------------------ agent events

  private ensureStream(): MarkdownStream {
    if (!this.stream) {
      this.flushReasoningLine();
      this.streamFirst = true;
      this.stream = new MarkdownStream(
        () => this.width() - 2,
        (lines) => {
          const out: string[] = [];
          for (const l of lines) {
            if (this.streamFirst) {
              if (!l.trim()) continue; // skip leading blank lines
              out.push(`${c.white(BULLET)} ${l}`);
              this.streamFirst = false;
            } else out.push(`  ${l}`);
          }
          if (out.length) this.host.printLines(out);
        },
      );
    }
    return this.stream;
  }

  private endStream(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  private flushReasoningLine(): void {
    if (this.reasoning.trim()) {
      const dur = formatDuration(Date.now() - this.reasoningStarted);
      this.print(c.dim(c.italic(`✻ Thought for ${dur}`)));
    }
    this.reasoning = '';
  }

  private onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'turn_start':
        break;
      case 'profile':
        break;
      case 'model': {
        this.turnModels.add(e.key);
        this.turnRequests++;
        if (e.key !== this.lastAnnouncedModel && this.app.settings.router.showDecisions) {
          const prof = this.app.agent.lastProfile;
          const why = this.app.pinnedModel ? 'pinned' : prof && e.reason === 'selected' ? `${prof.complexity} ${prof.type}` : 'switched';
          this.endStream();
          this.print(c.dim(`◆ ${why} → ${e.key}${e.toolMode === 'text' ? ' (text tools)' : ''}`));
          this.lastAnnouncedModel = e.key;
        }
        this.wait = null;
        break;
      }
      case 'text':
        if (!this.reasoning && !this.stream) this.reasoningStarted = Date.now();
        this.ensureStream().push(e.delta);
        this.turnOut += e.delta.length / 3.5;
        break;
      case 'reasoning':
        if (!this.reasoning) this.reasoningStarted = Date.now();
        this.reasoning += e.delta;
        this.turnOut += e.delta.length / 3.5;
        break;
      case 'tool_call_streaming':
        this.streamingToolName = e.name;
        break;
      case 'assistant':
        this.endStream();
        if (this.reasoning) this.flushReasoningLine();
        this.streamingToolName = null;
        break;
      case 'tool_start':
        this.endStream();
        this.running.set(e.id, { label: e.label, started: Date.now(), progress: '' });
        break;
      case 'tool_progress': {
        const t = this.running.get(e.id);
        if (t) t.progress = e.text;
        break;
      }
      case 'tool_end': {
        this.running.delete(e.id);
        this.printToolResult(e.label, e.result, e.denied);
        break;
      }
      case 'failover': {
        this.endStream();
        const note = e.retrySame ? `${e.description}` : `${e.description} → switching model`;
        this.print(theme.warn(`  ⚠ ${e.from}: ${note}${e.hadOutput ? c.dim(' (partial answer discarded)') : ''}`));
        debug('repl', 'failover', e.error);
        break;
      }
      case 'wait':
        this.wait = { until: Date.now() + e.ms, model: e.model, reason: e.reason };
        break;
      case 'compact':
        this.print(c.dim(`✻ ${e.auto ? 'Auto-compacted' : 'Compacted'} conversation: ${formatTokens(e.beforeTokens)} → ${formatTokens(e.afterTokens)} tokens (${e.method})`));
        break;
      case 'notice':
        if (e.level === 'error') this.error(e.text);
        else if (e.level === 'warn') this.warn(e.text);
        else this.info(e.text);
        break;
      case 'usage':
        this.turnIn += e.usage.promptTokens;
        break;
      case 'todos':
        break;
      case 'subagent':
        this.onSubagentEvent(e.id, e.description, e.event);
        break;
      case 'turn_end': {
        this.endStream();
        if (this.reasoning) this.flushReasoningLine();
        if (e.reason === 'error' && e.error) this.error(e.error);
        else if (e.reason === 'aborted') this.print(theme.warn('  ⎿  Interrupted. What should FreeCode do instead?'));
        else if (e.reason === 'denied') this.print(c.dim('  ⎿  Waiting for your instructions.'));
        const secs = Date.now() - this.turnStarted;
        if (e.reason === 'done' && secs > 8000) {
          const models = [...this.turnModels];
          this.print(c.dim(`✻ Done in ${formatDuration(secs)} · ${this.turnRequests} request${this.turnRequests === 1 ? '' : 's'}${models.length > 1 ? ` · models: ${models.join(', ')}` : ''}`));
        }
        break;
      }
    }
    this.host.screen.requestRender();
  }

  private onSubagentEvent(id: string, description: string, ev: AgentEvent): void {
    let s = this.subagents.get(id);
    if (!s) {
      s = { description, activity: 'starting', tools: 0 };
      this.subagents.set(id, s);
    }
    switch (ev.type) {
      case 'tool_start':
        s.activity = ev.label;
        s.tools++;
        break;
      case 'model':
        s.activity = `using ${ev.key}`;
        break;
      case 'failover':
        s.activity = `${ev.from}: ${ev.description}`;
        break;
      case 'wait':
        s.activity = `waiting ${humanMs(ev.ms)} for ${ev.model}`;
        break;
      case 'turn_end':
        this.subagents.delete(id);
        break;
    }
    // Attach to the running Task tool line
    for (const t of this.running.values()) {
      if (t.label.startsWith('Task(') && t.label.includes(truncate(description, 60).slice(0, 20))) t.sub = `${s.activity} · ${s.tools} tool use${s.tools === 1 ? '' : 's'}`;
    }
  }

  private printToolResult(label: string, result: ToolResult, denied?: boolean): void {
    const status = denied ? 'denied' : result.isError ? 'error' : 'ok';
    const lines = [formatToolHeader(label, status), ...renderToolResult(result, this.width())];
    this.printLines(lines);
  }

  // ------------------------------------------------------------------ dialogs

  private async askPermission(req: PermissionRequest, meta: { toolCallId: string; subagent?: string }): Promise<PermissionAnswer> {
    const w = Math.min(this.width(), 120);
    const inner = w - 4;
    const header: string[] = [];
    const color = req.danger ? theme.error : req.category === 'edit' ? theme.accent2 : req.category === 'execute' ? theme.warn : theme.info;
    header.push(c.bold(color(req.title)) + (meta.subagent ? c.dim(` (requested by ${meta.subagent})`) : ''));
    header.push('');
    if (req.command) {
      for (const l of req.command.split('\n').slice(0, 12)) header.push('  ' + truncateToWidth(l, inner - 2));
      if (req.description) header.push(c.dim(`  ${req.description}`));
    } else if (req.preview?.kind === 'diff') {
      header.push(`  ${c.bold(req.subject)}`);
      const maxDiff = Math.max(6, this.host.screen.height - 16);
      header.push(...renderDiff(req.preview.hunks, req.preview.path, inner - 2, maxDiff).map((l) => '  ' + l));
    } else {
      header.push('  ' + truncateToWidth(req.subject, inner - 2));
      if (req.description) header.push(c.dim(`  ${truncate(req.description, 200)}`));
    }
    if (req.danger) header.push('', theme.error(`  ⚠ ${req.danger}`));
    header.push('', 'Do you want to proceed?');
    const options: SelectOption<string>[] = [{ label: 'Yes', value: 'yes' }];
    if (req.category === 'edit') options.push({ label: 'Yes, allow all edits during this session (shift+tab)', value: 'all_edits' });
    else if (req.ruleSuggestion && !req.danger) options.push({ label: `Yes, and don't ask again for ${req.ruleLabel ?? req.ruleSuggestion} in this project`, value: 'project' });
    options.push({ label: `No, and tell FreeCode what to do differently ${c.dim('(esc)')}`, value: 'no' });
    const choice = await this.host.showWidget(new SelectList(header, options, { border: color }));
    if (choice === 'yes') return { allow: true };
    if (choice === 'all_edits') {
      this.info(`Mode: ${modeLabel('acceptEdits')}`);
      return { allow: true, switchMode: 'acceptEdits' };
    }
    if (choice === 'project') return { allow: true, remember: 'project' };
    const feedback = await this.host.showWidget(new TextPrompt([c.dim('  Tell FreeCode what to do instead (or press enter to stop and wait):')], { allowEmpty: true, prompt: '  > ' }));
    return { allow: false, feedback: feedback || undefined };
  }

  private async askUser(questions: UserQuestion[]): Promise<QuestionAnswer[] | null> {
    this.endStream();
    const answers: QuestionAnswer[] = [];
    for (const q of questions) {
      const base = { question: q.question, header: q.header };
      const title = [theme.info(c.bold('? ') + (q.header ? c.dim(`[${q.header}] `) : '') + q.question)];
      if (!q.options.length) {
        const t = await this.host.showWidget(new TextPrompt(title, { prompt: '  > ' }));
        if (t === null) return null;
        answers.push({ ...base, selected: [], other: t });
      } else if (q.multiSelect) {
        const lines = [...title, ...q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? c.dim(` - ${o.description}`) : ''}`), c.dim('  Type the numbers you want (e.g. 1,3), or your own answer:')];
        const t = await this.host.showWidget(new TextPrompt(lines, { prompt: '  > ' }));
        if (t === null) return null;
        const nums = /^[\d,\s]+$/.test(t) ? [...new Set(t.split(/[,\s]+/).map(Number))].filter((n) => n >= 1 && n <= q.options.length) : [];
        answers.push(nums.length ? { ...base, selected: nums.map((n) => q.options[n - 1]!.label) } : { ...base, selected: [], other: t });
      } else {
        const opts: SelectOption<string>[] = q.options.map((o) => ({ label: o.description ? `${o.label}  ${c.dim(o.description)}` : o.label, value: o.label }));
        opts.push({ label: 'Type something else…', value: '__other' });
        const v = await this.host.showWidget(new SelectList(title, opts));
        if (v === null) return null;
        if (v === '__other') {
          const t = await this.host.showWidget(new TextPrompt([theme.info(q.question)], { prompt: '  > ' }));
          if (t === null) return null;
          answers.push({ ...base, selected: [], other: t });
        } else answers.push({ ...base, selected: [v] });
      }
    }
    return answers;
  }

  private async approvePlan(plan: string): Promise<'acceptEdits' | 'default' | null> {
    this.endStream();
    const w = Math.min(this.width(), 110);
    this.printLines(['', ...boxLines([theme.plan(c.bold('Here is the plan:')), '', ...renderMarkdown(plan, w - 6)], w, theme.plan), '']);
    const choice = await this.host.showWidget(
      new SelectList([c.bold('Would you like to proceed?')], [
        { label: 'Yes, and auto-accept edits', value: 'acceptEdits' },
        { label: 'Yes, and manually approve edits', value: 'default' },
        { label: 'No, keep planning', value: 'no' },
      ]),
    );
    if (choice === 'acceptEdits' || choice === 'default') {
      this.info(`Mode: ${modeLabel(choice)}`);
      return choice;
    }
    return null;
  }

  // ------------------------------------------------------------------ rendering

  private modeIndicator(): string {
    const mode = this.app?.session.permissionMode ?? 'default';
    const v = this.editor.value;
    if (v.startsWith('!')) return theme.warn('! shell mode') + c.dim(' (runs the command directly)');
    if (v.startsWith('#') && !v.startsWith('##')) return theme.info('# memory mode') + c.dim(' (saves a note to AGENTS.md)');
    switch (mode) {
      case 'acceptEdits':
        return theme.acceptEdits('⏵⏵ accept edits on') + c.dim(' (shift+tab to cycle)');
      case 'plan':
        return theme.plan('⏸ plan mode on') + c.dim(' (shift+tab to cycle)');
      case 'bypassPermissions':
        return theme.yolo('⚠ bypass permissions on');
      default:
        return c.dim('? for shortcuts');
    }
  }

  private modelIndicator(): string {
    if (!this.app) return '';
    if (this.busy && this.app.agent.currentModelKey) return c.dim(`◆ ${this.app.agent.currentModelKey}`);
    if (this.app.pinnedModel) return c.dim(`◆ ${this.app.pinnedModel}`);
    const n = this.app.usableModelCount();
    return c.dim(`◆ auto · ${n.models} model${n.models === 1 ? '' : 's'}`);
  }

  private spinnerLine(): string {
    const glyph = this.host.spinnerGlyph();
    if (this.wait && this.wait.until > Date.now()) {
      const left = Math.ceil((this.wait.until - Date.now()) / 1000);
      return `${theme.warn('⏳')} ${theme.warn(`Waiting ${left}s for ${this.wait.model}`)} ${c.dim(`(${this.wait.reason} · esc to interrupt)`)}`;
    }
    const elapsed = formatDuration(Date.now() - this.turnStarted);
    let text = `${this.verb}…`;
    if (this.reasoning && !this.stream) text = 'Thinking…';
    if (this.streamingToolName) text = `Writing ${this.streamingToolName} call…`;
    const tokens = this.turnOut > 0 ? ` · ↓ ${formatTokens(this.turnOut)} tokens` : '';
    let line = `${glyph} ${theme.accent(text)} ${c.dim(`(${elapsed}${tokens} · esc to interrupt)`)}`;
    if (this.reasoning && !this.stream) {
      const tail = this.reasoning.replace(/\s+/g, ' ').slice(-Math.max(10, this.width() - stringWidth(line) - 4));
      line += ' ' + c.dim(c.italic(tail));
    }
    return line;
  }

  private frame(): LiveFrame {
    const w = this.width();
    const lines: string[] = [];
    if (this.busy) {
      const pending = this.stream?.pending();
      if (pending) {
        const prefix = this.streamFirst ? `${c.white(BULLET)} ` : '  ';
        lines.push(...wrapAnsi(prefix + pending, w).slice(-4));
      }
      for (const t of this.running.values()) {
        lines.push(`${this.host.spinnerGlyph()} ${formatToolLabel(t.label)} ${c.dim(formatDuration(Date.now() - t.started))}`);
        if (t.sub) lines.push(c.dim(`${INDENT}↳ ${truncateToWidth(t.sub, w - 8)}`));
        if (t.progress) for (const p of t.progress.split('\n').slice(-3)) lines.push(c.dim(INDENT + truncateToWidth(p, w - INDENT.length - 1)));
      }
      lines.push(this.spinnerLine());
      for (const q of this.app.agent.queued) lines.push(c.dim(`  ⧗ queued: ${truncateToWidth(q.replace(/\s+/g, ' '), w - 14)}`));
    }
    lines.push('');
    const mode = this.app?.session.permissionMode ?? 'default';
    const border = this.editor.value.startsWith('!') ? theme.warn : mode === 'plan' ? theme.plan : mode === 'acceptEdits' ? theme.acceptEdits : mode === 'bypassPermissions' ? theme.yolo : theme.border;
    const placeholder = this.busy ? 'Type to queue a message for the agent…' : 'Ask FreeCode to build, fix or explain anything  (/ commands · @ files · ! shell)';
    const ed = this.editor.render(w, { borderColor: border, prompt: this.editor.value.startsWith('!') ? '! ' : '> ', promptColor: this.editor.value.startsWith('!') ? theme.warn : undefined, placeholder });
    const edStart = lines.length;
    lines.push(...ed.lines);
    let left = this.modeIndicator();
    if (this.hint && this.hint.until > Date.now()) left = theme.warn(this.hint.text);
    const right = this.modelIndicator();
    const gap = Math.max(1, w - stringWidth(left) - stringWidth(right) - 2);
    lines.push(' ' + left + ' '.repeat(gap) + right);
    const menu = this.editor.renderMenu(w);
    lines.push(...menu);
    return { lines, cursor: this.host.hasModal ? undefined : { row: edStart + ed.cursorRow, col: ed.cursorCol } };
  }
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  const repl = new Repl(opts);
  return repl.start();
}

// First-run setup screen (also /setup and `freecode setup`): shows every free provider, what it
// offers and where to get a key, then stores and verifies the keys the user pastes.
import { spawn } from 'node:child_process';
import type { UIHost } from './host.js';
import { SelectList, TextPrompt, maskKey, type SelectOption } from './widgets.js';
import { setupOrder, getProviderDef } from '../providers/catalog.js';
import type { ProviderDef, ProviderKind } from '../providers/types.js';
import { checkKey } from '../providers/validate.js';
import { readGlobalConfig, updateGlobalConfig, type Settings } from '../config/config.js';
import { loadDotenvFile } from '../config/dotenv.js';
import { globalPaths } from '../config/paths.js';
import { c, theme } from '../util/ansi.js';
import { isMac, isWindows } from '../util/platform.js';
import { logoLines } from './render.js';

const SECTION: Record<ProviderKind, string> = {
  free: 'FREE TIERS (recommended: add as many as you can)',
  keyless: 'NO SIGNUP NEEDED',
  local: 'RUNS ON YOUR COMPUTER',
  trial: 'FREE MONTHLY / TRIAL CREDITS',
  paid: 'PAID (optional - only used if you allow paid models)',
};

export function openInBrowser(url: string): boolean {
  try {
    const cmd = isMac ? 'open' : isWindows ? 'cmd' : 'xdg-open';
    const args = isWindows ? ['/c', 'start', '""', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Clickable link (OSC 8) where supported, plain text otherwise. */
export function link(url: string): string {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return url;
  return `\x1b]8;;${url}\x07${theme.link(url)}\x1b]8;;\x07`;
}

interface KeyStatus {
  state: 'config' | 'env' | 'none' | 'keyless' | 'local-up' | 'local-down';
  envName?: string;
}

function keyStatus(def: ProviderDef, cfg: Partial<Settings>, dotenv: Record<string, string>, localUp: Record<string, boolean>): KeyStatus {
  const pc = cfg.providers?.[def.id];
  if (def.kind === 'local') return { state: localUp[def.id] ? 'local-up' : 'local-down' };
  if (pc?.apiKey || pc?.apiKeys?.length) return { state: 'config' };
  for (const n of def.keyEnv) if (process.env[n] || dotenv[n]) return { state: 'env', envName: n };
  if (!def.keyRequired) return { state: 'keyless' };
  return { state: 'none' };
}

async function probeLocal(): Promise<Record<string, boolean>> {
  const ollamaHost = process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://localhost:11434';
  const probe = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      return r.ok;
    } catch {
      return false;
    }
  };
  const [ollama, lmstudio] = await Promise.all([probe(`${ollamaHost.replace(/\/+$/, '')}/api/tags`), probe('http://localhost:1234/v1/models')]);
  return { ollama, lmstudio };
}

function statusText(s: KeyStatus): string {
  switch (s.state) {
    case 'config':
      return theme.success('✓ key saved');
    case 'env':
      return theme.success(`✓ ${s.envName}`);
    case 'keyless':
      return theme.success('✓ ready (no key)');
    case 'local-up':
      return theme.success('✓ running');
    case 'local-down':
      return c.dim('○ not running');
    default:
      return theme.warn('○ add key');
  }
}

export interface SetupResult {
  changed: boolean;
  configured: number;
}

export async function runSetupWizard(host: UIHost, opts: { firstRun: boolean }): Promise<SetupResult> {
  const width = Math.min(host.width - 1, 110);
  if (opts.firstRun) {
    host.printLines([
      '',
      ...logoLines(width),
      '',
      `${theme.brand('Welcome to FreeCode')} ${c.dim('- an AI coding agent that runs on free AI models')}`,
      '',
      'FreeCode combines the free tiers of many AI providers. Add a free API key for as many providers',
      'as you can: when one runs out of free requests, FreeCode switches to the next one automatically,',
      'and a small "router" AI picks the best available model for each task.',
      '',
      c.dim('Most keys take ~1 minute to create (sign in with Google/GitHub). No credit card needed.'),
      c.dim(`Keys are stored only on this computer in ${globalPaths.configFile}.`),
      '',
    ]);
  } else {
    host.printLines(['', theme.brand('FreeCode provider setup'), '']);
  }
  let changed = false;
  let localUp = await host.withSpinner('Looking for local AI servers…', probeLocal);
  let lastSelected = 1;
  for (;;) {
    const cfg = readGlobalConfig();
    const dotenv = loadDotenvFile(globalPaths.envFile);
    const defs = setupOrder();
    const options: SelectOption<string>[] = [];
    const statuses = new Map<string, KeyStatus>();
    let configuredCount = 0;
    for (const d of defs) {
      const st = keyStatus(d, cfg, dotenv, localUp);
      statuses.set(d.id, st);
      if (st.state !== 'none' && st.state !== 'local-down' && d.kind !== 'paid') configuredCount++;
    }
    const doneLabel = configuredCount > 0 ? `Done - start coding (${configuredCount} provider${configuredCount === 1 ? '' : 's'} ready)` : 'Done - start coding';
    options.push({ label: doneLabel, value: '__done' });
    let lastKind: ProviderKind | null = null;
    for (const d of defs) {
      const opt: SelectOption<string> = { label: d.name, value: d.id, description: d.freeTier, status: statusText(statuses.get(d.id)!) };
      if (d.kind !== lastKind) {
        opt.section = SECTION[d.kind];
        lastKind = d.kind;
      }
      options.push(opt);
    }
    const list = new SelectList<string>(
      [c.bold('Choose a provider to add its free API key:')],
      options,
      {
        selected: Math.min(lastSelected, options.length - 1),
        numbered: false,
        maxVisible: Math.max(8, Math.min(18, host.screen.height - 8)),
        footer: '↑/↓ move · enter add/change key · o open signup page · d remove saved key · esc finish',
      },
    )
      .onKey('o', (o) => {
        const def = getProviderDef(o.value);
        if (def) openInBrowser(def.signupUrl);
        return undefined;
      })
      .onKey('d', (o) => `__delete:${o.value}`);
    const choice = await host.showWidget(list);
    lastSelected = list.selected;
    if (choice === null || choice === '__done') break;
    if (choice.startsWith('__delete:')) {
      const id = choice.slice(9);
      updateGlobalConfig((g) => {
        if (g.providers?.[id]) {
          delete g.providers[id]!.apiKey;
          delete g.providers[id]!.apiKeys;
        }
      });
      host.print(c.dim(`  Removed the saved key for ${getProviderDef(id)?.name ?? id}.`));
      changed = true;
      continue;
    }
    const def = getProviderDef(choice);
    if (!def) continue;
    if (def.kind === 'local') {
      host.printLines([
        '',
        theme.brand(def.name),
        `  ${def.freeTier}`,
        `  Install: ${link(def.signupUrl)}`,
        def.id === 'ollama'
          ? `  Then run e.g. ${theme.code('ollama pull qwen3-coder:30b')} (or any model with tool support).\n  Tip: start the server with ${theme.code('OLLAMA_CONTEXT_LENGTH=32768 ollama serve')} for bigger contexts.`
          : '  Load a model in LM Studio and start its local server (Developer tab).',
        '  FreeCode detects it automatically when it is running.',
        '',
      ]);
      localUp = await host.withSpinner('Checking…', probeLocal);
      continue;
    }
    if (def.kind === 'keyless' && !def.keyRequired) {
      host.printLines(['', `${theme.brand(def.name)}: ${def.freeTier}`, `  It already works without a key. Optional free token: ${link(def.signupUrl)}`, '']);
    }
    const r = await configureProvider(host, def);
    if (r) changed = true;
  }
  if (opts.firstRun || changed) {
    updateGlobalConfig((g) => {
      g.setupCompleted = true;
    });
  }
  const cfg = readGlobalConfig();
  const dotenv = loadDotenvFile(globalPaths.envFile);
  const count = setupOrder().filter((d) => {
    const s = keyStatus(d, cfg, dotenv, localUp).state;
    return s !== 'none' && s !== 'local-down' && d.kind !== 'paid';
  }).length;
  return { changed, configured: count };
}

/** Asks for (and verifies) the key of one provider. Returns true when something was saved. */
export async function configureProvider(host: UIHost, def: ProviderDef): Promise<boolean> {
  const cfg = readGlobalConfig();
  const existing = cfg.providers?.[def.id]?.apiKey;
  const header = [
    '',
    theme.brand(def.name),
    `  What's free: ${def.freeTier}`,
    `  1. Get a key: ${link(def.keyUrl ?? def.signupUrl)} ${c.dim("(press 'o' in the list to open it)")}`,
    `  2. Paste it below and press Enter ${c.dim(`(or set ${def.keyEnv[0] ?? 'the key'} in your environment)`)}`,
    existing ? c.dim(`  Current saved key: ${maskKey(existing)}`) : '',
    def.notes ? c.dim(`  Note: ${def.notes}`) : '',
  ].filter(Boolean);
  const key = await host.showWidget(new TextPrompt(header, { mask: true, prompt: '  API key: ', placeholder: 'paste key here, esc to go back' }));
  if (!key) return false;
  let accountId: string | undefined;
  if (def.accountIdEnv) {
    const existingAcct = cfg.providers?.[def.id]?.accountId;
    accountId =
      (await host.showWidget(
        new TextPrompt([`  ${def.name} also needs your Account ID (shown on the Cloudflare dashboard, right sidebar of Workers & Pages).`], {
          prompt: '  Account ID: ',
          initial: existingAcct,
        }),
      )) ?? undefined;
    if (!accountId) return false;
  }
  const check = await host.withSpinner(`Checking the ${def.name} key…`, () => checkKey(def, key.trim(), { accountId }));
  if (!check.ok) {
    host.print(`  ${theme.error('✗')} ${check.message}`);
    const what = await host.showWidget(
      new SelectList<string>(['  Save this key anyway?'], [
        { label: 'No, discard it', value: 'no' },
        { label: 'Yes, save it anyway', value: 'yes' },
      ]),
    );
    if (what !== 'yes') return false;
  } else {
    host.print(`  ${theme.success('✓')} ${check.message}`);
  }
  updateGlobalConfig((g) => {
    g.providers = g.providers ?? {};
    const p = { ...(g.providers[def.id] ?? {}) };
    p.apiKey = key.trim();
    if (accountId) p.accountId = accountId;
    delete p.enabled;
    g.providers[def.id] = p;
  });
  host.print(c.dim(`  Saved. ${def.name} is now part of your free model pool.`));
  return true;
}

/** True when the setup screen should be shown automatically. */
export function needsFirstRunSetup(): boolean {
  return !readGlobalConfig().setupCompleted;
}

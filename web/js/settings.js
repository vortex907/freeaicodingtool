// Onboarding (first-run provider setup), Settings modal and folder picker.
import { h, clear, icon, colorFor, fmtTokens, escapeHtml } from './dom.js';
import { api } from './api.js';

const SECTIONS = [
  { kind: 'free', title: 'Free tiers', sub: 'Add as many as you can: FreeCode rotates between them so you rarely hit a limit.' },
  { kind: 'keyless', title: 'No signup needed', sub: 'Work out of the box.' },
  { kind: 'local', title: 'On your computer', sub: 'Run open models locally with Ollama or LM Studio: free, private, unlimited.' },
  { kind: 'trial', title: 'Free monthly credits', sub: 'Providers that give free credits each month.' },
  { kind: 'paid', title: 'Paid (optional)', sub: 'Only used when you allow paid models or pick one explicitly.' },
];

function initials(name) {
  const clean = name.replace(/\(.*?\)/g, '').trim();
  const parts = clean.split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function stateBadge(p) {
  switch (p.state) {
    case 'saved':
      return h('span', { class: 'badge ok' }, icon('check', 'svg-sm'), 'Connected');
    case 'env':
      return h('span', { class: 'badge ok', title: `Found in environment variable ${p.envName}` }, icon('check', 'svg-sm'), p.envName);
    case 'keyless':
      return h('span', { class: 'badge ok' }, icon('check', 'svg-sm'), 'Ready');
    case 'local-up':
      return h('span', { class: 'badge ok' }, icon('check', 'svg-sm'), 'Running');
    case 'local-down':
      return h('span', { class: 'badge off' }, 'Not running');
    case 'disabled':
      return h('span', { class: 'badge off' }, 'Disabled');
    default:
      return p.recommended ? h('span', { class: 'badge rec' }, 'Recommended') : h('span', { class: 'badge warn' }, 'Add key');
  }
}

/** One provider card: what's free, link to get a key, paste + test. */
export function providerCard(p, ctx, onChange) {
  const ready = ['saved', 'env', 'keyless', 'local-up'].includes(p.state);
  const msg = h('div', { class: 'prov-msg' });
  const input = h('input', { type: 'password', placeholder: p.state === 'saved' ? `Saved: ${p.maskedKey ?? ''}  (paste to replace)` : 'Paste your free API key', autocomplete: 'off', spellcheck: 'false' });
  const acct = p.needsAccountId ? h('input', { type: 'text', placeholder: 'Account ID', value: p.accountId ?? '', style: { maxWidth: '130px' } }) : null;
  const save = h('button', { class: 'btn btn-primary btn-sm' }, 'Save');
  const doSave = async () => {
    const key = input.value.trim();
    if (!key) {
      input.focus();
      return;
    }
    save.disabled = true;
    save.textContent = 'Testing…';
    msg.className = 'prov-msg';
    msg.textContent = '';
    try {
      const r = await api.post('/api/providers/key', { id: p.id, key, accountId: acct?.value.trim() || undefined });
      msg.className = `prov-msg ${r.ok ? 'ok' : 'err'}`;
      msg.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
      if (r.saved) {
        input.value = '';
        setTimeout(() => onChange?.(), 900);
      }
    } catch (e) {
      msg.className = 'prov-msg err';
      msg.textContent = e.message;
    } finally {
      save.disabled = false;
      save.textContent = 'Save';
    }
  };
  save.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSave();
  });
  const getKey = h('button', { class: 'btn btn-sm', title: p.signupUrl }, p.kind === 'local' ? 'Download' : 'Get free key', icon('external', 'svg-sm'));
  getKey.addEventListener('click', () => ctx.openUrl(p.signupUrl));
  const actions = h('div', { class: 'prov-actions' }, getKey, h('span', { class: 'spacer' }));
  if (p.state === 'saved') {
    const test = h('button', { class: 'btn btn-ghost btn-sm' }, 'Test');
    test.addEventListener('click', async () => {
      test.disabled = true;
      msg.className = 'prov-msg';
      msg.textContent = 'Testing…';
      const r = await api.post('/api/providers/test', { id: p.id }).catch((e) => ({ ok: false, message: e.message }));
      msg.className = `prov-msg ${r.ok ? 'ok' : 'err'}`;
      msg.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
      test.disabled = false;
    });
    const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger' }, 'Remove');
    remove.addEventListener('click', async () => {
      await api.post('/api/providers/remove', { id: p.id });
      onChange?.();
    });
    actions.append(test, remove);
  }
  const needsKey = p.kind !== 'local' && p.kind !== 'keyless';
  return h(
    'div',
    { class: `prov ${ready ? 'ready' : ''}` },
    h(
      'div',
      { class: 'prov-top' },
      h('div', { class: 'prov-avatar', style: { background: colorFor(p.id) } }, initials(p.name)),
      h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'prov-name' }, p.name), h('div', { class: 'prov-free' }, p.freeTier)),
      h('div', { class: 'prov-status' }, stateBadge(p)),
    ),
    p.models && ready ? h('div', { class: 'faint', style: { fontSize: '12px' } }, `${p.models} model${p.models === 1 ? '' : 's'} in your pool`) : null,
    needsKey ? h('div', { class: 'prov-key' }, input, acct, save) : null,
    p.kind === 'keyless' ? h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'Works without a key. A free token (optional) raises the limits.') : null,
    p.kind === 'local' ? h('div', { class: 'faint', style: { fontSize: '12.5px' } }, p.id === 'ollama' ? 'Install Ollama, run "ollama pull qwen3-coder:30b" (or any tool-capable model). FreeCode detects it automatically.' : 'Load a model in LM Studio and start the local server. FreeCode detects it automatically.') : null,
    actions,
    msg,
  );
}

function sectionBlock(kind, list, ctx, onChange) {
  const meta = SECTIONS.find((s) => s.kind === kind);
  const items = list.filter((p) => p.kind === kind);
  if (!items.length) return null;
  return h('div', { class: 'prov-section' }, h('h3', null, meta.title, h('span', { class: 'faint', style: { fontWeight: 400 } }, `· ${meta.sub}`)), h('div', { class: 'prov-grid' }, items.map((p) => providerCard(p, ctx, onChange))));
}

// ------------------------------------------------------------------ onboarding

export async function showOnboarding(ctx) {
  const root = h('div', { class: 'onboard' });
  const inner = h('div', { class: 'onboard-inner' });
  root.append(inner);
  const readyText = h('div', { class: 'ready-count' });
  const start = h('button', { class: 'btn btn-primary btn-lg' }, 'Start coding', icon('chevronRight'));
  const skip = h('button', { class: 'btn btn-ghost' }, 'Skip for now');
  const foot = h('div', { class: 'onboard-foot' }, h('div', { class: 'onboard-foot-inner' }, readyText, h('span', { class: 'grow' }), skip, start));
  document.body.append(root, foot);
  const close = async () => {
    await api.post('/api/setup/complete').catch(() => {});
    root.remove();
    foot.remove();
    ctx.afterSetup();
  };
  start.addEventListener('click', close);
  skip.addEventListener('click', close);

  const render = async () => {
    let list = [];
    try {
      list = await api.get('/api/providers');
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
    const ready = list.filter((p) => ['saved', 'env', 'keyless', 'local-up'].includes(p.state) && p.kind !== 'paid');
    const keyed = list.filter((p) => ['saved', 'env'].includes(p.state));
    readyText.innerHTML = ready.length
      ? `<b>${ready.length}</b> provider${ready.length === 1 ? '' : 's'} ready${keyed.length < 3 ? ' · add 2-3 free keys for the best experience' : ' · great setup!'}`
      : 'Add at least one free key to get started (Gemini or Groq take a minute).';
    const rec = list.filter((p) => p.recommended);
    const others = list.filter((p) => !p.recommended);
    clear(inner);
    inner.append(
      h(
        'div',
        { class: 'onboard-hero' },
        h('div', { class: 'big-logo' }),
        h('div', null, h('h1', null, 'Welcome to FreeCode'), h('p', null, 'An AI coding agent that runs on free AI models. Connect a few free providers below: when one runs out of free requests, FreeCode switches to the next automatically, and a small router AI picks the best available model for every task.')),
      ),
      h(
        'div',
        { class: 'how' },
        h('div', { class: 'how-item' }, h('div', { class: 'n' }, '1'), h('b', null, 'Get free keys'), h('span', null, 'Click "Get free key", sign in, create a key. No credit card needed.')),
        h('div', { class: 'how-item' }, h('div', { class: 'n' }, '2'), h('b', null, 'Paste & save'), h('span', null, 'FreeCode tests the key and adds that provider\'s free models to your pool.')),
        h('div', { class: 'how-item' }, h('div', { class: 'n' }, '3'), h('b', null, 'Just code'), h('span', null, 'The router picks the best model per task and switches when limits are hit.')),
      ),
      h('div', { class: 'step-title' }, icon('zap'), 'Start here'),
      h('p', { class: 'step-sub' }, 'These have the most generous free tiers. Each takes about a minute.'),
      h('div', { class: 'prov-grid', style: { marginBottom: '28px' } }, rec.map((p) => providerCard(p, ctx, render))),
      h('div', { class: 'step-title' }, icon('plug'), 'More free providers'),
      h('p', { class: 'step-sub' }, 'Every extra provider means more free requests per day.'),
      ...SECTIONS.map((s) => sectionBlock(s.kind, others, ctx, render)),
      h('p', { class: 'faint', style: { fontSize: '12.5px' } }, 'Keys are stored only on this computer (~/.freecode/config.json). You can change them any time in Settings → Providers.'),
    );
  };
  await render();
}

// ------------------------------------------------------------------ settings modal

const TABS = [
  { id: 'providers', label: 'Providers', icon: 'key' },
  { id: 'models', label: 'Models', icon: 'cpu' },
  { id: 'router', label: 'Router', icon: 'route' },
  { id: 'permissions', label: 'Permissions', icon: 'shield' },
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'skills', label: 'Skills', icon: 'package' },
  { id: 'index', label: 'Code index', icon: 'search' },
  { id: 'mcp', label: 'MCP servers', icon: 'plug' },
  { id: 'about', label: 'About', icon: 'info' },
];

function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
}

function field(label, desc, control) {
  return h('div', { class: 'field' }, h('div', { class: 'f-main' }, h('div', { class: 'f-label' }, label), desc ? h('div', { class: 'f-desc' }, desc) : null), control);
}

export function openSettings(ctx, tab = 'providers') {
  const overlay = document.getElementById('overlay');
  clear(overlay);
  overlay.classList.remove('hidden');
  const main = h('div', { class: 'modal-main' });
  const nav = h('div', { class: 'modal-nav' }, h('div', { class: 'nav-title' }, 'Settings'));
  const modal = h('div', { class: 'modal' }, nav, main);
  overlay.append(modal);
  const close = () => {
    overlay.classList.add('hidden');
    clear(overlay);
    document.removeEventListener('keydown', onKey);
    ctx.refresh();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  let current = tab;
  const navButtons = TABS.map((t) => {
    const b = h('button', { class: 'nav-item' }, icon(t.icon), t.label);
    b.addEventListener('click', () => show(t.id));
    nav.append(b);
    return [t.id, b];
  });
  const show = async (id) => {
    current = id;
    for (const [tid, b] of navButtons) b.classList.toggle('active', tid === id);
    const t = TABS.find((x) => x.id === id);
    const body = h('div', { class: 'modal-body' }, h('div', { class: 'muted' }, 'Loading…'));
    const closeBtn = h('button', { class: 'icon-btn', title: 'Close (Esc)' }, icon('x'));
    closeBtn.addEventListener('click', close);
    clear(main).append(h('div', { class: 'modal-head' }, h('h2', null, t.label), h('span', { class: 'grow' }), closeBtn), body);
    try {
      await renderTab(id, body);
    } catch (e) {
      clear(body).append(h('div', { class: 'note error' }, e.message));
    }
  };
  const renderTab = async (id, body) => {
    const st = ctx.state();
    if (id === 'providers') {
      const list = await api.get('/api/providers');
      clear(body).append(
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'Connect free AI providers. FreeCode pools all their free models and switches automatically when one hits a limit.'),
        ...SECTIONS.map((s) => sectionBlock(s.kind, list, ctx, () => current === 'providers' && show('providers'))),
      );
    } else if (id === 'models') {
      const models = await api.get('/api/models');
      const refresh = h('button', { class: 'btn btn-sm' }, icon('refresh', 'svg-sm'), 'Refresh model lists');
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = 'Asking providers…';
        try {
          const reports = await api.post('/api/models/refresh');
          const bad = reports.filter((r) => !r.ok);
          ctx.toast(`Updated model lists${bad.length ? ` (${bad.length} provider(s) failed)` : ''}`, bad.length ? 'err' : 'ok');
        } catch (e) {
          ctx.toast(e.message, 'err');
        }
        show('models');
      });
      const search = h('input', { class: 'text-input', placeholder: 'Filter models…', style: { flex: 1 } });
      const tbody = h('tbody');
      const fill = () => {
        const q = search.value.toLowerCase();
        clear(tbody);
        const autoRow = h(
          'tr',
          null,
          h('td', null, h('span', { class: 'status-dot ready' })),
          h('td', null, h('span', { class: 'tier tier-A' }, '★')),
          h('td', null, h('b', null, 'Auto'), h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Router AI picks the best available model for every task (recommended)')),
          h('td', null, ''),
          h('td', null, ''),
          h('td', null, st.model.pinned ? useBtn('auto') : h('span', { class: 'badge ok' }, 'In use')),
        );
        tbody.append(autoRow);
        for (const m of models.filter((x) => !q || x.key.toLowerCase().includes(q))) {
          tbody.append(
            h(
              'tr',
              null,
              h('td', { title: m.reason || m.status }, h('span', { class: `status-dot ${m.status}` })),
              h('td', null, h('span', { class: `tier tier-${m.tier}`, title: 'Estimated coding strength' }, m.tier)),
              h('td', null, h('div', { class: 'mkey' }, m.id), h('div', { class: 'faint', style: { fontSize: '12px' } }, m.providerName + (m.paid ? ' · paid' : '') + (m.status !== 'ready' ? ` · ${m.status}${m.reason ? ` (${m.reason})` : ''}` : ''))),
              h('td', { class: 'muted' }, fmtTokens(m.context)),
              h('td', { class: 'muted' }, m.toolMode === 'text' ? 'text tools' : 'native tools'),
              h('td', null, st.model.pinned === m.key ? h('span', { class: 'badge ok' }, 'Pinned') : useBtn(m.key)),
            ),
          );
        }
      };
      const useBtn = (key) => {
        const b = h('button', { class: 'btn btn-sm' }, key === 'auto' ? 'Use auto' : 'Use');
        b.addEventListener('click', async () => {
          await api.post('/api/model', { model: key });
          await ctx.refresh();
          show('models');
        });
        return b;
      };
      search.addEventListener('input', fill);
      fill();
      clear(body).append(
        h('div', { class: 'row', style: { marginBottom: '12px' } }, search, refresh),
        h('p', { class: 'muted', style: { margin: '0 0 10px', fontSize: '13px' } }, `${models.length} models available. Tier = estimated coding strength (S best). Green = ready, yellow = rate limited right now, red = unavailable.`),
        h('table', { class: 'models' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Tier'), h('th', null, 'Model'), h('th', null, 'Context'), h('th', null, 'Tools'), h('th', null, ''))), tbody),
      );
    } else if (id === 'router') {
      const r = st.settings.router;
      const upd = (k) => (v) => api.post('/api/settings', { patch: { [k]: v } }).then(ctx.refresh);
      const waitInput = h('input', { type: 'number', min: 0, max: 600, value: r.maxWaitSeconds, style: { width: '90px' } });
      waitInput.addEventListener('change', () => upd('router.maxWaitSeconds')(Number(waitInput.value)));
      const prefer = h('input', { type: 'text', value: (r.prefer || []).join(', '), placeholder: 'e.g. gemini, groq/openai/gpt-oss-120b', style: { width: '280px' } });
      prefer.addEventListener('change', () => upd('router.prefer')(prefer.value.split(',').map((s) => s.trim()).filter(Boolean)));
      const avoid = h('input', { type: 'text', value: (r.avoid || []).join(', '), placeholder: 'providers or models to skip', style: { width: '280px' } });
      avoid.addEventListener('change', () => upd('router.avoid')(avoid.value.split(',').map((s) => s.trim()).filter(Boolean)));
      clear(body).append(
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'The router scores every free model by strength, speed, context size, remaining free quota and recent errors. It keeps using one model while it works and switches automatically on rate limits or failures.'),
        field('AI task router', 'A small, fast model rates each request (simple / complex, debugging, planning…) so hard tasks get the strongest model and easy ones the fastest.', toggle(r.enabled, upd('router.enabled'))),
        field('Allow paid models', 'Let the router use paid providers you configured (they are still ranked after free ones).', toggle(r.allowPaid, upd('router.allowPaid'))),
        field('Show routing decisions', 'Show which model was picked and why in the chat.', toggle(r.showDecisions, upd('router.showDecisions'))),
        field('Max wait for a busy model (seconds)', 'If the best model is briefly rate limited, wait up to this long instead of switching to a weaker one.', waitInput),
        field('Prefer', 'Providers or models to favour (comma separated).', prefer),
        field('Avoid', 'Providers or models never to use automatically.', avoid),
      );
    } else if (id === 'permissions') {
      const p = st.settings.permissions;
      const modeSel = h('select', null, ...[['default', 'Ask before edits & commands'], ['acceptEdits', 'Edit automatically'], ['plan', 'Plan mode'], ['bypassPermissions', 'Bypass permissions (yolo)']].map(([v, l]) => h('option', { value: v }, l)));
      modeSel.value = p.defaultMode;
      modeSel.addEventListener('change', () => api.post('/api/settings', { patch: { 'permissions.mode': modeSel.value } }).then(ctx.refresh));
      const ruleList = (list, rules) => {
        const wrap = h('div', { class: 'rules' });
        for (const r of rules) {
          const rm = h('button', { title: 'Remove' }, '×');
          rm.addEventListener('click', async () => {
            await api.post('/api/permissions', { list, rule: r, remove: true });
            await ctx.refresh();
            show('permissions');
          });
          wrap.append(h('span', { class: 'rule' }, r, rm));
        }
        if (!rules.length) wrap.append(h('span', { class: 'faint', style: { fontSize: '13px' } }, 'none'));
        const input = h('input', { class: 'text-input', placeholder: list === 'allow' ? 'e.g. Bash(npm test:*)  or  Edit(src/**)' : 'e.g. Bash(git push:*)', style: { flex: 1 } });
        const add = h('button', { class: 'btn btn-sm' }, 'Add');
        const doAdd = async () => {
          if (!input.value.trim()) return;
          await api.post('/api/permissions', { list, rule: input.value.trim() });
          await ctx.refresh();
          show('permissions');
        };
        add.addEventListener('click', doAdd);
        input.addEventListener('keydown', (e) => e.key === 'Enter' && doAdd());
        return h('div', null, wrap, h('div', { class: 'row', style: { marginTop: '8px' } }, input, add));
      };
      clear(body).append(
        field('Default mode for new sessions', 'You can always switch with Shift+Tab or the mode menu in the composer.', modeSel),
        h('div', { class: 'field', style: { display: 'block' } }, h('div', { class: 'f-label' }, 'Always allow'), h('div', { class: 'f-desc' }, 'Actions that run without asking in this project.'), ruleList('allow', p.allow)),
        h('div', { class: 'field', style: { display: 'block' } }, h('div', { class: 'f-label' }, 'Always deny'), h('div', { class: 'f-desc' }, 'Actions that are never allowed.'), ruleList('deny', p.deny)),
        h('p', { class: 'faint', style: { fontSize: '12.5px' } }, 'Read-only actions (reading files, searching, safe commands like ls or git status) never ask. Dangerous commands always ask, even in bypass mode.'),
      );
    } else if (id === 'general') {
      const s = st.settings;
      const upd = (k) => (v) => api.post('/api/settings', { patch: { [k]: v } }).then(ctx.refresh);
      const num = (k, v, w = 110) => {
        const i = h('input', { type: 'number', value: v, style: { width: `${w}px` } });
        i.addEventListener('change', () => upd(k)(Number(i.value)));
        return i;
      };
      const ws = h('select', null, ...['auto', 'duckduckgo', 'brave', 'tavily', 'searxng'].map((v) => h('option', { value: v }, v)));
      ws.value = s.webSearch.provider;
      ws.addEventListener('change', () => upd('webSearch.provider')(ws.value));
      const brave = h('input', { type: 'password', placeholder: s.webSearch.hasBrave ? '•••••••• (saved)' : 'optional', style: { width: '200px' } });
      brave.addEventListener('change', () => upd('webSearch.braveApiKey')(brave.value.trim()));
      const tavily = h('input', { type: 'password', placeholder: s.webSearch.hasTavily ? '•••••••• (saved)' : 'optional', style: { width: '200px' } });
      tavily.addEventListener('change', () => upd('webSearch.tavilyApiKey')(tavily.value.trim()));
      const theme = h('select', null, h('option', { value: 'dark' }, 'Dark'), h('option', { value: 'light' }, 'Light'));
      theme.value = document.documentElement.dataset.theme;
      theme.addEventListener('change', () => ctx.setTheme(theme.value));
      clear(body).append(
        field('Theme', null, theme),
        field('Context budget (tokens)', 'Older conversation is summarized above this size. Free tiers resend the whole context every step, so smaller is cheaper.', num('contextBudget', s.contextBudget)),
        field('Auto-compact', 'Summarize old conversation automatically when it gets large.', toggle(s.autoCompact, upd('autoCompact'))),
        field('Max agent steps per request', null, num('maxSteps', s.maxSteps, 90)),
        field('Command timeout (ms)', 'Default time limit for shell commands.', num('bashTimeoutMs', s.bashTimeoutMs)),
        field('Show model reasoning', 'Show "thinking" sections from reasoning models.', toggle(s.showReasoning, upd('showReasoning'))),
        field('Save conversations', 'Keep history so you can resume tasks later.', toggle(s.saveSessions, upd('saveSessions'))),
        field('No em dashes in replies', 'Rewrite em and en dashes in answers as commas, colons or hyphens. Code is left as it is.', toggle(s.plainPunctuation !== false, upd('plainPunctuation'))),
        field('Language servers', 'Check every edit with the installed language server (TypeScript, Python, Rust, Go, C/C++, C# and more) and let the agent jump to definitions, find references and rename across files.', toggle(s.lsp?.enabled !== false, upd('lsp.enabled'))),
        field('Update automatically', 'Download new versions from GitHub in the background and install them when you restart.', toggle(s.autoUpdate !== false, upd('autoUpdate'))),
        field('Web search engine', 'DuckDuckGo works without a key; Brave/Tavily give better results with a free key.', ws),
        field('Brave Search API key', null, brave),
        field('Tavily API key', null, tavily),
      );
    } else if (id === 'skills') {
      await skillsTab(body, ctx, () => current === 'skills' && show('skills'));
    } else if (id === 'index') {
      await indexTab(body, ctx, () => current === 'index' && show('index'));
    } else if (id === 'mcp') {
      const list = st.mcp || [];
      clear(body).append(
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'MCP servers give the agent extra tools (databases, browsers, APIs…). Add them to ~/.freecode/mcp.json or a project .mcp.json, or run: freecode mcp add <name> <command> [args]'),
        list.length
          ? h(
              'div',
              null,
              list.map((m) =>
                h(
                  'div',
                  { class: 'field' },
                  h('div', { class: 'f-main' }, h('div', { class: 'f-label' }, m.name, h('span', { class: 'faint', style: { fontWeight: 400, marginLeft: '8px', fontSize: '12px' } }, m.transport)), h('div', { class: 'f-desc' }, m.status === 'ready' ? m.tools.join(', ') || 'no tools' : m.error || m.status)),
                  h('span', { class: `badge ${m.status === 'ready' ? 'ok' : m.status === 'failed' ? 'err' : 'off'}` }, m.status),
                ),
              ),
            )
          : h('div', { class: 'panel-empty' }, 'No MCP servers configured.'),
        h('div', { class: 'codeblock' }, h('div', { class: 'cb-head' }, h('span', null, '~/.freecode/mcp.json')), h('pre', null, h('code', null, '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}'))),
      );
    } else if (id === 'about') {
      const doc = h('button', { class: 'btn' }, 'Test all providers');
      const out = h('div', { style: { marginTop: '12px' } });
      doc.addEventListener('click', async () => {
        doc.disabled = true;
        clear(out);
        const list = await api.get('/api/providers');
        for (const p of list.filter((x) => x.state === 'saved' || x.state === 'env')) {
          const line = h('div', { class: 'note' }, `Testing ${p.name}…`);
          out.append(line);
          const r = await api.post('/api/providers/test', { id: p.id }).catch((e) => ({ ok: false, message: e.message }));
          line.className = `note ${r.ok ? '' : 'warn'}`;
          line.textContent = `${r.ok ? '✓' : '✗'} ${p.name}: ${r.message}`;
        }
        if (!out.childNodes.length) out.append(h('div', { class: 'note warn' }, 'No providers with keys yet.'));
        doc.disabled = false;
      });
      const checkBtn = h('button', { class: 'btn' }, icon('refresh', 'svg-sm'), 'Check for updates');
      const updLine = h('span', { class: 'muted', style: { marginLeft: '10px' } });
      const describe = (u) => {
        if (!u) return '';
        if (u.status === 'up-to-date') return `You have the latest version (${u.current}).`;
        if (u.status === 'available') return `Version ${u.latest.version} is available${u.method === 'installer' ? '' : u.command ? ` - update with: ${u.command}` : ''}.`;
        if (u.status === 'downloading') return `Downloading ${u.latest.version}…`;
        if (u.status === 'ready') return `Version ${u.latest.version} is downloaded: use "Restart to update" in the sidebar.`;
        if (u.status === 'error') return `Could not check: ${u.error}`;
        if (u.status === 'checking') return 'Checking…';
        return '';
      };
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        updLine.textContent = 'Checking…';
        const u = await api.post('/api/update/check').catch((e) => ({ status: 'error', error: e.message }));
        updLine.textContent = describe(u);
        checkBtn.disabled = false;
      });
      api.get('/api/update').then((u) => (updLine.textContent = describe(u))).catch(() => {});
      clear(body).append(
        h('div', { class: 'row', style: { gap: '14px', marginBottom: '14px' } }, h('div', { class: 'big-logo', style: { width: '48px', height: '48px', borderRadius: '13px', background: "url('/icon.svg') center/cover" } }), h('div', null, h('div', { style: { fontWeight: 700, fontSize: '18px' } }, 'FreeCode'), h('div', { class: 'muted' }, `Version ${st.version} · free AI coding agent`))),
        field('Project', st.project.root, h('span')),
        field('Session', st.session.id, h('span')),
        field('Configuration', 'Keys and settings are stored in ~/.freecode/config.json', h('span')),
        field('Updates', 'New versions come from github.com/vortex907/freeaicodingtool releases.', h('div', { class: 'row' }, checkBtn, updLine)),
        field('Diagnostics', 'Checks that every saved API key works.', doc),
        out,
      );
    }
  };
  show(tab);
}

// ------------------------------------------------------------------ folder picker

export function openFolderPicker(ctx) {
  const overlay = document.getElementById('overlay');
  clear(overlay);
  overlay.classList.remove('hidden');
  const pathInput = h('input', { class: 'text-input', style: { flex: 1 }, spellcheck: 'false' });
  const list = h('div', { class: 'dir-list' });
  const openBtn = h('button', { class: 'btn btn-primary' }, 'Open this folder');
  const upBtn = h('button', { class: 'btn btn-sm', title: 'Parent folder' }, '↑ Up');
  const recent = h('div', { class: 'rules' });
  const close = () => {
    overlay.classList.add('hidden');
    clear(overlay);
  };
  let parent = null;
  const load = async (p) => {
    try {
      const r = await api.get(`/api/fs?path=${encodeURIComponent(p || '')}`);
      pathInput.value = r.path;
      parent = r.parent;
      upBtn.disabled = !parent;
      clear(list);
      if (!r.dirs.length) list.append(h('div', { class: 'panel-empty', style: { padding: '20px' } }, 'No sub-folders'));
      for (const d of r.dirs) {
        const row = h('div', { class: 'dir' }, icon('folder'), d.name, d.isGit ? h('span', { class: 'git' }, 'git') : null);
        row.addEventListener('click', () => load(d.path));
        row.addEventListener('dblclick', () => openIt(d.path));
        list.append(row);
      }
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
  };
  const openIt = async (p, trust) => {
    openBtn.disabled = true;
    try {
      const r = await api.post('/api/project', { path: p, ...(trust !== undefined ? { trust } : {}) });
      if (r.needsTrust) {
        const ok = confirm(`This folder contains project settings (hooks, MCP servers or permission rules) that can run commands:\n\n${r.root}\n\nDo you trust this folder?`);
        return openIt(p, ok);
      }
      if (!r.ok) throw new Error(r.error || 'Could not open folder');
      close();
      await ctx.reload();
    } catch (e) {
      ctx.toast(e.message, 'err');
    } finally {
      openBtn.disabled = false;
    }
  };
  upBtn.addEventListener('click', () => parent && load(parent));
  openBtn.addEventListener('click', () => openIt(pathInput.value));
  pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && load(pathInput.value));
  for (const r of ctx.state().recentProjects || []) {
    const b = h('button', { class: 'rule', style: { cursor: 'pointer', paddingRight: '9px' }, title: r }, icon('folder', 'svg-sm'), r.split(/[\\/]/).filter(Boolean).pop() || r);
    b.addEventListener('click', () => openIt(r));
    recent.append(b);
  }
  const closeBtn = h('button', { class: 'icon-btn' }, icon('x'));
  closeBtn.addEventListener('click', close);
  overlay.append(
    h(
      'div',
      { class: 'modal small' },
      h('div', { class: 'modal-head' }, h('h2', null, 'Open a project folder'), h('span', { class: 'grow' }), closeBtn),
      h(
        'div',
        { class: 'modal-body' },
        (ctx.state().recentProjects || []).length ? h('div', { style: { marginBottom: '14px' } }, h('div', { class: 'panel-section-title', style: { marginTop: 0 } }, 'Recent'), recent) : null,
        h('div', { class: 'row', style: { marginBottom: '10px' } }, upBtn, pathInput),
        list,
      ),
      h('div', { class: 'modal-foot' }, h('span', { class: 'faint', style: { fontSize: '12.5px' } }, 'The agent can read and edit files inside this folder.'), h('span', { class: 'grow' }), openBtn),
    ),
  );
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  load(ctx.state().project.root);
}

export { escapeHtml };

// ---------------------------------------------------------------- Skills

const RECOMMENDED_SKILLS = new Set(['frontend-design', 'webapp-testing', 'pdf', 'docx', 'xlsx', 'pptx', 'mcp-builder', 'skill-creator']);

// ------------------------------------------------------------------ code index

function indexStatusText(s) {
  if (!s) return 'Not started yet.';
  if (!s.enabled) return 'Turned off.';
  const p = s.progress || {};
  const parts = [`${s.files.toLocaleString()} files`, `${s.symbols.toLocaleString()} symbols`, `${s.projects} project${s.projects === 1 ? '' : 's'}`];
  if (s.indexing) {
    const what = { loading: 'Loading the saved index', scanning: 'Looking for changed files', indexing: 'Indexing', history: 'Reading git history', saving: 'Saving' }[p.phase] || 'Working';
    return `${what}${p.total ? ` (${p.done.toLocaleString()} of ${p.total.toLocaleString()})` : ''}. ${parts.join(', ')} so far.`;
  }
  return `${parts.join(', ')}.${s.lastUpdate ? ` Updated ${new Date(s.lastUpdate).toLocaleTimeString()}.` : ''}`;
}

async function indexTab(body, ctx, rerender) {
  const st = ctx.state();
  const idx = st.index || {};
  let roots = [...(idx.configuredRoots || [])];
  const save = async (patch) => {
    await api.post('/api/settings', { patch });
    await ctx.refresh();
    rerender();
  };
  const status = h('div', { class: 'index-status' }, indexStatusText(idx));
  // Live progress while the tab is open.
  const onIndex = (e) => {
    if (!status.isConnected) return document.removeEventListener('fc-index', onIndex);
    status.textContent = indexStatusText(e.detail);
  };
  document.addEventListener('fc-index', onIndex);

  const rootList = h('div', { class: 'rules' });
  const drawRoots = () => {
    clear(rootList);
    if (!roots.length) rootList.append(h('div', { class: 'muted', style: { padding: '6px 0', fontSize: '12.5px' } }, 'Only the open project is indexed. Add a folder that holds your other projects to search across all of them.'));
    roots.forEach((r, i) => {
      const rm = h('button', { class: 'btn btn-ghost btn-sm' }, 'Remove');
      rm.addEventListener('click', () => {
        roots.splice(i, 1);
        save({ 'index.roots': roots });
      });
      rootList.append(h('div', { class: 'rule' }, h('span', { class: 'mono', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, r), rm));
    });
  };
  drawRoots();
  const input = h('input', { class: 'text-input', placeholder: 'C:\\Users\\you\\Desktop\\Projects', spellcheck: 'false', style: { flex: 1 } });
  const add = h('button', { class: 'btn btn-primary btn-sm' }, 'Add folder');
  const doAdd = () => {
    const v = input.value.trim().replace(/^"|"$/g, '');
    if (!v) return;
    if (!roots.includes(v)) roots.push(v);
    input.value = '';
    save({ 'index.roots': roots });
  };
  add.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && doAdd());
  const refresh = h('button', { class: 'btn btn-sm' }, icon('refresh', 'svg-sm'), 'Refresh now');
  refresh.addEventListener('click', () => api.post('/api/index/refresh').then(() => ctx.toast('Refreshing the index')));

  const projects = h('div', { class: 'index-projects' });
  api.get('/api/index/projects').then((list) => {
    if (!list.length) return;
    projects.append(h('div', { class: 'panel-section-title' }, `Projects found (${list.length})`));
    for (const p of list.slice(0, 200)) {
      const langs = p.languages.slice(0, 3).map((l) => l.name).join(', ');
      projects.append(h('div', { class: 'index-project' }, h('span', { class: 'ip-name' }, p.name), h('span', { class: 'ip-langs' }, langs), p.summary ? h('div', { class: 'ip-summary' }, p.summary) : null));
    }
  }).catch(() => undefined);

  clear(body).append(
    h('p', { class: 'muted', style: { marginTop: 0 } }, 'FreeCode keeps a local index of your code (files, symbols, imports between projects, dependencies and git history) so the agent can find things across projects with the CodeSearch tool. Everything stays on this computer.'),
    field('Index code', 'Turn off to stop indexing and hide the CodeSearch tool.', toggle(idx.enabled !== false, (v) => save({ 'index.enabled': v }))),
    h('div', { class: 'panel-section-title' }, 'Folders with your other projects'),
    rootList,
    h('div', { class: 'row', style: { gap: '8px', marginTop: '8px' } }, input, add),
    h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12.5px' } }, 'Each project inside the folder is detected on its own (package.json, .csproj or .sln, pyproject, Cargo.toml, go.mod, Unity, Godot, Unreal and more). Big folders take a few minutes the first time and use more memory.'),
    h('div', { class: 'panel-section-title' }, 'Status'),
    h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, status, h('span', { class: 'grow' }), refresh),
    ...((idx.errors || []).length ? [h('div', { class: 'note warn', style: { marginTop: '8px', whiteSpace: 'pre-line' } }, idx.errors.slice(0, 3).join('\n'))] : []),
    projects,
  );
}

async function skillsTab(body, ctx, rerender) {
  const data = await api.get('/api/skills');
  let source = data.marketplaces[0] || 'anthropics/skills';
  const installedBox = h('div');
  const drawInstalled = (list) => {
    clear(installedBox);
    if (!list.length) {
      installedBox.append(h('div', { class: 'panel-empty' }, 'No skills yet. Install some from a marketplace below.'));
      return;
    }
    for (const sk of list) {
      const remove = h('button', { class: 'btn btn-ghost btn-sm' }, 'Remove');
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove the "${sk.name}" skill?`)) return;
        await api.post('/api/skills/remove', { name: sk.name });
        ctx.toast(`Removed ${sk.name}`);
        rerender();
      });
      const where = sk.from ? `from ${sk.from.source}` : sk.scope === 'project' ? 'this project' : sk.dir.includes('.claude') ? 'Claude skills folder' : 'your skills folder';
      installedBox.append(
        h(
          'div',
          { class: 'field skill-row' },
          h('div', { class: 'f-main' }, h('div', { class: 'f-label' }, sk.name, h('span', { class: 'faint skill-where' }, where)), h('div', { class: 'f-desc' }, sk.description || 'No description')),
          sk.from || (sk.scope === 'user' && !sk.dir.includes('.claude')) ? remove : null,
        ),
      );
    }
  };
  drawInstalled(data.installed);

  const sourceSel = h('select', { class: 'text-input', style: { flex: '0 1 260px' } }, data.marketplaces.map((m) => h('option', { value: m }, m)));
  const search = h('input', { class: 'text-input', placeholder: 'Search skills…', style: { flex: 1 } });
  const refresh = h('button', { class: 'btn btn-sm', title: 'Download the latest list' }, icon('refresh', 'svg-sm'), 'Refresh');
  const list = h('div', { class: 'skill-market' }, h('div', { class: 'muted' }, 'Loading…'));
  let catalog = null;
  const drawCatalog = () => {
    clear(list);
    if (!catalog) return;
    if (catalog.error) {
      list.append(h('div', { class: 'note error' }, `Could not load ${catalog.source}: ${catalog.error}`));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const items = catalog.skills.filter((sk) => !q || sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q));
    items.sort((a, b) => (RECOMMENDED_SKILLS.has(b.name) ? 1 : 0) - (RECOMMENDED_SKILLS.has(a.name) ? 1 : 0));
    if (!items.length) list.append(h('div', { class: 'panel-empty' }, 'No skills found.'));
    for (const sk of items) {
      const btn = h('button', { class: `btn btn-sm ${sk.installed ? '' : 'btn-primary'}` }, sk.installed ? 'Reinstall' : 'Install');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Installing…';
        const r = await api.post('/api/skills/install', { source: catalog.source, path: sk.path }).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) {
          ctx.toast(`Installed the ${r.name} skill`);
          rerender();
        } else {
          ctx.toast(r.error || 'Install failed', 'err');
          btn.disabled = false;
          btn.textContent = 'Install';
        }
      });
      list.append(
        h(
          'div',
          { class: 'skill-card' },
          h('div', { class: 'skill-top' }, h('span', { class: 'skill-name' }, sk.name), RECOMMENDED_SKILLS.has(sk.name) ? h('span', { class: 'badge ok' }, 'Recommended') : null, sk.installed ? h('span', { class: 'badge off' }, 'Installed') : null, h('span', { class: 'grow' }), btn),
          h('div', { class: 'f-desc' }, sk.description || ''),
        ),
      );
    }
  };
  const load = async (force) => {
    clear(list).append(h('div', { class: 'muted' }, `Loading ${source}…`));
    catalog = await api.get(`/api/skills/catalog?source=${encodeURIComponent(source)}${force ? '&refresh=1' : ''}`).catch((e) => ({ source, skills: [], error: e.message }));
    drawCatalog();
  };
  sourceSel.addEventListener('change', () => {
    source = sourceSel.value;
    load(false);
  });
  search.addEventListener('input', drawCatalog);
  refresh.addEventListener('click', () => load(true));

  const addInput = h('input', { class: 'text-input', placeholder: 'owner/repo or GitHub link', style: { flex: 1 } });
  const addBtn = h('button', { class: 'btn btn-sm' }, icon('plus', 'svg-sm'), 'Add marketplace');
  addBtn.addEventListener('click', async () => {
    const r = await api.post('/api/skills/marketplaces', { add: addInput.value.trim() });
    if (!r.ok) return ctx.toast(r.error, 'err');
    rerender();
  });

  clear(body).append(
    h('p', { class: 'muted', style: { marginTop: 0 } }, 'Skills are expert playbooks the agent loads when a task matches (documents, design, testing…). They use the same SKILL.md format as Claude, so skills from Claude marketplaces work here, and skills in ~/.claude/skills are picked up too.'),
    h('div', { class: 'panel-section-title', style: { marginTop: '6px' } }, 'Installed'),
    installedBox,
    h('div', { class: 'panel-section-title', style: { marginTop: '22px' } }, 'Marketplace'),
    h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } }, sourceSel, search, refresh),
    list,
    h('div', { class: 'row', style: { gap: '8px', marginTop: '14px' } }, addInput, addBtn),
  );
  load(false);
}

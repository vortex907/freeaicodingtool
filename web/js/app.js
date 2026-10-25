// FreeCode app: chat UI driven by the local FreeCode engine.
import { h, clear, icon, iconHtml, escapeHtml, fmtTokens, fmtUsd, fmtDuration, timeAgo, dayGroup, debounce } from './dom.js';
import { api, connectEvents, token } from './api.js';
import { renderMarkdown, FILE_REF } from './markdown.js';
import { highlightLine, langFromPath } from './highlight.js';
import { showOnboarding, openSettings, openFolderPicker } from './settings.js';

// Shared with the engine (src/shared). Falls back to showing text unchanged if it can't load.
const { plainPunctuation } = await import('/shared/punctuation.js').catch(() => ({ plainPunctuation: (t) => t }));

const $ = (id) => document.getElementById(id);
/** Model-written text as the user sees it (em dashes rewritten unless turned off in Settings). */
const tidy = (t) => (t && S.state?.settings?.plainPunctuation !== false ? plainPunctuation(t) : t);

const S = {
  state: null,
  items: [],
  pending: [],
  sessions: [],
  changes: [],
  models: [],
  history: [],
  historyIdx: -1,
  ui: {
    panel: localStorage.getItem('fc-panel') || 'changes',
    panelOpen: localStorage.getItem('fc-panel-open') !== '0',
    sidebarOpen: localStorage.getItem('fc-sidebar') !== '0',
    open: new Set(),
    closed: new Set(),
  },
  live: { assistant: null, lastModel: null, turnStart: 0, outChars: 0, wait: null, streamingTool: null, reasoningStart: 0, subs: new Map() },
};
let itemSeq = 0;
const nid = (p) => `${p}-${++itemSeq}`;

// ---------------------------------------------------------------- toasts & helpers

function toast(text, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info'), h('div', null, text));
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

function openUrl(url) {
  api.post('/api/open', { url }).catch(() => window.open(url, '_blank'));
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('fc-theme', t);
  } catch {}
  renderSidebar();
  syncHostTheme();
}

// ---------------------------------------------------------------- native window (FreeCode.exe on Windows)

/** Colors the native window's title bar like the app. */
function syncHostTheme() {
  if (typeof window.fcHostTheme !== 'function') return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-sidebar').trim();
  Promise.resolve(window.fcHostTheme(document.documentElement.dataset.theme || 'dark', color)).catch(() => {});
}

/** Called by the native window for "Open with FreeCode" on a folder while the app is open. */
window.fcOpenProject = async (path, trust) => {
  try {
    const r = await api.post('/api/project', { path, ...(trust !== undefined ? { trust } : {}) });
    if (r.needsTrust) {
      const ok = confirm(`This folder contains project settings (hooks, MCP servers or permission rules) that can run commands:\n\n${r.root}\n\nDo you trust this folder?`);
      return window.fcOpenProject(path, ok);
    }
    if (!r.ok) throw new Error(r.error || 'Could not open folder');
    await loadState();
  } catch (e) {
    toast(e.message, 'err');
  }
};

const ctx = {
  state: () => S.state,
  toast,
  openUrl,
  setTheme,
  refresh: async () => {
    await refreshState(false);
  },
  reload: async () => {
    await loadState();
  },
  afterSetup: async () => {
    await refreshState(false);
    renderAll();
    $('composer-input')?.focus();
  },
};

// ---------------------------------------------------------------- state loading

async function loadState() {
  const st = await api.get('/api/state');
  S.state = st;
  S.items = st.transcript || [];
  S.pending = st.pending || [];
  S.live = { assistant: null, lastModel: null, turnStart: Date.now(), outChars: 0, wait: null, streamingTool: null, reasoningStart: 0, subs: new Map() };
  for (const ev of st.liveEvents || []) handleMessage(ev, true);
  renderAll();
  loadSessions();
  loadChanges();
  loadLaunch();
  api.get('/api/update').then((u) => {
    S.update = u;
    renderSidebarFooter();
  }).catch(() => {});
  if (!st.setupCompleted) showOnboarding(ctx);
  if (st.initialPrompt) send(st.initialPrompt);
}

async function refreshState(full = false) {
  if (full) return loadState();
  const st = await api.get('/api/state');
  const keepItems = S.items;
  S.state = st;
  S.items = keepItems;
  S.pending = st.pending || S.pending;
  renderTopbar();
  renderSidebar();
  renderComposer();
  renderPending();
  renderPanel();
}

async function loadSessions() {
  try {
    S.sessions = await api.get('/api/sessions');
  } catch {
    S.sessions = [];
  }
  renderSidebar();
}

async function loadChanges() {
  const [changes, checkpoints] = await Promise.all([api.get('/api/changes').catch(() => []), api.get('/api/checkpoints').catch(() => [])]);
  S.changes = changes;
  S.checkpoints = checkpoints;
  renderPanel();
}

/** "Rewind to before this request" list under the changed files. Two clicks, so a stray click can't revert work. */
function checkpointList() {
  const cps = S.checkpoints || [];
  if (!cps.length) return null;
  const list = h('div', { class: 'cp-list' }, h('div', { class: 'panel-section-title' }, 'Checkpoints'));
  for (const cp of cps) {
    const btn = h('button', { class: 'btn btn-sm btn-ghost cp-rewind', title: 'Put the files back the way they were before this request (later requests are undone too)' }, icon('undo', 'svg-sm'), 'Rewind');
    let armed = null;
    btn.addEventListener('click', async () => {
      if (!armed) {
        btn.lastChild.textContent = 'Click again to rewind';
        btn.classList.add('armed');
        armed = setTimeout(() => {
          armed = null;
          btn.lastChild.textContent = 'Rewind';
          btn.classList.remove('armed');
        }, 3500);
        return;
      }
      clearTimeout(armed);
      const r = await api.post('/api/rewind', { turn: cp.turn }).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) toast(r.error || 'Could not rewind', 'err');
      loadChanges();
    });
    list.append(
      h(
        'div',
        { class: 'cp' },
        h('div', { class: 'cp-text' }, h('div', { class: 'cp-prompt', title: cp.prompt }, cp.prompt), h('div', { class: 'cp-files', title: cp.files.join('\n') }, `${cp.files.length} file${cp.files.length === 1 ? '' : 's'}: ${cp.files.slice(0, 3).join(', ')}${cp.files.length > 3 ? ', ...' : ''}`)),
        btn,
      ),
    );
  }
  return list;
}

// ---------------------------------------------------------------- live events

function findItem(id) {
  return S.items.find((i) => i.id === id);
}

/** The current model produced output: later switches start a new route line. */
function settleRoute() {
  const r = S.live.route;
  if (r && (r.open || r.retrying)) {
    touch(r);
    r.open = false;
    r.retrying = null;
  }
}

function currentAssistant() {
  if (!S.live.assistant) {
    const item = { kind: 'assistant', id: nid('a'), text: '', reasoning: '', streaming: true };
    S.items.push(item);
    S.live.assistant = item;
  }
  return S.live.assistant;
}

function handleAgentEvent(e, replay) {
  const live = S.live;
  switch (e.type) {
    case 'turn_start':
      live.turnStart = Date.now();
      live.outChars = 0;
      live.turnModel = null;
      live.route = null;
      break;
    case 'model': {
      live.wait = null;
      if (live.route && live.route.open) {
        // Still looking for a model that works: update the same line instead of adding another.
        touch(live.route);
        live.route.model = e.key;
        live.route.textTools = e.toolMode === 'text';
        live.route.retrying = null;
        live.lastModel = e.key;
        live.assistant = null;
      } else if (e.key !== live.lastModel) {
        const switched = !!live.turnModel && live.turnModel !== e.key;
        const prof = !switched && e.reason === 'selected' && !S.state?.model?.pinned ? live.profile : null;
        const why = S.state?.model?.pinned && !switched ? 'Pinned' : switched || e.attempt > 1 ? 'Switched' : prof ? `${prof.complexity} ${prof.type}` : 'Auto';
        live.route = { kind: 'route', id: nid('r'), why, model: e.key, textTools: e.toolMode === 'text', tries: [], open: false };
        S.items.push(live.route);
        live.lastModel = e.key;
        live.assistant = null;
      }
      live.turnModel = live.turnModel || e.key;
      break;
    }
    case 'profile':
      live.profile = e.profile;
      break;
    case 'text': {
      settleRoute();
      const a = currentAssistant();
      touch(a);
      if (a.reasoning && a.thinkingSince && !a.thoughtMs) a.thoughtMs = Date.now() - a.thinkingSince;
      a.text += e.delta;
      live.outChars += e.delta.length;
      break;
    }
    case 'reasoning': {
      settleRoute();
      const a = currentAssistant();
      touch(a);
      if (!a.reasoning) live.reasoningStart = Date.now();
      a.reasoning += e.delta;
      a.thinkingSince = a.thinkingSince || Date.now();
      live.outChars += e.delta.length;
      break;
    }
    case 'tool_call_streaming':
      live.streamingTool = e.name;
      break;
    case 'assistant':
      if (live.assistant) {
        touch(live.assistant);
        live.assistant.streaming = false;
        if (live.assistant.thinkingSince && !live.assistant.thoughtMs) live.assistant.thoughtMs = Date.now() - live.assistant.thinkingSince;
        if (!live.assistant.text.trim() && !live.assistant.reasoning) S.items = S.items.filter((i) => i !== live.assistant);
      }
      live.assistant = null;
      live.streamingTool = null;
      break;
    case 'tool_start':
      settleRoute();
      live.assistant = null;
      S.items.push({ kind: 'tool', id: e.id, name: e.name, label: e.label, input: e.input, status: 'running', started: Date.now() });
      break;
    case 'tool_progress': {
      const t = findItem(e.id);
      if (t) {
        t.progress = e.text;
        touch(t);
      }
      break;
    }
    case 'tool_end': {
      let t = findItem(e.id);
      if (!t) {
        t = { kind: 'tool', id: e.id, name: e.name, label: e.label, input: {} };
        S.items.push(t);
      }
      touch(t);
      t.status = e.denied ? 'denied' : e.result.isError ? 'error' : 'ok';
      t.result = { content: e.result.content, display: e.result.display };
      t.durationMs = e.durationMs;
      t.progress = '';
      if (!replay && (e.name === 'Edit' || e.name === 'Write' || e.name === 'MultiEdit')) debouncedChanges();
      break;
    }
    case 'failover': {
      if (e.hadOutput && live.assistant) {
        touch(live.assistant);
        live.assistant.discarded = true;
        live.assistant.streaming = false;
        live.assistant = null;
      }
      if (!live.route) {
        live.route = { kind: 'route', id: nid('r'), why: 'Auto', model: e.from, tries: [], open: true };
        S.items.push(live.route);
      }
      touch(live.route);
      if (e.retrySame) live.route.retrying = e.description;
      else {
        live.route.tries.push({ model: e.from, reason: e.description });
        live.route.open = true;
        live.route.retrying = null;
        live.lastModel = null;
      }
      break;
    }
    case 'wait':
      live.wait = { until: Date.now() + e.ms, model: e.model, reason: e.reason };
      break;
    case 'compact':
      S.items.push({ kind: 'notice', id: nid('n'), level: 'info', text: `${e.auto ? 'Auto-compacted' : 'Compacted'} the conversation: ${fmtTokens(e.beforeTokens)} → ${fmtTokens(e.afterTokens)} tokens` });
      break;
    case 'notice':
      S.items.push({ kind: 'notice', id: nid('n'), level: e.level, text: e.text });
      break;
    case 'todos':
      if (S.state) S.state.todos = e.todos;
      break;
    case 'subagent': {
      const inner = e.event;
      const task = [...S.items].reverse().find((i) => i.kind === 'tool' && i.name === 'Task' && i.status === 'running');
      if (task) {
        touch(task);
        if (inner.type === 'tool_start') {
          task.subCount = (task.subCount || 0) + 1;
          task.sub = inner.label;
        } else if (inner.type === 'model') task.sub = `using ${inner.key}`;
        else if (inner.type === 'failover') task.sub = `${inner.from}: ${inner.description}`;
      }
      break;
    }
    case 'turn_end':
      if (live.assistant) {
        touch(live.assistant);
        live.assistant.streaming = false;
      }
      live.assistant = null;
      live.wait = null;
      live.streamingTool = null;
      live.lastModel = null;
      if (e.reason === 'error' && e.error) S.items.push({ kind: 'notice', id: nid('n'), level: 'error', text: e.error });
      else if (e.reason === 'aborted') S.items.push({ kind: 'notice', id: nid('n'), level: 'warn', text: 'Interrupted. Tell FreeCode what to do instead.' });
      else if (e.reason === 'max_steps') S.items.push({ kind: 'notice', id: nid('n'), level: 'warn', text: 'Stopped after the maximum number of steps. Say "continue" to keep going.' });
      break;
  }
}

function handleMessage(msg, replay = false) {
  switch (msg.type) {
    case 'index':
      if (S.state) S.state.index = { ...msg.status, configuredRoots: S.state.index?.configuredRoots ?? [] };
      document.dispatchEvent(new CustomEvent('fc-index', { detail: msg.status }));
      break;
    case 'agent':
      handleAgentEvent(msg.event, replay);
      if (!replay) scheduleChat();
      break;
    case 'item':
      S.items.push(msg.item);
      if (msg.item.kind === 'user') {
        S.live.lastModel = null;
        S.live.turnStart = Date.now();
        S.live.outChars = 0;
      }
      if (!replay) scheduleChat(true);
      break;
    case 'pending':
      if (!S.pending.some((p) => p.id === msg.item.id)) S.pending.push(msg.item);
      renderPending();
      touchToolFor(msg.item);
      scrollChat(true);
      break;
    case 'update':
      S.update = msg.state;
      renderSidebarFooter();
      break;
    case 'pending_resolved': {
      const gone = S.pending.find((p) => p.id === msg.id);
      S.pending = S.pending.filter((p) => p.id !== msg.id);
      renderPending();
      if (gone) touchToolFor(gone);
      break;
    }
    case 'state': {
      const prevBusy = S.state?.busy;
      S.state = { ...S.state, ...msg.state };
      S.pending = msg.state.pending ?? S.pending;
      renderTopbar();
      renderComposer();
      renderPending();
      renderPanel();
      renderSidebarFooter();
      if (prevBusy !== S.state.busy) scheduleChat();
      break;
    }
    case 'transcript':
      S.items = msg.transcript;
      S.live.assistant = null;
      S.live.lastModel = null;
      renderChat(true);
      loadSessions();
      loadChanges();
      break;
    case 'turn_done':
      loadSessions();
      loadChanges();
      break;
    case 'changes':
      loadChanges();
      break;
    case 'reload':
      loadState();
      break;
  }
}

const debouncedChanges = debounce(loadChanges, 600);

function touchToolFor(p) {
  if (p?.kind !== 'permission' || !p.toolCallId) return;
  const t = findItem(p.toolCallId);
  if (t) {
    touch(t);
    scheduleChat();
  }
}

// ---------------------------------------------------------------- chat rendering

let chatScheduled = false;
let forceScroll = false;
function scheduleChat(scroll = false) {
  forceScroll = forceScroll || scroll;
  if (chatScheduled) return;
  chatScheduled = true;
  requestAnimationFrame(() => {
    chatScheduled = false;
    renderChat(forceScroll);
    forceScroll = false;
  });
}

function nearBottom() {
  const c = $('chat');
  return c.scrollHeight - c.scrollTop - c.clientHeight < 160;
}

function scrollChat(force = false) {
  const c = $('chat');
  if (force || nearBottom()) c.scrollTop = c.scrollHeight;
}

const TOOL_ICONS = { Read: 'fileText', Write: 'filePlus', Edit: 'pencil', MultiEdit: 'pencil', Update: 'pencil', NotebookEdit: 'pencil', Bash: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', TestRun: 'listChecks', Glob: 'folder', LS: 'folder', Grep: 'search', WebFetch: 'globe', WebSearch: 'search', TodoWrite: 'listChecks', Task: 'bot', AskUser: 'message', AskUserQuestion: 'message', Skill: 'sparkle', ExitPlanMode: 'map', Browser: 'eye', Desktop: 'eye', REPL: 'code', Debugger: 'zap', CodeSearch: 'search', LSP: 'code' };

function splitLabel(label) {
  const m = /^([\w:.-]+)\(([\s\S]*)\)$/.exec(label || '');
  if (m) return { name: m[1], arg: m[2] };
  return { name: label, arg: '' };
}

function diffLineCount(display) {
  return (display.hunks || []).reduce((n, hk) => n + hk.lines.length, 0);
}

/** opts.maxLines renders only the first lines (the rest is summarised in a last row). */
function diffTable(display, opts = {}) {
  const rows = [];
  const hunks = display.hunks || [];
  const lang = langFromPath(display.path);
  const max = opts.maxLines ?? Infinity;
  let shown = 0;
  for (const [i, hk] of hunks.entries()) {
    if (shown >= max) break;
    if (i > 0) rows.push(`<tr class="gap"><td colspan="4">⋯</td></tr>`);
    for (const l of hk.lines) {
      if (shown >= max) break;
      shown++;
      const cls = l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : '';
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
      const code = l.type === 'ctx' ? highlightLine(l.text, lang) : escapeHtml(l.text);
      rows.push(`<tr class="${cls}"><td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td><td class="sign">${sign}</td><td class="code">${code || ' '}</td></tr>`);
    }
  }
  const rest = diffLineCount(display) - shown;
  if (rest > 0) rows.push(`<tr class="more"><td colspan="4">${rest} more line${rest === 1 ? '' : 's'} not shown here</td></tr>`);
  const head = opts.noHead
    ? ''
    : `<div class="diff-file">${iconHtml(display.created ? 'filePlus' : 'pencil', 'svg-sm')}<span class="mono">${escapeHtml(display.path)}</span><span class="add">+${display.added}</span><span class="del">−${display.removed}</span></div>`;
  return `<div class="diff">${head}<div class="diff-scroll"><table>${rows.join('')}</table></div></div>`;
}

function todoList(todos) {
  return h(
    'div',
    { class: 'todos' },
    todos.map((t) => h('div', { class: `todo ${t.status}` }, h('span', { class: 'box' }, t.status === 'completed' ? icon('check', 'svg-sm') : ''), h('span', { class: 'txt' }, t.content))),
  );
}

function toolMeta(item) {
  const d = item.result?.display;
  const bits = [];
  const waiting = item.status === 'running' && S.pending.some((p) => p.kind === 'permission' && p.toolCallId === item.id);
  if (waiting) bits.push(h('span', { style: { color: 'var(--warn)' } }, 'waiting for your approval'));
  else if (item.status === 'running') bits.push(h('span', null, fmtDuration(Date.now() - (item.started || Date.now()))));
  if (d?.kind === 'diff') {
    bits.push(h('span', { class: 'add' }, `+${d.added}`), h('span', { class: 'del' }, `−${d.removed}`));
  } else if (d?.kind === 'summary') bits.push(h('span', null, d.text));
  else if (d?.kind === 'image') bits.push(h('span', null, d.summary || 'screenshot'));
  else if (d?.kind === 'todos') bits.push(h('span', null, `${d.todos.filter((t) => t.status === 'completed').length}/${d.todos.length} done`));
  else if (d?.kind === 'text' && item.status !== 'running') {
    const n = d.text.split('\n').filter((l) => l.trim()).length;
    bits.push(h('span', null, n ? `${n} line${n === 1 ? '' : 's'} of output` : 'no output'));
  }
  else if (item.status === 'error' && item.result) bits.push(h('span', { style: { color: 'var(--danger)' } }, 'failed'));
  else if (item.status === 'denied') bits.push(h('span', { style: { color: 'var(--warn)' } }, 'rejected'));
  if (item.durationMs && item.durationMs > 1500 && item.status !== 'running') bits.push(h('span', null, fmtDuration(item.durationMs)));
  return bits;
}

function defaultOpen(item) {
  const d = item.result?.display;
  if (item.status === 'error') return true;
  if (d?.kind === 'diff' && (d.added + d.removed) <= 60) return true;
  if (d?.kind === 'todos' || d?.kind === 'markdown' || d?.kind === 'image') return true;
  return false;
}

function toolBody(item) {
  const d = item.result?.display;
  const body = h('div', { class: 'tool-body' });
  if (!item.result) return body;
  if (item.status === 'error' || item.status === 'denied') {
    body.append(h('div', { class: 'term err' }, linkify(item.result.content.slice(0, 60000))));
    return body;
  }
  if (d?.kind === 'diff') body.innerHTML = diffTable(d);
  else if (d?.kind === 'image') {
    const src = `/api/shot/${encodeURIComponent(d.name)}?t=${encodeURIComponent(token)}`;
    const img = h('img', { class: 'shot', src, alt: 'Screenshot of the page', loading: 'lazy' });
    img.addEventListener('click', () => openShot(src));
    body.append(img);
    if (d.text) body.append(h('details', { class: 'shot-report' }, h('summary', null, 'Page report'), h('div', { class: 'term' }, d.text)));
  }
  else if (d?.kind === 'todos') body.append(todoList(d.todos));
  else if (d?.kind === 'markdown') body.append(h('div', { class: 'md', html: renderMarkdown(d.text) }));
  else if (item.name === 'Task') body.append(h('div', { class: 'md', html: renderMarkdown(item.result.content) }));
  else if (d?.kind === 'text') {
    const term = h('div', { class: 'term' });
    if (item.name === 'Bash') term.append(h('span', { class: 'prompt' }, '$ '), (item.input?.command ?? '') + '\n');
    term.append(d.text.length < 60000 ? linkify(d.text) : d.text);
    body.append(term);
  } else {
    let content = item.result.content || '';
    if (content.length > 12000) content = content.slice(0, 12000) + '\n…';
    body.append(h('div', { class: 'term' }, content));
  }
  return body;
}

function renderToolItem(item) {
  const { name, arg } = splitLabel(item.label);
  const isOpen = S.ui.open.has(item.id) || (defaultOpen(item) && !S.ui.closed.has(item.id));
  const waiting = item.status === 'running' && S.pending.some((p) => p.kind === 'permission' && p.toolCallId === item.id);
  const ico = waiting ? icon('hand', 'svg-sm') : item.status === 'running' ? icon('loader', 'svg-sm spin') : icon(TOOL_ICONS[name] || TOOL_ICONS[item.name] || (item.name?.startsWith('mcp__') ? 'plug' : 'zap'), 'svg-sm');
  const head = h('div', { class: 'tool-head' }, h('span', { class: 'ico' }, ico), h('span', { class: 't-name' }, name), h('span', { class: 't-arg', title: arg }, arg), h('span', { class: 't-meta' }, toolMeta(item)), item.result ? icon('chevronRight', 'svg-sm chev') : null);
  const el = h('div', { class: `tool ${item.status} ${isOpen ? 'open' : ''}`, 'data-id': item.id }, head);
  head.addEventListener('click', () => {
    if (!item.result) return;
    if (el.classList.contains('open')) {
      S.ui.open.delete(item.id);
      S.ui.closed.add(item.id);
    } else {
      S.ui.open.add(item.id);
      S.ui.closed.delete(item.id);
    }
    replaceItem(item);
  });
  if (item.sub && item.status === 'running') el.append(h('div', { class: 'tool-sub' }, icon('bot', 'svg-sm'), `${item.sub}${item.subCount ? ` · ${item.subCount} tool use${item.subCount === 1 ? '' : 's'}` : ''}`));
  if (item.progress && item.status === 'running') el.append(h('div', { class: 'tool-progress' }, item.progress));
  if (isOpen && item.result) el.append(toolBody(item));
  return el;
}

/**
 * The model's reasoning: open and streaming (newest lines visible) while it thinks, then folded to
 * "Thought for 12s" with a one-line preview. Your open/closed choice is remembered.
 */
function thinkingBlock(item) {
  const live = item.streaming && !item.text;
  const secs = item.thoughtMs && item.thoughtMs >= 1000 ? fmtDuration(item.thoughtMs) : null;
  const open = live ? !S.ui.closed.has(item.id) : S.ui.open.has(item.id);
  const text = tidy(live && item.reasoning.length > 6000 ? `…${item.reasoning.slice(-6000)}` : item.reasoning);
  const label = live ? h('span', { class: 'w-text' }, 'Thinking') : h('span', null, secs ? `Thought for ${secs}` : 'Thought');
  const preview = !live && !open ? h('span', { class: 't-preview' }, firstThought(tidy(item.reasoning))) : null;
  const timer = live && item.thinkingSince ? h('span', { class: 't-timer', 'data-since': String(item.thinkingSince) }, fmtDuration(Date.now() - item.thinkingSince)) : null;
  const body = h('div', { class: `t-body ${live ? 'live' : ''}` }, text);
  const det = h('details', { class: `thinking ${live ? 'live' : ''}`, ...(open ? { open: '' } : {}) }, h('summary', null, icon('sparkle', 'svg-sm'), label, timer, preview, icon('chevronDown', 'svg-sm chev')), body);
  det.addEventListener('toggle', () => {
    const set = live ? S.ui.closed : S.ui.open;
    if (det.open === live) set.delete(item.id);
    else set.add(item.id);
    if (!live) replaceItem(item);
  });
  if (live) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  return det;
}

/** First sentence of the reasoning, for the folded preview and the status line. */
function firstThought(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^(.{12,140}?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t.slice(0, 110);
  return s.length < t.length && !m ? `${s}…` : s;
}

/** The newest complete thought, for the status line while the model thinks. */
function latestThought(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = t.split(/(?<=[.!?])\s+/).filter((x) => x.length > 8);
  const last = sentences.length > 1 && !/[.!?]$/.test(t) ? sentences[sentences.length - 2] : sentences[sentences.length - 1] || t;
  return last.length > 110 ? `${last.slice(0, 107)}…` : last;
}

function renderRoute(item) {
  const tries = item.tries || [];
  const searching = item.open && !!S.state?.busy;
  const chip = h(
    'span',
    { class: 'chip', title: 'The router picked this model for the task and switches automatically when a model is rate limited or failing.' },
    h('span', { class: 'spark' }, '◆'),
    h('span', null, tries.length && item.why === 'Auto' ? 'Switched' : item.why),
    h('span', { class: 'faint' }, '→'),
    h('b', null, item.model),
    item.textTools ? h('span', { class: 'faint' }, '(text tools)') : null,
  );
  const row = h('div', { class: 'route-row' }, chip);
  if (item.retrying) row.append(h('span', { class: 'route-status' }, item.retrying));
  else if (item.open && searching) row.append(h('span', { class: 'route-status' }, 'trying the next model…'));
  const wrap = h('div', { class: 'route', 'data-id': item.id }, row);
  if (tries.length) {
    const open = S.ui.open.has(item.id);
    const toggle = h('button', { class: 'route-tries', type: 'button' }, `${item.open ? 'tried' : 'after'} ${tries.length} other model${tries.length === 1 ? '' : 's'}`, icon(open ? 'chevronDown' : 'chevronRight', 'svg-sm'));
    toggle.addEventListener('click', () => {
      if (S.ui.open.has(item.id)) S.ui.open.delete(item.id);
      else S.ui.open.add(item.id);
      replaceItem(item);
    });
    row.append(toggle);
    if (open) wrap.append(h('ul', { class: 'route-list' }, tries.map((t) => h('li', null, h('b', null, t.model), h('span', null, t.reason)))));
  }
  return wrap;
}

function highlightMentions(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  const re = /(^|\s)(@[^\s]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    frag.append(text.slice(last, start));
    frag.append(h('span', { class: 'mention' }, m[2]));
    last = start + m[2].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function renderItemEl(item) {
  switch (item.kind) {
    case 'user':
      return h(
        'div',
        { class: `msg-user ${item.queued ? 'queued' : ''}`, 'data-id': item.id },
        item.queued ? h('span', { class: 'q-tag' }, 'Sent while the agent was working') : null,
        highlightMentions(item.text),
        item.images ? h('div', { class: 'u-images' }, icon('image', 'svg-sm'), `${item.images} image${item.images === 1 ? '' : 's'} attached`) : null,
      );
    case 'assistant': {
      const wrap = h('div', { class: `msg-assistant ${item.discarded ? 'discarded' : ''}`, 'data-id': item.id });
      if (item.reasoning && S.state?.settings?.showReasoning !== false) wrap.append(thinkingBlock(item));
      if (item.text) wrap.append(h('div', { class: 'md', html: renderMarkdown(tidy(item.text)) }));
      if (item.text && !item.streaming && !item.discarded && item.final) {
        const copy = h('button', { class: 'msg-act', title: 'Copy this answer (Markdown)' }, icon('copy', 'svg-sm'), 'Copy');
        copy.addEventListener('click', () =>
          navigator.clipboard?.writeText(tidy(item.text)).then(() => {
            copy.lastChild.textContent = 'Copied';
            setTimeout(() => (copy.lastChild.textContent = 'Copy'), 1200);
          }),
        );
        const listen = h('button', { class: 'msg-act', title: 'Read this answer aloud' }, icon('volume', 'svg-sm'), 'Read aloud');
        listen.addEventListener('click', () => speak(listen, tidy(item.text)));
        wrap.append(h('div', { class: 'msg-actions' }, copy, listen));
      }
      if (item.discarded) wrap.append(h('div', { class: 'note warn' }, 'This partial answer was discarded because the model failed; another model continued.'));
      return wrap;
    }
    case 'tool':
      return renderToolItem(item);
    case 'route':
      return renderRoute(item);
    case 'notice':
      return h('div', { class: `note ${item.level}`, 'data-id': item.id }, icon(item.level === 'info' ? 'info' : 'alert', 'svg-sm'), h('span', null, item.text));
    case 'shell':
      return h('div', { 'data-id': item.id, style: { margin: '8px 0' } }, h('div', { class: 'term' }, h('span', { class: 'prompt' }, '$ '), item.command + '\n', item.output || '(no output)', item.exitCode ? `\n[exit code ${item.exitCode}]` : ''));
    default:
      return h('div', null);
  }
}

const elCache = new WeakMap();

function touch(item) {
  item._v = (item._v || 0) + 1;
}

function elFor(item) {
  const v = item._v || 0;
  const c = elCache.get(item);
  if (c && c.v === v) return c.el;
  const el = renderItemEl(item);
  elCache.set(item, { v, el });
  return el;
}

function replaceItem(item) {
  const old = elCache.get(item)?.el;
  touch(item);
  const el = elFor(item);
  if (old && old.isConnected) old.replaceWith(el);
}

function emptyState() {
  const st = S.state;
  const pool = st?.pool || { models: 0, providers: 0 };
  const ideas = [
    ['Explain this codebase', 'Give me an overview of how this project is structured'],
    ['Find and fix a bug', 'Run the tests and fix whatever is failing'],
    ['Build a feature', 'Add a dark mode toggle to the settings page'],
    ['Write tests', 'Write unit tests for the most important module'],
  ];
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'big-logo' }),
    h('h1', null, 'What should we build?'),
    h('p', null, pool.models ? `${pool.models} free models from ${pool.providers} provider${pool.providers === 1 ? '' : 's'} ready · working in ${st?.project?.name ?? ''}` : 'Add a free provider key to get started.'),
    pool.models
      ? h(
          'div',
          { class: 'suggestions' },
          ideas.map(([t, p]) => {
            const b = h('div', { class: 'suggestion' }, h('div', { class: 's1' }, t), h('div', { class: 's2' }, p));
            b.addEventListener('click', () => {
              const ta = $('composer-input');
              ta.value = p;
              autoGrow(ta);
              ta.focus();
            });
            return b;
          }),
        )
      : h('button', { class: 'btn btn-primary', onclick: () => openSettings(ctx, 'providers') }, icon('key'), 'Add free providers'),
  );
}

function workingIndicator() {
  const el = h('div', { class: 'working', id: 'working' });
  updateWorking(el);
  return el;
}

function updateWorking(el) {
  const live = S.live;
  clear(el);
  const waiting = S.pending.find((p) => p.kind === 'question' || p.kind === 'permission' || p.kind === 'plan');
  if (waiting) {
    el.append(h('span', { class: 'spark' }, '✋'), h('span', { class: 'w-text paused' }, waiting.kind === 'question' ? 'Waiting for your answer' : waiting.kind === 'plan' ? 'Waiting for you to review the plan' : 'Waiting for your approval'), h('span', { class: 'w-meta' }, 'Esc to stop'));
    return;
  }
  if (live.wait && live.wait.until > Date.now()) {
    el.append(h('span', { class: 'spark' }, '⏳'), h('span', { class: 'w-text' }, `Waiting ${Math.ceil((live.wait.until - Date.now()) / 1000)}s for ${live.wait.model}`), h('span', { class: 'w-meta' }, `${live.wait.reason} · Esc to stop`));
    return;
  }
  const a = live.assistant;
  let verb = 'Working…';
  if (live.streamingTool) verb = `Preparing ${live.streamingTool}…`;
  else if (a?.reasoning && !a.text) verb = 'Thinking…';
  else if (a?.text) verb = 'Writing…';
  const model = S.state?.model?.current;
  el.append(h('span', { class: 'spark' }, '✻'), h('span', { class: 'w-text' }, verb), h('span', { class: 'w-meta' }, `${fmtDuration(Date.now() - live.turnStart)} · ↓ ${fmtTokens(live.outChars / 3.5)} tokens${model ? ` · ${model}` : ''} · Esc to stop`));
  if (a?.reasoning && !a.text) el.append(h('div', { class: 'w-thought' }, latestThought(tidy(a.reasoning))));
}

function renderChat(scroll = false) {
  const inner = $('chat-inner');
  const wasNear = nearBottom();
  if (!S.items.length && !S.state?.busy) {
    clear(inner).append(emptyState());
    return;
  }
  // Copy goes under the final answer of each task only (not under "Let me check…" steps).
  S.items.forEach((it, i) => {
    if (it.kind !== 'assistant') return;
    const next = S.items[i + 1];
    const final = next ? next.kind === 'user' : !S.state?.busy;
    if (!!it.final !== final) {
      it.final = final;
      touch(it);
    }
  });
  // Long chats: render the latest part; older items render on demand (keeps the page light).
  const LIMIT = 150;
  let items = S.items;
  const hidden = S.ui.showAll ? 0 : Math.max(0, items.length - LIMIT);
  if (hidden) items = items.slice(hidden);
  const nodes = items.map(elFor);
  if (hidden) {
    const more = h('button', { class: 'show-earlier' }, `Show ${hidden} earlier item${hidden === 1 ? '' : 's'}`);
    more.addEventListener('click', () => {
      S.ui.showAll = true;
      renderChat();
    });
    nodes.unshift(more);
  }
  if (S.state?.busy) nodes.push(workingIndicator());
  inner.replaceChildren(...nodes);
  if (scroll || wasNear) scrollChat(true);
  updateJumpButton();
}

function updateJumpButton() {
  let btn = $('jump-latest');
  if (!btn) {
    btn = h('button', { id: 'jump-latest', class: 'jump-latest', title: 'Jump to the latest message' }, icon('arrowUp', 'svg-sm flip'), 'Latest');
    btn.addEventListener('click', () => {
      $('chat').scrollTo({ top: $('chat').scrollHeight, behavior: 'smooth' });
    });
    $('dock').append(btn);
  }
  btn.classList.toggle('show', !nearBottom() && S.items.length > 0);
}

let jumpQueued = false;
$('chat').addEventListener('scroll', () => {
  if (jumpQueued) return;
  jumpQueued = true;
  requestAnimationFrame(() => {
    jumpQueued = false;
    updateJumpButton();
  });
});

setInterval(() => {
  const w = $('working');
  if (w && S.state?.busy) updateWorking(w);
  for (const t of document.querySelectorAll('.t-timer[data-since]')) t.textContent = fmtDuration(Date.now() - Number(t.dataset.since));
  // refresh running tool timers
  if (S.state?.busy) for (const item of S.items) if (item.kind === 'tool' && item.status === 'running') replaceItem(item);
}, 500);

// copy buttons in code blocks + external links
document.addEventListener('click', (e) => {
  const copy = e.target.closest?.('[data-copy]');
  if (copy) {
    const code = copy.closest('.codeblock')?.querySelector('code')?.innerText ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      copy.lastChild.textContent = 'Copied';
      setTimeout(() => (copy.lastChild.textContent = 'Copy'), 1200);
    });
    return;
  }
  const runBtn = e.target.closest?.('[data-run]');
  if (runBtn) {
    const code = runBtn.closest('.codeblock')?.querySelector('code')?.innerText ?? '';
    const cmd = code.replace(/^\s*[$>]\s?/gm, '').trim();
    if (cmd && confirm(`Run this in ${S.state?.project?.name ?? 'the project'}?\n\n${cmd}`)) api.post('/api/prompt', { text: `!${cmd}` }).catch((err) => toast(err.message, 'err'));
    return;
  }
  const a = e.target.closest?.('a[data-ext], a[href^="http"]');
  if (a && /^https?:/.test(a.getAttribute('href') || '')) {
    e.preventDefault();
    openUrl(a.getAttribute('href'));
  }
});

// ---------------------------------------------------------------- pending approvals

function respond(id, payload) {
  S.pending = S.pending.filter((p) => p.id !== id);
  renderPending();
  api.post('/api/respond', { id, ...payload }).catch((e) => toast(e.message, 'err'));
  $('composer-input')?.focus();
}

function permissionCard(p) {
  const r = p.request;
  const danger = !!r.danger && /command|deletes|disk|shuts|fork|force|downloads|discards|filesystem/i.test(r.danger);
  const cls = danger ? 'perm-danger' : r.category === 'edit' ? 'perm-edit' : r.category === 'execute' ? 'perm-execute' : '';
  let title;
  let ico;
  if (r.category === 'execute') {
    // REPL, Debugger, LSP and Desktop explain themselves ("Run Python code", "Start the C# language server for this project").
    title = r.tool === 'Bash' || !r.title ? 'Run this command?' : `${r.title}?`;
    ico = r.tool === 'Desktop' ? 'eye' : r.tool === 'REPL' || r.tool === 'Debugger' || r.tool === 'LSP' ? 'code' : 'terminal';
  } else if (r.category === 'edit') {
    title = r.title === 'Create file' ? 'Create this file?' : 'Make this edit?';
    ico = 'pencil';
  } else if (r.category === 'network') {
    title = r.tool === 'WebSearch' ? 'Search the web?' : 'Fetch this web page?';
    ico = 'globe';
  } else if (r.category === 'mcp') {
    title = `Use ${r.title}?`;
    ico = 'plug';
  } else {
    title = r.title;
    ico = 'shield';
  }
  const body = h('div', { class: 'card-body' });
  if (r.command) {
    body.append(h('div', { class: 'cmd' }, h('span', { class: 'prompt' }, '$ '), r.command));
    if (r.description) body.append(h('div', { class: 'desc' }, r.description));
  } else if (r.preview?.kind === 'diff') {
    body.classList.add('diff-body');
    body.innerHTML = diffTable(r.preview, { maxLines: CARD_DIFF_LINES });
    const total = diffLineCount(r.preview);
    const review = h('button', { class: 'btn btn-sm btn-ghost diff-expand', title: 'Open the whole change in a large view' }, icon('maximize', 'svg-sm'), total > CARD_DIFF_LINES ? `Review all ${total} lines` : 'Expand');
    review.addEventListener('click', () => openDiffReview(p));
    body.querySelector('.diff-file')?.append(review);
  } else {
    body.append(h('div', { class: 'cmd' }, r.subject));
    if (r.description) body.append(h('div', { class: 'desc' }, r.description));
  }
  if (r.danger) body.append(h('div', { class: 'danger-line' }, icon('alert', 'svg-sm'), r.danger));
  const allow = h('button', { class: 'btn btn-primary' }, 'Allow');
  allow.addEventListener('click', () => respond(p.id, { decision: 'allow' }));
  const actions = h('div', { class: 'card-actions' }, allow);
  if (r.category === 'edit') {
    const all = h('button', { class: 'btn' }, 'Allow all edits this session');
    all.addEventListener('click', () => respond(p.id, { decision: 'all_edits' }));
    actions.append(all);
  } else if (r.ruleSuggestion && !r.danger) {
    const label = (r.ruleLabel ?? r.ruleSuggestion).replace(/`([^`]+)`/g, '$1');
    const always = h('button', { class: 'btn', title: r.ruleSuggestion }, `Always allow ${label}`);
    always.addEventListener('click', () => respond(p.id, { decision: 'always' }));
    actions.append(always);
  }
  const deny = h('button', { class: 'btn btn-danger' }, 'Deny');
  deny.addEventListener('click', () => respond(p.id, { decision: 'deny' }));
  actions.append(deny);
  const fb = h('input', { placeholder: 'Or tell FreeCode what to do instead…' });
  const sendFb = h('button', { class: 'btn btn-sm' }, 'Send');
  const doFb = () => fb.value.trim() && respond(p.id, { decision: 'deny', feedback: fb.value.trim() });
  sendFb.addEventListener('click', doFb);
  fb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doFb();
    }
    e.stopPropagation();
  });
  return h(
    'div',
    { class: `card ${cls}`, 'data-pending': p.id },
    h('div', { class: 'card-head' }, icon(ico), title, p.subagent ? h('span', { class: 'badge off' }, `requested by ${p.subagent}`) : null, h('span', { class: 'kbd-hint' }, h('kbd', null, 'Enter'), ' allow · ', h('kbd', null, 'Esc'), ' deny')),
    body,
    actions,
    h('div', { class: 'card-feedback' }, fb, sendFb),
  );
}

// file:line references in command output (stack traces, compiler errors) become clickable.
const TRACE_REFS = [
  /File "([^"]+)", line (\d+)/g, // Python
  /((?:[A-Za-z]:)?[\w@$.\\/-]+\.(?:cs|vb|fs|cpp|cc|cxx|c|h|hpp))\((\d+),\d+\)/g, // MSVC, dotnet
  /((?:[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@$.-]+(?:[\\/][\w@$.-]+)*\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g, // path:line[:col]
];

function linkify(text) {
  const frag = document.createDocumentFragment();
  const hits = [];
  for (const re of TRACE_REFS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && hits.length < 200) {
      if (/^(https?|wss?):/.test(text.slice(Math.max(0, m.index - 8), m.index + 8)) || !FILE_REF.test(`${m[1]}:${m[2]}`)) continue;
      if (hits.some((h0) => m.index < h0.end && m.index + m[0].length > h0.start)) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, path: m[1], line: m[2] });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let last = 0;
  for (const hit of hits) {
    frag.append(text.slice(last, hit.start));
    frag.append(h('span', { class: 'file-link', 'data-path': hit.path, 'data-line': hit.line, title: 'Open in editor' }, text.slice(hit.start, hit.end)));
    last = hit.end;
  }
  frag.append(text.slice(last));
  return frag;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest?.('.file-link');
  if (!el) return;
  e.preventDefault();
  const line = Number(el.dataset.line) || undefined;
  api.post('/api/launch/file', { path: el.dataset.path, line }).then((r) => !r.ok && toast(r.error || 'Could not open the file', 'err'), (err) => toast(err.message, 'err'));
});

/** Full-size screenshot over the app (click or Esc closes it). */
function openShot(src) {
  const overlay = $('overlay');
  clear(overlay);
  overlay.classList.remove('hidden');
  const close = () => {
    overlay.classList.add('hidden');
    clear(overlay);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.onclick = close;
  overlay.append(h('img', { class: 'shot-full', src, alt: 'Screenshot of the page' }));
}

// Lines of a proposed edit shown inside the approval card; "Review" opens the whole change.
const CARD_DIFF_LINES = 150;
let review = null;

function openDiffReview(p) {
  const r = p.request;
  const d = r.preview;
  const overlay = $('overlay');
  clear(overlay);
  overlay.classList.remove('hidden');
  const close = () => {
    review = null;
    overlay.classList.add('hidden');
    clear(overlay);
    document.removeEventListener('keydown', onKey, true);
  };
  // Capture phase: Esc closes this view and must not reach the global handler (which would deny).
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  const act = (decision) => {
    close();
    respond(p.id, { decision });
  };
  const allow = h('button', { class: 'btn btn-primary' }, 'Allow');
  allow.addEventListener('click', () => act('allow'));
  const all = h('button', { class: 'btn' }, 'Allow all edits this session');
  all.addEventListener('click', () => act('all_edits'));
  const deny = h('button', { class: 'btn btn-danger' }, 'Deny');
  deny.addEventListener('click', () => act('deny'));
  const x = h('button', { class: 'icon-btn', title: 'Close (Esc)' }, icon('x'));
  x.addEventListener('click', close);
  const body = h('div', { class: 'modal-body' });
  body.innerHTML = diffTable(d, { noHead: true });
  const modal = h(
    'div',
    { class: 'modal review', tabindex: '-1' },
    h('div', { class: 'modal-head' }, icon(d.created ? 'filePlus' : 'pencil'), h('div', { class: 'review-title' }, h('h2', null, d.created ? 'Create this file?' : 'Make this edit?'), h('div', { class: 'sub', title: d.path }, d.path)), h('span', { class: 'review-stats' }, h('span', { class: 'add' }, `+${d.added}`), h('span', { class: 'del' }, `−${d.removed}`)), x),
    body,
    h('div', { class: 'modal-foot' }, allow, all, deny, h('span', { class: 'kbd-hint' }, h('kbd', null, 'Esc'), ' close')),
  );
  overlay.append(modal);
  modal.focus({ preventScroll: true });
  review = { id: p.id, close };
}

function questionCard(p) {
  const questions = p.questions || [];
  const answers = questions.map(() => ({ selected: new Set(), other: '' }));
  const submit = h('button', { class: 'btn btn-primary' }, questions.length > 1 ? 'Submit answers' : 'Submit');
  const skip = h('button', { class: 'btn btn-ghost' }, 'Skip');
  const answered = (i) => answers[i].selected.size > 0 || answers[i].other.trim() !== '';
  const refresh = () => {
    submit.disabled = !questions.every((_, i) => answered(i));
  };
  const send = () => {
    if (submit.disabled) return;
    respond(p.id, { answers: answers.map((a) => ({ selected: [...a.selected], other: a.other.trim() || undefined })) });
  };
  const blocks = questions.map((q, i) => {
    const a = answers[i];
    const tiles = [];
    const other = h('input', { class: 'q-other-input', placeholder: q.options?.length ? 'Something else…' : 'Type your answer…', spellcheck: 'true' });
    const syncTiles = () => {
      for (const t of tiles) t.el.classList.toggle('sel', a.selected.has(t.label));
    };
    for (const [n, o] of (q.options || []).entries()) {
      const el = h(
        'button',
        { class: `q-opt ${q.multiSelect ? 'multi' : ''}`, type: 'button' },
        h('span', { class: 'q-mark' }, q.multiSelect ? icon('check', 'svg-sm') : h('span', { class: 'q-dot' })),
        h('span', { class: 'q-texts' }, h('span', { class: 'q-label' }, o.label), o.description ? h('span', { class: 'q-desc' }, tidy(o.description)) : null),
        h('kbd', { class: 'q-key' }, String(n + 1)),
      );
      el.addEventListener('click', () => {
        if (q.multiSelect) {
          if (a.selected.has(o.label)) a.selected.delete(o.label);
          else a.selected.add(o.label);
        } else {
          a.selected = new Set([o.label]);
          a.other = '';
          other.value = '';
        }
        syncTiles();
        refresh();
        // One single-choice question: a click is the answer.
        if (questions.length === 1 && !q.multiSelect) send();
      });
      tiles.push({ el, label: o.label });
    }
    other.addEventListener('input', () => {
      a.other = other.value;
      if (!q.multiSelect && other.value.trim()) {
        a.selected.clear();
        syncTiles();
      }
      refresh();
    });
    other.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') send();
    });
    return h(
      'div',
      { class: 'q-block' },
      h('div', { class: 'q-head' }, q.header ? h('span', { class: 'q-chip' }, q.header) : null, q.multiSelect ? h('span', { class: 'q-hint' }, 'Choose any') : null),
      h('div', { class: 'q-text md', html: renderMarkdown(tidy(q.question)) }),
      tiles.length ? h('div', { class: 'q-opts' }, tiles.map((t) => t.el)) : null,
      h('div', { class: 'q-other' }, other),
    );
  });
  // Number keys pick options of the first question.
  const card = h('div', { class: 'card question', 'data-pending': p.id, tabindex: '-1' }, h('div', { class: 'card-head' }, icon('message'), questions.length > 1 ? `FreeCode has ${questions.length} questions` : 'FreeCode has a question'), h('div', { class: 'card-body q-body' }, blocks), h('div', { class: 'card-actions' }, submit, skip));
  card.addEventListener('keydown', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && e.target.tagName !== 'INPUT') card.querySelectorAll('.q-block')[0]?.querySelectorAll('.q-opt')[n - 1]?.click();
  });
  submit.addEventListener('click', send);
  skip.addEventListener('click', () => respond(p.id, { answers: null }));
  refresh();
  setTimeout(() => card.focus({ preventScroll: true }), 0);
  return card;
}

function planCard(p) {
  const yes = h('button', { class: 'btn btn-primary' }, 'Yes, and auto-accept edits');
  yes.addEventListener('click', () => respond(p.id, { decision: 'acceptEdits' }));
  const manual = h('button', { class: 'btn' }, 'Yes, but ask before edits');
  manual.addEventListener('click', () => respond(p.id, { decision: 'default' }));
  const no = h('button', { class: 'btn btn-ghost' }, 'No, keep planning');
  no.addEventListener('click', () => respond(p.id, { decision: null }));
  return h('div', { class: 'card plan', 'data-pending': p.id }, h('div', { class: 'card-head' }, icon('map'), 'Ready to code? Here is the plan'), h('div', { class: 'card-body', style: { maxHeight: '42vh', overflow: 'auto' } }, h('div', { class: 'md', html: renderMarkdown(tidy(p.plan)) })), h('div', { class: 'card-actions' }, yes, manual, no));
}

function renderPending() {
  const box = $('pending');
  clear(box);
  for (const p of S.pending) {
    if (p.kind === 'permission') box.append(permissionCard(p));
    else if (p.kind === 'question') box.append(questionCard(p));
    else if (p.kind === 'plan') box.append(planCard(p));
  }
  // The request under review was answered or cancelled elsewhere.
  if (review && !S.pending.some((p) => p.id === review.id)) review.close();
}

// ---------------------------------------------------------------- composer

// How hard models that take an effort level think (Claude, GPT-5, gpt-oss). Others ignore it.
const EFFORTS = [
  { id: 'auto', label: 'Auto', short: 'Effort', desc: 'Each model uses its own default' },
  { id: 'low', label: 'Low', short: 'Low', desc: 'Faster and cheaper; good for simple tasks' },
  { id: 'medium', label: 'Medium', short: 'Medium', desc: 'Balanced' },
  { id: 'high', label: 'High', short: 'High', desc: 'More thinking for hard problems' },
  { id: 'max', label: 'Max', short: 'Max', desc: 'The most thinking; slowest and costs the most on paid models' },
];

const MODES = [
  { id: 'default', label: 'Ask before edits', desc: 'Approve every edit and command', icon: 'hand' },
  { id: 'acceptEdits', label: 'Edit automatically', desc: 'Edits are applied, commands still ask', icon: 'pencil' },
  { id: 'plan', label: 'Plan mode', desc: 'Research and plan first, no changes', icon: 'map' },
  { id: 'bypassPermissions', label: 'Bypass permissions', desc: 'Run everything without asking (careful!)', icon: 'zap' },
];

let menu = null; // { el, items, sel, onPick, kind }

function closeMenu() {
  if (menu) menu.el.remove();
  menu = null;
}

function showMenu(anchor, items, onPick, opts = {}) {
  closeMenu();
  const el = h('div', { class: 'menu' });
  const root = $('popover-root');
  root.append(el);
  menu = { el, items, sel: opts.sel ?? 0, onPick, kind: opts.kind, search: opts.search };
  const draw = () => {
    clear(el);
    if (opts.title) el.append(h('div', { class: 'menu-title' }, opts.title));
    if (opts.searchable) {
      const s = h('input', { class: 'menu-search', placeholder: 'Search models…', value: menu.query || '' });
      s.addEventListener('input', () => {
        menu.query = s.value;
        menu.sel = 0;
        draw();
        el.querySelector('.menu-search')?.focus();
      });
      s.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') menuKey(e);
        e.stopPropagation();
      });
      el.append(s);
    }
    const q = (menu.query || '').toLowerCase();
    menu.visible = items.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q));
    menu.visible.forEach((it, idx) => {
      if (it.sep) {
        el.append(h('div', { class: 'menu-sep' }));
        return;
      }
      const row = h('div', { class: `menu-item ${idx === menu.sel ? 'sel' : ''}` }, it.icon ? (typeof it.icon === 'string' ? icon(it.icon) : it.icon) : null, h('div', { class: 'mi-main' }, h('div', { class: 'mi-label' }, it.label), it.desc ? h('div', { class: 'mi-desc' }, it.desc) : null), it.right ? h('span', { class: 'mi-right' }, it.right) : null, it.checked ? icon('check', 'check') : null);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pick = menu.onPick;
        closeMenu();
        pick(it);
      });
      el.append(row);
    });
    if (!menu.visible.length) el.append(h('div', { class: 'menu-title' }, 'No matches'));
    position();
  };
  const position = () => {
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
    const below = opts.below;
    if (below) el.style.top = `${r.bottom + 6}px`;
    else el.style.top = `${Math.max(8, r.top - el.offsetHeight - 6)}px`;
  };
  menu.draw = draw;
  draw();
  if (opts.searchable) el.querySelector('.menu-search')?.focus();
}

function menuKey(e) {
  if (!menu) return false;
  const vis = menu.visible.filter((x) => !x.sep);
  if (e.key === 'ArrowDown') {
    menu.sel = (menu.sel + 1) % Math.max(1, menu.visible.length);
    menu.draw();
  } else if (e.key === 'ArrowUp') {
    menu.sel = (menu.sel - 1 + menu.visible.length) % Math.max(1, menu.visible.length);
    menu.draw();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    const it = menu.visible[menu.sel];
    const pick = menu.onPick;
    closeMenu();
    if (it) pick(it);
  } else if (e.key === 'Escape') closeMenu();
  else return false;
  e.preventDefault();
  void vis;
  return true;
}

document.addEventListener('mousedown', (e) => {
  if (menu && !menu.el.contains(e.target)) closeMenu();
});

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(300, ta.scrollHeight)}px`;
}

// Pasted or dropped images waiting to be sent with the next message.
S.images = [];

/** Reads an image file, shrinking very large ones (they cost tokens and upload time). */
function addImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Only PNG, JPEG, GIF and WebP images can be attached', 'err');
  if (S.images.length >= 4) return toast('Up to 4 images per message', 'err');
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let src = reader.result;
      const max = 2000;
      if ((img.width > max || img.height > max || file.size > 4_000_000) && file.type !== 'image/gif') {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        src = c.toDataURL('image/jpeg', 0.9);
      }
      const m = /^data:([^;]+);base64,(.*)$/.exec(src);
      if (!m) return;
      S.images.push({ mediaType: m[1], data: m[2], src });
      renderImageStrip();
      updateSendBtn();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function renderImageStrip() {
  const strip = $('composer-images');
  if (!strip) return;
  clear(strip);
  S.images.forEach((im, i) => {
    const x = h('button', { title: 'Remove image', type: 'button' }, icon('x', 'svg-sm'));
    x.addEventListener('click', () => {
      S.images.splice(i, 1);
      renderImageStrip();
      updateSendBtn();
    });
    strip.append(h('div', { class: 'c-img' }, h('img', { src: im.src, alt: 'Attached image' }), x));
  });
}

// ------------------------------------------------------------ voice: speak a request, hear an answer

let recorder = null;

function insertAtCursor(ta, text) {
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const insert = (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '');
  ta.value = before + insert + after;
  ta.selectionStart = ta.selectionEnd = pos + insert.length;
  autoGrow(ta);
  updateSendBtn();
  ta.focus();
}

/** Click to record, click again to stop; the speech is transcribed (Groq Whisper) into the composer. */
async function toggleVoice(btn) {
  if (recorder) {
    recorder.stop();
    return;
  }
  const voice = await api.get('/api/voice').catch(() => ({ available: false }));
  if (!voice.available) return toast('Voice input needs a free Groq API key: Settings, Providers, Groq.', 'err');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('Microphone access was blocked.', 'err');
  }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn.classList.remove('recording');
    btn.title = 'Speak your request';
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    if (blob.size < 1500) return;
    btn.classList.add('busy');
    const data = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.readAsDataURL(blob);
    });
    const r = await api.post('/api/transcribe', { audio: data, mediaType: blob.type }).catch((e) => ({ ok: false, error: e.message }));
    btn.classList.remove('busy');
    if (!r.ok) return toast(r.error || 'Could not transcribe the recording', 'err');
    if (r.text) insertAtCursor($('composer-input'), r.text);
  };
  recorder = mr;
  mr.start();
  btn.classList.add('recording');
  btn.title = 'Stop recording';
  setTimeout(() => recorder === mr && mr.stop(), 120_000);
}

/** Reads an answer aloud with the system voices (code blocks are skipped). */
function speak(btn, markdown) {
  if (!window.speechSynthesis) return toast('Speech is not available here', 'err');
  const wasMe = btn.classList.contains('speaking');
  speechSynthesis.cancel();
  document.querySelectorAll('.msg-act.speaking').forEach((b) => b.classList.remove('speaking'));
  if (wasMe) return;
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_>|]/g, ' ');
  const u = new SpeechSynthesisUtterance(plain);
  u.onend = u.onerror = () => btn.classList.remove('speaking');
  btn.classList.add('speaking');
  speechSynthesis.speak(u);
}

async function send(text) {
  const t = text.trim();
  const images = S.images.map(({ mediaType, data }) => ({ mediaType, data }));
  if (!t && !images.length) return;
  if (images.length) {
    S.images = [];
    renderImageStrip();
  }
  if (t) S.history.push(t);
  S.historyIdx = -1;
  if (t === '/help' || t === '?') {
    showHelp();
    return;
  }
  if (t === '/setup' || t === '/settings') {
    openSettings(ctx, 'providers');
    return;
  }
  try {
    const r = await api.post('/api/prompt', images.length ? { text: t, images } : { text: t });
    if (!r.ok && r.error) toast(r.error, 'err');
    if (r.action === 'setup' || r.action === 'settings') openSettings(ctx, 'providers');
    if (r.action === 'help') showHelp();
    if (r.queued) toast('Queued: FreeCode will read it at its next step', 'info');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function showHelp() {
  S.items.push({
    kind: 'assistant',
    id: nid('help'),
    text: [
      '### FreeCode tips',
      '- **Enter** sends, **Shift+Enter** adds a new line. Type while the agent works to queue a message.',
      '- **@file** attaches a file, **/command** runs a command, **!cmd** runs a shell command, **#note** saves a note to AGENTS.md.',
      '- **Shift+Tab** cycles modes: ask before edits → edit automatically → plan mode.',
      '- **Esc** stops the agent. **Ctrl/Cmd+K** starts a new task. **Ctrl/Cmd+,** opens settings.',
      '- The model picker shows every free model; **Auto** lets the router choose and switch automatically.',
      '',
      '**Commands:** ' + (S.state?.commands || []).map((c) => `\`/${c.name}\``).join(' '),
    ].join('\n'),
  });
  renderChat(true);
}

function renderComposer() {
  const wrap = $('composer-wrap');
  const st = S.state;
  if (!st) return;
  let ta = $('composer-input');
  const mode = st.mode || 'default';
  if (!ta) {
    ta = h('textarea', { id: 'composer-input', rows: 1, placeholder: 'Ask FreeCode to build, fix or explain anything…', spellcheck: 'false' });
    ta.addEventListener('input', () => {
      autoGrow(ta);
      updateComposerMenus(ta);
      updateSendBtn();
    });
    ta.addEventListener('keydown', (e) => composerKey(e, ta));
    ta.addEventListener('blur', () => setTimeout(() => menu?.kind === 'inline' && closeMenu(), 150));
    // Paste or drop a screenshot or design to attach it.
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      files.forEach(addImage);
    });
    const box = h('div', { class: 'composer', id: 'composer' }, h('div', { class: 'composer-images', id: 'composer-images' }), ta, h('div', { class: 'composer-bar', id: 'composer-bar' }));
    box.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file')) return;
      e.preventDefault();
      box.classList.add('dragging');
    });
    box.addEventListener('dragleave', () => box.classList.remove('dragging'));
    box.addEventListener('drop', (e) => {
      box.classList.remove('dragging');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      files.forEach(addImage);
    });
    clear(wrap).append(h('div', { class: 'queued-list', id: 'queued' }), box, h('div', { class: 'composer-hint' }, 'Enter to send · Shift+Enter new line · @ files · / commands · ! shell'));
  }
  $('composer').className = `composer mode-${mode}`;
  // queued messages
  const q = $('queued');
  clear(q);
  for (const m of st.queued || []) q.append(h('div', { class: 'queued-chip' }, `Queued: ${m}`));
  // toolbar
  const bar = $('composer-bar');
  clear(bar);
  const attach = h('button', { class: 'icon-btn', title: 'Attach a file (@)' }, icon('at'));
  attach.addEventListener('click', () => {
    const t = $('composer-input');
    const pos = t.selectionStart;
    const before = t.value.slice(0, pos);
    const insert = (before && !/\s$/.test(before) ? ' ' : '') + '@';
    t.value = before + insert + t.value.slice(pos);
    t.selectionStart = t.selectionEnd = pos + insert.length;
    t.focus();
    updateComposerMenus(t);
  });
  const modeInfo = MODES.find((m) => m.id === mode) || MODES[0];
  const modeBtn = h('button', { class: `pill mode-${mode}`, title: 'Permission mode (Shift+Tab)' }, icon(modeInfo.icon, 'svg-sm'), h('span', { class: 'pill-label' }, modeInfo.label), icon('chevronDown', 'svg-sm'));
  modeBtn.addEventListener('click', () =>
    showMenu(
      modeBtn,
      MODES.map((m) => ({ label: m.label, desc: m.desc, icon: m.icon, id: m.id, checked: m.id === mode })),
      (it) => api.post('/api/mode', { mode: it.id }).catch((e) => toast(e.message, 'err')),
      { title: 'Permission mode' },
    ),
  );
  const pinned = st.model?.pinned;
  // The provider is in the tooltip; the pill shows the model.
  const modelBtn = h('button', { class: 'pill', title: pinned ? `Model: ${pinned}` : 'Model' }, h('span', { class: 'dot' }), h('span', { class: 'pill-label' }, pinned ? pinned.slice(pinned.indexOf('/') + 1) : 'Auto'), icon('chevronDown', 'svg-sm'));
  modelBtn.addEventListener('click', async () => {
    let models = [];
    try {
      models = await api.get('/api/models');
    } catch {
      models = [];
    }
    const items = [
      { label: 'Auto (recommended)', desc: 'Router AI picks the best free model and switches on limits', key: 'auto', icon: 'sparkle', checked: !pinned },
      { sep: true, label: '' },
      ...models.map((m) => ({
        label: m.key,
        desc: `${m.providerName} · ${fmtTokens(m.context)} ctx${m.status !== 'ready' ? ` · ${m.status}` : ''}`,
        key: m.key,
        icon: h('span', { class: `tier tier-${m.tier}` }, m.tier),
        right: h('span', { class: `status-dot ${m.status}` }),
        checked: pinned === m.key,
      })),
    ];
    showMenu(modelBtn, items, (it) => api.post('/api/model', { model: it.key }).catch((e) => toast(e.message, 'err')), { title: 'Model', searchable: true });
  });
  const effort = EFFORTS.find((e) => e.id === (st.effort?.level ?? 'auto')) ?? EFFORTS[0];
  const effortTip = st.effort?.supported ? 'Thinking effort' : 'Thinking effort (applies to models that support it: Claude, GPT-5, gpt-oss)';
  const effortBtn = h('button', { class: `pill effort-pill${st.effort?.supported ? '' : ' unsupported'}`, title: effortTip }, icon('zap', 'svg-sm'), h('span', { class: 'pill-label' }, effort.short), icon('chevronDown', 'svg-sm'));
  effortBtn.addEventListener('click', () =>
    showMenu(
      effortBtn,
      EFFORTS.map((e) => ({ label: e.label, desc: e.desc, id: e.id, checked: e.id === effort.id })),
      (it) => api.post('/api/command', { name: 'effort', args: it.id }).catch((e) => toast(e.message, 'err')),
      { title: 'Thinking effort' },
    ),
  );
  const sendBtn = h('button', { class: 'send-btn', id: 'send-btn' });
  sendBtn.addEventListener('click', () => {
    const t = $('composer-input');
    if (S.state?.busy && !t.value.trim()) {
      api.post('/api/stop');
      return;
    }
    const text = t.value;
    t.value = '';
    autoGrow(t);
    closeMenu();
    send(text);
    updateSendBtn();
  });
  const mic = h('button', { class: `icon-btn mic-btn ${recorder ? 'recording' : ''}`, title: 'Speak your request' }, icon('mic'));
  mic.addEventListener('click', () => toggleVoice(mic));
  bar.append(attach, mic, modeBtn, modelBtn, effortBtn, h('span', { class: 'grow' }), sendBtn);
  updateSendBtn();
}

function updateSendBtn() {
  const b = $('send-btn');
  const t = $('composer-input');
  if (!b || !t) return;
  const busy = S.state?.busy;
  clear(b);
  if (busy && !t.value.trim()) {
    b.className = 'send-btn stop';
    b.title = 'Stop (Esc)';
    b.disabled = false;
    b.append(icon('stop', 'svg-sm'));
  } else {
    b.className = 'send-btn';
    b.title = busy ? 'Queue message' : 'Send (Enter)';
    b.disabled = !t.value.trim() && !S.images.length;
    b.append(icon('arrowUp'));
  }
}

const fetchFiles = debounce(async (q, ta, from, to) => {
  try {
    const files = await api.get(`/api/files?q=${encodeURIComponent(q)}`);
    if (!files.length) return closeMenu();
    showMenu(
      ta,
      files.map((f) => ({ label: f.path, icon: f.dir ? 'folder' : 'file', insert: `@${f.path}${f.dir ? '' : ' '}` })),
      (it) => {
        ta.value = ta.value.slice(0, from) + it.insert + ta.value.slice(to);
        const pos = from + it.insert.length;
        ta.selectionStart = ta.selectionEnd = pos;
        ta.focus();
        autoGrow(ta);
        updateSendBtn();
        if (it.insert.endsWith('/')) updateComposerMenus(ta);
      },
      { kind: 'inline', title: 'Attach file' },
    );
  } catch {
    closeMenu();
  }
}, 120);

function updateComposerMenus(ta) {
  const v = ta.value;
  const pos = ta.selectionStart;
  const before = v.slice(0, pos);
  if (/^\/[\w:-]*$/.test(before)) {
    const q = before.slice(1).toLowerCase();
    const cmds = (S.state?.commands || []).filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)));
    if (!cmds.length) return closeMenu();
    showMenu(
      ta,
      cmds.map((c) => ({ label: `/${c.name}${c.args ? ' ' + c.args : ''}`, desc: c.description, name: c.name, args: c.args, icon: c.custom ? 'fileText' : 'slash' })),
      (it) => {
        if (it.args) {
          ta.value = `/${it.name} `;
          ta.focus();
          autoGrow(ta);
          updateSendBtn();
        } else {
          ta.value = '';
          autoGrow(ta);
          send(`/${it.name}`);
          updateSendBtn();
        }
      },
      { kind: 'inline', title: 'Commands' },
    );
    return;
  }
  const at = /(^|\s)@([^\s]*)$/.exec(before);
  if (at) {
    fetchFiles(at[2], ta, pos - at[2].length - 1, pos);
    return;
  }
  if (menu?.kind === 'inline') closeMenu();
}

function cycleMode() {
  const order = ['default', 'acceptEdits', 'plan'];
  const cur = S.state?.mode || 'default';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  api.post('/api/mode', { mode: next });
}

function composerKey(e, ta) {
  if (menu && menu.kind === 'inline' && menuKey(e)) return;
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    cycleMode();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = ta.value;
    if (!text.trim()) return;
    ta.value = '';
    autoGrow(ta);
    closeMenu();
    send(text);
    updateSendBtn();
    return;
  }
  if (e.key === 'Escape') {
    if (menu) {
      closeMenu();
      return;
    }
    if (S.state?.busy) {
      api.post('/api/stop');
      toast('Stopping…', 'info');
    }
    return;
  }
  if (e.key === 'ArrowUp' && !ta.value.includes('\n') && ta.selectionStart === 0 && S.history.length) {
    e.preventDefault();
    S.historyIdx = S.historyIdx < 0 ? S.history.length - 1 : Math.max(0, S.historyIdx - 1);
    ta.value = S.history[S.historyIdx];
    autoGrow(ta);
    updateSendBtn();
    return;
  }
  if (e.key === 'ArrowDown' && S.historyIdx >= 0 && !ta.value.includes('\n')) {
    e.preventDefault();
    S.historyIdx++;
    ta.value = S.historyIdx < S.history.length ? S.history[S.historyIdx] : '';
    if (S.historyIdx >= S.history.length) S.historyIdx = -1;
    autoGrow(ta);
    updateSendBtn();
  }
}

// ---------------------------------------------------------------- sidebar / topbar / panel

function renderSidebar() {
  const sb = $('sidebar');
  const st = S.state;
  if (!st) return;
  clear(sb);
  const themeBtn = h('button', { class: 'icon-btn', title: 'Toggle theme' }, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
  themeBtn.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  const hide = h('button', { class: 'icon-btn', title: 'Hide sidebar (Ctrl+B)' }, icon('panelLeft'));
  hide.addEventListener('click', () => toggleSidebar());
  sb.append(h('div', { class: 'brand' }, h('div', { class: 'logo' }), h('span', { class: 'name' }, 'FreeCode'), h('span', { class: 'tag' }, 'free'), h('span', { class: 'spacer' }), themeBtn, hide));
  const newBtn = h('button', { class: 'btn new-task' }, icon('plus'), 'New task', h('span', { class: 'grow' }), h('kbd', null, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'));
  newBtn.addEventListener('click', newTask);
  sb.append(newBtn);
  const proj = h('button', { class: 'project-btn', title: 'Open another project folder' }, icon('folder'), h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'p-name' }, st.project.name), h('div', { class: 'p-path' }, st.project.root.replace(st.home, '~'))), icon('chevronDown', 'svg-sm'));
  proj.addEventListener('click', () => openFolderPicker(ctx));
  sb.append(proj);
  const list = h('nav', { class: 'sessions' });
  const groups = new Map();
  for (const s of S.sessions) {
    const g = dayGroup(s.updatedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  if (!S.sessions.length) list.append(h('div', { class: 'sess-empty' }, 'Your tasks in this project will appear here.'));
  for (const [g, items] of groups) {
    list.append(h('div', { class: 'sess-group' }, g));
    for (const s of items) {
      const b = h('button', { class: `sess ${s.id === st.session.id ? 'active' : ''}`, title: `${s.title}\n${timeAgo(s.updatedAt)}` }, s.title || 'Untitled');
      b.addEventListener('click', async () => {
        if (s.id === st.session.id) return;
        const r = await api.post('/api/sessions/resume', { id: s.id }).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) toast(r.error || 'Could not open that task', 'err');
      });
      list.append(b);
    }
  }
  sb.append(list, h('div', { class: 'sidebar-footer', id: 'sidebar-footer' }));
  renderSidebarFooter();
}

function renderSidebarFooter() {
  const f = $('sidebar-footer');
  const st = S.state;
  if (!f || !st) return;
  clear(f);
  const pool = st.pool || { models: 0, providers: 0 };
  const card = h('div', { class: 'pool-card', title: 'Your free model pool' }, h('span', { class: `dot ${pool.models ? '' : 'off'}` }), h('div', { style: { minWidth: 0 } }, h('div', { class: 't1' }, pool.models ? `${pool.models} free models` : 'No models yet'), h('div', { class: 't2' }, pool.models ? `${pool.providers} provider${pool.providers === 1 ? '' : 's'} · auto-switching` : 'Add a free provider key')));
  card.addEventListener('click', () => openSettings(ctx, pool.models ? 'models' : 'providers'));
  const settings = h('button', { class: 'side-link' }, icon('settings'), 'Settings', h('span', { class: 'grow' }), h('kbd', null, navigator.platform.includes('Mac') ? '⌘,' : 'Ctrl ,'));
  settings.addEventListener('click', () => openSettings(ctx, 'providers'));
  const keys = h('button', { class: 'side-link' }, icon('key'), 'Providers & keys');
  keys.addEventListener('click', () => openSettings(ctx, 'providers'));
  const upd = updateCard();
  f.append(...(upd ? [upd] : []), card, keys, settings);
}

/** Shows new versions from GitHub: progress while downloading, then "Restart to update". */
function updateCard() {
  const u = S.update;
  if (!u || !u.latest || !['available', 'downloading', 'ready', 'installing'].includes(u.status)) return null;
  const v = u.latest.version;
  const notes = h('a', { href: u.latest.url, 'data-ext': '1', class: 'upd-link' }, "What's new");
  if (u.status === 'installing') return h('div', { class: 'upd-card' }, h('div', { class: 't1' }, `Updating to ${v}…`), h('div', { class: 't2' }, 'FreeCode reopens in a moment.'));
  if (u.status === 'downloading') {
    const pct = Math.round((u.progress || 0) * 100);
    return h('div', { class: 'upd-card' }, h('div', { class: 't1' }, `Downloading FreeCode ${v}`), h('div', { class: 'upd-bar' }, h('i', { style: { width: `${pct}%` } })), h('div', { class: 't2' }, `${pct}%`));
  }
  if (u.status === 'ready') {
    const btn = h('button', { class: 'btn btn-primary btn-sm' }, icon('refresh', 'svg-sm'), 'Restart to update');
    btn.addEventListener('click', async () => {
      if (S.state?.busy) return toast('Stop the current task first, then update.', 'err');
      btn.disabled = true;
      const r = await api.post('/api/update/install').catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) {
        btn.disabled = false;
        return toast(r.error || 'Could not start the update', 'err');
      }
      S.update = { ...u, status: 'installing' };
      renderSidebarFooter();
    });
    return h('div', { class: 'upd-card ready' }, h('div', { class: 't1' }, icon('download', 'svg-sm'), `FreeCode ${v} is ready`), h('div', { class: 't2' }, 'Installs in a few seconds, or next time you open FreeCode. ', notes), btn);
  }
  // available
  if (u.method === 'installer') {
    const btn = h('button', { class: 'btn btn-sm' }, icon('download', 'svg-sm'), 'Download');
    btn.addEventListener('click', () => api.post('/api/update/download').then((r) => !r.ok && toast(r.error, 'err')));
    return h('div', { class: 'upd-card' }, h('div', { class: 't1' }, `FreeCode ${v} is available`), h('div', { class: 't2' }, notes), btn);
  }
  return h('div', { class: 'upd-card' }, h('div', { class: 't1' }, `FreeCode ${v} is available`), h('div', { class: 't2' }, u.command ? h('code', null, u.command) : notes));
}

// ---------------------------------------------------------------- Run / Open in

async function loadLaunch() {
  try {
    S.launch = await api.get('/api/launch');
  } catch {
    S.launch = null;
  }
  renderTopbar();
}

async function runProject(command, save) {
  try {
    const r = await api.post('/api/launch/run', command ? { command, save: !!save } : {});
    if (r.error === 'no-command') return editRunCommand();
    if (!r.ok) toast(r.error || 'Could not start the project', 'err');
    else toast(`Started in a terminal window: ${r.command}`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function editRunCommand() {
  const current = S.launch?.run?.command || '';
  const cmd = prompt('How should this project be started?\nIt runs in a terminal window in the project folder (e.g. npm run dev, dotnet run, python main.py).', current);
  if (!cmd || !cmd.trim()) return;
  await runProject(cmd.trim(), true);
  loadLaunch();
}

const OPEN_ICONS = { editor: 'code', agent: 'sparkle', files: 'folder', terminal: 'terminal' };

function renderTopbar() {
  const tb = $('topbar');
  const st = S.state;
  if (!st) return;
  clear(tb);
  if (!S.ui.sidebarOpen) {
    const show = h('button', { class: 'icon-btn', title: 'Show sidebar (Ctrl+B)' }, icon('panelLeft'));
    show.addEventListener('click', toggleSidebar);
    tb.append(show);
  }
  const title = st.session.title && st.session.title !== 'New task' ? st.session.title : 'New task';
  tb.append(h('div', { class: 'crumb' }, icon('folder', 'svg-sm'), st.project.name, h('span', { class: 'sep' }, '/')), h('div', { class: 'title' }, title), h('span', { class: 'grow' }));
  const launch = S.launch;
  const runBtn = h('button', { class: 'tb-btn', title: launch?.run ? `Run: ${launch.run.command}` : 'Run this project' }, icon('play', 'svg-sm'), 'Run');
  runBtn.addEventListener('click', () => runProject());
  const runMore = h('button', { class: 'tb-btn tb-caret', title: 'Run options' }, icon('chevronDown', 'svg-sm'));
  runMore.addEventListener('click', () =>
    showMenu(
      runMore,
      [...(launch?.run ? [{ id: 'run', label: 'Run', desc: launch.run.command, icon: 'play' }] : []), { id: 'edit', label: 'Change run command…', icon: 'pencil' }],
      (it) => (it.id === 'run' ? runProject() : editRunCommand()),
      { below: true },
    ),
  );
  const openBtn = h('button', { class: 'tb-btn', title: 'Open this project in another app' }, icon('code', 'svg-sm'), 'Open', icon('chevronDown', 'svg-sm'));
  openBtn.addEventListener('click', () =>
    showMenu(
      openBtn,
      (launch?.targets ?? []).map((t) => ({ id: t.id, label: t.name, icon: OPEN_ICONS[t.kind] || 'external' })),
      async (it) => {
        const r = await api.post('/api/launch/open', { target: it.id }).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) toast(r.error || 'Could not open', 'err');
      },
      { below: true, title: 'Open project in' },
    ),
  );
  tb.append(h('div', { class: 'tb-group' }, runBtn, runMore), openBtn);
  const c = st.context || { tokens: 0, budget: 1 };
  const pct = Math.min(100, Math.round((c.tokens / Math.max(1, c.budget)) * 100));
  tb.append(h('div', { class: `ctx-meter ${pct > 75 ? 'high' : ''}`, title: `Context: ~${fmtTokens(c.tokens)} of ${fmtTokens(c.budget)} tokens. Older messages are summarized automatically above the budget.` }, h('span', { class: 'bar' }, h('i', { style: { width: `${pct}%` } })), `${pct}%`));
  const panelBtn = h('button', { class: `icon-btn ${S.ui.panelOpen ? 'active' : ''}`, title: 'Changes & tasks panel' }, icon('panelRight'));
  panelBtn.addEventListener('click', () => {
    S.ui.panelOpen = !S.ui.panelOpen;
    if (!narrowWindow.matches) localStorage.setItem('fc-panel-open', S.ui.panelOpen ? '1' : '0');
    renderPanel();
    renderTopbar();
  });
  tb.append(panelBtn);
}

function renderPanel() {
  const panel = $('panel');
  const st = S.state;
  if (!st) return;
  panel.classList.toggle('closed', !S.ui.panelOpen);
  if (!S.ui.panelOpen) return;
  clear(panel);
  const todos = st.todos || [];
  const tabs = [
    ['changes', 'Changes', S.changes.length],
    ['tasks', 'Tasks', todos.length ? `${todos.filter((t) => t.status === 'completed').length}/${todos.length}` : 0],
    ['usage', 'Usage', 0],
  ];
  const tabBar = h('div', { class: 'panel-tabs' });
  for (const [id, label, count] of tabs) {
    const b = h('button', { class: `panel-tab ${S.ui.panel === id ? 'active' : ''}` }, label, count ? h('span', { class: 'count' }, String(count)) : null);
    b.addEventListener('click', () => {
      S.ui.panel = id;
      localStorage.setItem('fc-panel', id);
      renderPanel();
    });
    tabBar.append(b);
  }
  const close = h('button', { class: 'icon-btn', style: { marginLeft: 'auto' }, title: 'Close panel' }, icon('x'));
  close.addEventListener('click', () => {
    S.ui.panelOpen = false;
    if (!narrowWindow.matches) localStorage.setItem('fc-panel-open', '0');
    renderPanel();
    renderTopbar();
  });
  tabBar.append(close);
  const body = h('div', { class: 'panel-body' });
  panel.append(tabBar, body);
  if (S.ui.panel === 'changes') {
    if (!S.changes.length) {
      body.append(h('div', { class: 'panel-empty' }, icon('git', 'svg-lg'), h('div', { style: { marginTop: '8px' } }, 'Files FreeCode changes in this task show up here.')));
    } else {
      const undo = h('button', { class: 'btn btn-sm', title: "Revert the agent's last turn of edits" }, icon('undo', 'svg-sm'), 'Undo last changes');
      undo.addEventListener('click', async () => {
        const r = await api.post('/api/command', { name: 'undo', args: '' }).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) toast(r.error || 'Nothing to undo', 'err');
        loadChanges();
      });
      const tot = S.changes.reduce((a, c) => ({ add: a.add + c.added, del: a.del + c.removed }), { add: 0, del: 0 });
      body.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, h('span', { class: 'muted', style: { fontSize: '13px' } }, `${S.changes.length} file${S.changes.length === 1 ? '' : 's'} · `, h('span', { style: { color: 'var(--accent)' } }, `+${tot.add}`), ' ', h('span', { style: { color: 'var(--danger)' } }, `−${tot.del}`)), h('span', { class: 'grow' }), undo));
      for (const ch of S.changes) {
        const open = S.ui.open.has('chg:' + ch.path);
        const head = h('div', { class: 'change-head' }, icon(ch.created ? 'filePlus' : ch.deleted ? 'trash' : 'pencil', 'svg-sm'), h('span', { class: 'fname', title: ch.path }, ch.rel), h('span', { class: 'add' }, `+${ch.added}`), h('span', { class: 'del' }, `−${ch.removed}`));
        const box = h('div', { class: 'change' }, head);
        if (open) {
          const d = h('div');
          d.innerHTML = diffTable({ path: ch.rel, hunks: ch.hunks, added: ch.added, removed: ch.removed }, { noHead: true });
          box.append(d);
        }
        head.addEventListener('click', () => {
          if (open) S.ui.open.delete('chg:' + ch.path);
          else S.ui.open.add('chg:' + ch.path);
          renderPanel();
        });
        body.append(box);
      }
    }
    const cps = checkpointList();
    if (cps) body.append(cps);
  } else if (S.ui.panel === 'tasks') {
    if (!todos.length) body.append(h('div', { class: 'panel-empty' }, icon('listChecks', 'svg-lg'), h('div', { style: { marginTop: '8px' } }, 'When FreeCode works on a multi-step task, its plan and progress appear here.')));
    else body.append(todoList(todos));
  } else {
    const u = st.usage || {};
    body.append(
      h(
        'div',
        { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, String(u.requests || 0)), h('div', { class: 'k' }, 'AI requests')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtUsd(u.costUsd || 0)), h('div', { class: 'k' }, u.costUsd ? 'Cost (paid models)' : 'Cost (free models)')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtTokens(u.promptTokens || 0)), h('div', { class: 'k' }, 'Tokens in')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtTokens(u.completionTokens || 0)), h('div', { class: 'k' }, 'Tokens out')),
        u.cacheReadTokens ? h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtTokens(u.cacheReadTokens)), h('div', { class: 'k' }, 'Read from cache')) : null,
        u.cacheReadTokens ? h('div', { class: 'stat' }, h('div', { class: 'v' }, `${Math.round((100 * u.cacheReadTokens) / Math.max(1, u.promptTokens))}%`), h('div', { class: 'k' }, 'Input from cache')) : null,
      ),
      h('div', { class: 'panel-section-title' }, 'Model pool'),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, `${st.pool?.models ?? 0} models from ${st.pool?.providers ?? 0} provider${st.pool?.providers === 1 ? '' : 's'}. ${st.model?.pinned ? `Pinned: ${st.model.pinned}` : 'Auto routing is on.'}`),
      st.model?.current ? h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, `Last used: ${st.model.current}`) : null,
      h('div', { class: 'panel-section-title' }, 'Shortcuts'),
      h('div', { class: 'faint', style: { fontSize: '12.5px', lineHeight: 1.9 } }, 'Shift+Tab cycle mode · Esc stop · Ctrl/Cmd+K new task · Ctrl/Cmd+B sidebar · Ctrl/Cmd+, settings'),
    );
    const btn = h('button', { class: 'btn btn-sm', style: { marginTop: '12px' } }, icon('cpu', 'svg-sm'), 'See all models');
    btn.addEventListener('click', () => openSettings(ctx, 'models'));
    body.append(btn);
  }
}

function toggleSidebar() {
  S.ui.sidebarOpen = !S.ui.sidebarOpen;
  localStorage.setItem('fc-sidebar', S.ui.sidebarOpen ? '1' : '0');
  $('app').classList.toggle('no-sidebar', !S.ui.sidebarOpen);
  renderTopbar();
}

async function newTask() {
  if (S.state?.busy) {
    toast('Stop the current task first (Esc).', 'err');
    return;
  }
  await api.post('/api/command', { name: 'new', args: '' }).catch((e) => toast(e.message, 'err'));
  $('composer-input')?.focus();
}

function renderBanner() {
  const b = $('banner');
  clear(b);
  const st = S.state;
  if (st?.pendingTrust) {
    const yes = h('button', { class: 'btn btn-sm btn-primary' }, 'Trust folder');
    const no = h('button', { class: 'btn btn-sm btn-ghost' }, 'Not now');
    yes.addEventListener('click', async () => {
      await api.post('/api/trust', { trust: true });
      await loadState();
    });
    no.addEventListener('click', () => {
      st.pendingTrust = null;
      renderBanner();
    });
    b.append(h('div', { class: 'banner warn' }, icon('shield'), h('div', { class: 'grow' }, 'This folder has project settings (hooks, MCP servers or permission rules) that can run commands. They are ignored until you trust the folder.'), yes, no));
  }
}

function renderAll() {
  $('app').classList.toggle('no-sidebar', !S.ui.sidebarOpen);
  renderSidebar();
  renderTopbar();
  renderBanner();
  renderChat(true);
  renderPending();
  renderComposer();
  renderPanel();
}

// On a narrow window the panel floats over the chat, so it starts closed there (without changing the
// saved preference for wide windows).
const narrowWindow = window.matchMedia('(max-width: 900px)');
if (narrowWindow.matches) S.ui.panelOpen = false;
narrowWindow.addEventListener('change', () => {
  S.ui.panelOpen = narrowWindow.matches ? false : localStorage.getItem('fc-panel-open') !== '0';
  if (!S.state) return;
  renderPanel();
  renderTopbar();
});

// ---------------------------------------------------------------- global keys

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    newTask();
  } else if (mod && e.key === ',') {
    e.preventDefault();
    openSettings(ctx, 'providers');
  } else if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  } else if (e.key === 'Escape' && !document.querySelector('.overlay:not(.hidden)') && !menu) {
    const perm = S.pending.find((p) => p.kind === 'permission');
    if (perm && document.activeElement?.tagName !== 'INPUT') respond(perm.id, { decision: 'deny' });
    else if (S.state?.busy) api.post('/api/stop');
  } else if (e.key === 'Enter' && !e.shiftKey && document.activeElement?.id !== 'composer-input' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    const perm = S.pending.find((p) => p.kind === 'permission');
    if (perm && !document.querySelector('.overlay:not(.hidden)')) {
      e.preventDefault();
      respond(perm.id, { decision: 'allow' });
    }
  }
});

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    await loadState();
  } catch (e) {
    $('boot').querySelector('.boot-text').textContent = e.message;
    return;
  }
  $('boot').classList.add('gone');
  setTimeout(() => $('boot').remove(), 400);
  syncHostTheme();
  connectEvents(handleMessage, (status) => {
    if (status === 'reconnected') loadState();
  });
  $('composer-input')?.focus();
}

boot();

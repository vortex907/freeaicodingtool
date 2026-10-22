// FreeCode app: chat UI driven by the local FreeCode engine.
import { h, clear, icon, iconHtml, escapeHtml, fmtTokens, fmtDuration, timeAgo, dayGroup, debounce } from './dom.js';
import { api, connectEvents } from './api.js';
import { renderMarkdown } from './markdown.js';
import { highlightLine, langFromPath } from './highlight.js';
import { showOnboarding, openSettings, openFolderPicker } from './settings.js';

const $ = (id) => document.getElementById(id);

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
}

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
  try {
    S.changes = await api.get('/api/changes');
  } catch {
    S.changes = [];
  }
  renderPanel();
}

// ---------------------------------------------------------------- live events

function findItem(id) {
  return S.items.find((i) => i.id === id);
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
      break;
    case 'model': {
      live.wait = null;
      if (e.key !== live.lastModel) {
        const switched = !!live.turnModel && live.turnModel !== e.key;
        const prof = !switched && e.reason === 'selected' && !S.state?.model?.pinned ? live.profile : null;
        const why = S.state?.model?.pinned && !switched ? 'Pinned' : switched || e.attempt > 1 ? 'Switched' : prof ? `${prof.complexity} ${prof.type}` : 'Auto';
        S.items.push({ kind: 'route', id: nid('r'), why, model: e.key, textTools: e.toolMode === 'text' });
        live.lastModel = e.key;
        live.turnModel = live.turnModel || e.key;
        live.assistant = null;
      }
      break;
    }
    case 'profile':
      live.profile = e.profile;
      break;
    case 'text': {
      const a = currentAssistant();
      touch(a);
      if (a.reasoning && a.thinkingSince && !a.thoughtMs) a.thoughtMs = Date.now() - a.thinkingSince;
      a.text += e.delta;
      live.outChars += e.delta.length;
      break;
    }
    case 'reasoning': {
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
      S.items.push({ kind: 'notice', id: nid('n'), level: 'warn', text: `${e.from}: ${e.description}${e.retrySame ? '' : ' → switching model'}` });
      if (!e.retrySame) live.lastModel = null;
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

const TOOL_ICONS = { Read: 'fileText', Write: 'filePlus', Edit: 'pencil', MultiEdit: 'pencil', Update: 'pencil', Bash: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', Glob: 'folder', LS: 'folder', Grep: 'search', WebFetch: 'globe', WebSearch: 'search', TodoWrite: 'listChecks', Task: 'bot', AskUser: 'message', ExitPlanMode: 'map' };

function splitLabel(label) {
  const m = /^([\w:.-]+)\(([\s\S]*)\)$/.exec(label || '');
  if (m) return { name: m[1], arg: m[2] };
  return { name: label, arg: '' };
}

function diffTable(display, opts = {}) {
  const rows = [];
  const hunks = display.hunks || [];
  const lang = langFromPath(display.path);
  hunks.forEach((hk, i) => {
    if (i > 0) rows.push(`<tr class="gap"><td colspan="4">⋯</td></tr>`);
    for (const l of hk.lines) {
      const cls = l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : '';
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
      const code = l.type === 'ctx' ? highlightLine(l.text, lang) : escapeHtml(l.text);
      rows.push(`<tr class="${cls}"><td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td><td class="sign">${sign}</td><td class="code">${code || ' '}</td></tr>`);
    }
  });
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
  if (d?.kind === 'todos' || d?.kind === 'markdown') return true;
  return false;
}

function toolBody(item) {
  const d = item.result?.display;
  const body = h('div', { class: 'tool-body' });
  if (!item.result) return body;
  if (item.status === 'error' || item.status === 'denied') {
    body.append(h('div', { class: 'term err' }, item.result.content));
    return body;
  }
  if (d?.kind === 'diff') body.innerHTML = diffTable(d);
  else if (d?.kind === 'todos') body.append(todoList(d.todos));
  else if (d?.kind === 'markdown') body.append(h('div', { class: 'md', html: renderMarkdown(d.text) }));
  else if (item.name === 'Task') body.append(h('div', { class: 'md', html: renderMarkdown(item.result.content) }));
  else if (d?.kind === 'text') {
    const term = h('div', { class: 'term' });
    if (item.name === 'Bash') term.append(h('span', { class: 'prompt' }, '$ '), (item.input?.command ?? '') + '\n');
    term.append(d.text);
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
      return h('div', { class: `msg-user ${item.queued ? 'queued' : ''}`, 'data-id': item.id }, item.queued ? h('span', { class: 'q-tag' }, 'Sent while the agent was working') : null, highlightMentions(item.text));
    case 'assistant': {
      const wrap = h('div', { class: `msg-assistant ${item.discarded ? 'discarded' : ''}`, 'data-id': item.id });
      if (item.reasoning && S.state?.settings?.showReasoning !== false) {
        const thinking = item.streaming && !item.text;
        const secs = item.thoughtMs && item.thoughtMs >= 1000 ? fmtDuration(item.thoughtMs) : null;
        const det = h('details', { class: 'thinking' }, h('summary', null, icon('sparkle', 'svg-sm'), h('span', { class: thinking ? 'w-text' : '' }, thinking ? 'Thinking…' : secs ? `Thought for ${secs}` : 'Thoughts'), icon('chevronDown', 'svg-sm')), h('div', { class: 't-body' }, item.reasoning));
        wrap.append(det);
      }
      if (item.text) wrap.append(h('div', { class: 'md', html: renderMarkdown(item.text) }));
      if (item.discarded) wrap.append(h('div', { class: 'note warn' }, 'This partial answer was discarded because the model failed; another model continued.'));
      return wrap;
    }
    case 'tool':
      return renderToolItem(item);
    case 'route':
      return h('div', { class: 'route', 'data-id': item.id }, h('span', { class: 'chip', title: 'The router chose this model for the task. It switches automatically if the model is rate limited.' }, h('span', { class: 'spark' }, '◆'), h('span', null, item.why), h('span', { class: 'faint' }, '→'), h('b', null, item.model), item.textTools ? h('span', { class: 'faint' }, '(text tools)') : null));
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
}

function renderChat(scroll = false) {
  const inner = $('chat-inner');
  const wasNear = nearBottom();
  if (!S.items.length && !S.state?.busy) {
    clear(inner).append(emptyState());
    return;
  }
  const nodes = S.items.map(elFor);
  if (S.state?.busy) nodes.push(workingIndicator());
  inner.replaceChildren(...nodes);
  if (scroll || wasNear) scrollChat(true);
}

setInterval(() => {
  const w = $('working');
  if (w && S.state?.busy) updateWorking(w);
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
    title = 'Run this command?';
    ico = 'terminal';
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
    body.innerHTML = diffTable(r.preview);
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
  actions.append(deny, h('span', { class: 'kbd-hint' }, h('kbd', null, 'Enter'), ' allow · ', h('kbd', null, 'Esc'), ' deny'));
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
    h('div', { class: 'card-head' }, icon(ico), title, p.subagent ? h('span', { class: 'badge off' }, `requested by ${p.subagent}`) : null),
    body,
    actions,
    h('div', { class: 'card-feedback' }, fb, sendFb),
  );
}

function questionCard(p) {
  const input = h('input', { placeholder: 'Type your answer…' });
  const send = h('button', { class: 'btn btn-primary btn-sm' }, 'Answer');
  const doSend = () => input.value.trim() && respond(p.id, { answer: input.value.trim() });
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
    e.stopPropagation();
  });
  const opts = (p.options || []).map((o) => {
    const b = h('button', { class: 'btn' }, o);
    b.addEventListener('click', () => respond(p.id, { answer: o }));
    return b;
  });
  const skip = h('button', { class: 'btn btn-ghost btn-sm' }, 'Skip');
  skip.addEventListener('click', () => respond(p.id, { answer: null }));
  return h('div', { class: 'card', 'data-pending': p.id }, h('div', { class: 'card-head' }, icon('message'), 'FreeCode has a question'), h('div', { class: 'card-body' }, h('div', { class: 'md', html: renderMarkdown(p.question) })), opts.length ? h('div', { class: 'card-actions' }, opts) : null, h('div', { class: 'card-feedback' }, input, send, skip));
}

function planCard(p) {
  const yes = h('button', { class: 'btn btn-primary' }, 'Yes, and auto-accept edits');
  yes.addEventListener('click', () => respond(p.id, { decision: 'acceptEdits' }));
  const manual = h('button', { class: 'btn' }, 'Yes, but ask before edits');
  manual.addEventListener('click', () => respond(p.id, { decision: 'default' }));
  const no = h('button', { class: 'btn btn-ghost' }, 'No, keep planning');
  no.addEventListener('click', () => respond(p.id, { decision: null }));
  return h('div', { class: 'card plan', 'data-pending': p.id }, h('div', { class: 'card-head' }, icon('map'), 'Ready to code? Here is the plan'), h('div', { class: 'card-body', style: { maxHeight: '42vh', overflow: 'auto' } }, h('div', { class: 'md', html: renderMarkdown(p.plan) })), h('div', { class: 'card-actions' }, yes, manual, no));
}

function renderPending() {
  const box = $('pending');
  clear(box);
  for (const p of S.pending) {
    if (p.kind === 'permission') box.append(permissionCard(p));
    else if (p.kind === 'question') box.append(questionCard(p));
    else if (p.kind === 'plan') box.append(planCard(p));
  }
}

// ---------------------------------------------------------------- composer

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

async function send(text) {
  const t = text.trim();
  if (!t) return;
  S.history.push(t);
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
    const r = await api.post('/api/prompt', { text: t });
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
    const box = h('div', { class: 'composer', id: 'composer' }, ta, h('div', { class: 'composer-bar', id: 'composer-bar' }));
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
  const modeBtn = h('button', { class: `pill mode-${mode}`, title: 'Permission mode (Shift+Tab)' }, icon(modeInfo.icon, 'svg-sm'), modeInfo.label, icon('chevronDown', 'svg-sm'));
  modeBtn.addEventListener('click', () =>
    showMenu(
      modeBtn,
      MODES.map((m) => ({ label: m.label, desc: m.desc, icon: m.icon, id: m.id, checked: m.id === mode })),
      (it) => api.post('/api/mode', { mode: it.id }).catch((e) => toast(e.message, 'err')),
      { title: 'Permission mode' },
    ),
  );
  const pinned = st.model?.pinned;
  const modelBtn = h('button', { class: 'pill', title: 'Model' }, h('span', { class: 'dot' }), pinned ? pinned : 'Auto', icon('chevronDown', 'svg-sm'));
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
  bar.append(attach, modeBtn, modelBtn, h('span', { class: 'grow' }), sendBtn);
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
    b.disabled = !t.value.trim();
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
  f.append(card, keys, settings);
}

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
  const c = st.context || { tokens: 0, budget: 1 };
  const pct = Math.min(100, Math.round((c.tokens / Math.max(1, c.budget)) * 100));
  tb.append(h('div', { class: `ctx-meter ${pct > 75 ? 'high' : ''}`, title: `Context: ~${fmtTokens(c.tokens)} of ${fmtTokens(c.budget)} tokens. Older messages are summarized automatically above the budget.` }, h('span', { class: 'bar' }, h('i', { style: { width: `${pct}%` } })), `${pct}%`));
  const panelBtn = h('button', { class: `icon-btn ${S.ui.panelOpen ? 'active' : ''}`, title: 'Changes & tasks panel' }, icon('panelRight'));
  panelBtn.addEventListener('click', () => {
    S.ui.panelOpen = !S.ui.panelOpen;
    localStorage.setItem('fc-panel-open', S.ui.panelOpen ? '1' : '0');
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
    localStorage.setItem('fc-panel-open', '0');
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
        h('div', { class: 'stat' }, h('div', { class: 'v' }, '$0.00'), h('div', { class: 'k' }, 'Cost (free models)')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtTokens(u.promptTokens || 0)), h('div', { class: 'k' }, 'Tokens in')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmtTokens(u.completionTokens || 0)), h('div', { class: 'k' }, 'Tokens out')),
      ),
      h('div', { class: 'panel-section-title' }, 'Model pool'),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, `${st.pool?.models ?? 0} models from ${st.pool?.providers ?? 0} providers. ${st.model?.pinned ? `Pinned: ${st.model.pinned}` : 'Auto routing is on.'}`),
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
  connectEvents(handleMessage, (status) => {
    if (status === 'reconnected') loadState();
  });
  $('composer-input')?.focus();
}

boot();

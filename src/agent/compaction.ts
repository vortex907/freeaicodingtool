// Context management: prune stale tool outputs, then summarize older history when the conversation
// outgrows the budget. Free tiers resend the whole context on every step, so staying small matters.
import type { ChatMessage } from '../providers/types.js';
import { estimateMessagesTokens, estimateTextTokens } from '../util/tokens.js';
import { truncate } from '../util/strings.js';
import { CONTAINER_KINDS, extract, langOf } from '../codeindex/lang.js';

export const SUMMARY_INSTRUCTIONS = `Write a detailed summary of the conversation so far so the work can continue seamlessly in a fresh context. Include:
1. The user's requests and goals (quote important instructions and preferences verbatim).
2. Key technical decisions, constraints and conventions discovered.
3. Files examined or modified, with the important details (paths, functions, what changed and why).
4. Commands run and their important results (errors, test results).
5. Problems solved and problems still open.
6. The current state of the work and the exact next steps.
Be specific: keep exact names, paths, numbers and error messages. Do not invent anything. Use markdown sections.`;

/** Replaces old, large tool outputs with short placeholders. Returns the number of tokens saved. */
export function pruneToolOutputs(messages: ChatMessage[], keepRecent = 6, minChars = 600): number {
  let saved = 0;
  const calls = callsById(messages);
  const toolIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool' && !m.meta?.pruned) toolIdx.push(i);
  });
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  for (const i of candidates) {
    const m = messages[i]!;
    if (m.content.length < minChars) continue;
    const before = estimateTextTokens(m.content);
    const placeholder = shortNote(m, calls.get(m.toolCallId ?? ''));
    messages[i] = { ...m, content: placeholder, meta: { ...m.meta, pruned: true } };
    saved += before - estimateTextTokens(placeholder);
  }
  // Also drop stored reasoning from older assistant messages (never sent, but keeps sessions lean).
  for (let i = 0; i < messages.length - 4; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.reasoning) messages[i] = { ...m, reasoning: undefined };
  }
  return saved;
}

/** Short description of a tool call for placeholders, e.g. Read(src/app.ts). */
export function describeCall(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args) as Record<string, unknown>;
  } catch {
    // keep empty
  }
  const pick = (...keys: string[]) => keys.map((k) => a[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  const arg = pick('file_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description');
  return arg ? `${name}(${truncate(arg.replace(/\s+/g, ' '), 70)})` : name;
}

export interface LeanOptions {
  /** The current turn number; attachments from earlier turns are trimmed. */
  turn: number;
  /** Tokens all tool outputs together may take; past it the oldest are shortened first. */
  toolBudget?: number;
  /** The newest tool outputs stay in full whatever their size. */
  keepLatest?: number;
}

/**
 * The conversation as sent to the model. Tool outputs stay in full while they fit the budget; past it the
 * oldest become a short note (for a file: what it defines, so the model can read just the lines it needs
 * instead of the whole file again). A file read again later is kept once, as the newer copy. Older
 * screenshots and attachments from earlier tasks are dropped and reasoning is never resent. Tool calls stay
 * paired with their results; the full history is kept in the session for the user.
 */
export function leanView(messages: ChatMessage[], opts: LeanOptions): ChatMessage[] {
  const keepLatest = opts.keepLatest ?? 4;
  const budget = opts.toolBudget ?? 24000;
  const calls = callsById(messages);
  // A Read of the same file and range as a later Read: the later one is newer, so keep only that.
  const superseded = new Set<number>();
  const later = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool' || m.isError || m.meta?.pruned) continue;
    const c = calls.get(m.toolCallId ?? '');
    const file = c?.name === 'Read' ? pathArg(c.args) : undefined;
    if (!file) continue;
    const key = `${file}\n${String(c!.args.offset ?? '')}\n${String(c!.args.limit ?? '')}`;
    if (later.has(key)) superseded.add(i);
    else later.add(key);
  }
  // Newest first: keep what fits, shorten the rest (small outputs cost little and stay).
  const shorten = new Set<number>();
  let used = 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool' || m.meta?.pruned || superseded.has(i)) continue;
    const tokens = estimateTextTokens(m.content);
    if (seen++ < keepLatest || tokens <= 200 || used + tokens <= budget) used += tokens;
    else shorten.add(i);
  }
  // Only the newest screenshot is worth its tokens; older ones are described by their tool results.
  let lastShot = -1;
  messages.forEach((m, i) => m.meta?.kind === 'screenshot' && m.images?.length && (lastShot = i));
  return messages.map((m, i) => {
    const earlier = (m.meta?.turn ?? opts.turn) < opts.turn;
    if (m.meta?.kind === 'screenshot' && i !== lastShot) return { ...m, images: undefined, content: '[An older screenshot was here.]' };
    if (m.role === 'assistant' && m.reasoning) return { ...m, reasoning: undefined };
    if (m.role === 'tool' && superseded.has(i)) {
      return { ...m, content: `[${pathArg(calls.get(m.toolCallId ?? '')!.args)} was read again later in this conversation; the newer copy is further down.]` };
    }
    if (m.role === 'tool' && shorten.has(i)) return { ...m, content: shortNote(m, calls.get(m.toolCallId ?? '')) };
    if (m.role === 'user' && earlier && m.content.length > 4000 && /<attached-(file|folder)/.test(m.content)) {
      return { ...m, content: m.content.replace(/(<attached-(file|folder)\b[^>]*>)[\s\S]*?(<\/attached-\2>)/g, '$1\n[contents omitted; read the file again if you need it]\n$3') };
    }
    return m;
  });
}

type CallInfo = { name: string; args: Record<string, unknown> };

function callsById(messages: ChatMessage[]): Map<string, CallInfo> {
  const calls = new Map<string, CallInfo>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        // keep empty
      }
      calls.set(tc.id, { name: tc.name, args: args && typeof args === 'object' ? args : {} });
    }
  }
  return calls;
}

function pathArg(args: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'filePath', 'filename', 'file', 'target_file', 'notebook_path']) {
    if (typeof args[k] === 'string' && args[k]) return args[k] as string;
  }
  return undefined;
}

/** What a file defines, from Read output ("   12\tcode" lines), e.g. "function parse (line 12), class Lexer (line 40)". */
export function outlineOf(file: string, readOutput: string): string {
  const numbered = readOutput.split('\n').map((l) => /^\s*(\d+)\t(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x);
  if (numbered.length < 20) return '';
  const first = Number(numbered[0]![1]);
  const family = langOf(file.replace(/\\/g, '/')).family;
  if (!family || family === 'md') return '';
  let syms: { name: string; kind: string; line: number; indent: number }[];
  try {
    syms = extract(family, numbered.map((x) => x[2]!)).syms.filter((sym) => !sym.boundaryOnly);
  } catch {
    return '';
  }
  if (!syms.length) return '';
  const minIndent = Math.min(...syms.map((sym) => sym.indent));
  const top = syms.filter((sym) => sym.indent === minIndent || CONTAINER_KINDS.has(sym.kind));
  const pick = (top.length >= 3 ? top : syms).slice(0, 25);
  const more = (top.length >= 3 ? top : syms).length - pick.length;
  return `${pick.map((sym) => `${sym.kind} ${sym.name} (line ${sym.line + first - 1})`).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** A tool output that no longer fits, as one line that says what it was. */
function shortNote(m: ChatMessage, c: CallInfo | undefined): string {
  const lines = m.content.split('\n').length;
  const file = c?.name === 'Read' ? pathArg(c.args) : undefined;
  if (file) {
    const outline = outlineOf(file, m.content);
    return `[The Read of ${file} (${lines} lines) is not repeated here to save space.${outline ? ` It defines: ${outline}.` : ''} If you need exact lines from it again, Read only those lines (offset and limit) instead of the whole file.]`;
  }
  const what = c ? describeCall(c.name, JSON.stringify(c.args)) : (m.toolName ?? 'a tool');
  const first = m.content.split('\n').find((l) => l.trim()) ?? '';
  return `[The output of ${what} (${lines} lines) is not repeated here to save space. It started with: ${truncate(first.trim(), 160)}]`;
}

/** Index where the "recent" part starts so that it begins with a user message (never splits tool pairs). */
export function findCutIndex(messages: ChatMessage[], keepTokens: number): number {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessagesTokens([messages[i]!]);
    if (acc > keepTokens) break;
    cut = i;
  }
  // Move forward to a real user message boundary.
  while (cut < messages.length && !(messages[cut]!.role === 'user' && messages[cut]!.meta?.kind !== 'summary')) cut++;
  // If nothing fits, keep at least the last user message onwards.
  if (cut >= messages.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') return i;
    }
    return messages.length;
  }
  return cut;
}

/** Converts messages into a plain transcript for the summarizer. */
export function transcript(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') lines.push(`USER: ${truncate(m.content, 6000)}`);
    else if (m.role === 'assistant') {
      if (m.content.trim()) lines.push(`ASSISTANT: ${truncate(m.content, 4000)}`);
      for (const tc of m.toolCalls ?? []) lines.push(`ASSISTANT called ${tc.name}(${truncate(tc.arguments, 800)})`);
    } else if (m.role === 'tool') lines.push(`RESULT of ${m.toolName ?? 'tool'}${m.isError ? ' (error)' : ''}: ${truncate(m.content, 1500)}`);
  }
  let text = lines.join('\n\n');
  if (text.length > maxChars) {
    const head = text.slice(0, Math.floor(maxChars * 0.3));
    const tail = text.slice(text.length - Math.floor(maxChars * 0.7));
    text = `${head}\n\n[... middle of the conversation omitted ...]\n\n${tail}`;
  }
  return text;
}

export function summaryMessage(summary: string): ChatMessage {
  return {
    role: 'user',
    content: `<conversation-summary>\nThe earlier part of this conversation was compacted. Summary:\n\n${summary.trim()}\n</conversation-summary>\nContinue from where things stand; don't repeat completed work.`,
    meta: { synthetic: true, kind: 'summary', ts: Date.now() },
  };
}

/** Drops the oldest messages (keeping pairs intact) when summarizing is impossible. */
export function hardTruncate(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
  const cut = findCutIndex(messages, targetTokens);
  const kept = messages.slice(cut);
  return [{ role: 'user', content: '[Earlier conversation was dropped to fit the context window.]', meta: { synthetic: true, kind: 'summary' } }, ...kept];
}

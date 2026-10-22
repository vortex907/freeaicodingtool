// Context management: prune stale tool outputs, then summarize older history when the conversation
// outgrows the budget. Free tiers resend the whole context on every step, so staying small matters.
import type { ChatMessage } from '../providers/types.js';
import { estimateMessagesTokens, estimateTextTokens } from '../util/tokens.js';
import { truncate } from '../util/strings.js';

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
  const toolIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool' && !m.meta?.pruned) toolIdx.push(i);
  });
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  for (const i of candidates) {
    const m = messages[i]!;
    if (m.content.length < minChars) continue;
    const before = estimateTextTokens(m.content);
    const firstLine = truncate(m.content.split('\n').find((l) => l.trim()) ?? '', 120);
    const placeholder = `[Output of ${m.toolName ?? 'tool'} pruned to save context (${m.content.length} chars). First line: ${firstLine}. Run the tool again if you need it.]`;
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

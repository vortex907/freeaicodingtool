// Rough token estimation without shipping a tokenizer. Code averages ~3.3 chars/token and prose ~4,
// so 3.5 is a deliberately conservative middle; the router adds its own safety margin on top.
import type { ChatMessage, ToolSchema } from '../providers/types.js';

let charsPerToken = 3.5;

export function setCharsPerToken(v: number): void {
  if (v > 1.5 && v < 8) charsPerToken = v;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

export function estimateMessageTokens(m: ChatMessage): number {
  let n = 4 + estimateTextTokens(m.content);
  if (m.toolCalls) for (const tc of m.toolCalls) n += 8 + estimateTextTokens(tc.name) + estimateTextTokens(tc.arguments);
  if (m.images) n += m.images.length * 800;
  return n;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let n = 3;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

export function estimateToolsTokens(tools: ToolSchema[] | undefined): number {
  if (!tools?.length) return 0;
  let n = 0;
  for (const t of tools) n += 10 + estimateTextTokens(t.name + t.description + JSON.stringify(t.parameters));
  return n;
}

export function estimateRequestTokens(messages: ChatMessage[], tools?: ToolSchema[]): number {
  return estimateMessagesTokens(messages) + estimateToolsTokens(tools);
}

// Claude through the Messages API: how FreeCode's conversation becomes cache-friendly requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicParams, anthropicRateLimit, toAnthropicMessages } from '../src/providers/anthropic.js';
import { requestCost } from '../src/providers/cost.js';
import { getProviderDef } from '../src/providers/catalog.js';
import type { ChatRequest } from '../src/providers/client.js';
import type { ChatMessage, ModelInfo } from '../src/providers/types.js';

type Block = { type: string; [k: string]: unknown };
const blocks = (m: { content?: unknown }) => m.content as Block[];

const thinking = { type: 'thinking', thinking: 'Look at the file first.', signature: 'sig-1' };
const claudeTurn: ChatMessage = {
  role: 'assistant',
  content: 'Reading it.',
  toolCalls: [{ id: 'toolu_1', name: 'Read', arguments: '{"file_path":"a.ts"}' }],
  native: { provider: 'anthropic', model: 'claude-opus-5-5', content: [thinking, { type: 'text', text: 'Reading it.', citations: null }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
};
const history: ChatMessage[] = [
  { role: 'system', content: 'You are FreeCode.' },
  { role: 'user', content: 'Fix a.ts', images: [{ mediaType: 'image/png', data: 'iVBOR' }] },
  claudeTurn,
  { role: 'tool', content: 'export const a = 1;', toolCallId: 'toolu_1', toolName: 'Read' },
  { role: 'user', content: 'Also check b.ts' },
];

test('the conversation renders to Anthropic messages with thinking blocks sent back unchanged', () => {
  const { system, messages } = toAnthropicMessages(history);
  assert.equal(system, 'You are FreeCode.');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(blocks(messages[0]!).map((b) => b.type), ['image', 'text'], 'images come before the text');
  const asst = blocks(messages[1]!);
  assert.deepEqual(asst[0], thinking, 'thinking block exactly as received');
  assert.deepEqual(asst[1], { type: 'text', text: 'Reading it.' }, 'null citations are not sent back');
  assert.equal(asst[2]!.id, 'toolu_1');
  // The tool result leads the next user message; the user's new words follow it.
  assert.deepEqual(blocks(messages[2]!).map((b) => b.type), ['tool_result', 'text']);
  assert.equal(blocks(messages[2]!)[0]!.tool_use_id, 'toolu_1');
  assert.deepEqual(toAnthropicMessages(history), toAnthropicMessages(history), 'same history, same bytes');
});

test('thinking can be stripped, renamed calls fall back to plain blocks, loose ends are tidied', () => {
  const stripped = toAnthropicMessages(history, { stripThinking: true });
  assert.ok(!blocks(stripped.messages[1]!).some((b) => b.type === 'thinking'));

  const renamed: ChatMessage = { ...claudeTurn, toolCalls: [{ id: 'call_x', name: 'Read', arguments: '{"file_path":"a.ts"}' }] };
  const r = toAnthropicMessages([{ role: 'user', content: 'go' }, renamed, { role: 'tool', content: 'ok', toolCallId: 'call_x', toolName: 'Read' }]);
  assert.deepEqual(blocks(r.messages[1]!).map((b) => b.type), ['text', 'tool_use'], 'rebuilt without the thinking block');
  assert.deepEqual(blocks(r.messages[1]!)[1]!.input, { file_path: 'a.ts' });

  const loose = toAnthropicMessages([
    { role: 'user', content: 'start' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'never_ran', name: 'Bash', arguments: '{}' }] },
    { role: 'tool', content: 'orphan output', toolCallId: 'unknown', toolName: 'Bash' },
    { role: 'assistant', content: 'Done.' },
    { role: 'system', content: 'Plan mode is on.' },
  ]);
  const all = loose.messages.flatMap((m) => blocks(m));
  assert.ok(!all.some((b) => b.type === 'tool_use'), 'a call without a result is left out');
  assert.ok(all.some((b) => b.type === 'text' && /orphan output/.test(String(b.text))), 'a result without its call becomes text');
  assert.ok(all.some((b) => b.type === 'text' && /<system-reminder>\nPlan mode is on/.test(String(b.text))), 'later system notes become reminders');
  assert.equal(loose.messages.at(-1)!.role, 'user', 'never ends on Claude (no prefill on Claude 5)');
});

const model = (over: Partial<ModelInfo> = {}) => ({ id: 'claude-opus-5-5', key: 'anthropic/claude-opus-5-5', effort: true, ...over }) as ModelInfo;
const request = (over: Partial<ChatRequest> = {}) =>
  ({
    provider: { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1' },
    model: model(),
    apiKey: 'k',
    messages: history,
    tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    toolMode: 'native',
    maxTokens: 16000,
    temperature: 0.3,
    ...over,
  }) as unknown as ChatRequest;

test('requests carry two cache breakpoints, adaptive thinking that survives edits and the effort level', () => {
  const p = anthropicParams(request({ effort: 'low' })) as unknown as Record<string, unknown>;
  assert.deepEqual(p.cache_control, { type: 'ephemeral' });
  assert.deepEqual((p.system as Block[])[0], { type: 'text', text: 'You are FreeCode.', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(p.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(p.betas, ['thinking-binding-controls-2026-08-01']);
  assert.deepEqual(p.output_config, { effort: 'low' });
  assert.equal((p.tools as Block[])[0]!.eager_input_streaming, true);
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'stream']) assert.ok(!(k in p), `no ${k}`);
  assert.ok(!('output_config' in (anthropicParams(request()) as object)), 'no effort leaves the model default');
  assert.ok(!('output_config' in (anthropicParams(request({ effort: 'high', model: model({ effort: false }) })) as object)), 'models without effort get none');
});

test('cost follows the price card, with cache reads at a fraction and the long-prompt card for Haiku', () => {
  const price = (id: string) => getProviderDef('anthropic')!.models.find((m) => m.id === id)!.price;
  const opus = price('claude-opus-5-5');
  assert.equal(requestCost(opus, { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }), 4);
  assert.equal(requestCost(opus, { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 1_000_000 }), 0.2);
  assert.equal(requestCost(opus, { promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 }), 20);
  const haiku = price('claude-haiku-5-5');
  assert.equal(requestCost(haiku, { promptTokens: 50_000, completionTokens: 0, totalTokens: 50_000 }), 0.005);
  assert.equal(requestCost(haiku, { promptTokens: 200_000, completionTokens: 0, totalTokens: 200_000 }), 0.1, 'above 100K tokens the higher card applies');
  assert.equal(requestCost(undefined, { promptTokens: 5, completionTokens: 5, totalTokens: 10 }), undefined, 'free models have no cost');
});

test('anthropic rate limit headers feed the router', () => {
  const reset = new Date(Date.now() + 30_000).toISOString();
  const snap = anthropicRateLimit(new Headers({ 'anthropic-ratelimit-requests-remaining': '7', 'anthropic-ratelimit-input-tokens-remaining': '120000', 'anthropic-ratelimit-requests-reset': reset }));
  assert.equal(snap?.remainingRequests, 7);
  assert.equal(snap?.remainingTokens, 120000);
  assert.ok(snap!.resetRequestsMs! > 20_000 && snap!.resetRequestsMs! <= 30_000);
  assert.equal(anthropicRateLimit(new Headers()), undefined);
});

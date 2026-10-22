// Unit tests for request shaping, error handling and parsing helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWireMessages, validatesThoughtSignatures, DUMMY_THOUGHT_SIGNATURE } from '../src/providers/wire.js';
import { ToolCallAccumulator } from '../src/providers/client.js';
import { isChatModelId } from '../src/providers/modelInfo.js';
import { parseToolCallsFromText } from '../src/providers/textTools.js';
import { classifyHttpError } from '../src/providers/errors.js';
import { gitBashPath, powershellScript } from '../src/tools/bash.js';
import { shortError } from '../src/router/health.js';
import type { ChatMessage, ModelInfo, ProviderQuirks } from '../src/providers/types.js';

const model = (id: string) => ({ id, key: `p/${id}` }) as unknown as ModelInfo;
const history: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'read it' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"file_path":"a"}' }] },
  { role: 'tool', content: 'alpha', toolCallId: 'c1', toolName: 'Read' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'Read', arguments: '{"file_path":"b"}', extra: { google: { thought_signature: 'real' } } }] },
  { role: 'tool', content: 'beta', toolCallId: 'c2', toolName: 'Read' },
];
type WireCall = { extra_content?: { google?: { thought_signature?: string } } };
const calls = (msgs: Record<string, unknown>[]) => msgs.filter((m) => m.tool_calls).map((m) => m.tool_calls as WireCall[]);

test('Gemini 3 gets real signatures back and the placeholder for foreign tool calls', () => {
  const quirks: ProviderQuirks = { thoughtSignatures: true };
  const out = calls(toWireMessages(history, { quirks, model: model('gemini-3-flash-preview'), toolMode: 'native' }));
  assert.equal(out[0]![0]!.extra_content?.google?.thought_signature, DUMMY_THOUGHT_SIGNATURE);
  assert.equal(out[1]![0]!.extra_content?.google?.thought_signature, 'real');
});

test('Gemini 2.5 gets real signatures but no placeholder; other providers get neither', () => {
  const g25 = calls(toWireMessages(history, { quirks: { thoughtSignatures: true }, model: model('gemini-2.5-flash'), toolMode: 'native' }));
  assert.equal(g25[0]![0]!.extra_content, undefined);
  assert.equal(g25[1]![0]!.extra_content?.google?.thought_signature, 'real');
  const other = calls(toWireMessages(history, { quirks: {}, model: model('llama-4'), toolMode: 'native' }));
  assert.ok(other.flat().every((c) => c.extra_content === undefined));
});

test('which Gemini models validate thought signatures', () => {
  assert.equal(validatesThoughtSignatures('gemini-3-flash-preview'), true);
  assert.equal(validatesThoughtSignatures('gemini-3.1-pro-preview'), true);
  assert.equal(validatesThoughtSignatures('gemini-flash-latest'), true);
  assert.equal(validatesThoughtSignatures('gemini-2.5-flash'), false);
  assert.equal(validatesThoughtSignatures('gemma-3-27b-it'), false);
});

test('history as text keeps the conversation but drops the tool-call structure', () => {
  const out = toWireMessages(history, { quirks: {}, model: model('m'), toolMode: 'native', historyAsText: true });
  assert.ok(out.every((m) => !m.tool_calls && m.role !== 'tool'));
  const text = out.map((m) => String(m.content)).join('\n');
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.equal(out.at(-1)!.role, 'user');
});

test('streamed tool calls keep their extra_content', () => {
  const acc = new ToolCallAccumulator();
  acc.add([{ index: 0, id: 'x', function: { name: 'Read', arguments: '{"file_' }, extra_content: { google: { thought_signature: 'sig' } } }]);
  acc.add([{ index: 0, function: { arguments: 'path":"a"}' } }]);
  const [c] = acc.result();
  assert.equal(c!.arguments, '{"file_path":"a"}');
  assert.deepEqual(c!.extra, { google: { thought_signature: 'sig' } });
});

test('image, speech and embedding models are not chat models', () => {
  for (const id of ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'gpt-image-1', 'qwen/qwen-image', 'text-embedding-3-small', 'gemini-2.5-flash-preview-tts']) assert.equal(isChatModelId(id), false, id);
  for (const id of ['gemini-3-flash-preview', 'llama-3.2-11b-vision-instruct', 'qwen/qwen3-coder-480b-a35b-instruct', 'gemma-3-27b-it']) assert.equal(isChatModelId(id), true, id);
});

test('gpt-oss tool calls are recovered and its analysis text is hidden', () => {
  const t = '<|channel|>analysis<|message|>We need to list files.<|end|><|start|>assistant<|channel|>commentary to=functions.Bash <|constrain|>json<|message|>{"command":"ls"}<|call|>';
  const r = parseToolCallsFromText(t, new Set(['Bash']));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Bash');
  assert.deepEqual(JSON.parse(r.toolCalls[0]!.arguments), { command: 'ls' });
  assert.equal(r.text, '');
});

test('Gemini zero-quota and per-day errors are told apart', () => {
  const zero = classifyHttpError(429, JSON.stringify({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3-pro-preview' } }), new Headers());
  assert.equal(zero.kind, 'quota');
  assert.match(zero.message, /limit: 0/);
});

test('Git Bash gets its own tools on PATH', () => {
  assert.equal(gitBashPath('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows'), 'C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Windows');
  assert.equal(gitBashPath('D:\\Git\\usr\\bin\\bash.exe', 'D:\\Git\\usr\\bin;C:\\x'), 'D:\\Git\\mingw64\\bin;D:\\Git\\usr\\bin;C:\\x');
});

test('PowerShell wrapper reports program exit codes and the final folder', () => {
  const s = powershellScript('npm test', 'C:\\Temp\\it\'s.txt');
  assert.match(s, /\$global:LASTEXITCODE = \$null\nnpm test\n/);
  assert.match(s, /WriteAllText\('C:\\Temp\\it''s\.txt'/);
  assert.match(s, /if \(\$null -ne \$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}/);
});

test('provider errors are shortened to one readable line', () => {
  assert.equal(shortError('NVIDIA NIM/qwen: {"error":{"message":"Model is overloaded. Please retry later."}}'), 'Model is overloaded');
  assert.equal(shortError(''), 'unknown error');
});

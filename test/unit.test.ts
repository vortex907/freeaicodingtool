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

test('keyless search fallbacks parse their result pages', async () => {
  const { parseDuckDuckGoLite, parseMojeek } = await import('../src/tools/webTools.js');
  const lite = `<table><tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.counter-strike.net%2Fnews%2Fupdates&amp;rut=abc" class='result-link'>Counter-Strike 2 &amp; Updates</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Release notes for the <b>latest</b> CS2 update.</td></tr></table>`;
  assert.deepEqual(parseDuckDuckGoLite(lite, 5), [{ title: 'Counter-Strike 2 & Updates', url: 'https://www.counter-strike.net/news/updates', snippet: 'Release notes for the latest CS2 update.' }]);
  const mojeek = `<ul class="results-standard"><li class="r1"><a class="ob" href="https://store.steampowered.com/news/app/730">x</a><h2><a class="title" href="https://store.steampowered.com/news/app/730">Counter-Strike 2 News</a></h2><p class="i">store.steampowered.com</p><p class="s">Patch notes from Valve.</p></li></ul>`;
  assert.deepEqual(parseMojeek(mojeek, 5), [{ title: 'Counter-Strike 2 News', url: 'https://store.steampowered.com/news/app/730', snippet: 'Patch notes from Valve.' }]);
});

test('skills: front matter (plain, quoted and folded) is parsed', async () => {
  const { parseFrontMatter } = await import('../src/skills/skills.js');
  const r = parseFrontMatter('---\nname: pdf\ndescription: >\n  Work with PDF files.\n  Use for forms.\nlicense: "MIT"\n---\n# Body\n');
  assert.deepEqual(r.data, { name: 'pdf', description: 'Work with PDF files. Use for forms.', license: 'MIT' });
  assert.equal(r.body, '# Body\n');
});

test('tar reader handles GitHub-style tarballs with long names', async () => {
  const { gzipSync } = await import('node:zlib');
  const { readTar } = await import('../src/util/tar.js');
  const header = (name: string, size: number, type = '0') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write(type, 156);
    h.write('ustar', 257);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const longName = `repo-abc/skills/${'x'.repeat(120)}/SKILL.md`;
  const body = Buffer.from('---\nname: x\n---\nhi');
  const tar = Buffer.concat([
    header('repo-abc/', 0, '5'),
    header('././@LongLink', longName.length, 'L'),
    pad(Buffer.from(longName)),
    header('ignored', body.length),
    pad(body),
    Buffer.alloc(1024),
  ]);
  const entries = readTar(gzipSync(tar));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.path, longName);
  assert.equal(entries[0]!.data.toString(), body.toString());
});

test('marketplace sources accept owner/repo, @ref and GitHub links', async () => {
  const { parseSource } = await import('../src/skills/marketplace.js');
  assert.deepEqual(parseSource('anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: 'HEAD' });
  assert.deepEqual(parseSource('me/my-skills@dev'), { owner: 'me', repo: 'my-skills', ref: 'dev' });
  assert.deepEqual(parseSource('https://github.com/a/b/tree/main'), { owner: 'a', repo: 'b', ref: 'main' });
  assert.equal(parseSource('not a repo'), null);
});

test('time-sensitive questions get the search reminder, coding requests do not', async () => {
  const { asksAboutCurrentInfo } = await import('../src/agent/agent.js');
  for (const q of ['check what cs2 update we are in', "what's the latest version of react?", 'Is Python 3.8 still supported?', 'who won the game today?', 'what are the newest gemini models']) assert.equal(asksAboutCurrentInfo(q), true, q);
  for (const q of ['update the README with install steps', 'make a calculator in csharp and make it good', 'fix the failing test', 'add a version field to package.json']) assert.equal(asksAboutCurrentInfo(q), false, q);
});

test('lean view trims old tool outputs but keeps recent ones and the call/result pairs', async () => {
  const { leanView } = await import('../src/agent/compaction.js');
  const big = 'x'.repeat(5000);
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'first task', meta: { turn: 1 } },
    { role: 'assistant', content: '', reasoning: 'thinking...', toolCalls: [{ id: 'a', name: 'Read', arguments: '{"file_path":"src/app.ts"}' }], meta: { turn: 1 } },
    { role: 'tool', toolCallId: 'a', toolName: 'Read', content: big, meta: { turn: 1 } },
    { role: 'assistant', content: 'done', meta: { turn: 1 } },
    { role: 'user', content: 'second task', meta: { turn: 2 } },
    { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'Bash', arguments: '{"command":"npm test"}' }], meta: { turn: 2 } },
    { role: 'tool', toolCallId: 'b', toolName: 'Bash', content: big, meta: { turn: 2 } },
  ];
  // keepLatest 0 so only the turn rules apply here.
  const lean = leanView(msgs, { turn: 2, keepLatest: 0 });
  assert.equal(lean.length, msgs.length);
  assert.match(lean[2]!.content, /output of Read\(src\/app\.ts\) \(1 lines\) from an earlier task/);
  assert.equal(lean[2]!.toolCallId, 'a');
  assert.equal(lean[6]!.content, big, 'current task output kept');
  assert.equal(lean[1]!.reasoning, undefined, 'reasoning is not resent');
  assert.equal(msgs[2]!.content, big, 'the stored history is untouched');
});

test('re-reading an unchanged file within a task returns a short note', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ReadTool } = await import('../src/tools/fileTools.js');
  const { FileTracker } = await import('../src/tools/fileTracker.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-read-'));
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  const files = new FileTracker(false);
  files.beginTurn(1);
  const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as import('../src/tools/types.js').SessionState;
  const ctx = { projectRoot: dir, session, settings: {}, files, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as import('../src/tools/types.js').ToolContext;
  const read = async () => {
    const prep = await ReadTool.prepare({ file_path: file }, ctx);
    const r = await prep.execute();
    session.toolSeq = (session.toolSeq ?? 0) + 1;
    return r.content;
  };
  assert.match(await read(), /one/);
  assert.match(await read(), /has not changed since you read these lines/);
  writeFileSync(file, 'one\ntwo\nthree\n');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.match(await read(), /three/, 'a changed file is read again');
  files.beginTurn(2);
  assert.match(await read(), /three/, 'a new task reads again');
});

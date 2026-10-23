// End-to-end tests: run the real CLI in print mode against a mock OpenAI-compatible server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockServer, rateLimited, text, tools } from './helpers/mockServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '../../bin/freecode.js');

let server: MockServer;

before(async () => {
  server = new MockServer();
  await server.start();
});

after(async () => {
  await server.stop();
});

interface Env {
  home: string;
  project: string;
}

function setup(providers: Record<string, { model: string; quality: number; tools?: 'native' | 'text'; context?: number }>, extra: Record<string, unknown> = {}): Env {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fc-home-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'fc-proj-'));
  const cfg: Record<string, unknown> = {
    setupCompleted: true,
    router: { enabled: false, maxWaitSeconds: 1 },
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, p]) => [
        id,
        {
          baseURL: server.baseURL(id),
          apiKey: 'test-key',
          discover: false,
          models: [{ id: p.model, quality: p.quality, context: p.context ?? 100000, maxOutput: 4096, tools: p.tools ?? 'native', speed: 50 }],
        },
      ]),
    ),
    ...extra,
  };
  // Disable every built-in provider so only the mock ones are used.
  for (const id of ['gemini', 'openrouter', 'groq', 'cerebras', 'mistral', 'nvidia', 'cohere', 'zai', 'bigmodel', 'cloudflare', 'sambanova', 'huggingface', 'together', 'siliconflow', 'vercel', 'kilo', 'opencode', 'chutes', 'llm7', 'pollinations', 'ollama', 'lmstudio', 'dashscope', 'scaleway', 'deepseek', 'openai', 'anthropic', 'xai', 'moonshot']) {
    (cfg.providers as Record<string, unknown>)[id] = { enabled: false };
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  return { home, project };
}

function runCli(env: Env, args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: env.project,
      env: { ...process.env, FREECODE_HOME: env.home, NO_COLOR: '1', HOME: env.home, USERPROFILE: env.home, FREECODE_DEBUG: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.stdin.end(stdin);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

test('agent writes a file through a streamed tool call and finishes', async () => {
  const env = setup({ tw1: { model: 'm1', quality: 80 } });
  server.script('tw1', [tools({ name: 'Write', args: { file_path: 'hello.txt', content: 'hi there\n' } }), text('Created **hello.txt** for you.')]);
  const r = await runCli(env, ['-p', 'create hello.txt', '--yolo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Created \*\*hello\.txt\*\*/);
  assert.equal(readFileSync(path.join(env.project, 'hello.txt'), 'utf8'), 'hi there\n');
  const reqs = server.requestsFor('tw1');
  assert.equal(reqs.length, 2);
  const msgs = reqs[1]!.body.messages as { role: string; content: string; tool_call_id?: string }[];
  const toolMsg = msgs.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'second request carries the tool result');
  assert.match(toolMsg!.content, /Created hello\.txt/);
  assert.ok(Array.isArray(reqs[0]!.body.tools), 'native tools are sent');
});

test('fails over to another provider when the best one is rate limited', async () => {
  const env = setup({ rlA: { model: 'big', quality: 95 }, rlB: { model: 'small', quality: 60 } });
  server.script('rlA', [rateLimited(40)]);
  server.script('rlB', [text('answer from B')]);
  const r = await runCli(env, ['-p', 'hello there, explain recursion briefly', '--verbose']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /answer from B/);
  assert.equal(server.requestsFor('rlA').length, 1);
  assert.equal(server.requestsFor('rlB').length, 1);
  assert.match(r.stderr, /rate limited/i);
  // The cooldown is remembered: a second run goes straight to B.
  server.script('rlB', [text('second answer')]);
  const r2 = await runCli(env, ['-p', 'and again please, explain loops']);
  assert.match(r2.stdout, /second answer/);
  assert.equal(server.requestsFor('rlA').length, 1, 'rate-limited provider skipped while cooling down');
});

test('text-mode tool protocol works for models without native tools', async () => {
  const env = setup({ txt: { model: 'plain', quality: 70, tools: 'text' } });
  writeFileSync(path.join(env.project, 'notes.txt'), 'secret word: banana\n');
  server.script('txt', [
    text('Let me read it.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "notes.txt"}}\n</tool_call>'),
    text('The secret word is banana.'),
  ]);
  const r = await runCli(env, ['-p', 'what is the secret word in notes.txt?']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /banana/);
  const reqs = server.requestsFor('txt');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0]!.body.tools, undefined, 'no native tools in text mode');
  const sys = (reqs[0]!.body.messages as { role: string; content: string }[])[0]!;
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /<tool_call>/);
  const last = (reqs[1]!.body.messages as { role: string; content: string }[]).at(-1)!;
  assert.equal(last.role, 'user');
  assert.match(last.content, /<tool_result name="Read"/);
  assert.match(last.content, /banana/);
});

test('salvages tool calls that a native-mode model prints as text', async () => {
  const env = setup({ salv: { model: 'm', quality: 70 } });
  writeFileSync(path.join(env.project, 'a.txt'), 'alpha\n');
  server.script('salv', [text('<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}</tool_call>'), text('It says alpha.')]);
  const r = await runCli(env, ['-p', 'read a.txt']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /It says alpha/);
  const msgs = server.requestsFor('salv')[1]!.body.messages as { role: string; content: string }[];
  assert.ok(msgs.some((m) => m.role === 'tool' && /alpha/.test(m.content)));
});

test('edits are denied without approval in non-interactive mode', async () => {
  const env = setup({ deny: { model: 'm', quality: 70 } });
  server.script('deny', [tools({ name: 'Write', args: { file_path: 'x.txt', content: 'nope' } }), text('I could not write the file.')]);
  const r = await runCli(env, ['-p', 'write x.txt']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(path.join(env.project, 'x.txt')), false);
  const msgs = server.requestsFor('deny')[1]!.body.messages as { role: string; content: string }[];
  assert.ok(msgs.some((m) => m.role === 'tool' && /Permission denied/.test(m.content)));
});

test('read-only bash commands run without approval; --allowedTools grants others', async () => {
  const env = setup({ sh: { model: 'm', quality: 70 } });
  server.script('sh', [tools({ name: 'Bash', args: { command: 'echo hello-from-bash' } }), tools({ name: 'Bash', args: { command: 'touch made.txt' } }), text('done')]);
  const r = await runCli(env, ['-p', 'run things', '--allowedTools', 'Bash(touch:*)']);
  assert.equal(r.code, 0, r.stderr);
  const msgs = server.requestsFor('sh')[2]!.body.messages as { role: string; content: string }[];
  const results = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(results[0]!, /hello-from-bash/);
  assert.ok(existsSync(path.join(env.project, 'made.txt')), 'allowed command ran');
});

test('tool calls without index fields (Gemini style) are accumulated correctly', async () => {
  const env = setup({ noidx: { model: 'm', quality: 70 } });
  writeFileSync(path.join(env.project, 'f1.txt'), 'one\n');
  writeFileSync(path.join(env.project, 'f2.txt'), 'two\n');
  server.script('noidx', [
    { kind: 'tools', omitIndex: true, calls: [{ name: 'Read', args: { file_path: 'f1.txt' } }, { name: 'Read', args: { file_path: 'f2.txt' } }] },
    text('one and two'),
  ]);
  const r = await runCli(env, ['-p', 'read both']);
  assert.equal(r.code, 0, r.stderr);
  const msgs = server.requestsFor('noidx')[1]!.body.messages as { role: string; content: string }[];
  const results = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(results.length, 2);
  assert.match(results[0]!, /one/);
  assert.match(results[1]!, /two/);
});

test('context-length errors teach the router a limit and fail over', async () => {
  const env = setup({ ctxA: { model: 'small-ctx', quality: 90 }, ctxB: { model: 'large', quality: 60 } });
  server.script('ctxA', [{ kind: 'error', status: 400, body: { error: { message: "This model's maximum context length is 4096 tokens. However, you requested 9000 tokens." } } }]);
  server.script('ctxB', [text('handled by B')]);
  const r = await runCli(env, ['-p', 'summarize the universe']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /handled by B/);
});

test('tools_unsupported switches the same model to the text protocol', async () => {
  const env = setup({ notools: { model: 'm', quality: 70 } });
  server.on('notools', (req) => {
    if (req.body.tools) return { kind: 'error', status: 400, body: { error: { message: 'This model does not support tools' } } };
    return text('answered in text mode');
  });
  const r = await runCli(env, ['-p', 'hi, explain closures']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /answered in text mode/);
});

test('json output format reports the result and usage', async () => {
  const env = setup({ js: { model: 'm', quality: 70 } });
  server.script('js', [text('json answer')]);
  const r = await runCli(env, ['-p', 'say something', '--output-format', 'json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result, 'json answer');
  assert.equal(out.is_error, false);
  assert.ok(out.usage.totalTokens > 0);
});

test('stdin is appended to the prompt', async () => {
  const env = setup({ stdin: { model: 'm', quality: 70 } });
  server.script('stdin', [text('ok')]);
  const r = await runCli(env, ['-p', 'explain this'], 'console.log("piped")');
  assert.equal(r.code, 0, r.stderr);
  const user = (server.requestsFor('stdin')[0]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!;
  assert.match(user.content, /piped/);
});

test('reports a clear error when every provider fails', async () => {
  const env = setup({ dead: { model: 'm', quality: 70 } });
  server.script('dead', [{ kind: 'error', status: 401, body: { error: { message: 'Invalid API key' } } }]);
  const r = await runCli(env, ['-p', 'hello friend, write a poem']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rate limited or failing|No AI provider|key/i);
});

// ------------------------------------------------------------------ failover problems seen in real use

/** Like setup(), but with the real built-in provider definitions (quirks included) pointed at the mock. */
function setupBuiltin(providers: Record<string, (string | { id: string; quality: number })[]>): Env {
  const env = setup({});
  const cfgFile = path.join(env.home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { providers: Record<string, unknown> };
  for (const [id, models] of Object.entries(providers)) {
    cfg.providers[id] = {
      baseURL: server.baseURL(id),
      apiKey: 'test-key',
      discover: false,
      models: models.map((m, i) => ({ id: typeof m === 'string' ? m : m.id, quality: typeof m === 'string' ? 99 - i * 5 : m.quality, context: 100000, maxOutput: 4096, tools: 'native', speed: 90 })),
    };
  }
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return env;
}

type WireCall = { id: string; function: { name: string }; extra_content?: { google?: { thought_signature?: string } } };
const assistantCalls = (body: Record<string, unknown>) =>
  ((body.messages as { role: string; tool_calls?: WireCall[] }[]) ?? []).filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls!);

test('Gemini 3: echoes its thought signatures and adds the placeholder for other models\' tool calls', async () => {
  const env = setupBuiltin({ groq: ['tool-maker'], gemini: [{ id: 'gemini-3-flash-preview', quality: 70 }] });
  writeFileSync(path.join(env.project, 'a.txt'), 'alpha\n');
  writeFileSync(path.join(env.project, 'b.txt'), 'beta\n');
  // Groq makes the first tool call, then hits its limit; Gemini continues the task.
  server.script('groq', [tools({ name: 'Read', args: { file_path: 'a.txt' } }), rateLimited(60)]);
  const seen: WireCall[][] = [];
  server.on('gemini', (req, i) => {
    const calls = assistantCalls(req.body);
    seen.push(calls);
    // What the real API does: tool calls without a signature are rejected.
    if (calls.some((c) => !c.extra_content?.google?.thought_signature)) {
      return { kind: 'error', status: 400, body: { error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.', status: 'INVALID_ARGUMENT' } } };
    }
    if (i === 0) return { kind: 'tools', calls: [{ name: 'Read', args: { file_path: 'b.txt' }, extra: { google: { thought_signature: 'sig-from-gemini' } } }] };
    return text('Both files read.');
  });
  const r = await runCli(env, ['-p', 'read a.txt and then b.txt', '--yolo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Both files read/);
  assert.equal(seen.length, 2, 'no request was rejected');
  assert.equal(seen[0]![0]!.extra_content?.google?.thought_signature, 'skip_thought_signature_validator', "placeholder on Groq's call");
  const sigs = seen[1]!.map((c) => c.extra_content?.google?.thought_signature);
  assert.deepEqual(sigs, ['skip_thought_signature_validator', 'sig-from-gemini'], "Gemini's own signature is sent back");
  // Other providers never see the Gemini-only field.
  server.script('groq', [text('done')]);
});

test('a rejected tool history is resent as plain text instead of giving up on the model', async () => {
  const env = setup({ th1: { model: 'first', quality: 90 }, th2: { model: 'strict', quality: 80 } });
  writeFileSync(path.join(env.project, 'notes.md'), '# notes\n');
  server.script('th1', [tools({ name: 'Read', args: { file_path: 'notes.md' } }), rateLimited(60)]);
  server.on('th2', (req) => {
    const msgs = req.body.messages as { role: string; tool_calls?: unknown[] }[];
    if (msgs.some((m) => m.role === 'tool' || m.tool_calls)) return { kind: 'error', status: 400, body: { error: { message: 'Invalid tool_call history: unexpected function call' } } };
    return text('Read it via text history.');
  });
  const r = await runCli(env, ['-p', 'read notes.md', '--yolo', '--verbose']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Read it via text history/);
  const last = server.requestsFor('th2').at(-1)!.body;
  const msgs = last.messages as { role: string; content: string }[];
  assert.ok(msgs.some((m) => m.role === 'user' && /notes/.test(m.content)), 'the tool result travels as text');
  assert.ok(Array.isArray(last.tools), 'native tools stay available');
});

test("recovers a tool call from Groq's tool_use_failed error", async () => {
  const env = setup({ tuf: { model: 'oss', quality: 90 } });
  const failed = '<|channel|>commentary to=functions.Write <|constrain|>json<|message|>{"file_path":"out.txt","content":"ok\\n"}<|call|>';
  server.script('tuf', [
    { kind: 'error', status: 400, body: { error: { message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.", type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: failed } } },
    text('Wrote out.txt.'),
  ]);
  const r = await runCli(env, ['-p', 'write ok to out.txt', '--yolo']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(env.project, 'out.txt'), 'utf8'), 'ok\n');
  assert.match(r.stdout, /Wrote out\.txt/);
});

test('models with zero free quota are benched for days', async () => {
  const env = setupBuiltin({ gemini: ['gemini-3-pro-preview', 'gemini-3-flash-preview'] });
  server.on('gemini', (req) => {
    if (req.body.model === 'gemini-3-pro-preview') {
      return { kind: 'error', status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro-preview' } } };
    }
    return text(`answer from ${req.body.model}`);
  });
  const r = await runCli(env, ['-p', 'explain closures in javascript', '--verbose']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /answer from gemini-/);
  assert.doesNotMatch(r.stdout, /gemini-3-pro-preview/);
  assert.match(r.stderr, /no free quota/);
  const health = JSON.parse(readFileSync(path.join(env.home, 'state', 'health.json'), 'utf8')) as { models: Record<string, { disabledUntil?: number }> };
  const pro = Object.entries(health.models).find(([k]) => k.endsWith('gemini-3-pro-preview'))?.[1];
  assert.ok(pro?.disabledUntil && pro.disabledUntil - Date.now() > 2 * 24 * 3600_000, 'benched for days');
});

/** setup() plus the built-in Anthropic provider (its own model list) pointed at the mock. */
function setupClaude(extra: Record<string, unknown> = {}): Env {
  const env = setup({ free1: { model: 'free-model', quality: 80 } }, extra);
  const cfgFile = path.join(env.home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { providers: Record<string, unknown> };
  cfg.providers.anthropic = { baseURL: server.baseURL('anthropic'), apiKey: 'test-key', discover: false };
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return env;
}

type Block = { type: string; [k: string]: unknown };
type AnthropicMessage = { role: string; content: Block[] };

test('Claude: auto mode skips the paid key, a picked Claude model gets a cached Messages API request', async () => {
  const env = setupClaude({ temperature: 0.2, effort: 'low' });
  server.script('free1', [text('free answer')]);
  const auto = await runCli(env, ['-p', 'say hi']);
  assert.equal(auto.code, 0, auto.stderr);
  assert.match(auto.stdout, /free answer/);
  assert.equal(server.requestsFor('anthropic').length, 0, 'paid models stay out of auto mode');
  assert.equal(server.requestsFor('free1').at(-1)!.body.temperature, 0.2, 'other providers still get the temperature');

  server.script('anthropic', [text('Claude here.')]);
  const picked = await runCli(env, ['-p', 'say hi', '--model', 'anthropic/claude-opus-5-5']);
  assert.equal(picked.code, 0, picked.stderr);
  assert.match(picked.stdout, /Claude here/);
  const req = server.requestsFor('anthropic').at(-1)!;
  const body = req.body;
  assert.equal(req.path, '/messages');
  // SDK 1.x sends the API key as a bearer token, which the API accepts for keys.
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.match(String(req.headers['anthropic-beta']), /thinking-binding-controls-2026-08-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  // Claude 4.7 and later answer 400 to sampling parameters and to a forced tool_choice.
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.ok(!(k in body), `no ${k}`);
  // Two cache breakpoints: after the system prompt (caches tools and system) and at the end of the conversation.
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  const system = body.system as { text: string; cache_control?: unknown }[];
  assert.deepEqual(system.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(body.output_config, { effort: 'low' });
  const tools = body.tools as { name: string; eager_input_streaming?: boolean }[];
  assert.ok(tools.length > 5 && tools.every((t) => t.eager_input_streaming === true));
  assert.ok(typeof body.max_tokens === 'number' && (body.max_tokens as number) > 0);
});

test('Claude: thinking blocks go back unchanged, tool results lead the next turn, cache use is counted', async () => {
  const env = setupClaude();
  writeFileSync(path.join(env.project, 'notes.md'), '# notes\nalpha\n');
  server.script('anthropic', [
    { kind: 'tools', reasoning: 'Read the notes first.', text: 'Reading it.', calls: [{ name: 'Read', args: { file_path: 'notes.md' } }] },
    text('The notes say alpha.', { reasoning: 'It says alpha.' }),
  ]);
  const before = server.requestsFor('anthropic').length;
  const r = await runCli(env, ['-p', 'what do my notes say?', '--model', 'anthropic/claude-sonnet-5-5', '--yolo', '--output-format', 'json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { result: string; usage: { cacheReadTokens?: number; cacheWriteTokens?: number; promptTokens: number } };
  assert.match(out.result, /alpha/);
  const reqs = server.requestsFor('anthropic').slice(before);
  assert.equal(reqs.length, 2);
  const msgs = reqs[1]!.body.messages as AnthropicMessage[];
  const asst = msgs.find((m) => m.role === 'assistant')!;
  assert.deepEqual(asst.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(asst.content[0], { type: 'thinking', thinking: 'Read the notes first.', signature: 'sig-0' });
  assert.deepEqual(asst.content[2]!.input, { file_path: 'notes.md' });
  const next = msgs[msgs.indexOf(asst) + 1]!;
  assert.equal(next.role, 'user');
  assert.equal(next.content[0]!.type, 'tool_result');
  assert.equal(next.content[0]!.tool_use_id, asst.content[2]!.id);
  assert.match(String(next.content[0]!.content), /alpha/);
  // The first request must be a prefix of the second one, so the cache written by step 1 is read by step 2.
  const first = reqs[0]!.body;
  assert.deepEqual(first.system, reqs[1]!.body.system);
  assert.deepEqual(first.tools, reqs[1]!.body.tools);
  assert.deepEqual((first.messages as AnthropicMessage[])[0], msgs[0]);
  // Usage includes the mock's cache reads and writes (900 written, then 900 read).
  assert.equal(out.usage.cacheReadTokens, 900);
  assert.equal(out.usage.cacheWriteTokens, 960);
});

test('effort reaches models that take one in their own format and no others', async () => {
  const env = setupBuiltin({ groq: [{ id: 'openai/gpt-oss-120b', quality: 90 }, { id: 'moonshotai/kimi-k2-instruct', quality: 60 }] });
  const cfgFile = path.join(env.home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { effort?: string; providers: Record<string, { models: { limits?: unknown }[] }> };
  cfg.effort = 'max';
  // Groq's real per-minute token caps are smaller than FreeCode's full prompt; lift them for the test.
  for (const m of cfg.providers.groq!.models) m.limits = { rpm: 1000, rpd: 100000, tpm: 1000000 };
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  server.script('groq', [text('done')]);
  // The last request of a run can be the session title; look for the model's own request.
  const lastFor = (model: string) => server.requestsFor('groq').filter((q) => q.body.model === model).at(-1)!.body;
  const r = await runCli(env, ['-p', 'hi', '--model', 'groq/openai/gpt-oss-120b']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastFor('openai/gpt-oss-120b').reasoning_effort, 'high', 'max is the highest OpenAI-style level');
  const r2 = await runCli(env, ['-p', 'hi', '--model', 'groq/moonshotai/kimi-k2-instruct']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!('reasoning_effort' in lastFor('moonshotai/kimi-k2-instruct')), 'models without effort get none');
});

test('a picked paid model works when no free provider is configured', async () => {
  const env = setup({});
  const cfgFile = path.join(env.home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as { providers: Record<string, unknown> };
  cfg.providers.anthropic = { baseURL: server.baseURL('anthropic'), apiKey: 'test-key', discover: false };
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  server.script('anthropic', [text('Only Claude here.')]);
  const r = await runCli(env, ['-p', 'hi', '--model', 'anthropic/claude-haiku-5-5']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Only Claude here/);
});

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

// Background shells: the listing with run time, status and listening ports, and the warning when a second
// dev server would use a port a running shell already holds. Starts real Node HTTP servers.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BashOutputTool, BashTool, KillShellTool, killAllShells } from '../src/tools/bash.js';
import { guessServerPort, parseLsof, parseNetstat, parseSs } from '../src/tools/ports.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import type { SessionState, Tool, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-shells-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
const ctx = { projectRoot: dir, session, settings: { env: {} }, files: new FileTracker(false), signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;

after(() => killAllShells(session.shells));

async function call(tool: Tool, input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await tool.prepare(input, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  return prep.execute();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('ss, lsof and netstat output is read into pid and port pairs', () => {
  const ss =
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n' +
    'LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4242,fd=21))\n' +
    'LISTEN 0      4096            [::]:8080          [::]:*    users:(("python3",pid=77,fd=3),("python3",pid=78,fd=3))\n';
  assert.deepEqual(parseSs(ss), [{ pid: 4242, port: 5173 }, { pid: 77, port: 8080 }, { pid: 78, port: 8080 }]);
  assert.deepEqual(parseLsof('p4242\nf21\nn127.0.0.1:5173\nn[::1]:5174\np99\nf3\nn*:3000\n'), [
    { pid: 4242, port: 5173 },
    { pid: 4242, port: 5174 },
    { pid: 99, port: 3000 },
  ]);
  const netstat =
    '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n' +
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       5120\r\n' +
    '  TCP    127.0.0.1:52000        127.0.0.1:3000         ESTABLISHED     900\r\n' +
    '  TCP    [::]:5173              [::]:0                 ABH\u00d6REN         6000\r\n' +
    '  UDP    0.0.0.0:5353           *:*                                    1700\r\n';
  assert.deepEqual(parseNetstat(netstat), [{ pid: 5120, port: 3000 }, { pid: 6000, port: 5173 }]);
});

test('the port a dev server command will use is guessed from flags, defaults and package.json scripts', () => {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 3001', start: 'next start', test: 'jest' } }));
  assert.equal(guessServerPort('npx vite', dir), 5173);
  assert.equal(guessServerPort('vite build', dir), null);
  assert.equal(guessServerPort('next dev -p 4000', dir), 4000);
  assert.equal(guessServerPort('PORT=4100 node server.js', dir), 4100);
  assert.equal(guessServerPort('python -m http.server 9000', dir), 9000);
  assert.equal(guessServerPort('python manage.py runserver 0.0.0.0:8001', dir), 8001);
  assert.equal(guessServerPort('php -S localhost:8080 -t public', dir), 8080);
  assert.equal(guessServerPort('npm run dev', dir), 3001);
  assert.equal(guessServerPort('npm start', dir), 3000);
  assert.equal(guessServerPort('npm test', dir), null);
  assert.equal(guessServerPort('uvicorn app:app --reload', dir), 8000);
  assert.equal(guessServerPort('mkdir -p 755 out', dir), null);
  assert.equal(guessServerPort('ls -la', dir), null);
});

test('BashOutput without an id lists background shells with their listening ports and a second server is warned', { timeout: 60_000 }, async () => {
  assert.match((await call(BashOutputTool, {})).content, /No background shells/);
  const server = path.join(dir, 'server.cjs');
  writeFileSync(
    server,
    "const http = require('http');\n" +
      "const s = http.createServer((q, r) => r.end('ok'));\n" +
      "s.on('error', (e) => { console.log('error ' + e.code); process.exit(1); });\n" +
      "s.listen(0, '127.0.0.1', () => console.log('listening on ' + s.address().port));\n",
  );
  const script = server.replace(/\\/g, '/');
  const started = await call(BashTool, { command: `node "${script}"`, run_in_background: true });
  assert.match(started.content, /Started in background as shell_1/);
  let output = '';
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) {
    output += (await call(BashOutputTool, { bash_id: 'shell_1' })).content;
    port = Number(/listening on (\d+)/.exec(output)?.[1] ?? 0);
    if (!port) await sleep(100);
  }
  assert.ok(port, `the server reported its port: ${output}`);

  const list = await call(BashOutputTool, {});
  assert.match(list.content, /^1 background shell:/);
  assert.match(list.content, new RegExp(`shell_1: running for [^\\n]*listening on port ${port}\\n  \\$ node "`));

  const second = await call(BashTool, { command: `node "${script}" --port ${port}`, run_in_background: true });
  assert.match(second.content, new RegExp(`Port ${port} is already in use by shell_1 \\(node `));

  await call(KillShellTool, { shell_id: 'shell_1' });
  await call(KillShellTool, { shell_id: 'shell_2' });
  assert.match((await call(BashOutputTool, {})).content, /No background shells/);
});

test('a shell that exited is listed with its exit code and run time', { timeout: 30_000 }, async () => {
  await call(BashTool, { command: 'node -e "process.exit(3)"', run_in_background: true });
  const id = [...session.shells.keys()].pop()!;
  for (let i = 0; i < 200 && session.shells.get(id)!.running; i++) await sleep(50);
  const list = await call(BashOutputTool, {});
  assert.match(list.content, new RegExp(`${id}: exited with code 3 after \\d`));
  await call(KillShellTool, { shell_id: id });
});

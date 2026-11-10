// Tests for the code index: search ranking, symbols, cross-project links, profiles, incremental
// refresh, unused definitions, git history and the CodeSearch tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexManager, applyIndexSettings, getIndex } from '../src/codeindex/index.js';
import { splitWords, stem, queryTerms } from '../src/codeindex/tokenize.js';
import { readmeSummary } from '../src/codeindex/projects.js';
import { hasGit } from '../src/util/git.js';
import type { SessionState, ToolContext } from '../src/tools/types.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fc-index-'));
process.env.FREECODE_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'Projects');
const app = path.join(root, 'app');

function write(rel: string, content: string | Buffer): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Changes a file and moves its mtime forward, so the change shows even on coarse-mtime file systems. */
function touch(rel: string, content: string): void {
  write(rel, content);
  const later = new Date(Date.now() + 10_000);
  utimesSync(path.join(root, rel), later, later);
}

let idx: IndexManager;

before(async () => {
  write('mylib/package.json', JSON.stringify({ name: 'mylib', version: '1.2.0', description: 'Combat math for the game projects', main: 'index.js', scripts: { test: 'node --test' } }));
  write('mylib/README.md', '# mylib\n\n[![build](https://x/badge.svg)](https://x)\n\nCombat math helpers shared by the **game** projects.\n\nMore text.\n');
  write(
    'mylib/index.js',
    [
      '// Combat math shared by the game projects.',
      'export const MAX_ARMOR = 100;',
      '',
      '/**',
      ' * Calculates the damage a hit deals after armor.',
      ' */',
      'export function computeDamage(attack, armor) {',
      '  const reduced = attack - Math.min(armor, MAX_ARMOR) * 0.5;',
      '  return Math.max(1, Math.round(reduced));',
      '}',
      '',
      'export function legacyFormula(a, b) {',
      '  return a * 2 - b;',
      '}',
      '',
    ].join('\n'),
  );
  write('app/package.json', JSON.stringify({ name: 'game-app', version: '0.1.0', scripts: { start: 'node src/main.js', build: 'tsc -p .' }, dependencies: { mylib: 'file:../mylib', express: '4.19.2' }, devDependencies: { typescript: '5.9.3' } }));
  write('app/tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');
  write('app/.env.example', 'API_KEY=\nDB_URL=postgres://localhost/game\nPORT=3000\n');
  write('app/.env', 'PORT=8080\nSECRET_VALUE=do-not-index\n');
  write(
    'app/src/main.js',
    [
      "import express from 'express';",
      "import { computeDamage } from 'mylib';",
      "import { formatScore } from './score.js';",
      '',
      'const server = express();',
      "server.get('/hit', (req, res) => {",
      '  const dmg = computeDamage(Number(req.query.attack), Number(req.query.armor));',
      '  res.json({ damage: dmg, text: formatScore(dmg) });',
      '});',
      'server.listen(3000);',
      '',
    ].join('\n'),
  );
  write('app/src/score.js', 'export function formatScore(value) {\n  return `Score: ${value}`;\n}\n');
  // Things the walker must skip: vendor folders, build output, binary data, huge files.
  write('app/node_modules/leftpad/index.js', 'export function vendoredOnlyFunction() {}\n');
  write('engine/bin/Debug/Engine.deps.json', '{ "buildOutputMarker": true }\n');
  write('app/data.blob', Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
  write('app/big.txt', `hugeFileMarker ${'x'.repeat(1024 * 1024 + 10)}`);
  write('app/.gitignore', 'generated/\n*.local.js\n');
  write('app/generated/out.js', 'export function generatedMarker() {}\n');
  write('app/src/dev.local.js', 'export function localOnlyMarker() {}\n');

  write('pytool/pyproject.toml', '[project]\nname = "pytool"\nversion = "0.3.0"\ndescription = "Stats helpers"\nrequires-python = ">=3.10"\ndependencies = [\n  "requests>=2.31",\n  "numpy==1.26.4",\n]\n');
  write('pytool/pytool/__init__.py', 'from .stats import average\n');
  write('pytool/pytool/stats.py', 'def average(values):\n    """Mean of a list of numbers."""\n    return sum(values) / len(values)\n\n\nclass Histogram:\n    def add(self, value):\n        self.values.append(value)\n');

  write('engine/Engine.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>\n</Project>\n');
  write(
    'engine/Physics.cs',
    ['namespace Engine.Physics', '{', '    public class RigidBody', '    {', '        public float Mass { get; set; }', '        public float Velocity;', '', '        public void ApplyForce(float force)', '        {', '            Velocity += force / Mass;', '        }', '    }', '}', ''].join('\n'),
  );
  write('editor/Editor.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n');
  write('editor/Program.cs', ['using Engine.Physics;', '', 'class Program', '{', '    static void Main()', '    {', '        var body = new RigidBody { Mass = 2 };', '        body.ApplyForce(10);', '    }', '}', ''].join('\n'));

  idx = new IndexManager({ minWalkIntervalMs: 0 });
  idx.setRoots([root]);
  await idx.ensureProject(app);
});

after(async () => {
  await idx?.close();
  await getIndex().close();
  rmSync(tmp, { recursive: true, force: true });
});

test('tokenizer splits identifiers and stems word forms the same way', () => {
  assert.deepEqual(splitWords('getHTTPResponse2'), ['get', 'http', 'response2']);
  assert.deepEqual(splitWords('MAX_HEALTH'), ['max', 'health']);
  assert.equal(stem('calculated'), stem('calculate'));
  assert.equal(stem('calculation'), stem('calculates'));
  assert.equal(stem('rendering'), stem('render'));
  const terms = queryTerms('how is computeDamage calculated').map((t) => t.term);
  assert.ok(terms.includes('computedamage'), 'the whole identifier is kept');
  assert.ok(!terms.includes('how') && !terms.includes('is'), 'stopwords are dropped');
});

test('README summary skips the title and badges', () => {
  assert.equal(readmeSummary('# mylib\n\n[![build](x)](y)\n\nCombat math **helpers**.\n\nMore.'), 'Combat math helpers.');
});

test('a natural language query ranks the defining chunk first', async () => {
  const res = await idx.search('how is damage calculated', { scope: 'all' });
  assert.ok(res.hits.length > 0);
  assert.equal(res.hits[0]!.rel, 'mylib/index.js');
  assert.match(res.hits[0]!.symbol ?? '', /computeDamage/);
  assert.ok(res.hits[0]!.start <= 7 && res.hits[0]!.end >= 7, 'the chunk covers the function');
  // Default scope is the current project (app): only its files.
  const local = await idx.search('damage', { projectRoot: app });
  assert.ok(local.hits.length > 0);
  assert.ok(local.hits.every((h) => h.rel.startsWith('app/')));
});

test('vendor folders, build output, ignored, binary and oversized files are not indexed', async () => {
  // Exact identifiers: none of these files is in the index.
  for (const q of ['vendoredOnlyFunction', 'buildOutputMarker', 'hugeFileMarker', 'generatedMarker', 'localOnlyMarker']) {
    assert.equal((await idx.references(q, { scope: 'all' })).hits.length, 0, q);
  }
  assert.deepEqual((await idx.search('vendoredOnlyFunction', { scope: 'all' })).unknownWords, ['vendoredOnlyFunction']);
  assert.equal((await idx.references('SECRET_VALUE', { scope: 'all' })).hits.length, 0, '.env is never indexed');
});

test('definitions and references', async () => {
  const defs = await idx.definitions('computeDamage', { scope: 'all' });
  assert.equal(defs.length, 1);
  assert.equal(defs[0]!.rel, 'mylib/index.js');
  assert.equal(defs[0]!.line, 7);
  assert.equal(defs[0]!.kind, 'function');
  assert.ok(defs[0]!.exported);
  const cs = await idx.definitions('RigidBody.ApplyForce', { scope: 'all' });
  assert.equal(cs[0]?.rel, 'engine/Physics.cs');
  assert.equal(cs[0]?.kind, 'method');
  assert.equal(cs[0]?.parent, 'RigidBody');
  const py = await idx.definitions('average', { scope: 'all' });
  assert.equal(py[0]?.rel, 'pytool/pytool/stats.py');

  const refs = await idx.references('computeDamage', { scope: 'all' });
  assert.deepEqual(
    refs.hits.map((h) => `${h.rel}:${h.line}`),
    ['app/src/main.js:2', 'app/src/main.js:7'],
  );
  // From inside mylib the users live in another project.
  const scoped = await idx.references('computeDamage', { scope: 'mylib' });
  assert.equal(scoped.hits.length, 0);
  assert.equal(scoped.outOfScope, 1);
});

test('imports link projects: JS package names and C# namespaces', async () => {
  const appProfile = await idx.projectProfile('game-app');
  assert.ok(appProfile);
  const uses = appProfile.uses.find((u) => u.name === 'mylib');
  assert.ok(uses, 'game-app uses mylib');
  assert.deepEqual(uses.files, ['src/main.js']);
  assert.ok(uses.declared, 'mylib is also a dependency in package.json');
  const lib = await idx.projectProfile('mylib');
  assert.deepEqual(lib?.usedBy.map((u) => u.name), ['game-app']);
  const editor = await idx.projectProfile('editor');
  assert.deepEqual(editor?.uses.map((u) => u.name), ['Engine']);
});

test('project profiles: dependencies with versions, scripts, configs and missing .env keys', async () => {
  const p = await idx.projectProfile(app);
  assert.ok(p);
  assert.equal(p.name, 'game-app');
  assert.deepEqual(p.dependencies.find((d) => d.name === 'express'), { name: 'express', version: '4.19.2' });
  assert.deepEqual(p.dependencies.find((d) => d.name === 'typescript'), { name: 'typescript', version: '5.9.3', dev: true });
  assert.equal(p.scripts.start, 'node src/main.js');
  assert.ok(p.configs.includes('tsconfig.json'));
  assert.ok(p.configs.includes('.env.example'));
  assert.deepEqual(p.envMissing, ['API_KEY', 'DB_URL']);
  assert.deepEqual(p.languages, [{ name: 'JavaScript', files: 2 }]);

  const py = await idx.projectProfile('pytool');
  assert.deepEqual(py?.dependencies, [
    { name: 'requests', version: '>=2.31' },
    { name: 'numpy', version: '==1.26.4' },
  ]);
  assert.ok(py?.platform.includes('python >=3.10'));
  const engine = await idx.projectProfile('engine');
  assert.deepEqual(engine?.dependencies, [{ name: 'Newtonsoft.Json', version: '13.0.3' }]);
  assert.ok(engine?.platform.includes('net8.0'));
  const lib = await idx.projectProfile('mylib');
  assert.equal(lib?.readme, 'Combat math helpers shared by the game projects.');

  const names = idx.projects().map((x) => x.name).sort();
  assert.deepEqual(names, ['Editor', 'Engine', 'game-app', 'mylib', 'pytool']);
});

test('the prompt sections describe this project and list the others', async () => {
  const text = await idx.preparePromptSection(app);
  assert.match(text, /# Project profile/);
  assert.match(text, /express 4\.19\.2/);
  assert.match(text, /API_KEY, DB_URL/);
  assert.match(text, /# Other projects/);
  assert.match(text, /- mylib \(JavaScript\): Combat math for the game projects/);
  assert.match(text, /Use CodeSearch with scope "all" to look across them/);
  assert.equal(idx.promptSection(app), text, 'cached for the next request');
  const current = text.split('# Other projects')[0]!.trim().split('\n');
  assert.ok(current.length <= 20);
});

test('switching the current project keeps profiles and links intact', async () => {
  await idx.ensureProject(path.join(root, 'editor'));
  const other = await idx.projectProfile('game-app');
  assert.deepEqual(other?.languages, [{ name: 'JavaScript', files: 2 }]);
  assert.deepEqual(other?.uses.map((u) => u.name), ['mylib']);
  assert.match(await idx.preparePromptSection(path.join(root, 'editor')), /Uses these other indexed projects: Engine/);
  await idx.ensureProject(app);
});

test('unused report lists exported definitions nobody references', async () => {
  const r = await idx.unused('mylib');
  assert.ok(r);
  assert.equal(r.approximate, true);
  const names = r.symbols.map((s) => s.name);
  assert.ok(names.includes('legacyFormula'));
  assert.ok(!names.includes('computeDamage'), 'used by another project');
  assert.ok(!names.includes('MAX_ARMOR'), 'used in its own file');
});

test('incremental refresh picks up a changed file and a deleted one', async () => {
  touch('app/src/score.js', 'export function formatScore(value) {\n  return `Score: ${value}`;\n}\n\nexport function formatTime(ms) {\n  return `${ms} ms`;\n}\n');
  await idx.refresh();
  assert.equal(idx.lastRefresh.analyzed, 1, 'only the changed file is read again');
  assert.equal((await idx.definitions('formatTime', { scope: 'all' }))[0]?.rel, 'app/src/score.js');

  rmSync(path.join(root, 'pytool/pytool/stats.py'));
  await idx.refresh();
  assert.equal(idx.lastRefresh.removed, 1);
  assert.equal(idx.lastRefresh.analyzed, 0);
  assert.equal((await idx.definitions('average', { scope: 'all' })).length, 0);
  assert.equal((await idx.search('Histogram', { scope: 'all' })).hits.length, 0);
});

test('changes reported by touchPaths (or the file watcher) are indexed without a full walk', async () => {
  const m = new IndexManager({ minWalkIntervalMs: 60_000 }); // no second walk unless one is needed
  m.setRoots([root]);
  await m.ensureProject(app);
  touch('app/src/score.js', 'export function formatScore(value) {\n  return `Score: ${value}`;\n}\n\nexport function formatDuration(ms) {\n  return `${ms / 1000} s`;\n}\n');
  write('app/src/extra.js', 'export function extraHelper() {\n  return 1;\n}\n');
  m.touchPaths([path.join(app, 'src', 'score.js'), path.join(app, 'src', 'extra.js')]);
  await m.refresh();
  assert.equal(m.lastRefresh.walked, 0, 'no walk');
  assert.equal(m.lastRefresh.analyzed, 2);
  assert.equal((await m.definitions('formatDuration', { scope: 'all' }))[0]?.rel, 'app/src/score.js');
  assert.equal((await m.definitions('extraHelper', { scope: 'all' }))[0]?.rel, 'app/src/extra.js');
  // A new folder needs a walk (it may hold ignored files); a deleted one does not.
  write('app/src/gone/x.js', 'export function goneSoon() {}\n');
  m.touchPaths([path.join(app, 'src', 'gone')]);
  await m.refresh();
  await m.refresh();
  assert.equal((await m.definitions('goneSoon', { scope: 'all' })).length, 1);
  rmSync(path.join(app, 'src', 'gone'), { recursive: true, force: true });
  m.touchPaths([path.join(app, 'src', 'gone')]);
  await m.refresh();
  assert.equal(m.lastRefresh.walked, 0);
  assert.equal(m.lastRefresh.removed, 1);
  assert.equal((await m.definitions('goneSoon', { scope: 'all' })).length, 0);
  await m.close();
});

function canWatchRecursively(): boolean {
  try {
    watch(tmp, { recursive: true, persistent: false }).close();
    return true;
  } catch {
    return false;
  }
}

test('the file watcher re-indexes saved files', { skip: !canWatchRecursively() && 'no recursive fs.watch on this platform' }, async () => {
  const m = new IndexManager({ watch: true });
  m.setRoots([root]);
  await m.ensureProject(app);
  m.startAutoRefresh(3_600_000);
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 100));
  };
  write('app/src/watched.js', 'export function watchedOne() {}\n');
  await until(async () => (await m.definitions('watchedOne', { scope: 'all' })).length > 0);
  assert.equal((await m.definitions('watchedOne', { scope: 'all' })).length, 1);
  write('app/src/watched.js', 'export function watchedTwo() {}\n');
  await until(async () => (await m.definitions('watchedTwo', { scope: 'all' })).length > 0);
  assert.equal((await m.definitions('watchedTwo', { scope: 'all' })).length, 1);
  assert.equal((await m.definitions('watchedOne', { scope: 'all' })).length, 0);
  await m.close();
});

test('a saved index loads without reading the files again', async () => {
  const dir = path.join(tmp, 'persisted');
  const first = new IndexManager({ dir, minWalkIntervalMs: 0 });
  first.setRoots([root]);
  await first.ensureProject(app);
  assert.ok(first.lastRefresh.analyzed > 10);
  await first.close();
  const again = new IndexManager({ dir, minWalkIntervalMs: 0 });
  again.setRoots([root]);
  await again.ensureProject(app);
  assert.equal(again.lastRefresh.analyzed, 0);
  assert.equal((await again.search('how is damage calculated', { scope: 'all' })).hits[0]?.rel, 'mylib/index.js');
  assert.equal((await again.definitions('ApplyForce', { scope: 'all' }))[0]?.parent, 'RigidBody');
  assert.deepEqual((await again.projectProfile('game-app'))?.envMissing, ['API_KEY', 'DB_URL']);
  await again.close();
});

test('git history is searchable by message and by changed file', { skip: !hasGit() && 'git is not installed' }, async () => {
  const repo = mkdtempSync(path.join(tmp, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'damage.js'), 'export const damage = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Fix damage formula for armor');
  writeFileSync(path.join(repo, 'README.md'), '# Repo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add readme');
  const h = new IndexManager({ minWalkIntervalMs: 0 });
  await h.ensureProject(repo);
  const byMessage = await h.history('damage formula');
  assert.equal(byMessage.total, 2);
  assert.equal(byMessage.commits[0]?.subject, 'Fix damage formula for armor');
  assert.deepEqual(byMessage.commits[0]?.files, ['src/damage.js']);
  const byFile = await h.history('README.md');
  assert.equal(byFile.commits[0]?.subject, 'Add readme');
  await h.close();
});

test('CodeSearch tool output: path:line ranges, short snippets, summary display', async () => {
  const { CodeSearchTool } = await import('../src/tools/codeSearch.js');
  const { FileTracker } = await import('../src/tools/fileTracker.js');
  applyIndexSettings({ roots: [root] });
  const session = { cwd: app, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
  const ctx = { projectRoot: app, session, settings: {}, files: new FileTracker(false), signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;
  const call = async (input: Record<string, unknown>) => {
    const prep = await CodeSearchTool.prepare(input, ctx);
    assert.equal(prep.error, undefined);
    return prep.execute();
  };

  const r = await call({ query: 'how is damage calculated', scope: 'all' });
  assert.ok(!r.isError, r.content);
  assert.ok(r.content.length <= 8200);
  assert.match(r.content, /^\d+ results? for "how is damage calculated" \(scope: all\):/);
  assert.match(r.content, /index\.js:\d+-\d+ {2}computeDamage \(function\) {2}\[mylib\]/);
  assert.match(r.content, /\n +7 {2}export function computeDamage\(attack, armor\) \{/);
  const firstSnippet = r.content.split('\n\n')[1]!.split('\n').slice(1);
  assert.ok(firstSnippet.length >= 1 && firstSnippet.length <= 12);
  assert.equal(r.display?.kind, 'summary');
  assert.match(r.display?.kind === 'summary' ? r.display.text : '', /^\d+ results? for "how is damage calculated"$/);

  const weak = await call({ query: 'zebra quantum flux' });
  assert.match(weak.content, /No results/);
  assert.match(weak.content, /Hint:/);

  const def = await call({ query: 'computeDamage', mode: 'definition' });
  assert.match(def.content, /1 definition of "computeDamage"/);
  assert.match(def.content, /index\.js:7 {2}function computeDamage \(exported\)/);

  const refs = await call({ query: 'formatScore', mode: 'references' });
  assert.match(refs.content, /src[\\/]main\.js\n {2}3: import \{ formatScore \}/);

  const projects = await call({ query: '', mode: 'projects' });
  assert.match(projects.content, /^5 indexed projects:/);
  const profile = await call({ query: 'mylib', mode: 'project' });
  assert.match(profile.content, /Used by:\n {2}game-app/);
  const unused = await call({ query: 'mylib', mode: 'unused' });
  assert.match(unused.content, /approximate/);
  assert.match(unused.content, /index\.js:12 {2}function legacyFormula/);

  const bad = await call({ query: 'x', scope: 'no-such-project' });
  assert.ok(bad.isError);
  assert.match(bad.content, /Unknown scope "no-such-project"/);
});

test('end to end: the agent calls CodeSearch in print mode and gets the indexed code', async () => {
  const { MockServer, text, tools } = await import('./helpers/mockServer.js');
  const { PROVIDERS } = await import('../src/providers/catalog.js');
  const server = new MockServer();
  await server.start();
  try {
    const home = mkdtempSync(path.join(tmp, 'cli-home-'));
    const providers: Record<string, unknown> = {};
    for (const p of PROVIDERS) providers[p.id] = { enabled: false };
    providers.cs = { baseURL: server.baseURL('cs'), apiKey: 'test-key', discover: false, models: [{ id: 'm1', quality: 80, context: 100000, maxOutput: 4096, tools: 'native', speed: 50 }] };
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ setupCompleted: true, router: { enabled: false, maxWaitSeconds: 1 }, providers, index: { roots: [root] } }));
    server.script('cs', [tools({ name: 'CodeSearch', args: { query: 'how is damage calculated', scope: 'all' } }), text('It is computed in mylib.')]);
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/freecode.js');
    const { spawn } = await import('node:child_process');
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, '-p', 'where is damage calculated?'], { cwd: app, env: { ...process.env, FREECODE_HOME: home, HOME: home, USERPROFILE: home, NO_COLOR: '1', FREECODE_DEBUG: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      child.stdin.end('');
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /It is computed in mylib/);
    const reqs = server.requestsFor('cs');
    const toolNames = ((reqs[0]!.body.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name);
    assert.ok(toolNames.includes('CodeSearch'), 'CodeSearch is offered');
    const sys = (reqs[0]!.body.messages as { role: string; content: string }[])[0]!.content;
    assert.match(sys, /use CodeSearch first, then Read the hits/);
    const result = (reqs[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    assert.match(result?.content ?? '', /computeDamage/);
  } finally {
    await server.stop();
  }
});

// Synthetic benchmark: FREECODE_INDEX_BENCH=1 npm test
test('benchmark: 10k files index in under 20 s, searches in under 50 ms', { skip: !process.env.FREECODE_INDEX_BENCH && 'set FREECODE_INDEX_BENCH=1 to run' }, async (t) => {
  const bench = mkdtempSync(path.join(tmp, 'bench-'));
  let seed = 42;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const words = 'player enemy damage health armor weapon inventory item spawn level score render texture mesh shader physics collision velocity input camera audio sound network packet server client session token user account config settings parser lexer token buffer stream cache queue worker task job schedule timer event signal handler route request response database query table record index search filter sort map reduce'.split(' ');
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  const ident = () => words[rnd(words.length)]! + cap(words[rnd(words.length)]!);
  const FILES = 10_000;
  for (let d = 0; d < 100; d++) {
    const dir = path.join(bench, `module${d}`, 'src');
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES / 100; f++) {
      const lines: string[] = [`import { ${ident()} } from '../shared/${ident()}.js';`, ''];
      for (let k = 0; k < 6; k++) {
        lines.push(`/** ${cap(words[rnd(words.length)]!)} the ${words[rnd(words.length)]} for the ${words[rnd(words.length)]}. */`);
        lines.push(`export function ${ident()}${k}(${ident()}, ${ident()}) {`);
        for (let l = 0; l < 18; l++) lines.push(`  const ${ident()} = ${ident()}(${ident()}, ${rnd(100)}) + ${ident()}.${ident()};`);
        lines.push(`  return ${ident()};`, '}', '');
      }
      writeFileSync(path.join(dir, `${ident()}${f}.ts`), lines.join('\n'));
    }
  }
  const b = new IndexManager({ dir: path.join(tmp, 'bench-index'), minWalkIntervalMs: 0 });
  let t0 = performance.now();
  await b.ensureProject(bench);
  const indexMs = performance.now() - t0;
  const st = b.status();
  t.diagnostic(`indexed ${st.files} files, ${st.chunks} chunks, ${st.symbols} symbols in ${Math.round(indexMs)} ms`);
  assert.equal(st.files, FILES);
  assert.ok(indexMs < 20_000, `indexing took ${Math.round(indexMs)} ms`);
  await b.search('warm up', { scope: 'all' });
  const queries = ['how is damage calculated', 'player health', 'renderTexture', 'parse the request token', 'collision velocity physics', 'cache queue worker', 'where is the session stored', 'spawn enemy'];
  let worst = 0;
  let total = 0;
  for (const q of queries) {
    t0 = performance.now();
    const res = await b.search(q, { scope: 'all', limit: 8 });
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms);
    total += ms;
    assert.ok(res.hits.length > 0, q);
  }
  t.diagnostic(`search: average ${(total / queries.length).toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
  assert.ok(worst < 50, `slowest search took ${worst.toFixed(1)} ms`);
  t0 = performance.now();
  await b.refresh();
  t.diagnostic(`incremental refresh with no changes: ${Math.round(performance.now() - t0)} ms`);
  await b.close();
});

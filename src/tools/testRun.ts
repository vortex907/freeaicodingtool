// TestRun: runs the project's tests with machine-readable output and returns a short summary: the counts, then
// each failure with its name, file:line, message and expected/actual. pytest writes JUnit XML, jest and vitest a
// JSON report, node --test TAP, go test -json events and dotnet test TRX files; cargo test is read from its text.
// When no report can be read, the end of the output is returned instead.
import { existsSync, promises as fsp, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PreparedCall, Tool, ToolContext, ToolResult } from './types.js';
import { errorResult, numParam, strParam } from './types.js';
import { buildInvocation, cleanOutput, runProcess, shellEnv, type ProcessResult } from './bash.js';
import { invalidateFileListCache } from './listFiles.js';
import { displayPath, isDirectory } from '../util/fs.js';
import { isWindows, which } from '../util/platform.js';
import { stripAnsi } from '../util/ansi.js';
import { escapeRegExp, formatDuration, randomId, truncate } from '../util/strings.js';

export const RUNNERS = ['pytest', 'jest', 'vitest', 'node', 'cargo', 'go', 'dotnet'] as const;
export type Runner = (typeof RUNNERS)[number];

const LABEL: Record<Runner, string> = { pytest: 'pytest', jest: 'jest', vitest: 'vitest', node: 'node --test', cargo: 'cargo test', go: 'go test', dotnet: 'dotnet test' };

/** The summary is at most this many lines (plus notes). */
const MAX_LINES = 40;
const DEFAULT_TIMEOUT = 600_000;
const MAX_TIMEOUT = 1_800_000;

export interface TestProblem {
  /** 'error' when a test or file could not run at all (setup or collection error, build failure, a file that failed to load). */
  kind: 'fail' | 'error';
  name: string;
  file?: string;
  line?: number;
  message: string;
  expected?: string;
  actual?: string;
}

export interface TestReport {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  problems: TestProblem[];
}

const emptyReport = (): TestReport => ({ passed: 0, failed: 0, skipped: 0, errors: 0, problems: [] });

// ------------------------------------------------------------------ helpers

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).split(path.sep).join('/');
    return isWindows ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** A path relative to the folder the tests ran in, with forward slashes. Accepts file:// URLs. */
function relPath(p: string, root: string): string {
  let f = p;
  if (f.startsWith('file://')) {
    try {
      f = fileURLToPath(f);
    } catch {
      // keep it as it is
    }
  }
  if (path.isAbsolute(f)) {
    const rel = path.relative(root, f);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) f = rel;
  }
  return f.split(path.sep).join('/');
}

/** "path:line" places in a stack trace (absolute paths and file:// URLs). */
const FRAME = /((?:file:\/\/)?(?:\/?[A-Za-z]:[\\/]|\/)[^():\n]+?):(\d+)(?::\d+)?(?=\)|\s|$)/g;

function frames(text: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const m of text.matchAll(FRAME)) {
    let file = m[1]!;
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    out.push({ file, line: Number(m[2]) });
  }
  return out;
}

/** The message part of an error: no ANSI codes, no stack frames, no blank lines, common indent removed. */
function messageText(text: string): string {
  const lines = stripAnsi(text).replace(/\r\n?/g, '\n').split('\n');
  const stack = lines.findIndex((l) => /^\s+at\s/.test(l));
  const kept = (stack >= 0 ? lines.slice(0, stack) : lines).map((l) => l.trimEnd()).filter((l) => l.trim());
  const indent = Math.min(...kept.map((l) => /^\s*/.exec(l)![0].length));
  return kept.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/** Expected and actual values when the message states them (jest, xUnit, NUnit, MSTest, testify, chai). */
export function expectedActual(message: string): { expected?: string; actual?: string } {
  const exp = /^\s*Expected(?: value)?\s*:\s*(.+)$/im.exec(message);
  const act = /^\s*(?:Received|Actual|But was)(?: value)?\s*:\s*(.+)$/im.exec(message);
  if (exp && act) return { expected: exp[1]!.trim(), actual: act[1]!.trim() };
  const ms = /Expected:<(.*?)>\.?\s*Actual:<(.*?)>/s.exec(message);
  if (ms) return { expected: ms[1], actual: ms[2] };
  const chai = /^(?:\w*Error: )?expected (.+?) to (?:be|equal|deeply equal|strictly equal|loosely equal|eql) (.+?)(?: \/\/ .*)?$/m.exec(message);
  if (chai) return { actual: chai[1], expected: chai[2] };
  return {};
}

function showValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  try {
    return truncate(JSON.stringify(v) ?? String(v), 200);
  } catch {
    return truncate(String(v), 200);
  }
}

// ------------------------------------------------------------------ XML (JUnit, TRX)

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

/** A small XML reader for test reports: elements, attributes, text and CDATA. Namespace prefixes are dropped. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const local = (n: string) => n.slice(n.indexOf(':') + 1);
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1]!;
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top.text += decodeXml(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // The end of the tag, skipping '>' inside quoted attribute values.
    let end = lt + 1;
    for (let q = ''; end < src.length; end++) {
      const c = src[end];
      if (q) {
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const tag = src.slice(lt + 1, end);
    i = end + 1;
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    if (tag.startsWith('/')) {
      const name = local(tag.slice(1).trim());
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^[^\s/>]+/.exec(body);
    if (!m) continue;
    const node: XmlNode = { name: local(m[0]), attrs: {}, children: [], text: '' };
    for (const a of body.slice(m[0].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[local(a[1]!)] = decodeXml(a[2] ?? a[3] ?? '');
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Every element named `name` below `node` (not `node` itself), in document order. */
function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

const child = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);

// ------------------------------------------------------------------ pytest (JUnit XML)

/** JUnit XML as pytest writes it (xunit1 has file and line attributes; xunit2 gets them from the traceback). */
export function parseJUnit(xml: string, root: string): TestReport | null {
  const doc = parseXml(xml);
  const cases = findAll(doc, 'testcase');
  if (!cases.length && !findAll(doc, 'testsuite').length) return null;
  const report = emptyReport();
  for (const tc of cases) {
    const failure = child(tc, 'failure');
    const error = child(tc, 'error');
    if (failure) report.failed++;
    else if (error) report.errors++;
    else if (child(tc, 'skipped')) report.skipped++;
    else report.passed++;
    const bad = failure ?? error;
    if (bad) report.problems.push(junitProblem(tc, bad, failure ? 'fail' : 'error', root));
  }
  return report;
}

function junitProblem(tc: XmlNode, bad: XmlNode, kind: 'fail' | 'error', root: string): TestProblem {
  const cls = tc.attrs.classname ?? '';
  const name = tc.attrs.name ?? '?';
  const text = bad.text.replace(/\r\n?/g, '\n');
  // Traceback entries: "tests/test_x.py:10: in test_y" (or ": AssertionError" with --tb=long).
  const tb = [...text.matchAll(/^(\S[^\n]*?\.py):(\d+): /gm)].map((m) => ({ file: relPath(m[1]!, root), line: Number(m[2]) }));
  const asModule = (f: string) => f.replace(/\.py$/, '').replace(/\//g, '.');
  const file = tc.attrs.file ? relPath(tc.attrs.file, root) : tb.find((f) => cls === asModule(f.file) || cls.startsWith(asModule(f.file) + '.'))?.file;
  let id = cls ? `${cls}.${name}` : name;
  if (file) {
    const mod = asModule(file);
    const rest = cls.startsWith(mod + '.') ? cls.slice(mod.length + 1).split('.') : [];
    id = name === mod ? file : [file, ...rest, name].join('::');
  }
  const loc = tb.filter((f) => f.file === file).pop() ?? tb.find((f) => !path.isAbsolute(f.file)) ?? (file && tc.attrs.line ? { file, line: Number(tc.attrs.line) + 1 } : undefined);
  // The "E   " lines hold the exception; the message attribute is a fallback (and is generic for collection errors).
  const eLines = text
    .split('\n')
    .filter((l) => /^E(\s|$)/.test(l))
    .map((l) => l.replace(/^E {0,3}/, ''))
    .filter((l) => !/use -vv? to (show|get more diff)/i.test(l));
  const message = (eLines.join('\n').trim() ? eLines.join('\n') : bad.attrs.message) ?? '';
  return { kind, name: id, file: loc?.file ?? file, line: loc?.line, message: messageText(message) || (kind === 'error' ? 'error' : 'failed'), ...expectedActual(message) };
}

// ------------------------------------------------------------------ jest and vitest (JSON)

interface JestTest {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
  failureDetails?: unknown[];
  location?: { line?: number } | null;
}

interface JestFile {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: JestTest[];
}

/** The JSON report of jest (--json) and vitest (--reporter=json), which share a format. */
export function parseJestJson(json: string, root: string): TestReport | null {
  let data: { testResults?: JestFile[] };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.testResults)) return null;
  const report = emptyReport();
  for (const f of data.testResults) {
    const abs = f.name ?? '';
    const rel = relPath(abs, root);
    const tests = f.assertionResults ?? [];
    for (const t of tests) {
      if (t.status === 'passed') report.passed++;
      else if (t.status !== 'failed') report.skipped++;
      else {
        report.failed++;
        const raw = stripAnsi((t.failureMessages ?? []).join('\n'));
        const message = messageText(raw);
        const matcher = (t.failureDetails ?? [])
          .map((d) => (d && typeof d === 'object' ? (d as { matcherResult?: { expected?: unknown; actual?: unknown } }).matcherResult : undefined))
          .find((m) => m && (m.expected !== undefined || m.actual !== undefined));
        const values = matcher ? { expected: showValue(matcher.expected), actual: showValue(matcher.actual) } : expectedActual(message);
        const line = frames(raw).find((fr) => samePath(fr.file, abs))?.line ?? t.location?.line ?? undefined;
        report.problems.push({ kind: 'fail', name: [...(t.ancestorTitles ?? []), t.title ?? t.fullName ?? '?'].join(' > '), file: rel, line, message: message || 'failed', ...values });
      }
    }
    // A file that failed with no failing test did not load (syntax error, missing module, a failing hook).
    if (f.status === 'failed' && !tests.some((t) => t.status === 'failed')) {
      const raw = stripAnsi(f.message ?? '').replace(/^\s*\u25cf Test suite failed to run\s*/, '');
      // jest marks the failing line of its code frame with ">".
      const marked = /^\s*>\s*(\d+) \|/m.exec(raw);
      const line = frames(raw).find((fr) => samePath(fr.file, abs))?.line ?? (marked ? Number(marked[1]) : undefined);
      report.errors++;
      report.problems.push({ kind: 'error', name: rel, file: rel, line, message: messageText(raw) || 'The test file failed to run.' });
    }
  }
  return report;
}

// ------------------------------------------------------------------ node --test (TAP)

/** A scalar of node's TAP YAML. Quoted strings are written with util.inspect, so they use JS escapes ('C:\\Users'). */
function yamlString(v: string): string {
  const q = v[0];
  if (v.length < 2 || (q !== "'" && q !== '"' && q !== '`') || !v.endsWith(q)) return v === '~' ? '' : v;
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  return v.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[^])/g, (_, e: string) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.replace(/^[ux]\{?|\}$/g, ''), 16));
    return simple[e] ?? e;
  });
}

/** The keys of a TAP YAML block: scalars as written; block scalars and nested maps as dedented text, listed in `blocks`. */
function yamlBlock(lines: string[], indent: number): { values: Record<string, string>; blocks: Set<string> } {
  const values: Record<string, string> = {};
  const blocks = new Set<string>();
  const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([\w-]+):(?: (.*))?$/.exec(lines[i]!);
    if (!m || m[1]!.length !== indent) continue;
    const value = (m[3] ?? '').trim();
    const body: string[] = [];
    while (i + 1 < lines.length && (!lines[i + 1]!.trim() || indentOf(lines[i + 1]!) > indent)) body.push(lines[++i]!);
    if (value && !/^[|>][-+]?$/.test(value)) values[m[2]!] = value;
    else {
      const min = Math.min(...body.filter((l) => l.trim()).map(indentOf));
      values[m[2]!] = body.map((l) => l.slice(Number.isFinite(min) ? min : 0).trimEnd()).join('\n').replace(/\n+$/, '');
      blocks.add(m[2]!);
    }
  }
  return { values, blocks };
}

/** Test names in TAP escape "#" and backslashes. */
const tapUnescape = (s: string) => s.replace(/\\([\\#])/g, '$1');

/** TAP from node --test --test-reporter=tap: nested subtests, YAML diagnostics and the closing counts. */
export function parseNodeTap(tap: string, root: string): TestReport | null {
  const lines = tap.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((l) => /^\s*(not )?ok \d+/.test(l))) return null;
  const report = emptyReport();
  const names: string[] = [];
  const kids: number[] = [];
  const counts: Record<string, number> = {};
  const leaves = { passed: 0, failed: 0, skipped: 0 };
  // Files that failed to load count as failed tests in node's totals; here they are errors.
  let fileErrors = 0;
  // Top-level comments: the stderr of a test file that failed to load comes as "# ..." lines.
  let diag: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const level = Math.floor(sub[1]!.length / 4);
      names.length = level;
      names[level] = tapUnescape(sub[2]!);
      kids[level + 1] = 0;
      continue;
    }
    const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (count) {
      counts[count[1]!] = Number(count[2]);
      continue;
    }
    if (line.startsWith('# ')) {
      diag.push(line.slice(2));
      continue;
    }
    const point = /^(\s*)(not ok|ok) \d+(?: - (.*))?$/.exec(line);
    if (!point) continue;
    const level = Math.floor(point[1]!.length / 4);
    const hasKids = (kids[level + 1] ?? 0) > 0;
    kids[level] = (kids[level] ?? 0) + 1;
    kids[level + 1] = 0;
    const d = /^(.*?)(?<!\\) # (SKIP|TODO)\b.*$/i.exec(point[3] ?? '');
    const title = tapUnescape(d ? d[1]! : point[3] ?? '');
    const directive = d?.[2]!.toUpperCase();
    let yaml: Record<string, string> = {};
    let blocks = new Set<string>();
    const open = /^(\s*)---$/.exec(lines[i + 1] ?? '');
    if (open) {
      let end = i + 2;
      while (end < lines.length && lines[end] !== `${open[1]}...`) end++;
      ({ values: yaml, blocks } = yamlBlock(lines.slice(i + 2, end), open[1]!.length));
      i = end;
    }
    const top = level === 0;
    const fileDiag = diag;
    if (top) diag = [];
    const val = (key: string) => (blocks.has(key) ? yaml[key]! : yamlString(yaml[key] ?? ''));
    const suite = val('type') === 'suite';
    const failureType = val('failureType');
    if (suite && point[2] === 'ok') continue;
    if (point[2] === 'ok' || directive === 'TODO') {
      if (!hasKids && !suite) {
        if (directive) leaves.skipped++;
        else leaves.passed++;
      }
      continue;
    }
    if (!hasKids && !suite) leaves.failed++;
    // Parents fail with their subtests, which are reported themselves.
    if (failureType === 'subtestsFailed' || failureType === 'cancelledByParent') continue;
    let message = val('error');
    const location = /^(.*):(\d+):\d+$/.exec(val('location'));
    // The assertion is the first stack frame in the test's file (any project file when node gives no location).
    const stack = frames(val('stack')).filter((f) => !/[\\/]node_modules[\\/]/.test(f.file));
    const assertion = location ? stack.find((f) => samePath(f.file, location[1]!)) : stack[0];
    const defFile = location?.[1] ?? assertion?.file;
    // A test file that could not load: node only says "test failed"; its output above says why.
    const fileFailed = top && message === 'test failed' && !hasKids;
    if (fileFailed) {
      fileErrors++;
      const errorLines = fileDiag.filter((l) => /\b\w*(Error|Exception)\b|Cannot find/.test(l)).slice(0, 3);
      message = (errorLines.length ? errorLines : fileDiag.slice(-3)).join('\n') || `The test file failed${val('exitCode') ? ` with exit code ${val('exitCode')}` : ''}.`;
    }
    // Objects come as nested YAML; the error message has their diff, so only plain values are kept.
    const expected = blocks.has('expected') ? undefined : yaml.expected;
    const actual = blocks.has('actual') ? undefined : yaml.actual;
    report.problems.push({
      kind: fileFailed || suite ? 'error' : 'fail',
      name: [...names.slice(0, level), title].join(' > '),
      file: defFile ? relPath(defFile, root) : undefined,
      line: assertion?.line ?? (location ? Number(location[2]) : undefined),
      message: messageText(message) || failureType || 'failed',
      ...(expected !== undefined && actual !== undefined ? { expected, actual } : {}),
    });
  }
  if (counts.pass !== undefined && counts.fail !== undefined) {
    report.passed = counts.pass;
    report.failed = Math.max(0, counts.fail + (counts.cancelled ?? 0) - fileErrors);
    report.skipped = (counts.skipped ?? 0) + (counts.todo ?? 0);
  } else {
    report.passed = leaves.passed;
    report.failed = Math.max(0, leaves.failed - fileErrors);
    report.skipped = leaves.skipped;
  }
  report.errors = report.problems.filter((p) => p.kind === 'error').length;
  return report;
}

// ------------------------------------------------------------------ go test -json

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
  ImportPath?: string;
  FailedBuild?: string;
}

/**
 * go test -json events. Build errors come as build-output events since Go 1.24 and on stderr before that, so
 * `output` (stdout and stderr together) is searched for them too. Only the innermost subtests are counted.
 */
export function parseGoTestJson(stdout: string, opts: { root: string; modulePath?: string; output?: string }): TestReport | null {
  const tests = new Map<string, { pkg: string; name: string; status?: string; output: string[] }>();
  const pkgs = new Map<string, { status?: string; output: string[]; failedBuild?: string }>();
  const builds = new Map<string, string[]>();
  let events = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(line) as GoEvent;
    } catch {
      continue;
    }
    events++;
    const done = e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip';
    if (e.Action === 'build-output' && e.ImportPath) {
      builds.set(e.ImportPath, [...(builds.get(e.ImportPath) ?? []), e.Output ?? '']);
    } else if (e.Package && e.Test) {
      const key = `${e.Package}\0${e.Test}`;
      const t = tests.get(key) ?? { pkg: e.Package, name: e.Test, output: [] };
      tests.set(key, t);
      if (e.Action === 'output') t.output.push(e.Output ?? '');
      else if (done) t.status = e.Action;
    } else if (e.Package) {
      const p = pkgs.get(e.Package) ?? { output: [] };
      pkgs.set(e.Package, p);
      if (e.Action === 'output') p.output.push(e.Output ?? '');
      else if (done) {
        p.status = e.Action;
        if (e.FailedBuild) p.failedBuild = e.FailedBuild;
      }
    }
  }
  if (!events) return null;
  const report = emptyReport();
  const list = [...tests.values()];
  const subtests = (t: { pkg: string; name: string }) => list.filter((o) => o.pkg === t.pkg && o.name.startsWith(t.name + '/'));
  const fileOf = (pkg: string, base: string) => {
    const mod = opts.modulePath;
    if (mod && pkg.startsWith(mod + '/')) return `${pkg.slice(mod.length + 1)}/${base}`;
    return base;
  };
  for (const t of list) {
    const subs = subtests(t);
    if (t.status === 'pass' || t.status === 'skip') {
      if (!subs.length) report[t.status === 'pass' ? 'passed' : 'skipped']++;
      continue;
    }
    if (t.status !== 'fail' || subs.some((s) => s.status === 'fail')) continue;
    report.failed++;
    const lines = t.output
      .join('')
      .split('\n')
      .filter((l) => l.trim() && !/^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP):)/.test(l));
    const at = lines.findIndex((l) => /^\s*[\w.-]+\.go:\d+: /.test(l));
    const problem: TestProblem = { kind: 'fail', name: t.name, message: '' };
    if (at >= 0) {
      const m = /^\s*([\w.-]+\.go):(\d+): (.*)$/.exec(lines[at]!)!;
      problem.file = fileOf(t.pkg, m[1]!);
      problem.line = Number(m[2]);
      problem.message = [m[3]!, ...lines.slice(at + 1).map((l) => l.trim())].join('\n');
    } else {
      // A panic: the message, and the frame right after the test function in the goroutine trace.
      const p = lines.findIndex((l) => /^panic: /.test(l));
      problem.message = p >= 0 ? lines[p]! : lines.slice(0, 3).join('\n');
      const fn = new RegExp(`\\.${escapeRegExp(t.name.split('/')[0]!)}(\\.func\\d+)*\\(`);
      const call = lines.findIndex((l) => fn.test(l));
      const frame = call >= 0 ? /^\s*(.+?\.go):(\d+)(?: \+0x[0-9a-f]+)?$/.exec(lines[call + 1] ?? '') : null;
      if (frame) {
        problem.file = relPath(frame[1]!, opts.root);
        problem.line = Number(frame[2]);
      }
    }
    problem.message ||= 'failed';
    Object.assign(problem, expectedActual(problem.message));
    report.problems.push(problem);
  }
  // Packages that failed without a failing test: build errors, a panic in TestMain or init, a timeout.
  const stderrLines = (opts.output ?? '').split('\n').filter((l) => l.trim() && !l.startsWith('{'));
  for (const [pkg, p] of pkgs) {
    if (p.status !== 'fail' || list.some((t) => t.pkg === pkg && t.status === 'fail')) continue;
    report.errors++;
    let text = (p.failedBuild ? builds.get(p.failedBuild) : undefined)?.join('') ?? '';
    if (!text && p.output.some((o) => /\[(build|setup) failed\]/.test(o))) text = stderrLines.join('\n');
    if (!text) text = p.output.filter((o) => !/^(FAIL|ok)\s/.test(o)).join('');
    const body = text.split('\n').filter((l) => l.trim() && !l.startsWith('# '));
    const loc = body.map((l) => /^(?:\.[\\/])?(\S+?\.go):(\d+)(?::\d+)?: (.*)$/.exec(l)).find(Boolean);
    report.problems.push({
      kind: 'error',
      name: pkg,
      file: loc ? relPath(loc[1]!, opts.root) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      message: (loc ? [loc[3]!, ...body.slice(body.indexOf(loc.input) + 1)] : body).join('\n') || 'the package failed',
    });
  }
  return report;
}

// ------------------------------------------------------------------ cargo test (text)

/** cargo test's text output: "test x ... ok" lines, the per-binary "test result:" lines and the panic messages. */
export function parseCargoTest(stdout: string, output: string): TestReport | null {
  const text = stdout.replace(/\r\n?/g, '\n');
  const report = emptyReport();
  const status = new Map<string, string>();
  for (const m of text.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)\b/gm)) status.set(m[1]!, m[2]!);
  let summaries = 0;
  for (const m of text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)) {
    summaries++;
    report.passed += Number(m[1]);
    report.failed += Number(m[2]);
    report.skipped += Number(m[3]);
  }
  if (!summaries) {
    for (const s of status.values()) report[s === 'ok' ? 'passed' : s === 'FAILED' ? 'failed' : 'skipped']++;
  }
  // "---- name stdout ----" sections hold each failed test's output and panic message.
  const sections = new Map<string, string>();
  const heads = [...text.matchAll(/^---- (.+?) stdout ----$/gm)];
  heads.forEach((h, k) => {
    const start = h.index! + h[0].length;
    const next = heads[k + 1]?.index ?? text.length;
    sections.set(h[1]!, text.slice(start, next).split(/^(?:failures:|test result:)/m)[0]!);
  });
  for (const [name, s] of status) {
    if (s !== 'FAILED') continue;
    const section = sections.get(name) ?? '';
    const problem: TestProblem = { kind: 'fail', name, message: '' };
    const now = /^thread '.*?'(?: \(\d+\))? panicked at (.+?):(\d+):\d+:\n([\s\S]*?)(?=\nstack backtrace:|\nnote: |\n\n|(?![\s\S]))/m.exec(section);
    const old = now ? null : /^thread '.*?'(?: \(\d+\))? panicked at '([\s\S]*?)', (\S+?):(\d+):\d+$/m.exec(section);
    if (now) Object.assign(problem, { file: now[1]!.replace(/\\/g, '/'), line: Number(now[2]), message: now[3]!.trim() });
    else if (old) Object.assign(problem, { file: old[2]!.replace(/\\/g, '/'), line: Number(old[3]), message: old[1]!.trim() });
    else problem.message = section.trim().split('\n').slice(0, 3).join('\n');
    problem.message ||= 'failed';
    report.problems.push(problem);
  }
  if (summaries || status.size) return report;
  // Nothing ran: compile errors, "error[E0308]: ..." followed by " --> file:line:col".
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((l, k) => {
    const m = /^error(\[E\d+\])?: (.+)$/.exec(l);
    const at = m ? lines.slice(k + 1, k + 4).map((x) => /^\s*--> (.+?):(\d+):\d+$/.exec(x)).find(Boolean) : undefined;
    if (!m || (!m[1] && !at) || report.problems.length >= 5) return;
    report.errors++;
    report.problems.push({ kind: 'error', name: 'compile error', file: at?.[1]!.replace(/\\/g, '/'), line: at ? Number(at[2]) : undefined, message: m[2]! });
  });
  return report.problems.length ? report : null;
}

// ------------------------------------------------------------------ dotnet test (TRX)

/** A Visual Studio TRX file from dotnet test --logger trx. */
export function parseTrx(xml: string, root: string): TestReport | null {
  const doc = parseXml(xml);
  const results = findAll(doc, 'UnitTestResult');
  if (!results.length && !findAll(doc, 'TestRun').length) return null;
  const report = emptyReport();
  for (const r of results) {
    // Data-driven tests nest their runs; the inner results are the ones counted.
    if (findAll(r, 'UnitTestResult').length) continue;
    const outcome = r.attrs.outcome ?? '';
    if (outcome === 'Passed') report.passed++;
    else if (/^(NotExecuted|Inconclusive|Pending|NotRunnable|Disconnected|Warning)$/.test(outcome)) report.skipped++;
    else {
      report.failed++;
      const info = findAll(r, 'ErrorInfo')[0];
      const raw = (info && child(info, 'Message')?.text) ?? '';
      const stack = (info && child(info, 'StackTrace')?.text) ?? '';
      const loc = /\bin (.+?):line (\d+)/.exec(stack);
      report.problems.push({ kind: 'fail', name: r.attrs.testName ?? '?', file: loc ? relPath(loc[1]!.trim(), root) : undefined, line: loc ? Number(loc[2]) : undefined, message: messageText(raw) || outcome || 'failed', ...expectedActual(raw) });
    }
  }
  return report;
}

// ------------------------------------------------------------------ summary

function countsText(r: TestReport): string {
  if (!r.passed && !r.failed && !r.skipped && !r.errors) return 'no tests ran';
  const parts: string[] = [];
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.errors) parts.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  parts.push(`${r.passed} passed`);
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  return parts.join(', ');
}

function problemLines(p: TestProblem, messageLines: number): string[] {
  const where = p.file ? ` (${p.file}${p.line ? `:${p.line}` : ''})` : '';
  const out = [`${p.kind === 'error' ? 'ERROR' : 'FAIL'} ${p.name}${where}`];
  const msg = p.message
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, messageLines)
    .map((l) => `  ${truncate(l.trimEnd(), 200)}`);
  out.push(...msg);
  // Skipped when the message already has labelled expected/actual lines.
  if (p.expected !== undefined && p.actual !== undefined && !msg.some((l) => /^\s*(expected|received|actual|but was)( value)?\s*:/i.test(l))) {
    out.push(`  expected: ${truncate(p.expected, 200)}`, `  actual:   ${truncate(p.actual, 200)}`);
  }
  return out;
}

/** The report as text: `head`, then each problem (errors first) until about `maxLines` lines, then the names of the rest. */
export function formatReport(report: TestReport, head: string, maxLines = MAX_LINES): string {
  const out = [head];
  const problems = [...report.problems.filter((p) => p.kind === 'error'), ...report.problems.filter((p) => p.kind === 'fail')];
  let shown = 0;
  for (const p of problems) {
    const block = problemLines(p, problems.length === 1 ? 8 : 4);
    // Room for the "... and N more" line when more problems follow.
    const reserve = shown + 1 < problems.length ? 1 : 0;
    if (shown && out.length + block.length + reserve > maxLines) break;
    if (!shown) {
      out.push('');
      out.push(...block.slice(0, Math.max(1, maxLines - out.length - reserve)));
    } else out.push(...block);
    shown++;
  }
  const rest = problems.slice(shown);
  if (rest.length) out.push(truncate(`... and ${rest.length} more: ${rest.map((p) => p.name).join(', ')}`, 400));
  return out.join('\n');
}

/** Messages name files relative to the folder the tests ran in, like the locations do. */
function shortenPaths(report: TestReport, root: string): void {
  const prefixes = [...new Set([root + path.sep, root.split(path.sep).join('/') + '/', pathToFileURL(root).href + '/'])];
  for (const p of report.problems) for (const pre of prefixes) p.message = p.message.split(pre).join('');
}

function outputTail(output: string, lines: number): string {
  const all = cleanOutput(output)
    .split('\n')
    .map((l) => l.trimEnd());
  while (all.length && !all[all.length - 1]) all.pop();
  const tail = all.slice(-lines).map((l) => truncate(l, 300));
  return tail.length ? tail.join('\n') : '(no output)';
}

// ------------------------------------------------------------------ finding the runner

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The package.json test script, following "npm run x" to the script it runs. Empty when there is none. */
export function testScript(pkg: Record<string, unknown> | null): string {
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  let s = typeof scripts.test === 'string' ? scripts.test : '';
  for (let i = 0; i < 3; i++) {
    const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)$/.exec(s.trim());
    const next = m && m[1] !== 'test' ? scripts[m[1]!] : undefined;
    if (typeof next !== 'string') break;
    s = next;
  }
  return /no test specified/.test(s) ? '' : s;
}

const OTHER_JS_RUNNERS = /\b(mocha|ava|tap|tape|karma|react-scripts|ng\s+test|playwright|cypress|jasmine|uvu|turbo|nx|lerna|bun\s+test|deno\s+test)\b/;

function jsRunner(pkg: Record<string, unknown>): Runner | null {
  const script = testScript(pkg);
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/(^|[\s;&|])node(\.exe)?\s(.*\s)?--test\b/.test(script)) return 'node';
  if (script && OTHER_JS_RUNNERS.test(script)) return null;
  const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, unknown>;
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  return null;
}

function hasPytest(dir: string): boolean {
  if (existsSync(path.join(dir, 'pytest.ini')) || existsSync(path.join(dir, 'conftest.py'))) return true;
  const mentions = (file: string, re: RegExp) => re.test(readText(path.join(dir, file)));
  if (mentions('pyproject.toml', /\[tool\.pytest|\bpytest\b/) || mentions('setup.cfg', /\[tool:pytest\]/) || mentions('tox.ini', /\[pytest\]/)) return true;
  const python = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'].some((f) => existsSync(path.join(dir, f)));
  if (python && (isDirectory(path.join(dir, 'tests')) || isDirectory(path.join(dir, 'test')))) return true;
  return [dir, path.join(dir, 'tests'), path.join(dir, 'test')].some((d) => listDir(d).some((f) => /^test_.*\.py$|_test\.py$/.test(f)));
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Test files that import node:test, in the folder or its test/tests folder (no package.json script needed). */
function hasNodeTests(dir: string): boolean {
  for (const d of [path.join(dir, 'test'), path.join(dir, 'tests'), dir]) {
    const files = listDir(d).filter((f) => /\.test\.[cm]?js$|^test.*\.[cm]?js$/.test(f)).slice(0, 5);
    if (files.some((f) => /['"]node:test['"]/.test(readText(path.join(d, f))))) return true;
  }
  return false;
}

function dotnetFiles(dir: string): string[] {
  return listDir(dir).filter((f) => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(f));
}

function hasMarker(runner: Runner, dir: string): boolean {
  switch (runner) {
    case 'jest':
    case 'vitest':
    case 'node':
      return existsSync(path.join(dir, 'package.json'));
    case 'pytest':
      return hasPytest(dir);
    case 'go':
      return existsSync(path.join(dir, 'go.mod'));
    case 'cargo':
      return existsSync(path.join(dir, 'Cargo.toml'));
    case 'dotnet':
      return dotnetFiles(dir).length > 0;
  }
}

/** The test setups found in one folder, most specific first. */
function candidatesIn(dir: string): Runner[] {
  const out: Runner[] = [];
  const pkg = readJson(path.join(dir, 'package.json'));
  const js = pkg ? jsRunner(pkg) : null;
  if (js) out.push(js);
  else if (!(pkg && OTHER_JS_RUNNERS.test(testScript(pkg))) && hasNodeTests(dir)) out.push('node');
  if (hasPytest(dir)) out.push('pytest');
  if (existsSync(path.join(dir, 'go.mod'))) out.push('go');
  if (existsSync(path.join(dir, 'Cargo.toml'))) out.push('cargo');
  if (dotnetFiles(dir).length) out.push('dotnet');
  return out;
}

/** start and its parents, up to the project root (or 8 levels when start is outside it). */
function upward(start: string, root: string): string[] {
  const dirs: string[] = [];
  for (let d = start; dirs.length < 8; d = path.dirname(d)) {
    dirs.push(d);
    if (samePath(d, root) || path.dirname(d) === d) break;
  }
  return dirs;
}

const EXT_RUNNERS: [RegExp, Runner[]][] = [
  [/\.py$/i, ['pytest']],
  [/\.go$/i, ['go']],
  [/\.rs$/i, ['cargo']],
  [/\.(cs|fs|vb)$/i, ['dotnet']],
  [/\.[cm]?[jt]sx?$/i, ['vitest', 'jest', 'node']],
];

export interface Detected {
  runner: Runner;
  dir: string;
  /** Other setups found in the same folder. */
  others: Runner[];
}

/** Picks the runner and the folder to run it in. Returns an error message when there is no test setup. */
export function detectRunner(start: string, projectRoot: string, runner?: Runner, filter?: string): Detected | string {
  const dirs = upward(start, projectRoot);
  if (runner) return { runner, dir: dirs.find((d) => hasMarker(runner, d)) ?? start, others: [] };
  // A file filter decides between setups (a .py file means pytest even next to a package.json).
  const byExt = filter ? EXT_RUNNERS.find(([re]) => re.test(filter.split('::')[0]!))?.[1] : undefined;
  let unsupported: string | undefined;
  for (const dir of dirs) {
    const found = candidatesIn(dir);
    const script = testScript(readJson(path.join(dir, 'package.json')));
    if (!unsupported && OTHER_JS_RUNNERS.test(script) && !found.some((r) => r === 'jest' || r === 'vitest' || r === 'node')) unsupported = script;
    if (!found.length) continue;
    const pick = found.find((r) => !byExt || byExt.includes(r));
    if (pick) return { runner: pick, dir, others: found.filter((r) => r !== pick) };
  }
  if (unsupported && (!byExt || byExt.includes('node'))) {
    return `The package.json test script ("${truncate(unsupported, 80)}") uses a runner TestRun does not read (it reads pytest, jest, vitest, node --test, cargo test, go test and dotnet test). Run it with Bash instead.`;
  }
  if (byExt) {
    const r = byExt[byExt.length - 1]!;
    return { runner: r, dir: dirs.find((d) => hasMarker(r, d)) ?? start, others: [] };
  }
  return `No test setup found in ${start} or the folders above it (looked for package.json with jest, vitest or node --test, pytest files, go.mod, Cargo.toml and .NET projects). Pass runner (${RUNNERS.join(', ')}) and path, or run the tests with Bash.`;
}

// ------------------------------------------------------------------ the command

/** Splits a command line into words, honoring quotes; a backslash escapes only quotes, spaces and itself. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let word = false;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"' && /["\\$`]/.test(s[i + 1] ?? '')) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      word = true;
    } else if (c === '\\' && /["'\\\s]/.test(s[i + 1] ?? '')) {
      cur += s[++i];
      word = true;
    } else if (/\s/.test(c)) {
      if (word) out.push(cur);
      cur = '';
      word = false;
    } else {
      cur += c;
      word = true;
    }
  }
  if (word) out.push(cur);
  return out;
}

/** What the package.json test script does around the runner: steps before it, env assignments and its own flags. */
export interface ScriptParts {
  pre: string[];
  env: Record<string, string>;
  /** Node flags before the runner's script (node --experimental-vm-modules node_modules/jest/bin/jest.js). */
  nodeArgs: string[];
  args: string[];
}

const RUNNER_WORD: Record<'jest' | 'vitest' | 'node', RegExp> = {
  jest: /(^|[\\/])jest(\.js)?$/,
  vitest: /(^|[\\/])vitest(\.m?js)?$/,
  node: /^node(\.exe)?$/,
};

export function scriptParts(script: string, runner: 'jest' | 'vitest' | 'node'): ScriptParts {
  const none: ScriptParts = { pre: [], env: {}, nodeArgs: [], args: [] };
  const segments = script.split('&&').map((s) => s.trim());
  for (let k = 0; k < segments.length; k++) {
    let words = shellWords(segments[k]!);
    const env: Record<string, string> = {};
    for (;;) {
      if (words[0] === 'cross-env' || words[0] === 'env' || words[0] === 'npx' || words[0] === 'bunx') words = words.slice(1);
      else if ((words[0] === 'pnpm' || words[0] === 'npm') && words[1] === 'exec') words = words.slice(words[2] === '--' ? 3 : 2);
      else if (words[0] === 'yarn' && words[1] && !words[1].startsWith('-')) words = words.slice(1);
      else if (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) {
        const eq = words[0]!.indexOf('=');
        env[words[0]!.slice(0, eq)] = words[0]!.slice(eq + 1);
        words = words.slice(1);
      } else break;
    }
    if (runner === 'node') {
      if (RUNNER_WORD.node.test(words[0] ?? '') && words.includes('--test')) return { pre: segments.slice(0, k), env, nodeArgs: [], args: words.slice(1) };
      continue;
    }
    let at = RUNNER_WORD[runner].test(words[0] ?? '') ? 0 : -1;
    let nodeArgs: string[] = [];
    if (at < 0 && RUNNER_WORD.node.test(words[0] ?? '')) {
      const j = words.findIndex((w, n) => n > 0 && RUNNER_WORD[runner].test(w));
      if (j > 0) {
        at = j;
        nodeArgs = words.slice(1, j);
      }
    }
    if (at >= 0) return { pre: segments.slice(0, k), env, nodeArgs, args: words.slice(at + 1) };
  }
  return none;
}

/** Flags that take no value, so the word after them is a file pattern and not the flag's value. */
const BOOLEAN_FLAGS = new Set([
  '--test', '--ci', '--coverage', '--runInBand', '-i', '--silent', '--verbose', '--detectOpenHandles', '--forceExit', '--passWithNoTests',
  '--noStackTrace', '--no-cache', '--logHeapUsage', '--errorOnDeprecated', '--globals', '--dom', '--typecheck', '--no-file-parallelism',
  '--experimental-test-coverage', '--experimental-vm-modules', '--experimental-strip-types', '--experimental-test-module-mocks', '--test-only',
  '--enable-source-maps', '--no-warnings', '--test-force-exit', '--allowOnly', '--clearMocks', '--resetMocks', '--restoreMocks',
]);

/** The script's flags (without the ones TestRun sets itself, `drop`, and their values) and its file patterns. */
function splitArgs(args: string[], drop: RegExp): { options: string[]; files: string[] } {
  const options: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      files.push(a);
      continue;
    }
    const next = args[i + 1];
    const takesValue = !a.includes('=') && !BOOLEAN_FLAGS.has(a) && next !== undefined && !next.startsWith('-');
    if (drop.test(a.split('=')[0]!)) {
      if (takesValue) i++;
      continue;
    }
    options.push(a);
    if (takesValue) options.push(args[++i]!);
  }
  return { options, files };
}

/** The JS file a package's bin points to, from the nearest node_modules up the tree. */
function packageBin(dir: string, pkgName: string, binName: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    const pkg = readJson(path.join(d, 'node_modules', pkgName, 'package.json'));
    const bin = typeof pkg?.bin === 'string' ? pkg.bin : (pkg?.bin as Record<string, unknown> | undefined)?.[binName];
    if (typeof bin === 'string') return path.join(d, 'node_modules', pkgName, bin);
    if (path.dirname(d) === d) return null;
  }
}

function pytestCommand(dir: string, root: string): { file: string; args: string[] } | null {
  for (const base of new Set([dir, root])) {
    for (const venv of ['.venv', 'venv', 'env']) {
      const bin = path.join(base, venv, isWindows ? 'Scripts' : 'bin');
      // Only a virtual environment that has pytest installed (pip puts its launcher next to python).
      const py = path.join(bin, isWindows ? 'python.exe' : 'python');
      if (existsSync(py) && existsSync(path.join(bin, isWindows ? 'pytest.exe' : 'pytest'))) return { file: py, args: ['-m', 'pytest'] };
    }
  }
  if (existsSync(path.join(dir, 'poetry.lock')) && which('poetry')) return { file: which('poetry')!, args: ['run', 'pytest'] };
  if (existsSync(path.join(dir, 'uv.lock')) && which('uv')) return { file: which('uv')!, args: ['run', 'pytest'] };
  const pytest = which('pytest');
  if (pytest) return { file: pytest, args: [] };
  for (const name of isWindows ? ['python', 'py'] : ['python3', 'python']) {
    const py = which(name);
    if (py) return { file: py, args: ['-m', 'pytest'] };
  }
  return null;
}

const looksLikeFile = (filter: string, dir: string, ext: RegExp) => /[\\/]/.test(filter) || ext.test(filter) || existsSync(path.resolve(dir, filter));

export interface Plan {
  runner: Runner;
  dir: string;
  /** Commands the package.json test script runs before the tests (a build), run through the shell. */
  pre: string[];
  file: string;
  args: string[];
  /** Env assignments from the test script (shown in the command). */
  env: Record<string, string>;
  /** Report file, or folder for TRX files; null when the output itself is read. */
  report: string | null;
  goModule?: string;
  display: string;
}

function showArg(a: string, dir: string): string {
  let s = a;
  if (path.isAbsolute(s)) {
    const rel = path.relative(dir, s);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) s = rel.split(path.sep).join('/');
  }
  return /^[\w@%+=:,./\\~-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function showExe(file: string, dir: string): string {
  const base = path.basename(file).replace(/\.(exe|cmd|bat)$/i, '');
  const onPath = which(base);
  if (onPath && samePath(onPath, file)) return base;
  return showArg(file, dir);
}

/** The command for a runner, with the flags that make it write a machine-readable report into reportDir. */
export function buildPlan(det: Detected, filter: string | undefined, reportDir: string, projectRoot: string): Plan | string {
  const { runner, dir } = det;
  const plan: Plan = { runner, dir, pre: [], file: '', args: [], env: {}, report: null, display: '' };
  const jsExt = /\.[cm]?[jt]sx?$/i;
  switch (runner) {
    case 'pytest': {
      const cmd = pytestCommand(dir, projectRoot);
      if (!cmd) return 'pytest was not found: no virtual environment in the project, no pytest and no python on PATH. Install pytest (pip install pytest) first.';
      plan.file = cmd.file;
      plan.report = path.join(reportDir, 'pytest.xml');
      plan.args = [...cmd.args, '-q', '--tb=short', '--color=no', '-o', 'junit_family=xunit1', `--junitxml=${plan.report}`];
      if (filter) plan.args.push(...(filter.includes('::') || looksLikeFile(filter, dir, /\.py$/i) ? [filter] : ['-k', filter]));
      break;
    }
    case 'jest':
    case 'vitest':
    case 'node': {
      const parts = scriptParts(testScript(readJson(path.join(dir, 'package.json'))), runner);
      const isFile = !!filter && looksLikeFile(filter, dir, jsExt);
      const fileArg = isFile ? filter!.replace(/\\/g, '/') : undefined;
      plan.pre = parts.pre;
      plan.env = parts.env;
      plan.file = which('node') ?? process.execPath;
      if (runner === 'node') {
        plan.report = path.join(reportDir, 'node.tap');
        const { options, files } = splitArgs(parts.args, /^--(test-reporter|test-reporter-destination|watch|watch-path)$/);
        // node reads its options only before the first file pattern.
        plan.args = [...(options.includes('--test') ? options : ['--test', ...options]), '--test-reporter=tap', `--test-reporter-destination=${plan.report}`, '--test-reporter=spec', '--test-reporter-destination=stdout'];
        if (filter && !isFile) plan.args.push(`--test-name-pattern=${escapeRegExp(filter)}`);
        plan.args.push(...(fileArg ? [fileArg] : files));
        break;
      }
      const bin = runner === 'jest' ? (packageBin(dir, 'jest', 'jest') ?? packageBin(dir, 'jest-cli', 'jest')) : packageBin(dir, 'vitest', 'vitest');
      if (!bin) return `${runner} is not installed in ${dir} (no node_modules/${runner}). Install the dependencies first (npm install).`;
      let files: string[];
      if (runner === 'jest') {
        plan.report = path.join(reportDir, 'jest.json');
        const split = splitArgs(parts.args, /^--(watch|watchAll|json|outputFile)$/);
        files = split.files;
        plan.args = [...parts.nodeArgs, bin, ...split.options, '--json', `--outputFile=${plan.report}`];
      } else {
        plan.report = path.join(reportDir, 'vitest.json');
        const words = /^(run|watch|dev)$/.test(parts.args[0] ?? '') ? parts.args.slice(1) : parts.args;
        const split = splitArgs(words, /^(--(watch|run|reporter|outputFile|ui|open)|-w)$/);
        files = split.files;
        plan.args = [...parts.nodeArgs, bin, 'run', ...split.options, '--reporter=default', '--reporter=json', `--outputFile=${plan.report}`];
      }
      if (filter && !isFile) plan.args.push('-t', escapeRegExp(filter));
      plan.args.push(...(fileArg ? [fileArg] : files));
      break;
    }
    case 'go': {
      const go = which('go');
      if (!go) return 'go was not found on PATH.';
      plan.file = go;
      plan.goModule = /^module\s+(\S+)/m.exec(readText(path.join(dir, 'go.mod')))?.[1];
      let pkgs = ['./...'];
      let run: string | undefined;
      if (filter && (filter.startsWith('./') || filter.includes('...') || isDirectory(path.resolve(dir, filter)))) pkgs = [filter];
      else if (filter && /\.go$/i.test(filter)) pkgs = [`./${path.dirname(filter).replace(/\\/g, '/')}`.replace(/^\.\/\.$/, '.')];
      else if (filter) run = /^[\w/]+$/.test(filter) ? filter.split('/').map((p) => `^${p}$`).join('/') : filter;
      plan.args = ['test', '-json', ...(run ? ['-run', run] : []), ...pkgs];
      break;
    }
    case 'cargo': {
      const cargo = which('cargo');
      if (!cargo) return 'cargo was not found on PATH.';
      plan.file = cargo;
      plan.args = ['test', '--color', 'never', '--no-fail-fast'];
      if (filter && /\.rs$/i.test(filter)) {
        const f = filter.replace(/\\/g, '/');
        const m = /(?:^|\/)tests\/([\w-]+)\.rs$/.exec(f);
        plan.args.push(...(m ? ['--test', m[1]!] : /(^|\/)src\//.test(f) ? ['--lib'] : []));
      } else if (filter) plan.args.push(filter);
      break;
    }
    case 'dotnet': {
      const dotnet = which('dotnet');
      if (!dotnet) return 'dotnet was not found on PATH.';
      plan.file = dotnet;
      plan.report = reportDir;
      const sln = dotnetFiles(dir).filter((f) => /\.slnx?$/i.test(f));
      plan.args = ['test', ...(dotnetFiles(dir).length > 1 && sln.length === 1 ? [sln[0]!] : []), '--logger', 'trx', '--results-directory', reportDir];
      if (filter) {
        const cls = /\.(cs|fs|vb)$/i.test(filter) ? path.basename(filter).replace(/\.\w+$/, '') : undefined;
        plan.args.push('--filter', cls ? `FullyQualifiedName~${cls}` : /[=~!]/.test(filter) ? filter : `FullyQualifiedName~${filter}`);
      }
      break;
    }
  }
  const env = Object.entries(plan.env).map(([k, v]) => `${k}=${showArg(v, dir)}`);
  plan.display = [...plan.pre, [...env, showExe(plan.file, dir), ...plan.args.map((a) => showArg(a, dir))].join(' ')].join(' && ');
  return plan;
}

// ------------------------------------------------------------------ running

/** The environment for the tests: the Bash tool's, with node_modules/.bin on PATH like npm test has it. */
function runEnv(plan: Plan, ctx: ToolContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...shellEnv(ctx), ...plan.env, FORCE_COLOR: '0', PY_COLORS: '0' };
  if (plan.runner === 'cargo') env.RUST_BACKTRACE = '0';
  // Set when FreeCode itself runs under node --test; the inner runner would then report to it instead.
  delete env.NODE_TEST_CONTEXT;
  if (plan.runner === 'jest' || plan.runner === 'vitest' || plan.runner === 'node') {
    const bins: string[] = [];
    for (let d = plan.dir; ; d = path.dirname(d)) {
      if (isDirectory(path.join(d, 'node_modules', '.bin'))) bins.push(path.join(d, 'node_modules', '.bin'));
      if (path.dirname(d) === d) break;
    }
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [...bins, env[key] ?? ''].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/** .cmd and .bat files cannot be started without cmd.exe. */
function spawnSpec(file: string, args: string[]): { file: string; args: string[]; verbatim?: boolean } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const q = (a: string) => (/^[\w@+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`], verbatim: true };
}

async function readReport(plan: Plan, res: ProcessResult): Promise<TestReport | null> {
  const read = (file: string) => fsp.readFile(file, 'utf8').catch(() => null);
  switch (plan.runner) {
    case 'pytest': {
      const xml = await read(plan.report!);
      return xml ? parseJUnit(xml, plan.dir) : null;
    }
    case 'jest':
    case 'vitest': {
      const json = await read(plan.report!);
      return json ? parseJestJson(json, plan.dir) : null;
    }
    case 'node': {
      const tap = await read(plan.report!);
      return tap ? parseNodeTap(tap, plan.dir) : null;
    }
    case 'go':
      return parseGoTestJson(res.stdout, { root: plan.dir, modulePath: plan.goModule, output: res.output });
    case 'cargo':
      return parseCargoTest(res.stdout, res.output);
    case 'dotnet': {
      const files = (await fsp.readdir(plan.report!).catch(() => [] as string[])).filter((f) => f.endsWith('.trx'));
      let merged: TestReport | null = null;
      for (const f of files) {
        const xml = await read(path.join(plan.report!, f));
        const r = xml ? parseTrx(xml, plan.dir) : null;
        if (!r) continue;
        merged ??= emptyReport();
        merged.passed += r.passed;
        merged.failed += r.failed;
        merged.skipped += r.skipped;
        merged.errors += r.errors;
        merged.problems.push(...r.problems);
      }
      return merged;
    }
  }
}

async function runPlan(plan: Plan, det: Detected, reportDir: string, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const left = () => Math.max(1000, started + timeoutMs - Date.now());
  let tail = '';
  let lastProgress = 0;
  const onOutput = (chunk: string) => {
    tail = (tail + chunk).slice(-2000);
    const now = Date.now();
    if (now - lastProgress > 150) {
      lastProgress = now;
      ctx.services.progress(cleanOutput(tail).split('\n').filter((l) => l.trim()).slice(-3).join('\n'));
    }
  };
  const where = samePath(plan.dir, ctx.session.cwd) ? '' : ` in ${displayPath(plan.dir, ctx.session.cwd)}`;
  const label = `${LABEL[plan.runner]}${where}`;
  const notes = det.others.length ? `\n\nAlso found here: ${det.others.map((r) => LABEL[r]).join(', ')}. Pass runner to run those tests.` : '';
  const result = (text: string, isError: boolean, summary?: string): ToolResult => ({ content: text, isError, display: summary ? { kind: 'summary', text: summary } : { kind: 'text', text, maxLines: 12, dim: true } });
  await fsp.mkdir(reportDir, { recursive: true });
  try {
    const env = runEnv(plan, ctx);
    for (const step of plan.pre) {
      const inv = buildInvocation(step, null);
      const res = await runProcess(inv.file, inv.args, { cwd: plan.dir, env, timeoutMs: left(), signal: ctx.signal, verbatim: inv.verbatim, onOutput });
      if (inv.scriptFile) await fsp.unlink(inv.scriptFile).catch(() => undefined);
      if (res.aborted) return { content: 'Interrupted by the user.', isError: true };
      if (res.timedOut || res.exitCode !== 0) {
        const why = res.timedOut ? `timed out after ${formatDuration(timeoutMs)}` : `failed with exit code ${res.exitCode ?? res.signal}`;
        return result(`"${step}", which the package.json test script runs before the tests, ${why}, so no tests ran. The last lines of its output:\n${outputTail(res.output, 30)}`, true);
      }
    }
    const spec = spawnSpec(plan.file, plan.args);
    const res = await runProcess(spec.file, spec.args, { cwd: plan.dir, env, timeoutMs: left(), signal: ctx.signal, verbatim: spec.verbatim, keepStdout: true, onOutput });
    invalidateFileListCache();
    if (res.aborted) return { content: 'Interrupted by the user.', isError: true };
    const report = await readReport(plan, res).catch(() => null);
    const took = formatDuration(Date.now() - started);
    if (!report) {
      const why = res.timedOut ? `timed out after ${took} and was stopped` : `exited with code ${res.exitCode ?? res.signal}`;
      return result(`${label} ${why} without a test report FreeCode could read. The last lines of its output:\n${outputTail(res.output, MAX_LINES - 2)}${notes}`, true);
    }
    shortenPaths(report, plan.dir);
    const failed = report.failed + report.errors > 0;
    let head = `${label}: ${countsText(report)} (${took})`;
    if (res.timedOut) head += `. It timed out and was stopped, so these results are partial`;
    else if (!failed && res.exitCode !== 0) head += `. It exited with code ${res.exitCode ?? res.signal}`;
    let text = formatReport(report, head);
    // Nothing failed but the run did (no tests found, a coverage threshold, a crash after the tests): show why.
    const ran = report.passed + report.failed + report.skipped + report.errors;
    if (!failed && (res.exitCode !== 0 || !ran)) text += `\n\nThe last lines of the output:\n${outputTail(res.output, 12)}`;
    const isError = failed || res.exitCode !== 0 || res.timedOut;
    return result(text + notes, isError, isError ? undefined : `${countsText(report)} (${took})`);
  } finally {
    await fsp.rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const ALIASES: Record<string, Runner> = {
  'py.test': 'pytest',
  python: 'pytest',
  'node --test': 'node',
  'node:test': 'node',
  'node-test': 'node',
  nodetest: 'node',
  'cargo test': 'cargo',
  rust: 'cargo',
  'go test': 'go',
  golang: 'go',
  'dotnet test': 'dotnet',
  '.net': 'dotnet',
  xunit: 'dotnet',
  nunit: 'dotnet',
  mstest: 'dotnet',
};

function runnerParam(v: string): Runner | undefined {
  const s = v.trim().toLowerCase();
  return (RUNNERS as readonly string[]).includes(s) ? (s as Runner) : ALIASES[s];
}

export const TestRunTool: Tool = {
  name: 'TestRun',
  category: 'execute',
  description:
    "Run the project's tests and get a short structured result: passed, failed and skipped counts, then each failure with its test name, file:line, " +
    'assertion message and expected vs actual. Detects pytest, jest, vitest, node --test, cargo test, go test and dotnet test from the project files ' +
    '(the package.json test script included, with its build step), or pass runner. Use filter to run one test or one file. Prefer it over Bash for running tests.',
  parameters: {
    type: 'object',
    properties: {
      runner: { type: 'string', enum: [...RUNNERS], description: 'Test runner. Detected from the project when left out' },
      filter: { type: 'string', description: 'One test or file: a test file path, a pytest node id (tests/test_x.py::test_y) or a test name' },
      path: { type: 'string', description: 'Folder of the project to test (default: the working directory; the project file is also looked for in the folders above)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 600000, max 1800000)' },
    },
  },
  label: (input) => `TestRun(${[strParam(input, 'runner'), strParam(input, 'filter', 'test', 'file')].filter(Boolean).join(', ') || 'all'})`,
  async prepare(input, ctx): Promise<PreparedCall> {
    const r = strParam(input, 'runner', 'framework');
    const runner = r?.trim() ? runnerParam(r) : undefined;
    if (r?.trim() && !runner) return errorResult(`Unknown runner "${r}". Use one of: ${RUNNERS.join(', ')}.`);
    const filter = strParam(input, 'filter', 'test', 'file', 'name', 'pattern')?.trim() || undefined;
    const where = strParam(input, 'path', 'dir', 'directory', 'cwd')?.trim();
    const start = where ? path.resolve(ctx.session.cwd, where) : ctx.session.cwd;
    if (!isDirectory(start)) return errorResult(`${where} is not a folder.`);
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, numParam(input, 'timeout', 'timeout_ms') ?? DEFAULT_TIMEOUT));
    const det = detectRunner(start, ctx.projectRoot, runner, filter);
    if (typeof det === 'string') return errorResult(det);
    const reportDir = path.join(os.tmpdir(), `freecode-test-${process.pid}-${randomId(8)}`);
    const plan = buildPlan(det, filter, reportDir, ctx.projectRoot);
    if (typeof plan === 'string') return errorResult(plan);
    return {
      permission: {
        tool: 'TestRun',
        category: 'execute',
        title: 'Run tests',
        subject: plan.display,
        command: plan.display,
        description: `${LABEL[plan.runner]} in ${displayPath(plan.dir, ctx.projectRoot)}`,
        specifier: plan.runner,
        ruleSuggestion: `TestRun(${plan.runner})`,
        ruleLabel: `${LABEL[plan.runner]} test runs`,
      },
      execute: () => runPlan(plan, det, reportDir, timeout, ctx),
    };
  },
};

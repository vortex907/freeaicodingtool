// TestRun: the report parsers on outputs recorded from real runs (pytest JUnit XML, jest and vitest JSON,
// go test -json, node --test TAP, cargo test text, a TRX file), runner detection, the command and its
// permission, and a real node --test run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import {
  TestRunTool,
  buildPlan,
  detectRunner,
  expectedActual,
  formatReport,
  parseCargoTest,
  parseGoTestJson,
  parseJUnit,
  parseJestJson,
  parseNodeTap,
  parseTrx,
  scriptParts,
  shellWords,
  type TestReport,
} from '../src/tools/testRun.js';
import { decide } from '../src/permissions/permissions.js';
import { FileTracker } from '../src/tools/fileTracker.js';
import { which } from '../src/util/platform.js';
import type { SessionState, ToolContext } from '../src/tools/types.js';

/** Fixture paths live under this folder (it is never created). */
const root = path.join(os.tmpdir(), 'fc-testrun-fixtures');
const abs = (rel: string) => path.join(root, ...rel.split('/'));
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const counts = (r: TestReport | null) => r && { passed: r.passed, failed: r.failed, skipped: r.skipped, errors: r.errors };

test('pytest JUnit XML: node ids, the failing line from the traceback, setup and collection errors', () => {
  // pytest -q --tb=short -o junit_family=xunit1 --junitxml=...
  const xml =
    '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="3" skipped="1" tests="7" time="0.033">' +
    '<testcase classname="tests.test_math" name="test_adds" file="tests/test_math.py" line="5" time="0.001" />' +
    '<testcase classname="tests.test_math" name="test_adds_wrong" file="tests/test_math.py" line="8" time="0.001"><failure message="assert 3 == 4&#10; +  where 3 = add(1, 2)">tests/test_math.py:10: in test_adds_wrong\n    assert add(1, 2) == 4\nE   assert 3 == 4\nE    +  where 3 = add(1, 2)</failure></testcase>' +
    '<testcase classname="tests.test_math.TestGroup" name="test_dict" file="tests/test_math.py" line="12" time="0.001"><failure message="AssertionError: assert {\'a\': 1} == {\'a\': 2}">tests/test_math.py:14: in test_dict\n    assert {"a": 1} == {"a": 2}\nE   AssertionError: assert {\'a\': 1} == {\'a\': 2}\nE     \nE     Differing items:\nE     {\'a\': 1} != {\'a\': 2}\nE     Use -v to get more diff</failure></testcase>' +
    '<testcase classname="tests.test_math" name="test_skipped" file="tests/test_math.py" line="18" time="0.000"><skipped type="pytest.skip" message="not ready">tests/test_math.py:19: not ready</skipped></testcase>' +
    '<testcase classname="tests.test_math" name="test_param[1]" file="tests/test_math.py" line="22" time="0.001" />' +
    '<testcase classname="tests.test_math" name="test_param[2]" file="tests/test_math.py" line="22" time="0.000"><failure message="AssertionError: n was 2&#10;assert 2 == 1">tests/test_math.py:25: in test_param\n    assert n == 1, f"n was {n}"\nE   AssertionError: n was 2\nE   assert 2 == 1</failure></testcase>' +
    '<testcase classname="tests.test_math" name="test_uses_broken" file="tests/test_math.py" line="30" time="0.000"><error message="failed on setup with &quot;RuntimeError: fixture broke&quot;">tests/test_math.py:29: in broken\n    raise RuntimeError("fixture broke")\nE   RuntimeError: fixture broke</error></testcase>' +
    '</testsuite></testsuites>';
  const r = parseJUnit(xml, root);
  assert.deepEqual(counts(r), { passed: 2, failed: 3, skipped: 1, errors: 1 });
  const [wrong, dict, param, setup] = r!.problems;
  assert.deepEqual(wrong, { kind: 'fail', name: 'tests/test_math.py::test_adds_wrong', file: 'tests/test_math.py', line: 10, message: 'assert 3 == 4\n +  where 3 = add(1, 2)' });
  assert.equal(dict!.name, 'tests/test_math.py::TestGroup::test_dict');
  assert.equal(dict!.line, 14);
  assert.doesNotMatch(dict!.message, /Use -v/);
  assert.equal(param!.name, 'tests/test_math.py::test_param[2]');
  assert.equal(param!.message, 'AssertionError: n was 2\nassert 2 == 1');
  assert.deepEqual([setup!.kind, setup!.line, setup!.message], ['error', 29, 'RuntimeError: fixture broke']);

  // A module that does not import: pytest stops and reports a collection error for the file.
  const collect =
    '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1" time="0.142"><testcase classname="" name="tests.test_collect" file="tests/test_collect.py" time="0.000"><error message="collection failure">ImportError while importing test module \'/repo/tests/test_collect.py\'.\nTraceback:\n/usr/lib/python3.13/importlib/__init__.py:88: in import_module\n    return _bootstrap._gcd_import(name[level:], package, level)\ntests/test_collect.py:1: in &lt;module&gt;\n    import does_not_exist_module\nE   ModuleNotFoundError: No module named \'does_not_exist_module\'</error></testcase></testsuite></testsuites>';
  const c = parseJUnit(collect, root);
  assert.deepEqual(counts(c), { passed: 0, failed: 0, skipped: 0, errors: 1 });
  assert.deepEqual(c!.problems[0], { kind: 'error', name: 'tests/test_collect.py', file: 'tests/test_collect.py', line: 1, message: "ModuleNotFoundError: No module named 'does_not_exist_module'" });

  // xunit2 (pytest's default) has no file attribute: the file comes from the traceback.
  const x2 = '<testsuites><testsuite name="pytest" tests="1"><testcase classname="pkg.tests.test_io" name="test_read" time="0.1"><failure message="OSError: nope">pkg/tests/test_io.py:7: in test_read\n    open("x")\nE   OSError: nope</failure></testcase></testsuite></testsuites>';
  assert.deepEqual(parseJUnit(x2, root)!.problems[0], { kind: 'fail', name: 'pkg/tests/test_io.py::test_read', file: 'pkg/tests/test_io.py', line: 7, message: 'OSError: nope' });
  assert.equal(parseJUnit('not xml at all', root), null);
});

test('jest JSON: names with their describe blocks, the failing line, matcher values and a file that failed to load', () => {
  const file = abs('src/math.test.js');
  const json = JSON.stringify({
    numFailedTests: 3,
    numPassedTests: 1,
    numPendingTests: 1,
    numTodoTests: 1,
    numRuntimeErrorTestSuites: 1,
    testResults: [
      {
        name: abs('src/broken.test.js'),
        status: 'failed',
        message:
          "  \u25cf Test suite failed to run\n\n    Cannot find module './does-not-exist' from 'src/broken.test.js'\n\n    > 1 | const x = require('./does-not-exist');\n        |           ^\n      2 | test('never runs', () => {});\n\n      at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/index.js:863:11)",
        assertionResults: [],
      },
      {
        name: file,
        status: 'failed',
        message: '',
        assertionResults: [
          { ancestorTitles: ['math'], title: 'adds numbers', status: 'passed', failureMessages: [], failureDetails: [] },
          {
            ancestorTitles: ['math'],
            title: 'adds wrong',
            status: 'failed',
            failureMessages: [`Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 4\nReceived: 3\n    at Object.toBe (${file}:7:23)\n    at Promise.finally.completed (${abs('node_modules/jest-circus/build/jestAdapterInit.js')}:1834:28)`],
            failureDetails: [{ matcherResult: { actual: 3, expected: 4, name: 'toBe', pass: false } }],
          },
          {
            ancestorTitles: ['math', 'objects'],
            title: 'deep equal',
            status: 'failed',
            failureMessages: [`Error: expect(received).toEqual(expected) // deep equality\n\n- Expected  - 1\n+ Received  + 1\n\n  Object {\n    "a": 1,\n-   "b": 3,\n+   "b": 2,\n  }\n    at Object.toEqual (${file}:11:35)`],
            failureDetails: [{ matcherResult: { actual: { a: 1, b: 2 }, expected: { a: 1, b: 3 }, name: 'toEqual', pass: false } }],
          },
          { ancestorTitles: ['math'], title: 'skipped test', status: 'pending', failureMessages: [] },
          { ancestorTitles: ['math'], title: 'later', status: 'todo', failureMessages: [] },
          { ancestorTitles: [], title: 'throws', status: 'failed', failureMessages: [`Error: kaboom\n    at Object.<anonymous> (${file}:18:9)`], failureDetails: [{}] },
        ],
      },
    ],
  });
  const r = parseJestJson(json, root);
  assert.deepEqual(counts(r), { passed: 1, failed: 3, skipped: 2, errors: 1 });
  const [broken, wrong, deep, throws] = r!.problems;
  assert.equal(broken!.kind, 'error');
  assert.equal(broken!.name, 'src/broken.test.js');
  assert.equal(broken!.line, 1);
  assert.match(broken!.message, /^Cannot find module '\.\/does-not-exist'/);
  assert.deepEqual(wrong, { kind: 'fail', name: 'math > adds wrong', file: 'src/math.test.js', line: 7, message: 'Error: expect(received).toBe(expected) // Object.is equality\nExpected: 4\nReceived: 3', expected: '4', actual: '3' });
  assert.deepEqual([deep!.name, deep!.line, deep!.expected, deep!.actual], ['math > objects > deep equal', 11, '{"a":1,"b":3}', '{"a":1,"b":2}']);
  assert.deepEqual([throws!.name, throws!.line, throws!.message, throws!.expected], ['throws', 18, 'Error: kaboom', undefined]);
  assert.equal(parseJestJson('{"no":"results"}', root), null);
});

test('vitest JSON: the same format, with expected and actual read from the assertion message', () => {
  const file = abs('vt/math.test.js');
  const json = JSON.stringify({
    numTotalTests: 3,
    testResults: [
      { name: abs('vt/broken.test.js'), status: 'failed', message: `Cannot find module './does-not-exist.js' imported from '${abs('vt/broken.test.js')}'`, assertionResults: [] },
      {
        name: file,
        status: 'failed',
        message: '',
        assertionResults: [
          { ancestorTitles: ['math'], fullName: 'math adds numbers', title: 'adds numbers', status: 'passed', failureMessages: [], meta: {} },
          { ancestorTitles: ['math'], fullName: 'math adds wrong', title: 'adds wrong', status: 'failed', failureMessages: [`AssertionError: expected 3 to be 4 // Object.is equality\n    at ${file}:8:23\n    at file:///${abs('node_modules/@vitest/runner/dist/index.js').replace(/\\/g, '/').replace(/^\//, '')}:155:11`], meta: {} },
          { ancestorTitles: ['math'], fullName: 'math skipped', title: 'skipped', status: 'skipped', failureMessages: [], meta: {} },
        ],
      },
    ],
  });
  const r = parseJestJson(json, root);
  assert.deepEqual(counts(r), { passed: 1, failed: 1, skipped: 1, errors: 1 });
  assert.deepEqual(r!.problems[1], { kind: 'fail', name: 'math > adds wrong', file: 'vt/math.test.js', line: 8, message: 'AssertionError: expected 3 to be 4 // Object.is equality', expected: '4', actual: '3' });
  assert.deepEqual(expectedActual('AssertionError: expected { a: 1 } to deeply equal { a: 2 }'), { actual: '{ a: 1 }', expected: '{ a: 2 }' });
});

test('go test -json: subtests, t.Errorf locations in sub-packages, panics and a package that does not build', () => {
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);
  const pkg = 'example.com/gofx';
  const out = (Test: string, Output: string, Package = pkg) => ev({ Action: 'output', Package, Test, Output });
  const lines = [
    ev({ ImportPath: `${pkg}/sub [${pkg}/sub.test]`, Action: 'build-output', Output: `# ${pkg}/sub [${pkg}/sub.test]\n` }),
    ev({ ImportPath: `${pkg}/sub [${pkg}/sub.test]`, Action: 'build-output', Output: 'sub/sub.go:3:28: cannot use "x" (untyped string constant) as int value in return statement\n' }),
    ev({ ImportPath: `${pkg}/sub [${pkg}/sub.test]`, Action: 'build-fail' }),
    ev({ Action: 'start', Package: `${pkg}/sub` }),
    ev({ Action: 'output', Package: `${pkg}/sub`, Output: `FAIL\t${pkg}/sub [build failed]\n` }),
    ev({ Action: 'fail', Package: `${pkg}/sub`, Elapsed: 0, FailedBuild: `${pkg}/sub [${pkg}/sub.test]` }),
    ev({ Action: 'run', Package: pkg, Test: 'TestAdd' }),
    out('TestAdd', '=== RUN   TestAdd\n'),
    ev({ Action: 'pass', Package: pkg, Test: 'TestAdd' }),
    ev({ Action: 'run', Package: `${pkg}/util`, Test: 'TestTrim' }),
    out('TestTrim', '    trim_test.go:14: Trim(" a ") = " a", want "a"\n', `${pkg}/util`),
    out('TestTrim', '--- FAIL: TestTrim (0.00s)\n', `${pkg}/util`),
    ev({ Action: 'fail', Package: `${pkg}/util`, Test: 'TestTrim' }),
    ev({ Action: 'fail', Package: `${pkg}/util` }),
    ev({ Action: 'run', Package: pkg, Test: 'TestSub' }),
    ev({ Action: 'run', Package: pkg, Test: 'TestSub/positive' }),
    ev({ Action: 'pass', Package: pkg, Test: 'TestSub/positive' }),
    ev({ Action: 'run', Package: pkg, Test: 'TestSub/negative' }),
    out('TestSub/negative', '=== RUN   TestSub/negative\n'),
    out('TestSub/negative', '    math_test.go:21: expected: -1\n'),
    out('TestSub/negative', '        actual  : 1\n'),
    out('TestSub/negative', '--- FAIL: TestSub/negative (0.00s)\n'),
    ev({ Action: 'fail', Package: pkg, Test: 'TestSub/negative' }),
    out('TestSub', '--- FAIL: TestSub (0.00s)\n'),
    ev({ Action: 'fail', Package: pkg, Test: 'TestSub' }),
    ev({ Action: 'run', Package: pkg, Test: 'TestSkip' }),
    out('TestSkip', '    math_test.go:26: not ready\n'),
    ev({ Action: 'skip', Package: pkg, Test: 'TestSkip' }),
    ev({ Action: 'run', Package: pkg, Test: 'TestPanic' }),
    out('TestPanic', '--- FAIL: TestPanic (0.00s)\n'),
    out('TestPanic', 'panic: assignment to entry in nil map [recovered]\n'),
    out('TestPanic', '\tpanic: assignment to entry in nil map\n\ngoroutine 23 [running]:\n'),
    out('TestPanic', `${pkg}.TestPanic(0xc000083340?)\n`),
    out('TestPanic', `\t${abs('math_test.go')}:31 +0x28\n`),
    ev({ Action: 'fail', Package: pkg, Test: 'TestPanic' }),
    ev({ Action: 'output', Package: pkg, Output: `FAIL\t${pkg}\t0.005s\n` }),
    ev({ Action: 'fail', Package: pkg }),
  ];
  const r = parseGoTestJson(lines.join('\n'), { root, modulePath: pkg });
  assert.deepEqual(counts(r), { passed: 2, failed: 3, skipped: 1, errors: 1 });
  const byName = Object.fromEntries(r!.problems.map((p) => [p.name, p]));
  assert.deepEqual(byName.TestTrim, { kind: 'fail', name: 'TestTrim', file: 'util/trim_test.go', line: 14, message: 'Trim(" a ") = " a", want "a"' });
  assert.deepEqual(byName['TestSub/negative'], { kind: 'fail', name: 'TestSub/negative', file: 'math_test.go', line: 21, message: 'expected: -1\nactual  : 1', expected: '-1', actual: '1' });
  assert.deepEqual([byName.TestPanic!.file, byName.TestPanic!.line, byName.TestPanic!.message], ['math_test.go', 31, 'panic: assignment to entry in nil map [recovered]']);
  assert.deepEqual(byName[`${pkg}/sub`], { kind: 'error', name: `${pkg}/sub`, file: 'sub/sub.go', line: 3, message: 'cannot use "x" (untyped string constant) as int value in return statement' });

  // Before Go 1.24 build errors went to stderr; the package event only says [build failed].
  const old = [ev({ Action: 'output', Package: `${pkg}/sub`, Output: `FAIL\t${pkg}/sub [build failed]\n` }), ev({ Action: 'fail', Package: `${pkg}/sub` })].join('\n');
  const stderr = `# ${pkg}/sub\nsub/sub.go:3:28: undefined: Foo\n${old}`;
  assert.deepEqual(parseGoTestJson(old, { root, modulePath: pkg, output: stderr })!.problems[0], { kind: 'error', name: `${pkg}/sub`, file: 'sub/sub.go', line: 3, message: 'undefined: Foo' });
  assert.equal(parseGoTestJson('go: cannot find main module\n', { root }), null);
});

test('node --test TAP: nested names, assertion lines, expected and actual, and a test file that failed to load', () => {
  const a = abs('test/a.test.mjs');
  const yamlPath = (p: string, line: number) => inspect(`${p}:${line}:1`);
  const frame = (p: string, line: number) => `TestContext.<anonymous> (${pathToFileURL(p).href}:${line}:10)`;
  const tap = [
    'TAP version 13',
    "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'missing.mjs' imported from broken.test.mjs",
    '#     at finalizeResolution (node:internal/modules/esm/resolve:274:11)',
    '# Subtest: test/broken.test.mjs',
    'not ok 1 - test/broken.test.mjs',
    '  ---',
    `  location: ${yamlPath(abs('test/broken.test.mjs'), 1)}`,
    "  failureType: 'testCodeFailure'",
    '  exitCode: 1',
    "  error: 'test failed'",
    '  ...',
    '# Subtest: adds',
    'ok 2 - adds',
    '  ---',
    "  type: 'test'",
    '  ...',
    '# Subtest: fails strict',
    'not ok 3 - fails strict',
    '  ---',
    "  type: 'test'",
    `  location: ${yamlPath(a, 4)}`,
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    ',
    '    2 !== 3',
    '    ',
    "  code: 'ERR_ASSERTION'",
    '  expected: 3',
    '  actual: 2',
    '  stack: |-',
    `    ${frame(a, 5)}`,
    '    Test.runInAsyncScope (node:async_hooks:214:14)',
    '  ...',
    '# Subtest: skipped one',
    'ok 4 - skipped one # SKIP not ready',
    '# Subtest: todo one',
    'ok 5 - todo one # TODO',
    '# Subtest: math suite',
    '    # Subtest: inner',
    '        # Subtest: a \\# weird name',
    '        not ok 1 - a \\# weird name',
    '          ---',
    "          type: 'test'",
    `          location: ${yamlPath(a, 11)}`,
    "          failureType: 'testCodeFailure'",
    "          error: 'boom here'",
    '          expected:',
    '            a: 1',
    '          actual:',
    '            a: 2',
    '          ...',
    '        1..1',
    '    not ok 1 - inner',
    '      ---',
    "      type: 'suite'",
    "      failureType: 'subtestsFailed'",
    "      error: '1 subtest failed'",
    '      ...',
    '    1..1',
    'not ok 6 - math suite',
    '  ---',
    "  type: 'suite'",
    "  failureType: 'subtestsFailed'",
    '  ...',
    '1..6',
    '# tests 6',
    '# suites 2',
    '# pass 1',
    '# fail 3',
    '# cancelled 0',
    '# skipped 1',
    '# todo 1',
  ].join('\n');
  const r = parseNodeTap(tap, root);
  assert.deepEqual(counts(r), { passed: 1, failed: 2, skipped: 2, errors: 1 });
  const [broken, strict, weird] = r!.problems;
  assert.deepEqual(broken, { kind: 'error', name: 'test/broken.test.mjs', file: 'test/broken.test.mjs', line: 1, message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'missing.mjs' imported from broken.test.mjs" });
  assert.deepEqual(strict, { kind: 'fail', name: 'fails strict', file: 'test/a.test.mjs', line: 5, message: 'Expected values to be strictly equal:\n2 !== 3', expected: '3', actual: '2' });
  // Multi-line values are left out; the error message has the diff.
  assert.deepEqual(weird, { kind: 'fail', name: 'math suite > inner > a # weird name', file: 'test/a.test.mjs', line: 11, message: 'boom here' });
  assert.equal(parseNodeTap('just some output\n', root), null);
});

test('cargo test output: per-binary totals, panic locations in both message formats, and compile errors', () => {
  const stdout = [
    'running 4 tests',
    'test tests::ignored ... ignored',
    'test tests::adds ... ok',
    'test tests::adds_wrong ... FAILED',
    'test tests::old_style ... FAILED',
    '',
    'failures:',
    '',
    '---- tests::adds_wrong stdout ----',
    '',
    "thread 'tests::adds_wrong' (2333) panicked at src/lib.rs:9:23:",
    'assertion `left == right` failed',
    '  left: 3',
    ' right: 4',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    '',
    '---- tests::old_style stdout ----',
    "thread 'tests::old_style' panicked at 'assertion failed: `(left == right)`",
    '  left: `1`,',
    " right: `2`', src/lib.rs:20:5",
    '',
    'failures:',
    '    tests::adds_wrong',
    '    tests::old_style',
    '',
    'test result: FAILED. 1 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.29s',
    '',
    'running 2 tests',
    'test int_ok ... ok',
    'test int_fail ... FAILED',
    '',
    'failures:',
    '',
    '---- int_fail stdout ----',
    '',
    "thread 'int_fail' panicked at tests/integration.rs:4:17:",
    'boom',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s',
  ].join('\n');
  const r = parseCargoTest(stdout, stdout);
  assert.deepEqual(counts(r), { passed: 2, failed: 3, skipped: 1, errors: 0 });
  assert.deepEqual(r!.problems, [
    { kind: 'fail', name: 'tests::adds_wrong', file: 'src/lib.rs', line: 9, message: 'assertion `left == right` failed\n  left: 3\n right: 4' },
    { kind: 'fail', name: 'tests::old_style', file: 'src/lib.rs', line: 20, message: 'assertion failed: `(left == right)`\n  left: `1`,\n right: `2`' },
    { kind: 'fail', name: 'int_fail', file: 'tests/integration.rs', line: 4, message: 'boom' },
  ]);
  const compile = 'error[E0308]: mismatched types\n --> src/lib.rs:3:28\n  |\n3 | pub fn broken() -> i32 { "x" }\n  |                          ^^^ expected `i32`, found `&str`\n\nerror: could not compile `rsfx` (lib test) due to 1 previous error\n';
  assert.deepEqual(parseCargoTest('', compile)!.problems, [{ kind: 'error', name: 'compile error', file: 'src/lib.rs', line: 3, message: 'mismatched types' }]);
  assert.equal(parseCargoTest('', 'error: could not find `Cargo.toml`\n'), null);
});

test('dotnet TRX: outcomes, file:line from the stack trace and xUnit or MSTest expected/actual', () => {
  const cs = xmlEscape(abs('Calc.Tests/MathTests.cs'));
  const trx =
    '<?xml version="1.0" encoding="utf-8"?>\n<TestRun id="1" name="runner 2026-10-23" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>' +
    '<UnitTestResult executionId="a" testName="Calc.Tests.MathTests.Adds" outcome="Passed" />' +
    `<UnitTestResult executionId="b" testName="Calc.Tests.MathTests.AddsWrong" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure: Values differ\nExpected: 4\nActual:   3</Message><StackTrace>   at Calc.Tests.MathTests.AddsWrong() in ${cs}:line 14\n   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments)</StackTrace></ErrorInfo></Output></UnitTestResult>` +
    '<UnitTestResult executionId="c" testName="Calc.Tests.MathTests.Later" outcome="NotExecuted"><Output><ErrorInfo><Message>not ready</Message></ErrorInfo></Output></UnitTestResult>' +
    `<UnitTestResult executionId="d" testName="Calc.Tests.MathTests.AreEqual" outcome="Failed"><Output><ErrorInfo><Message>Assert.AreEqual failed. Expected:&lt;5&gt;. Actual:&lt;6&gt;. </Message><StackTrace>   at Calc.Tests.MathTests.AreEqual() in ${cs}:line 30</StackTrace></ErrorInfo></Output></UnitTestResult>` +
    '</Results><ResultSummary outcome="Failed"><Counters total="4" executed="3" passed="1" failed="2" /></ResultSummary></TestRun>';
  const r = parseTrx(trx, root);
  assert.deepEqual(counts(r), { passed: 1, failed: 2, skipped: 1, errors: 0 });
  assert.deepEqual(r!.problems[0], { kind: 'fail', name: 'Calc.Tests.MathTests.AddsWrong', file: 'Calc.Tests/MathTests.cs', line: 14, message: 'Assert.Equal() Failure: Values differ\nExpected: 4\nActual:   3', expected: '4', actual: '3' });
  assert.deepEqual([r!.problems[1]!.line, r!.problems[1]!.expected, r!.problems[1]!.actual], [30, '5', '6']);
});

test('the summary stays within about 40 lines and names the failures it had no room for', () => {
  const report: TestReport = { passed: 120, failed: 30, skipped: 0, errors: 1, problems: [] };
  report.problems.push({ kind: 'error', name: 'tests/test_db.py', file: 'tests/test_db.py', line: 1, message: 'ModuleNotFoundError: No module named db' });
  for (let i = 1; i <= 30; i++) report.problems.push({ kind: 'fail', name: `test_case_${i}`, file: 'tests/test_x.py', line: i, message: `assert ${i} == 0\nmore detail\nmore\nmore\nmore`, expected: '0', actual: String(i) });
  const text = formatReport(report, 'pytest: 30 failed, 1 error, 120 passed (2.0s)');
  const lines = text.split('\n');
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.equal(lines[2], 'ERROR tests/test_db.py (tests/test_db.py:1)');
  assert.equal(lines[4], 'FAIL test_case_1 (tests/test_x.py:1)');
  assert.deepEqual(lines.slice(5, 11), ['  assert 1 == 0', '  more detail', '  more', '  more', '  expected: 0', '  actual:   1']);
  assert.match(lines[lines.length - 1]!, /^\.\.\. and 2\d more: test_case_\d+, /);
});

test('runner detection, the package.json test script and the command for each runner', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'fc-testrun-detect-'));
  const proj = (name: string, files: Record<string, string>) => {
    const dir = path.join(base, name);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    return dir;
  };
  const report = path.join(base, 'report');
  const plan = (dir: string, filter?: string, runner?: Parameters<typeof detectRunner>[2]) => {
    const det = detectRunner(dir, dir, runner, filter);
    assert.equal(typeof det, 'object', String(det));
    const p = buildPlan(det as Exclude<typeof det, string>, filter, report, dir);
    assert.equal(typeof p, 'object', String(p));
    return p as Exclude<typeof p, string>;
  };

  // A build step before node --test runs first; node's options go before the file patterns.
  const nodeDir = proj('node', { 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'npm run build && node --test "dist/**/*.test.js"' } }) });
  let p = plan(nodeDir);
  assert.equal(p.runner, 'node');
  assert.deepEqual(p.pre, ['npm run build']);
  assert.deepEqual(p.args.slice(0, 2), ['--test', '--test-reporter=tap']);
  assert.equal(p.args[p.args.length - 1], 'dist/**/*.test.js');
  assert.match(p.display, /^npm run build && node --test --test-reporter=tap .* "dist\/\*\*\/\*\.test\.js"$/);
  assert.equal(plan(nodeDir, 'adds (two)').args.find((a) => a.startsWith('--test-name-pattern=')), '--test-name-pattern=adds \\(two\\)');
  assert.equal(plan(nodeDir, 'dist/a.test.js').args.slice(-1)[0], 'dist/a.test.js');
  assert.ok(!plan(nodeDir, 'dist/a.test.js').args.includes('dist/**/*.test.js'), 'a file filter replaces the patterns');

  // jest through cross-env with its own flags; --watch is dropped, the jest binary comes from node_modules.
  const jestDir = proj('jest', {
    'package.json': JSON.stringify({ scripts: { test: 'cross-env NODE_OPTIONS=--experimental-vm-modules jest --config jest.ci.js --watch' }, devDependencies: { jest: '^30' } }),
    'node_modules/jest/package.json': JSON.stringify({ name: 'jest', bin: './bin/jest.js' }),
  });
  p = plan(jestDir, 'adds wrong');
  assert.equal(p.runner, 'jest');
  assert.deepEqual(p.env, { NODE_OPTIONS: '--experimental-vm-modules' });
  assert.equal(p.args[0], path.join(jestDir, 'node_modules', 'jest', 'bin', 'jest.js'));
  assert.deepEqual(p.args.slice(1, 4), ['--config', 'jest.ci.js', '--json']);
  assert.ok(!p.args.includes('--watch'));
  assert.deepEqual(p.args.slice(-2), ['-t', 'adds wrong']);
  assert.match(p.display, /^NODE_OPTIONS=--experimental-vm-modules node node_modules\/jest\/bin\/jest\.js --config jest\.ci\.js --json --outputFile=/);

  // vitest without its binary installed is refused before anything runs.
  const vitestDir = proj('vitest', { 'package.json': JSON.stringify({ scripts: { test: 'vitest' }, devDependencies: { vitest: '^3' } }) });
  assert.equal(detectRunner(vitestDir, vitestDir) && (detectRunner(vitestDir, vitestDir) as { runner: string }).runner, 'vitest');
  assert.match(String(buildPlan(detectRunner(vitestDir, vitestDir) as never, undefined, report, vitestDir)), /vitest is not installed/);

  // pytest from its config, -k for a name and the node id as it is; a .py filter wins over package.json.
  const pyDir = proj('py', { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-ra"\n', 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  assert.equal(plan(pyDir, 'tests/test_x.py::test_y').runner, 'pytest');
  if (which('pytest') || which('python3') || which('python')) {
    assert.deepEqual(plan(pyDir, 'tests/test_x.py::test_y').args.slice(-1), ['tests/test_x.py::test_y']);
    assert.deepEqual(plan(pyDir, 'add', 'pytest').args.slice(-2), ['-k', 'add']);
  }
  assert.deepEqual((detectRunner(pyDir, pyDir) as { runner: string; others: string[] }).others, ['pytest']);

  // go, cargo and .NET from their project files, one folder up from where the agent is.
  const goDir = proj('go', { 'go.mod': 'module example.com/x\n\ngo 1.22\n', 'pkg/a_test.go': 'package pkg\n' });
  assert.deepEqual(detectRunner(path.join(goDir, 'pkg'), base), { runner: 'go', dir: goDir, others: [] });
  if (which('go')) {
    assert.deepEqual(plan(goDir, 'TestSub/negative').args, ['test', '-json', '-run', '^TestSub$/^negative$', './...']);
    assert.deepEqual(plan(goDir, 'pkg/a_test.go').args, ['test', '-json', './pkg']);
  }
  const rsDir = proj('rs', { 'Cargo.toml': '[package]\nname = "x"\n' });
  if (which('cargo')) assert.deepEqual(plan(rsDir, 'tests/integration.rs').args, ['test', '--color', 'never', '--no-fail-fast', '--test', 'integration']);
  const csDir = proj('cs', { 'Calc.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk" />' });
  assert.equal((detectRunner(csDir, csDir) as { runner: string }).runner, 'dotnet');

  // A test script for a runner TestRun does not read, and a folder without tests.
  const mochaDir = proj('mocha', { 'package.json': JSON.stringify({ scripts: { test: 'mocha "test/**/*.js"' } }) });
  assert.match(String(detectRunner(mochaDir, mochaDir)), /test script \("mocha .*"\) uses a runner TestRun does not read/);
  assert.match(String(detectRunner(proj('empty', { 'README.md': 'hi' }), base)), /^No test setup found/);

  assert.deepEqual(shellWords(`a "b c" 'd "e"' f\\ g --x="h i"`), ['a', 'b c', 'd "e"', 'f g', '--x=h i']);
  assert.deepEqual(scriptParts('tsc -p . && NODE_ENV=test npx vitest run --coverage src', 'vitest'), { pre: ['tsc -p .'], env: { NODE_ENV: 'test' }, nodeArgs: [], args: ['run', '--coverage', 'src'] });
  assert.deepEqual(scriptParts('node --experimental-vm-modules node_modules/jest/bin/jest.js -i', 'jest'), { pre: [], env: {}, nodeArgs: ['--experimental-vm-modules'], args: ['-i'] });
});

function contextFor(dir: string): ToolContext {
  const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, toolSeq: 0, permissionMode: 'default' } as never as SessionState;
  return { projectRoot: dir, session, settings: { env: {}, permissions: { additionalDirectories: [] } }, files: new FileTracker(false), signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;
}

test('TestRun runs node --test and returns the counts and each failure with file:line and expected/actual', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-testrun-node-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { test: 'node --test' } }));
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(
    path.join(dir, 'test', 'math.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('adds', () => assert.equal(1 + 1, 2));\ntest('adds wrong', () => {\n  assert.equal(1 + 1, 3);\n});\n",
  );
  const ctx = contextFor(dir);
  const prep = await TestRunTool.prepare({}, ctx);
  assert.equal(prep.error, undefined, prep.error?.content);
  // Asks like Bash: an execute request with the command line, read-only in plan mode, covered by Bash rules.
  const req = prep.permission!;
  assert.deepEqual([req.tool, req.category, req.specifier, req.ruleSuggestion], ['TestRun', 'execute', 'node', 'TestRun(node)']);
  assert.match(req.command!, /^node --test --test-reporter=tap /);
  const perms = { mode: 'default' as const, allow: [] as string[], deny: [] as string[], ask: [] as string[], projectRoot: dir, additionalDirectories: [], sessionAllow: new Set<string>(), interactive: true };
  assert.equal(decide(req, perms).action, 'ask');
  assert.equal(decide(req, { ...perms, mode: 'plan' }).action, 'deny');
  assert.equal(decide(req, { ...perms, allow: ['TestRun(node)'] }).action, 'allow');
  assert.equal(decide(req, { ...perms, allow: ['Bash(node --test:*)'] }).action, 'allow');
  assert.equal(decide(req, { ...perms, mode: 'bypassPermissions', deny: ['Bash'] }).action, 'deny');

  const r = await prep.execute();
  assert.equal(r.isError, true, r.content);
  assert.match(r.content, /^node --test: 1 failed, 1 passed \(/);
  assert.match(r.content, /\nFAIL adds wrong \(test\/math\.test\.mjs:6\)\n {2}Expected values to be strictly equal:\n {2}2 !== 3\n {2}expected: 3\n {2}actual: {3}2/);

  const one = await (await TestRunTool.prepare({ filter: 'adds wrong' }, ctx)).execute();
  assert.match(one.content, /^node --test: 1 failed, 0 passed \(/);
  writeFileSync(path.join(dir, 'test', 'math.test.mjs'), "import { test } from 'node:test';\ntest('adds', () => {});\n");
  const ok = await (await TestRunTool.prepare({ filter: 'test/math.test.mjs' }, ctx)).execute();
  assert.equal(ok.isError, false, ok.content);
  assert.match(ok.content, /^node --test: 1 passed \(/);
  assert.equal(ok.display?.kind, 'summary');
});

test('TestRun runs pytest when it is installed', { timeout: 120_000, skip: !which('pytest') && 'pytest is not installed' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-testrun-py-'));
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'tests', 'test_calc.py'), 'def test_ok():\n    assert 1 + 1 == 2\n\n\ndef test_wrong():\n    total = 1 + 1\n    assert total == 3\n');
  const r = await (await TestRunTool.prepare({}, contextFor(dir))).execute();
  assert.match(r.content, /^pytest: 1 failed, 1 passed \(/);
  assert.match(r.content, /\nFAIL tests\/test_calc\.py::test_wrong \(tests\/test_calc\.py:7\)\n {2}assert 2 == 3/);
});

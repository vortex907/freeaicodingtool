// Browser tool against a real headless Chromium (Edge or Chrome on CI runners). Skipped when none is installed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeBrowser, isLocalUrl, resolveTarget } from '../src/browser/browser.js';
import { findBrowser } from '../src/browser/chrome.js';
import { BrowserTool, previewAfterEdit } from '../src/tools/browserTool.js';
import type { SessionState, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-browser-'));
process.env.FREECODE_HOME = mkdtempSync(path.join(os.tmpdir(), 'fc-browser-home-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, permissionMode: 'default' } as never as SessionState;
const ctx = { projectRoot: dir, session, settings: {}, files: {}, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;
const noBrowser = !findBrowser() || typeof WebSocket === 'undefined';

async function call(input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await BrowserTool.prepare(input, ctx);
  if (prep.error) return prep.error;
  return prep.execute();
}

after(() => closeBrowser());

test('local targets resolve without asking, remote ones are network access', () => {
  assert.equal(resolveTarget('localhost:5173', dir), 'http://localhost:5173');
  assert.equal(resolveTarget(':3000/app', dir), 'http://localhost:3000/app');
  assert.match(resolveTarget('index.html', dir), /^file:\/\//);
  assert.ok(isLocalUrl('http://127.0.0.1:8080/'));
  assert.ok(!isLocalUrl('https://example.com/'));
});

test('open reports console errors, layout problems and returns a screenshot', { skip: noBrowser && 'no Chromium-based browser installed' }, async () => {
  writeFileSync(path.join(dir, 'style.css'), 'body{margin:0;font-family:sans-serif}.wide{width:1700px}.sub{color:#cccccc;background:#fff}.cut{width:80px;overflow:hidden;white-space:nowrap}');
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test page</title><link rel="stylesheet" href="style.css"></head>' +
      '<body><h1>Hello</h1><p class="sub">Pale text</p><div class="cut">A long label that is cut off</div><div class="wide">Wide</div>' +
      '<button id="go" onclick="document.title=\'clicked\'">Go</button><input id="q" placeholder="Search"><script>console.error("kaboom")</script></body></html>',
  );
  const r = await call({ action: 'open', url: 'index.html' });
  assert.ok(!r.isError, r.content);
  assert.match(r.content, /Page: "Test page"/);
  assert.match(r.content, /Console: 1 error/);
  assert.match(r.content, /kaboom/);
  assert.match(r.content, /wider than the window/);
  assert.match(r.content, /Low contrast text: p\.sub/);
  assert.match(r.content, /Text cut off by its container: div\.cut/);
  assert.match(r.content, /form field has no label/);
  assert.match(r.content, /h1: Hello/);
  assert.equal(r.images?.length, 1);
  assert.equal(r.display?.kind, 'image');

  const typed = await call({ action: 'type', selector: '#q', text: 'cats' });
  assert.ok(!typed.isError, typed.content);
  const value = await call({ action: 'eval', script: 'document.querySelector("#q").value' });
  assert.match(value.content, /cats/);

  const clicked = await call({ action: 'click', selector: 'text=Go' });
  assert.match(clicked.content, /Clicked button#go/);
  assert.match((await call({ action: 'eval', script: 'document.title' })).content, /clicked/);

  const phone = await call({ action: 'responsive' });
  assert.match(phone.content, /At 375px \(phone\)/);
  assert.match(phone.content, /At 1280px \(desktop\)/);

  // Fixing the CSS: the open page reloads and the problems are gone.
  writeFileSync(path.join(dir, 'style.css'), 'body{margin:0;font-family:sans-serif}.wide{max-width:100%}.sub{color:#444}.cut{white-space:normal}input{height:40px}');
  const note = await previewAfterEdit(session, [path.join(dir, 'style.css')]);
  assert.ok(note);
  assert.doesNotMatch(note!, /wider than the window|Low contrast|cut off/);
  assert.equal(await previewAfterEdit(session, [path.join(dir, 'notes.txt')]), null, 'non-UI files do not reload the page');

  const closed = await call({ action: 'close' });
  assert.match(closed.content, /Closed/);
  const none = await call({ action: 'screenshot' });
  assert.ok(none.isError);
});

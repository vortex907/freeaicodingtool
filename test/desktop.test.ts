// Desktop tool against a real WinForms window (Windows only; CI runs it on windows-latest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopTool, formatWindow } from '../src/tools/desktopTool.js';
import type { SessionState, ToolContext, ToolResult } from '../src/tools/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-desktop-'));
process.env.FREECODE_HOME = mkdtempSync(path.join(os.tmpdir(), 'fc-desktop-home-'));
const session = { cwd: dir, todos: [], shells: new Map(), shellCounter: 0, permissionMode: 'default' } as never as SessionState;
const ctx = { projectRoot: dir, session, settings: {}, files: {}, signal: new AbortController().signal, toolCallId: 't', services: { progress: () => undefined }, depth: 0 } as never as ToolContext;

async function call(input: Record<string, unknown>): Promise<ToolResult> {
  const prep = await DesktopTool.prepare(input, ctx);
  if (prep.error) return prep.error;
  return prep.execute();
}

test('window report lists controls and finds layout problems', () => {
  const text = formatWindow({ hwnd: 1, title: 'Calc', pid: 7, process: 'Calc', x: 0, y: 0, width: 300, height: 200 }, [
    { depth: 0, type: 'Window', name: 'Calc', id: '', enabled: true, offscreen: false, x: 0, y: 0, w: 300, h: 200 },
    { depth: 1, type: 'Edit', name: '', id: 'display', enabled: true, offscreen: false, x: 10, y: 10, w: 280, h: 30, value: '42' },
    { depth: 1, type: 'Button', name: '7', id: 'b7', enabled: true, offscreen: false, x: 10, y: 50, w: 60, h: 40 },
    { depth: 1, type: 'Button', name: '8', id: 'b8', enabled: true, offscreen: false, x: 40, y: 50, w: 60, h: 40 },
    { depth: 1, type: 'Button', name: '=', id: 'eq', enabled: true, offscreen: false, x: 260, y: 150, w: 80, h: 40 },
    { depth: 1, type: 'Button', name: '', id: 'x', enabled: true, offscreen: false, x: 10, y: 150, w: 10, h: 10 },
  ]);
  assert.match(text, /Edit \[display\] 10,10 280x30 value "42"/);
  assert.match(text, /Button "=" \[eq\] reaches outside the window/);
  assert.match(text, /Button "7" \[b7\] and Button "8" \[b8\] overlap/);
  assert.match(text, /Button \[x\] is tiny/);
  assert.match(text, /Button \[x\] has no text/);
});

test('captures and operates a real WinForms window', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  const form = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object Windows.Forms.Form; $f.Text = "FreeCode Test Window"; $f.Width = 420; $f.Height = 260',
    '$b = New-Object Windows.Forms.Button; $b.Text = "Press me"; $b.Name = "pressBtn"; $b.Left = 20; $b.Top = 20; $b.Width = 120',
    '$b.Add_Click({ $f.Text = "FreeCode Test Window pressed" })',
    '$x = New-Object Windows.Forms.TextBox; $x.Name = "nameBox"; $x.Left = 20; $x.Top = 70; $x.Width = 200',
    '$f.Controls.Add($b); $f.Controls.Add($x)',
    '[Windows.Forms.Application]::Run($f)',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', form], { stdio: 'ignore', windowsHide: false });
  try {
    let seen: ToolResult | null = null;
    for (let i = 0; i < 30; i++) {
      const r = await call({ action: 'list' });
      if (/FreeCode Test Window/.test(r.content)) {
        seen = r;
        break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!seen) {
      t.skip('no interactive desktop on this machine');
      return;
    }
    const cap = await call({ action: 'capture', title: 'FreeCode Test Window' });
    assert.ok(!cap.isError, cap.content);
    assert.match(cap.content, /Button "Press me" \[pressBtn\]/);
    assert.match(cap.content, /Edit .*\[nameBox\]/);
    assert.equal(cap.images?.length, 1);

    const typed = await call({ action: 'type', title: 'FreeCode Test Window', target: 'nameBox', text: 'Ahoy' });
    assert.ok(!typed.isError, typed.content);
    assert.match(typed.content, /value "Ahoy"/);

    const clicked = await call({ action: 'click', title: 'FreeCode Test Window', target: 'Press me' });
    assert.ok(!clicked.isError, clicked.content);
    assert.match(clicked.content, /Window "FreeCode Test Window pressed"/);

    const closed = await call({ action: 'close', title: 'FreeCode Test Window' });
    assert.ok(!closed.isError, closed.content);
  } finally {
    child.kill();
  }
});

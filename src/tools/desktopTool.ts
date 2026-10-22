// Desktop: look at and operate the desktop app the agent is building (WinForms, WPF, Electron, games).
// The control tree from UI Automation lets text-only models "see" the window; vision models also get a
// screenshot. Windows only for now.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { saveScreenshot } from '../browser/browser.js';
import { WINDOW_SCRIPT } from '../desktop/windowScript.js';
import { isWindows } from '../util/platform.js';
import { truncate } from '../util/strings.js';
import { errorResult, numParam, strParam, type PreparedCall, type Tool, type ToolResult } from './types.js';

interface WinInfo {
  hwnd: number;
  title: string;
  pid: number;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UiNode {
  depth: number;
  type: string;
  name: string;
  id: string;
  enabled: boolean;
  offscreen: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  value?: string;
  toggle?: string;
}

interface ScriptResult {
  ok: boolean;
  error?: string;
  windows?: WinInfo[];
  window?: WinInfo;
  tree?: UiNode[];
  image?: string;
  control?: string;
}

const ACTIONS = ['list', 'capture', 'click', 'type', 'keys', 'close'] as const;
type Action = (typeof ACTIONS)[number];

function runScript(args: Record<string, unknown>, timeoutMs = 45_000): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, FC_ARGS: JSON.stringify(args) }, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        const line = stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
        if (line) {
          try {
            resolve(JSON.parse(line) as ScriptResult);
            return;
          } catch {
            // fall through to the error below
          }
        }
        resolve({ ok: false, error: err ? `${err.message.split('\n')[0]}${stderr ? `: ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}` : 'No result from PowerShell' });
      },
    );
  });
}

const LEAF = /^(Button|Edit|CheckBox|RadioButton|ComboBox|Text|Hyperlink|Slider|Spinner|ListItem|MenuItem|TabItem|Image|ProgressBar)$/;
const CLICKABLE = /^(Button|CheckBox|RadioButton|ComboBox|Hyperlink|MenuItem|TabItem|ListItem)$/;

function describe(n: UiNode): string {
  return `${n.type}${n.name ? ` "${truncate(n.name, 40)}"` : ''}${n.id ? ` [${n.id}]` : ''}`;
}

/** The window as text: control tree plus layout problems. */
export function formatWindow(win: WinInfo, tree: UiNode[]): string {
  const lines = [`Window "${win.title}" (${win.process || 'process'} pid ${win.pid}), ${win.width}x${win.height}.`];
  lines.push('Controls (type "name" [id] x,y size, relative to the window):');
  for (const n of tree.slice(0, 140)) {
    if (n.offscreen && n.depth > 0) continue;
    const pos = n.w !== undefined ? ` ${n.x},${n.y} ${n.w}x${n.h}` : '';
    const extra = `${n.value !== undefined && n.value !== '' ? ` value "${truncate(n.value, 60)}"` : ''}${n.toggle ? ` ${n.toggle}` : ''}${n.enabled ? '' : ' (disabled)'}`;
    lines.push(`${'  '.repeat(Math.min(n.depth, 8) + 1)}${describe(n)}${pos}${extra}`);
  }
  if (tree.length > 140) lines.push(`  ... ${tree.length - 140} more controls`);
  const problems: string[] = [];
  const leaves = tree.filter((n) => n.depth > 0 && !n.offscreen && n.w !== undefined && LEAF.test(n.type));
  for (const n of leaves) {
    if (problems.length > 12) break;
    if (n.x! + n.w! > win.width + 2 || n.y! + n.h! > win.height + 2 || n.x! < -2 || n.y! < -2) problems.push(`${describe(n)} reaches outside the window (${n.x},${n.y} ${n.w}x${n.h} in ${win.width}x${win.height})`);
    if (CLICKABLE.test(n.type) && (n.w! < 16 || n.h! < 16)) problems.push(`${describe(n)} is tiny (${n.w}x${n.h})`);
    if (n.type === 'Button' && !n.name) problems.push(`${describe(n)} has no text or accessible name`);
  }
  let overlaps = 0;
  for (let i = 0; i < leaves.length && overlaps < 5; i++) {
    for (let j = i + 1; j < leaves.length && overlaps < 5; j++) {
      const a = leaves[i]!;
      const b = leaves[j]!;
      const w = Math.min(a.x! + a.w!, b.x! + b.w!) - Math.max(a.x!, b.x!);
      const h = Math.min(a.y! + a.h!, b.y! + b.h!) - Math.max(a.y!, b.y!);
      if (w <= 2 || h <= 2) continue;
      const inside = (p: UiNode, q: UiNode) => p.x! <= q.x! && p.y! <= q.y! && p.x! + p.w! >= q.x! + q.w! && p.y! + p.h! >= q.y! + q.h!;
      if (inside(a, b) || inside(b, a)) continue;
      if (w * h > 0.2 * Math.min(a.w! * a.h!, b.w! * b.h!)) {
        problems.push(`${describe(a)} and ${describe(b)} overlap`);
        overlaps++;
      }
    }
  }
  if (problems.length) {
    lines.push('Layout problems:');
    for (const p of problems) lines.push(`  - ${p}`);
  } else lines.push('Layout problems: none found.');
  return lines.join('\n');
}

export const DesktopTool: Tool = {
  name: 'Desktop',
  category: 'read',
  description:
    'See and operate desktop app windows on Windows (WinForms, WPF, WinUI, Electron, games), for checking apps you build. ' +
    'Each result lists the window\'s controls (type, name, id, position, size, current value) from UI Automation and layout problems (controls outside the window, overlapping, tiny, buttons without text). Vision models also get a screenshot.\n' +
    'Actions: list (open windows), capture (find a window by title, process or pid and look at it), click (a control by its name or automation id, e.g. a button "7"), type (set the text of an edit control), keys (send keys to the window, SendKeys syntax like {ENTER} or ^a), close (close the window).\n' +
    'Start the app first with Bash run_in_background=true (for example dotnet run), wait a few seconds, then capture it by title or process name.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do (default capture)' },
      title: { type: 'string', description: 'Part of the window title' },
      process: { type: 'string', description: 'Process name, e.g. CalculatorGUI' },
      pid: { type: 'number', description: 'Process id (child processes are searched too)' },
      target: { type: 'string', description: 'For click/type: control name or automation id, or a kind with an optional number when controls have no names (Edit, Edit 2, Button 3)' },
      text: { type: 'string', description: 'For type: the text to set' },
      keys: { type: 'string', description: 'For keys: SendKeys string, e.g. 12+7{ENTER}' },
    },
  },
  label: (input) => {
    const action = strParam(input, 'action') ?? 'capture';
    const what = strParam(input, 'target', 'title', 'process') ?? '';
    return `Desktop(${action}${what ? ` ${truncate(what, 60)}` : ''})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    if (!isWindows) return errorResult('The Desktop tool works on Windows only. For web UIs use the Browser tool.');
    const action = (strParam(input, 'action') ?? 'capture').toLowerCase() as Action;
    if (!ACTIONS.includes(action)) return errorResult(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}`);
    const title = strParam(input, 'title', 'window');
    const proc = strParam(input, 'process', 'process_name', 'exe');
    const pid = numParam(input, 'pid');
    if (action !== 'list' && !title && !proc && !pid) return errorResult('Say which window: title, process or pid (use action=list to see the open windows).');
    const target = strParam(input, 'target', 'control', 'name', 'id');
    if ((action === 'click' || action === 'type') && !target) return errorResult(`${action} needs target (the control's name or automation id)`);
    if (action === 'keys' && !strParam(input, 'keys')) return errorResult('keys needs keys');

    const run = async (): Promise<ToolResult> => {
      const out = action === 'list' || action === 'close' ? undefined : path.join(os.tmpdir(), `freecode-window-${randomBytes(4).toString('hex')}.jpg`);
      ctx.services.progress(action === 'list' ? 'Listing windows' : `Looking at ${title ?? proc ?? pid}`);
      const r = await runScript({ action, title, process: proc, pid, target, text: strParam(input, 'text', 'value'), keys: strParam(input, 'keys'), out });
      if (!r.ok) return { content: `Desktop error: ${r.error}`, isError: true, display: { kind: 'summary', text: (r.error ?? 'failed').split('\n')[0]! } };
      if (action === 'list') {
        const wins = r.windows ?? [];
        const text = wins.length ? wins.map((w) => `"${w.title}" (${w.process} pid ${w.pid}) ${w.width}x${w.height}`).join('\n') : 'No app windows are open.';
        return { content: text, display: { kind: 'text', text } };
      }
      if (action === 'close') return { content: `Closed "${r.window?.title}".`, display: { kind: 'summary', text: 'Closed the window' } };
      const done = action === 'click' ? `Clicked ${r.control}.\n` : action === 'type' ? `Set ${r.control}.\n` : action === 'keys' ? `Sent ${strParam(input, 'keys')}.\n` : '';
      const text = `${done}${formatWindow(r.window!, r.tree ?? [])}`;
      if (!r.image) return { content: text, display: { kind: 'text', text } };
      const buf = await fsp.readFile(r.image).catch(() => null);
      void fsp.unlink(r.image).catch(() => undefined);
      if (!buf) return { content: text, display: { kind: 'text', text } };
      const name = saveScreenshot(buf);
      const problems = /Layout problems:\n((?:  - .*\n?)*)/.exec(text)?.[1]?.split('\n').filter(Boolean).length ?? 0;
      return {
        content: text,
        images: [{ mediaType: 'image/jpeg', data: buf.toString('base64') }],
        display: { kind: 'image', name, text, summary: problems ? `${problems} layout problem${problems === 1 ? '' : 's'}` : 'no layout problems found' },
      };
    };
    // Clicking and typing act on a real app on the user's desktop, so they ask first (like commands).
    if (action === 'click' || action === 'type' || action === 'keys' || action === 'close') {
      return {
        permission: { tool: 'Desktop', category: 'execute', title: 'Control a desktop app', subject: `${action} ${target ?? strParam(input, 'keys') ?? ''} in ${title ?? proc ?? pid}`.trim(), ruleSuggestion: 'Desktop', ruleLabel: 'desktop app control' },
        execute: run,
      };
    }
    return { execute: run };
  },
};

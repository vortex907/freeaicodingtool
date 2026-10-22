// Browser: lets the agent look at the UI it builds. Text-only models get a written report of what a
// person would notice; vision models also get the screenshot.
import { closePage, formatReport, isLocalUrl, openPage, pageFor, resolveTarget, saveScreenshot, type BrowserPage } from '../browser/browser.js';
import type { ImageAttachment } from '../providers/types.js';
import { truncate } from '../util/strings.js';
import { boolParam, errorResult, numParam, strParam, type PreparedCall, type Tool, type ToolResult } from './types.js';

const ACTIONS = ['open', 'screenshot', 'click', 'type', 'press', 'eval', 'responsive', 'console', 'resize', 'close'] as const;
type Action = (typeof ACTIONS)[number];
const RESPONSIVE_WIDTHS = [375, 768, 1280];

function problemCount(text: string): string {
  const errors = /Console: (\d+) error/.exec(text)?.[1];
  const problems = /problems:\n((?:  - .*\n?)*)/.exec(text)?.[1]?.split('\n').filter(Boolean).length ?? 0;
  const bits = [errors && errors !== '0' ? `${errors} console error${errors === '1' ? '' : 's'}` : '', problems ? `${problems} problem${problems === 1 ? '' : 's'}` : ''].filter(Boolean);
  return bits.join(', ') || 'no problems found';
}

async function capture(page: BrowserPage, text: string, opts: { fullPage?: boolean; selector?: string } = {}): Promise<ToolResult> {
  const shot = await page.screenshot(opts);
  const name = saveScreenshot(shot);
  const images: ImageAttachment[] = [{ mediaType: 'image/jpeg', data: shot.toString('base64') }];
  return { content: text, images, display: { kind: 'image', name, text, summary: problemCount(text) } };
}

export const BrowserTool: Tool = {
  name: 'Browser',
  category: 'read',
  planSafe: true,
  description:
    'Look at web pages in a real headless browser (Edge or Chrome) to check UI you build, the way a person would. ' +
    'Every result lists console errors, failed requests and layout problems (sideways overflow, cut-off text, overlapping elements, low contrast, tiny click targets, unstyled fields, broken images, unlabeled controls), plus design stats and what is on the page. Vision models also get a screenshot.\n' +
    'Actions:\n' +
    '- open: load a URL (http://localhost:5173) or an HTML file path. Start dev servers first with Bash run_in_background=true.\n' +
    '- screenshot: look again (full_page=true for the whole page, selector for one element).\n' +
    '- click / type / press: interact like a user. selector is CSS or text=Label; type puts text in a field (submit=true presses Enter); press sends a key (Enter, Tab, Escape, ArrowDown, ...).\n' +
    '- eval: run JavaScript in the page and get the result (await works).\n' +
    '- responsive: check phone (375), tablet (768) and desktop (1280) widths.\n' +
    '- console: console messages and failed requests since the last call.\n' +
    '- resize: change the window size (width, height). close: close the page.\n' +
    'While a page is open, it reloads after you edit UI files and the edit result says what broke.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do (default: open when url is given, else screenshot)' },
      url: { type: 'string', description: 'For open: http(s) URL, localhost:port or a path to an HTML file' },
      selector: { type: 'string', description: 'CSS selector or text=Visible text (click, type, screenshot)' },
      text: { type: 'string', description: 'For type: the text to enter' },
      submit: { type: 'boolean', description: 'For type: press Enter afterwards' },
      key: { type: 'string', description: 'For press: Enter, Tab, Escape, Backspace, ArrowDown, ... or one character' },
      script: { type: 'string', description: 'For eval: JavaScript to run in the page' },
      width: { type: 'number', description: 'Viewport width for open/resize (default 1280)' },
      height: { type: 'number', description: 'Viewport height for open/resize (default 800)' },
      full_page: { type: 'boolean', description: 'For screenshot: capture the whole page instead of the visible window' },
    },
  },
  label: (input) => {
    const action = strParam(input, 'action') ?? (strParam(input, 'url') ? 'open' : 'screenshot');
    const arg = strParam(input, 'url', 'selector', 'key', 'script') ?? '';
    return `Browser(${action}${arg ? ` ${truncate(arg.replace(/\s+/g, ' '), 80)}` : ''})`;
  },
  async prepare(input, ctx): Promise<PreparedCall> {
    const url = strParam(input, 'url', 'href', 'path', 'file');
    const action = (strParam(input, 'action', 'command') ?? (url ? 'open' : 'screenshot')).toLowerCase() as Action;
    if (!ACTIONS.includes(action)) return errorResult(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}`);
    const selector = strParam(input, 'selector', 'element', 'target');
    const owner = ctx.session;
    const size = (key: string, max: number) => {
      const v = numParam(input, key);
      return v ? Math.round(Math.min(max, Math.max(320, v))) : undefined;
    };
    const width = size('width', 3840);
    const height = size('height', 2400);
    let target = '';
    if (action === 'open') {
      if (!url) return errorResult('open needs a url (for example http://localhost:5173 or index.html)');
      target = resolveTarget(url, ctx.session.cwd);
    }
    if ((action === 'click' || action === 'type') && !selector) return errorResult(`${action} needs a selector (CSS or text=Label)`);
    if (action === 'type' && strParam(input, 'text', 'value') === undefined) return errorResult('type needs text');
    if (action === 'press' && !strParam(input, 'key')) return errorResult('press needs a key');
    if (action === 'eval' && !strParam(input, 'script', 'code', 'expression')) return errorResult('eval needs a script');
    if (action !== 'open' && action !== 'close' && !openPage(owner)) return errorResult('No page is open. Use action=open with a url first.');

    const run = async (): Promise<ToolResult> => {
      try {
        if (action === 'close') return { content: (await closePage(owner)) ? 'Closed the page.' : 'No page was open.', display: { kind: 'summary', text: 'Closed' } };
        const page = await pageFor(owner);
        const report = async (brief: boolean) => formatReport(page, await page.report(), page.takeLogs(), brief);
        switch (action) {
          case 'open': {
            ctx.services.progress(`Opening ${target}`);
            if (width || height) await page.setViewport(width ?? page.viewport.width, height ?? page.viewport.height);
            await page.navigate(target);
            return capture(page, await report(false));
          }
          case 'screenshot': {
            const text = await report(!!selector);
            return capture(page, `${selector ? `Screenshot of ${selector}.\n` : ''}${text}`, { fullPage: boolParam(input, 'full_page', 'fullPage') ?? false, selector });
          }
          case 'click': {
            const what = await page.click(selector!);
            return capture(page, `Clicked ${what}. Page: ${await currentUrl(page)}\n${await report(true)}`);
          }
          case 'type': {
            const what = await page.type(selector!, strParam(input, 'text', 'value') ?? '', boolParam(input, 'submit') ?? false);
            return capture(page, `Typed into ${what}.\n${await report(true)}`);
          }
          case 'press': {
            await page.press(strParam(input, 'key')!);
            return capture(page, `Pressed ${strParam(input, 'key')}.\n${await report(true)}`);
          }
          case 'eval': {
            const r = await page.evaluate(strParam(input, 'script', 'code', 'expression')!);
            const logs = page.takeLogs();
            let text = r.error ? `Error: ${r.error}` : `Result: ${truncate(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2) ?? 'undefined', 8000)}`;
            if (logs.logs.length) text += `\nConsole:\n${logs.logs.slice(-20).map((l) => `  ${l.level}: ${l.text}`).join('\n')}`;
            return { content: text, isError: !!r.error, display: { kind: 'text', text } };
          }
          case 'console': {
            const logs = page.takeLogs();
            const lines = logs.logs.map((l) => `${l.level}: ${l.text}`);
            if (logs.failures.length) lines.push(...logs.failures.map((f) => `failed request: ${f}`));
            const text = lines.length ? lines.slice(-60).join('\n') : 'No console messages or failed requests since the last check.';
            return { content: text, display: { kind: 'text', text } };
          }
          case 'resize': {
            await page.setViewport(width ?? page.viewport.width, height ?? page.viewport.height);
            await new Promise((r) => setTimeout(r, 250));
            return capture(page, `Window is now ${page.viewport.width}x${page.viewport.height}.\n${await report(true)}`);
          }
          case 'responsive': {
            const original = { ...page.viewport };
            const parts: string[] = [];
            let mobileShot: Buffer | null = null;
            for (const w of RESPONSIVE_WIDTHS) {
              await page.setViewport(w, w < 600 ? 740 : w < 1000 ? 1000 : 800);
              await new Promise((r) => setTimeout(r, 300));
              parts.push(`At ${w}px (${w < 600 ? 'phone' : w < 1000 ? 'tablet' : 'desktop'}):\n${(await report(true)).replace(/^/gm, '  ')}`);
              if (w === RESPONSIVE_WIDTHS[0]) mobileShot = await page.screenshot();
            }
            await page.setViewport(original.width, original.height);
            const text = parts.join('\n');
            const name = saveScreenshot(mobileShot!);
            return {
              content: `${text}\n(The screenshot shows the phone width.)`,
              images: [{ mediaType: 'image/jpeg', data: mobileShot!.toString('base64') }],
              display: { kind: 'image', name, text, summary: problemCount(text) },
            };
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: `Browser error: ${msg}`, isError: true, display: { kind: 'summary', text: msg.split('\n')[0]! } };
      }
      return { content: 'Nothing to do.', isError: true };
    };

    if (action === 'open' && !isLocalUrl(target)) {
      let host = target;
      try {
        host = new URL(target).hostname;
      } catch {
        // keep the raw target
      }
      return { permission: { tool: 'Browser', category: 'network', title: 'Open web page', subject: target, domain: host, ruleSuggestion: `Browser(domain:${host})`, ruleLabel: host }, execute: run };
    }
    return { execute: run };
  },
};

async function currentUrl(page: BrowserPage): Promise<string> {
  const r = await page.evaluate('location.href').catch(() => ({ value: page.url }));
  return String(r.value ?? page.url);
}

const UI_FILE = /\.(html?|css|scss|sass|less|jsx?|tsx?|mjs|vue|svelte|astro|mdx)$/i;

/** After the agent edits UI files: reload the open page and describe what is wrong now (or null). */
export async function previewAfterEdit(owner: object, editedPaths: string[]): Promise<string | null> {
  if (!editedPaths.some((p) => UI_FILE.test(p))) return null;
  const page = openPage(owner);
  if (!page) return null;
  try {
    // Dev servers rebuild on save; give them a moment before reloading.
    await new Promise((r) => setTimeout(r, page.url.startsWith('file:') ? 50 : 700));
    await page.reload();
    const text = formatReport(page, await page.report(), page.takeLogs(), true);
    return `Browser preview of ${page.url} after this change:\n${text}`;
  } catch (e) {
    return `Browser preview could not reload: ${e instanceof Error ? e.message : String(e)}`;
  }
}

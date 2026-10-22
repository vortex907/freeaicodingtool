// One headless browser per FreeCode process (started on first use, closed when idle) and one page per
// agent session. Pages collect console messages and failed requests so reports can mention them.
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { freecodeHome } from '../config/paths.js';
import { CdpConnection, type CdpEvent } from './cdp.js';
import { findBrowser, launchBrowser, type LaunchedBrowser } from './chrome.js';
import { PAGE_REPORT_SCRIPT } from './pageScript.js';

const IDLE_CLOSE_MS = 10 * 60_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface LogEntry {
  level: 'error' | 'warning' | 'log' | 'info';
  text: string;
}

export interface PageReport {
  title: string;
  url: string;
  viewport: [number, number];
  page: [number, number];
  overflow: { el: string; right: number }[];
  clipped: string[];
  spill: string[];
  overlaps: string[];
  lowContrast: { el: string; ratio: number; need: number; fg: string; bg: string }[];
  smallTargets: string[];
  smallTargetCount: number;
  smallFields: string[];
  viewportMeta: boolean;
  brokenImages: string[];
  imagesWithoutAlt: number;
  unlabeled: string[];
  unlabeledCount: number;
  emptyButtons: string[];
  emptyButtonCount: number;
  headings: { h1: number; skipped: string[] };
  canvases: string[];
  design: { fonts: string[]; sizes: number[]; colors: number; topColors: string[]; radii: string[]; shadows: number; textEls: number };
  outline: string[];
  text: string;
  empty: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserPage {
  logs: LogEntry[] = [];
  failures: string[] = [];
  status?: number;
  url = 'about:blank';
  viewport = { ...DEFAULT_VIEWPORT };
  loadMs = 0;
  /** Requests in flight (id to URL), for waiting until the network is quiet. */
  private inflight = new Map<string, string>();
  private lastNetwork = Date.now();
  private off: () => void;
  closed = false;

  constructor(
    private conn: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
  ) {
    this.off = conn.on((e) => this.onEvent(e));
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async init(): Promise<void> {
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('Network.enable')]);
    await this.setViewport(this.viewport.width, this.viewport.height);
  }

  private onEvent(e: CdpEvent): void {
    if (e.method === 'Connection.closed') {
      this.closed = true;
      return;
    }
    if (e.sessionId !== this.sessionId) return;
    const p = e.params as Record<string, any>;
    switch (e.method) {
      case 'Runtime.consoleAPICalled': {
        const text = (p.args ?? []).map((a: any) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' ');
        const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : 'log';
        const frame = p.stackTrace?.callFrames?.[0];
        this.log(level, frame?.url ? `${text} (${shortUrl(frame.url)}:${frame.lineNumber + 1})` : text);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const desc = String(d.exception?.description ?? d.text ?? 'Uncaught error').split('\n')[0];
        this.log('error', `Uncaught ${desc.replace(/^Uncaught\s+/, '')}${d.url ? ` (${shortUrl(d.url)}:${(d.lineNumber ?? 0) + 1})` : ''}`);
        break;
      }
      case 'Log.entryAdded': {
        const en = p.entry ?? {};
        if (en.level === 'error' || en.level === 'warning') this.log(en.level, `${en.text}${en.url && !String(en.text).includes(en.url) ? ` (${shortUrl(en.url)})` : ''}`);
        break;
      }
      case 'Network.requestWillBeSent':
        this.inflight.set(p.requestId, p.request?.url ?? '');
        this.lastNetwork = Date.now();
        break;
      case 'Network.responseReceived': {
        const r = p.response ?? {};
        if (p.type === 'Document' && r.url && !r.url.startsWith('data:')) this.status = r.status;
        if (r.status >= 400) this.failures.push(`${r.status} ${shortUrl(r.url)}`);
        break;
      }
      case 'Network.loadingFinished':
        this.inflight.delete(p.requestId);
        this.lastNetwork = Date.now();
        break;
      case 'Network.loadingFailed': {
        const url = this.inflight.get(p.requestId) ?? '';
        this.inflight.delete(p.requestId);
        this.lastNetwork = Date.now();
        if (!p.canceled && !String(p.errorText).includes('ERR_ABORTED')) this.failures.push(`${p.errorText} ${shortUrl(url)}`);
        break;
      }
      case 'Page.javascriptDialogOpening':
        this.log('info', `${p.type} dialog: ${p.message}`);
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
        break;
    }
  }

  private log(level: LogEntry['level'], text: string): void {
    this.logs.push({ level, text: text.length > 400 ? `${text.slice(0, 400)}...` : text });
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  /** Console messages and failed requests since the last call. */
  takeLogs(): { logs: LogEntry[]; failures: string[] } {
    const r = { logs: this.logs, failures: [...new Set(this.failures)] };
    this.logs = [];
    this.failures = [];
    return r;
  }

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 600 });
  }

  /** Waits until no request has been in flight for `quietMs` (or `maxMs` passed). */
  async networkIdle(quietMs = 500, maxMs = 6000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetwork >= quietMs) return;
      await sleep(100);
    }
  }

  async navigate(url: string, timeoutMs = 25_000): Promise<void> {
    this.takeLogs();
    this.status = undefined;
    this.inflight.clear();
    const start = Date.now();
    const loaded = this.conn.waitFor('Page.loadEventFired', this.sessionId, timeoutMs).catch(() => null);
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url }, timeoutMs);
    if (r.errorText) throw new Error(`Could not open ${url}: ${r.errorText}${/CONNECTION_REFUSED/.test(r.errorText) ? ' (is the dev server running?)' : ''}`);
    await loaded;
    await this.networkIdle(500, 6000);
    await sleep(120);
    this.url = url;
    this.loadMs = Date.now() - start;
  }

  async reload(): Promise<void> {
    this.takeLogs();
    this.inflight.clear();
    const start = Date.now();
    const loaded = this.conn.waitFor('Page.loadEventFired', this.sessionId, 20_000).catch(() => null);
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
    await this.networkIdle(400, 5000);
    await sleep(100);
    this.loadMs = Date.now() - start;
  }

  async evaluate(expression: string, timeoutMs = 15_000): Promise<{ value?: unknown; error?: string }> {
    const r = await this.send<{ result?: { value?: unknown; description?: string; type?: string; unserializableValue?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true },
      timeoutMs,
    );
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Error').split('\n').slice(0, 4).join('\n') };
    const res = r.result ?? {};
    if (res.value !== undefined) return { value: res.value };
    if (res.unserializableValue) return { value: res.unserializableValue };
    return { value: res.type === 'undefined' ? undefined : (res.description ?? null) };
  }

  async report(): Promise<PageReport> {
    const r = await this.evaluate(PAGE_REPORT_SCRIPT, 20_000);
    if (r.error) throw new Error(`Could not inspect the page: ${r.error}`);
    return r.value as PageReport;
  }

  /** Finds an element by CSS selector or "text=..." and returns its center in viewport coordinates. */
  async locate(selector: string): Promise<{ x: number; y: number; desc: string }> {
    const fn = `(function (sel) {
      var el = null;
      var text = /^text=/i.test(sel) ? sel.slice(5).trim().toLowerCase() : null;
      if (!text) { try { el = document.querySelector(sel); } catch (e) { text = sel.trim().toLowerCase(); } }
      if (!el && text) {
        var best = null;
        var nodes = document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label, summary, li, span, div, p, h1, h2, h3, h4, td');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var t = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim().toLowerCase();
          if (!t || t.indexOf(text) < 0) continue;
          var r0 = n.getBoundingClientRect();
          if (r0.width < 1 || r0.height < 1) continue;
          if (!best || t.length < best.t.length || (t.length === best.t.length && /^(BUTTON|A|INPUT|SUMMARY)$/.test(n.tagName))) best = { n: n, t: t };
        }
        el = best && best.n;
      }
      if (!el) return { error: 'No element matches ' + sel };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { error: 'The element ' + sel + ' is not visible' };
      var d = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ((el.innerText || '').trim() ? ' "' + el.innerText.trim().slice(0, 40) + '"' : '');
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, desc: d };
    })(${JSON.stringify(selector)})`;
    const r = await this.evaluate(fn);
    if (r.error) throw new Error(r.error);
    const v = r.value as { x?: number; y?: number; desc?: string; error?: string };
    if (v.error) throw new Error(v.error);
    return { x: v.x!, y: v.y!, desc: v.desc ?? selector };
  }

  async click(selector: string): Promise<string> {
    const at = await this.locate(selector);
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    await this.settle();
    return at.desc;
  }

  async type(selector: string, text: string, submit: boolean): Promise<string> {
    const at = await this.locate(selector);
    const focus = await this.evaluate(`(function(){var el=document.elementFromPoint(${at.x},${at.y});while(el&&!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)&&!el.isContentEditable)el=el.parentElement;if(!el)return false;el.focus();if(el.select)el.select();return true;})()`);
    if (!focus.value) await this.click(selector);
    await this.send('Input.insertText', { text });
    if (submit) await this.press('Enter');
    else await this.settle(300);
    return at.desc;
  }

  async press(key: string): Promise<void> {
    const k = KEYS[key.toLowerCase()] ?? (key.length === 1 ? { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!k) throw new Error(`Unknown key "${key}". Use Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown or a single character.`);
    const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await this.settle();
  }

  /** After an interaction: wait for a navigation or requests it caused to finish. */
  async settle(minMs = 250): Promise<void> {
    const nav = this.conn.waitFor('Page.frameStartedLoading', this.sessionId, minMs).then(() => true, () => false);
    if (await nav) await this.conn.waitFor('Page.loadEventFired', this.sessionId, 15_000).catch(() => null);
    await this.networkIdle(300, 4000);
  }

  async screenshot(opts: { fullPage?: boolean; selector?: string } = {}): Promise<Buffer> {
    let clip: Record<string, number> | undefined;
    if (opts.selector) {
      const r = await this.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(opts.selector)});if(!el)return null;el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};})()`);
      const b = r.value as { x: number; y: number; width: number; height: number } | null;
      if (!b || b.width < 1 || b.height < 1) throw new Error(`No visible element matches ${opts.selector}`);
      clip = { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(b.width + 16, 4000), height: Math.min(b.height + 16, 6000), scale: 1 };
    } else if (opts.fullPage) {
      const m = await this.send<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>('Page.getLayoutMetrics');
      const size = m.cssContentSize ?? m.contentSize ?? { width: this.viewport.width, height: this.viewport.height };
      clip = { x: 0, y: 0, width: Math.min(Math.max(size.width, this.viewport.width), 4000), height: Math.min(size.height, 8000), scale: 1 };
    }
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 82, ...(clip ? { clip, captureBeyondViewport: true } : {}) }, 45_000);
    return Buffer.from(r.data, 'base64');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.off();
    await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function shortUrl(u: string): string {
  if (!u) return '';
  try {
    const url = new URL(u);
    if (url.protocol === 'file:') return path.basename(decodeURIComponent(url.pathname));
    return url.origin === 'null' ? u : `${url.host}${url.pathname}${url.search}`.slice(0, 120);
  } catch {
    return u.slice(0, 120);
  }
}

// ------------------------------------------------------------------ browser process

class BrowserHost {
  private pages = new WeakMap<object, BrowserPage>();
  private idle: NodeJS.Timeout | null = null;

  constructor(
    readonly conn: CdpConnection,
    private launched: LaunchedBrowser,
  ) {}

  static async start(): Promise<BrowserHost> {
    const exe = findBrowser();
    if (!exe) throw new Error('No Chromium-based browser found (Edge, Chrome, Chromium or Brave). Install one, or set FREECODE_BROWSER to its path.');
    const launched = await launchBrowser(exe);
    try {
      const conn = await CdpConnection.connect(launched.wsUrl);
      return new BrowserHost(conn, launched);
    } catch (e) {
      launched.kill();
      throw e;
    }
  }

  get alive(): boolean {
    return !this.conn.closed && this.launched.child.exitCode === null;
  }

  touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => closeBrowser(), IDLE_CLOSE_MS);
    this.idle.unref();
  }

  existing(owner: object): BrowserPage | undefined {
    const p = this.pages.get(owner);
    return p && !p.closed ? p : undefined;
  }

  async page(owner: object): Promise<BrowserPage> {
    this.touch();
    const have = this.existing(owner);
    if (have) return have;
    const { targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new BrowserPage(this.conn, targetId, sessionId);
    await page.init();
    this.pages.set(owner, page);
    return page;
  }

  forget(owner: object): void {
    this.pages.delete(owner);
  }

  shutdown(): void {
    if (this.idle) clearTimeout(this.idle);
    this.conn.close();
    this.launched.kill();
  }
}

let host: Promise<BrowserHost> | null = null;
let current: BrowserHost | null = null;

async function getHost(): Promise<BrowserHost> {
  if (current && !current.alive) {
    current.shutdown();
    current = null;
    host = null;
  }
  if (!host) {
    host = BrowserHost.start().then(
      (h) => (current = h),
      (e) => {
        host = null;
        throw e;
      },
    );
  }
  return host;
}

/** The page that belongs to `owner` (an agent session), opening the browser if needed. */
export async function pageFor(owner: object): Promise<BrowserPage> {
  return (await getHost()).page(owner);
}

/** The open page of `owner`, without starting anything. */
export function openPage(owner: object): BrowserPage | undefined {
  if (!current?.alive) return undefined;
  const p = current.existing(owner);
  if (p) current.touch();
  return p;
}

export async function closePage(owner: object): Promise<boolean> {
  const p = current?.existing(owner);
  if (!p) return false;
  current!.forget(owner);
  await p.close();
  return true;
}

export function closeBrowser(): void {
  current?.shutdown();
  current = null;
  host = null;
}

process.once('exit', closeBrowser);

/** Turns a URL, a file path or a bare host:port into something the browser can open. */
export function resolveTarget(target: string, cwd: string): string {
  const t = target.trim();
  if (/^(https?|file|about|data):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^:\d+/.test(t)) return `http://localhost${t}`;
  return pathToFileURL(path.resolve(cwd, t)).href;
}

export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:' || u.protocol === 'about:' || u.protocol === 'data:') return true;
    return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ screenshots on disk

function shotsDir(): string {
  return path.join(freecodeHome(), 'screenshots');
}

/** Saves a screenshot for the UI and returns its file name. Old screenshots are pruned. */
export function saveScreenshot(buf: Buffer): string {
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.jpg`;
  writeFileSync(path.join(dir, name), buf);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jpg'));
    if (files.length > 300) {
      const old = files.map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const o of old.slice(0, files.length - 300)) unlinkSync(path.join(dir, o.f));
    }
  } catch {
    // pruning is best effort
  }
  return name;
}

export function screenshotPath(name: string): string | null {
  return /^[\w-]+\.jpg$/.test(name) ? path.join(shotsDir(), name) : null;
}

// ------------------------------------------------------------------ report text

/** The page report as compact text for the model. `brief` lists only problems (used after edits). */
export function formatReport(page: BrowserPage, r: PageReport, logs: { logs: LogEntry[]; failures: string[] }, brief = false): string {
  const lines: string[] = [];
  if (!brief) {
    lines.push(`Page: ${r.title ? `"${r.title}" ` : ''}${r.url}`);
    lines.push(`Viewport ${r.viewport[0]}x${r.viewport[1]}, page ${r.page[0]}x${r.page[1]}${page.status ? `, HTTP ${page.status}` : ''}${page.loadMs ? `, loaded in ${page.loadMs} ms` : ''}.`);
  }
  const errors = logs.logs.filter((l) => l.level === 'error');
  const warnings = logs.logs.filter((l) => l.level === 'warning');
  if (errors.length || warnings.length) {
    lines.push(`Console: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
    for (const l of [...errors.slice(0, 6), ...warnings.slice(0, 3)]) lines.push(`  ${l.level}: ${l.text}`);
  } else if (!brief) lines.push('Console: no errors.');
  if (logs.failures.length) {
    lines.push(`Failed requests: ${logs.failures.length}`);
    for (const f of logs.failures.slice(0, 6)) lines.push(`  ${f}`);
  }
  const problems: string[] = [];
  if (r.empty) problems.push('The page looks empty: no visible text, images or canvas.');
  if (r.page[0] > r.viewport[0] + 1) problems.push(`The page is wider than the window (${r.page[0]}px > ${r.viewport[0]}px), so it scrolls sideways.${r.overflow.length ? ` Sticking out: ${r.overflow.slice(0, 4).map((o) => `${o.el} (right edge ${o.right}px)`).join(', ')}` : ''}`);
  if (r.clipped.length) problems.push(`Text cut off by its container: ${r.clipped.slice(0, 4).join(', ')}`);
  if (r.spill.length) problems.push(`Content spills out of its box: ${r.spill.slice(0, 4).join(', ')}`);
  if (r.overlaps.length) problems.push(`Overlapping elements: ${r.overlaps.slice(0, 4).join('; ')}`);
  if (r.lowContrast.length) problems.push(`Low contrast text: ${r.lowContrast.slice(0, 4).map((c) => `${c.el} ${c.ratio}:1 (${c.fg} on ${c.bg}, needs ${c.need}:1)`).join('; ')}`);
  if (r.smallTargetCount) problems.push(`${r.smallTargetCount} click target${r.smallTargetCount === 1 ? ' is' : 's are'} smaller than 24x24px: ${r.smallTargets.join(', ')}`);
  if (r.smallFields.length) problems.push(`Form fields look like unstyled browser defaults: ${r.smallFields.join(', ')} (aim for 36-44px with padding)`);
  if (page.viewport.width <= 600 && !r.viewportMeta) problems.push('No <meta name="viewport" content="width=device-width, initial-scale=1"> tag, so phones show a zoomed-out desktop layout.');
  if (r.brokenImages.length) problems.push(`Broken images: ${r.brokenImages.slice(0, 4).join(', ')}`);
  if (r.unlabeledCount) problems.push(`${r.unlabeledCount} form field${r.unlabeledCount === 1 ? ' has' : 's have'} no label: ${r.unlabeled.join(', ')}`);
  if (r.emptyButtonCount) problems.push(`${r.emptyButtonCount} button${r.emptyButtonCount === 1 ? ' has' : 's have'} no text or aria-label: ${r.emptyButtons.join(', ')}`);
  if (!brief) {
    if (r.imagesWithoutAlt) problems.push(`${r.imagesWithoutAlt} image${r.imagesWithoutAlt === 1 ? '' : 's'} without alt text`);
    if (r.headings.h1 > 1) problems.push(`${r.headings.h1} h1 headings (use one per page)`);
    if (r.headings.skipped.length) problems.push(`Heading levels skipped: ${r.headings.skipped.join(', ')}`);
  }
  if (problems.length) {
    lines.push('Layout and accessibility problems:');
    for (const p of problems) lines.push(`  - ${p}`);
  } else lines.push(brief ? 'Preview: no layout problems found.' : 'Layout and accessibility problems: none found.');
  if (!brief) {
    const d = r.design;
    if (d.textEls) {
      const fonts = d.fonts.filter(Boolean).join(', ');
      const many = d.sizes.length > 7 ? ' (a lot: a tighter type scale looks more deliberate)' : '';
      lines.push(`Design: fonts ${fonts || 'default'}; ${d.sizes.length} font sizes [${d.sizes.join(', ')}]${many}; ${d.colors} text colors${d.colors > 8 ? ' (consider fewer)' : ''}; corner radii ${d.radii.join(', ') || 'none'}; ${d.shadows} shadows.`);
    }
    if (r.canvases.length) lines.push(`Canvas: ${r.canvases.join(', ')} (the screenshot shows what is drawn).`);
    if (r.outline.length) {
      lines.push('On the page (reading order):');
      for (const o of r.outline.slice(0, 40)) lines.push(`  ${o}`);
    }
    if (r.text) lines.push(`Visible text: ${r.text}`);
  }
  return lines.join('\n');
}

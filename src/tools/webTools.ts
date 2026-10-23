// WebFetch and WebSearch tools. Search works without any API key (DuckDuckGo/Bing HTML), and can use
// Brave, Tavily or SearXNG when configured.
import type { PreparedCall, Tool, ToolResult } from './types.js';
import { errorResult, fail, numParam, ok, strParam } from './types.js';
import { decodeEntities, extractTitle, htmlToMarkdown } from './html.js';
import { truncate } from '../util/strings.js';
import { VERSION } from '../version.js';

const FETCH_TIMEOUT = 30_000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_CHARS = 40_000;
const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 FreeCode/${VERSION}`;

const cache = new Map<string, { at: number; text: string; title?: string; finalUrl: string }>();

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export async function fetchUrlAsText(url: string, signal: AbortSignal): Promise<{ text: string; title?: string; finalUrl: string; contentType: string }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 15 * 60_000) return { ...hit, contentType: 'cached' };
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : signal,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (/image\/|video\/|audio\/|application\/(octet-stream|zip|x-tar|gzip)/.test(ct)) throw new Error(`Unsupported content type: ${ct}`);
  if (ct.includes('application/pdf')) throw new Error('PDF documents are not supported by WebFetch.');
  const raw = await readLimited(res, MAX_BYTES);
  let text: string;
  let title: string | undefined;
  if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw)) {
    title = extractTitle(raw);
    text = htmlToMarkdown(raw, res.url || url);
  } else if (ct.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else text = raw;
  const entry = { at: Date.now(), text, title, finalUrl: res.url || url };
  cache.set(url, entry);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return { ...entry, contentType: ct };
}

function normalizeUrl(raw: string): string | null {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) u = `https://${u}`;
    else return null;
  }
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

export const WebFetchTool: Tool = {
  name: 'WebFetch',
  category: 'network',
  parallelSafe: true,
  planSafe: true,
  description:
    'Fetch a web page (or JSON/text URL) and return its content converted to markdown. ' +
    'Optionally pass `prompt` describing what you need; long pages are then condensed to the relevant parts. Use it for documentation, issues, API references.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch' },
      prompt: { type: 'string', description: 'What information to extract from the page (optional)' },
    },
    required: ['url'],
  },
  label: (input) => `Fetch(${truncate(strParam(input, 'url', 'link') ?? '?', 90)})`,
  async prepare(input, ctx): Promise<PreparedCall> {
    const raw = strParam(input, 'url', 'link', 'href');
    if (!raw) return errorResult('Missing required parameter: url');
    const url = normalizeUrl(raw);
    if (!url) return errorResult(`Invalid URL: ${raw}`);
    const host = new URL(url).hostname;
    const prompt = strParam(input, 'prompt', 'query', 'question');
    return {
      permission: {
        tool: 'WebFetch',
        category: 'network',
        title: 'Fetch web page',
        subject: url,
        domain: host,
        ruleSuggestion: `WebFetch(domain:${host})`,
        ruleLabel: `fetches from ${host}`,
      },
      execute: async (): Promise<ToolResult> => {
        let page;
        try {
          page = await fetchUrlAsText(url, ctx.signal);
        } catch (e) {
          return fail(`Failed to fetch ${url}: ${(e as Error).message}`);
        }
        let body = page.text;
        const header = `${page.title ? `# ${page.title}\n` : ''}URL: ${page.finalUrl}\n\n`;
        if (prompt && body.length > 12_000 && ctx.services.summarize) {
          try {
            const condensed = await ctx.services.summarize(body.slice(0, 150_000), `From this web page, extract everything relevant to: ${prompt}\nKeep code samples, commands, API names and numbers exact. Use markdown.`, ctx.signal);
            if (condensed.trim()) {
              return ok(`${header}(Condensed for: ${prompt})\n\n${condensed}`, { kind: 'summary', text: `Fetched ${page.finalUrl} (${Math.round(body.length / 1000)}k chars, condensed)` });
            }
          } catch {
            // fall back to raw text
          }
        }
        if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + `\n\n[... page truncated, ${body.length - MAX_CHARS} more characters ...]`;
        return ok(header + (body || '(empty page)'), { kind: 'summary', text: `Fetched ${truncate(page.finalUrl, 70)} (${Math.round(page.text.length / 1000)}k chars)` });
      },
    };
  },
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

async function searchDuckDuckGo(query: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  if (/anomaly|captcha|unusual traffic/i.test(html) && !/result__a/.test(html)) throw new Error('DuckDuckGo asked for a captcha');
  const results: SearchResult[] = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < n) {
    let href = decodeEntities(m[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js|ad_provider|ad_domain/.test(href)) continue; // ads
    results.push({ title: stripTags(m[2]!), url: href, snippet: stripTags(m[3] ?? m[4] ?? '') });
  }
  return results;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : undefined;
}

/** DuckDuckGo's no-JavaScript "lite" page: a different endpoint that often works when html/ is limited. */
async function searchDuckDuckGoLite(query: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal });
  if (!res.ok) throw new Error(`DuckDuckGo Lite HTTP ${res.status}`);
  return parseDuckDuckGoLite(await res.text(), n);
}

export function parseDuckDuckGoLite(html: string, n: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a\b[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && results.length < n) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    let href = attr(tag, 'href') ?? '';
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const after = html.slice(linkRe.lastIndex, linkRe.lastIndex + 3000);
    const snippet = /class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i.exec(after)?.[1] ?? '';
    results.push({ title: stripTags(m[1]!), url: href, snippet: stripTags(snippet) });
  }
  return results;
}

/** Mojeek: an independent search engine with plain HTML results. */
async function searchMojeek(query: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' }, signal });
  if (!res.ok) throw new Error(`Mojeek HTTP ${res.status}`);
  return parseMojeek(await res.text(), n);
}

export function parseMojeek(html: string, n: number): SearchResult[] {
  const results: SearchResult[] = [];
  const titleRe = /<a\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) && results.length < n) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const href = attr(tag, 'href') ?? '';
    if (!/^https?:/.test(href)) continue;
    const after = html.slice(titleRe.lastIndex, titleRe.lastIndex + 3000);
    const snippet = /<p\b[^>]*class=["']s["'][^>]*>([\s\S]*?)<\/p>/i.exec(after)?.[1] ?? '';
    results.push({ title: stripTags(m[1]!), url: href, snippet: stripTags(snippet) });
  }
  return results;
}

async function searchBing(query: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=${n}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' },
    signal,
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < n) {
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]!)?.[1] ?? '';
    let url = decodeEntities(m[1]!);
    // Bing sometimes wraps links: /ck/a?...&u=a1<base64>
    const u = /[?&]u=a1([^&]+)/.exec(url);
    if (u) {
      try {
        url = Buffer.from(u[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch {
        // keep wrapped url
      }
    }
    results.push({ title: stripTags(m[2]!), url, snippet: stripTags(snippet) });
  }
  return results;
}

async function searchBrave(query: string, n: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const json = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (json.web?.results ?? []).slice(0, n).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description ?? '') }));
}

async function searchTavily(query: string, n: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: n }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const json = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.content ?? '', 300) }));
}

async function searchSearxng(query: string, n: number, base: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const json = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (json.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.content ?? '', 300) }));
}

export const WebSearchTool: Tool = {
  name: 'WebSearch',
  category: 'network',
  parallelSafe: true,
  planSafe: true,
  description:
    'Search the web and return results (title, URL, snippet). Use it whenever the answer may have changed since your training: latest versions and releases, game/app updates, news, prices, ' +
    'current docs and APIs, error messages. Include the year in queries about recent things. Then read the best results with WebFetch before answering.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      max_results: { type: 'number', description: 'Number of results (default 8, max 20)' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude results from these domains' },
    },
    required: ['query'],
  },
  label: (input) => `Search(${truncate(strParam(input, 'query', 'q', 'search') ?? '?', 80)})`,
  async prepare(input, ctx) {
    const query = strParam(input, 'query', 'q', 'search', 'search_query');
    if (!query) return errorResult('Missing required parameter: query');
    const n = Math.max(1, Math.min(20, numParam(input, 'max_results', 'num_results', 'count') ?? 8));
    const allowed = Array.isArray(input.allowed_domains) ? (input.allowed_domains as string[]) : [];
    const blocked = Array.isArray(input.blocked_domains) ? (input.blocked_domains as string[]) : [];
    return {
      permission: { tool: 'WebSearch', category: 'network', title: 'Web search', subject: query, readOnly: true },
      execute: async () => {
        const ws = ctx.settings.webSearch ?? { provider: 'auto' };
        const brave = ws.braveApiKey || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
        const tavily = ws.tavilyApiKey || process.env.TAVILY_API_KEY;
        const searx = ws.searxngUrl || process.env.SEARXNG_URL;
        const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) : ctx.signal;
        const attempts: [string, () => Promise<SearchResult[]>][] = [];
        const p = ws.provider ?? 'auto';
        if ((p === 'brave' || p === 'auto') && brave) attempts.push(['Brave', () => searchBrave(query, n + 5, brave, signal)]);
        if ((p === 'tavily' || p === 'auto') && tavily) attempts.push(['Tavily', () => searchTavily(query, n + 5, tavily, signal)]);
        if ((p === 'searxng' || p === 'auto') && searx) attempts.push(['SearXNG', () => searchSearxng(query, n + 5, searx, signal)]);
        // No key needed: several engines in turn, since any of them may rate limit or show a captcha.
        attempts.push(['DuckDuckGo', () => searchDuckDuckGo(query, n + 5, signal)]);
        attempts.push(['DuckDuckGo Lite', () => searchDuckDuckGoLite(query, n + 5, signal)]);
        attempts.push(['Bing', () => searchBing(query, n + 5, signal)]);
        attempts.push(['Mojeek', () => searchMojeek(query, n + 5, signal)]);
        const errors: string[] = [];
        for (const [name, run] of attempts) {
          try {
            let results = await run();
            if (allowed.length) results = results.filter((r) => allowed.some((d) => hostOf(r.url).endsWith(d)));
            if (blocked.length) results = results.filter((r) => !blocked.some((d) => hostOf(r.url).endsWith(d)));
            results = results.slice(0, n);
            if (!results.length) {
              errors.push(`${name}: no results`);
              continue;
            }
            const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
            return ok(`Search results for "${query}" (via ${name}):\n\n${text}`, { kind: 'summary', text: `${results.length} results (${name})` });
          } catch (e) {
            if (ctx.signal.aborted) throw e;
            errors.push(`${name}: ${(e as Error).message}`);
          }
        }
        return fail(`Web search failed: ${errors.join('; ')}`);
      },
    };
  },
};

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

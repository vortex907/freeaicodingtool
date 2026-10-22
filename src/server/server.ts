// Local HTTP server for the graphical app: JSON API + Server-Sent Events + static frontend.
// Bound to 127.0.0.1 and protected by a random token (the agent can run commands, so no other
// website or user on the machine may talk to it).
import * as http from 'node:http';
import { promises as fsp, existsSync } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Controller } from './controller.js';
import type { PermissionMode, Settings } from '../config/config.js';
import { openInBrowser } from '../ui/setup.js';
import { debug } from '../util/log.js';
import { VERSION } from '../version.js';
import { detectRunCommand, openFileAt, openIn, openTargets, runInTerminal } from './launchers.js';
import { readGlobalConfig, updateGlobalConfig, updateProjectSettings } from '../config/config.js';
import { clearSkillsCache, loadSkills } from '../skills/skills.js';
import { DEFAULT_MARKETPLACES, fetchCatalog, installSkill, installedFrom, parseSource, removeSkill } from '../skills/marketplace.js';
import { Updater } from '../update/updater.js';
import { screenshotPath } from '../browser/browser.js';
import { transcribe, voiceProvider } from './voice.js';
import { getIndex } from '../codeindex/index.js';

export interface ServerOptions {
  cwd: string;
  port?: number;
  permissionMode?: PermissionMode;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  trusted?: boolean;
  overrides?: Partial<Settings>;
  initialPrompt?: string;
  /** Check GitHub for new versions while the app runs. */
  updates?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function webRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'web');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('FreeCode web files not found (expected a "web" folder next to the package).');
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Pasted screenshots and voice recordings arrive as base64 in JSON.
    if (size > 40 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  controller: Controller;
  /** Number of app windows/tabs currently connected. */
  clientCount: () => number;
  close: () => Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(24).toString('hex');
  const clients = new Set<http.ServerResponse>();
  const broadcast = (msg: Record<string, unknown>) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) {
      try {
        c.write(data);
      } catch {
        clients.delete(c);
      }
    }
  };
  const controller = new Controller(broadcast, {
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    model: opts.model,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    trusted: opts.trusted,
    overrides: opts.overrides,
  });
  // Open the initial project (untrusted project settings are ignored until the user trusts the folder).
  const tc = await controller.trustCheck(opts.cwd);
  await controller.open(opts.cwd, tc.needsTrust ? (opts.trusted ?? false) : opts.trusted);
  let pendingTrust: string | null = tc.needsTrust && !opts.trusted ? tc.root : null;
  controller.initialPrompt = opts.initialPrompt;
  const updater = new Updater((state) => broadcast({ type: 'update', state }));
  if (opts.updates) updater.start(() => readGlobalConfig().autoUpdate !== false);
  const root = webRoot();
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end('Forbidden host');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      const p = url.pathname;
      const shared = /^\/shared\/([a-z]+\.js)$/.exec(p);
      if (shared) {
        // Browser-safe modules compiled from src/shared (the same code the agent uses).
        try {
          const data = await fsp.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', shared[1]!));
          res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
          res.end(data);
        } catch {
          res.writeHead(404).end('Not found');
        }
        return;
      }
      if (!p.startsWith('/api/')) {
        // Static files
        let rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
        rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
        const file = path.join(root, rel);
        if (!file.startsWith(root)) {
          res.writeHead(403).end();
          return;
        }
        try {
          const data = await fsp.readFile(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
          res.end(data);
        } catch {
          res.writeHead(404).end('Not found');
        }
        return;
      }
      const given = req.headers['x-freecode-token'] ?? url.searchParams.get('t');
      if (given !== token) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { error: 'expected application/json' });
        return;
      }
      const shot = req.method === 'GET' ? /^\/api\/shot\/([\w-]+\.jpg)$/.exec(p) : null;
      if (shot) {
        // Browser tool screenshots shown in the chat.
        const file = screenshotPath(shot[1]!);
        const data = file ? await fsp.readFile(file).catch(() => null) : null;
        if (!data) res.writeHead(404).end('Not found');
        else res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' }).end(data);
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
      switch (`${req.method} ${p}`) {
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          res.write(': connected\n\n');
          clients.add(res);
          const ping = setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {
              // closed
            }
          }, 20_000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        case 'GET /api/instance':
          return json(res, 200, { pid: process.pid, version: VERSION, projectRoot: controller.app.projectRoot, busy: controller.busy });
        case 'GET /api/state': {
          const st = await controller.state(true);
          st.pendingTrust = pendingTrust;
          return json(res, 200, st);
        }
        case 'POST /api/prompt': {
          // Pasted or dropped images: up to 4, each under 8 MB of base64.
          const images = (Array.isArray(body.images) ? body.images : [])
            .filter((im): im is { mediaType: string; data: string } => !!im && typeof im.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(String(im.mediaType)) && im.data.length < 8_000_000)
            .slice(0, 4)
            .map((im) => ({ mediaType: im.mediaType, data: im.data }));
          return json(res, 200, await controller.prompt(s('text'), images));
        }
        case 'POST /api/transcribe': {
          const audio = Buffer.from(s('audio'), 'base64');
          if (!audio.length || audio.length > 20_000_000) return json(res, 200, { ok: false, error: 'No audio, or the recording is too long.' });
          return json(res, 200, await transcribe(controller.app.providers, audio, s('mediaType'), s('language') || undefined));
        }
        case 'GET /api/index/projects':
          return json(res, 200, getIndex().projects());
        case 'POST /api/index/refresh':
          void getIndex().refresh();
          return json(res, 200, { ok: true });
        case 'GET /api/voice':
          return json(res, 200, { available: !!voiceProvider(controller.app.providers) });
        case 'POST /api/stop':
          controller.stop();
          return json(res, 200, { ok: true });
        case 'POST /api/respond':
          return json(res, 200, { ok: controller.respond(s('id'), body) });
        case 'POST /api/mode':
          controller.setMode(s('mode') as PermissionMode);
          return json(res, 200, { ok: true });
        case 'POST /api/model':
          return json(res, 200, controller.setModel(s('model') || 'auto'));
        case 'POST /api/command':
          return json(res, 200, await controller.command(s('name'), s('args')));
        case 'GET /api/sessions':
          return json(res, 200, await controller.sessions());
        case 'POST /api/sessions/resume':
          return json(res, 200, await controller.resume(s('id')));
        case 'GET /api/providers':
          return json(res, 200, await controller.providers());
        case 'POST /api/providers/key':
          return json(res, 200, await controller.saveKey(s('id'), s('key'), s('accountId') || undefined));
        case 'POST /api/providers/remove':
          controller.removeKey(s('id'));
          return json(res, 200, { ok: true });
        case 'POST /api/providers/enable':
          controller.setProviderEnabled(s('id'), body.enabled !== false);
          return json(res, 200, { ok: true });
        case 'POST /api/providers/test':
          return json(res, 200, await controller.testProvider(s('id')));
        case 'GET /api/models':
          return json(res, 200, controller.models());
        case 'POST /api/models/refresh':
          return json(res, 200, await controller.refreshModels());
        case 'POST /api/settings':
          controller.updateSettings((body.patch ?? {}) as Record<string, unknown>);
          return json(res, 200, { ok: true });
        case 'POST /api/permissions':
          controller.editRule(s('list') === 'deny' ? 'deny' : 'allow', s('rule'), body.remove === true);
          return json(res, 200, { ok: true });
        case 'POST /api/setup/complete':
          controller.completeSetup();
          return json(res, 200, { ok: true });
        case 'GET /api/files':
          return json(res, 200, await controller.files(url.searchParams.get('q') ?? ''));
        case 'GET /api/changes':
          return json(res, 200, await controller.changes());
        case 'GET /api/checkpoints':
          return json(res, 200, controller.checkpoints());
        case 'POST /api/rewind':
          return json(res, 200, await controller.rewind(typeof body.turn === 'number' ? body.turn : -1));
        case 'GET /api/fs':
          return json(res, 200, await controller.listDir(url.searchParams.get('path') ?? undefined));
        case 'POST /api/project': {
          const r = await controller.openProject(s('path'), typeof body.trust === 'boolean' ? body.trust : undefined);
          if (r.ok) pendingTrust = null;
          return json(res, 200, r);
        }
        case 'POST /api/trust': {
          const r = await controller.openProject(controller.app.projectRoot, body.trust === true);
          pendingTrust = null;
          return json(res, 200, r);
        }
        case 'GET /api/update':
          return json(res, 200, updater.state);
        case 'POST /api/update/check':
          return json(res, 200, await updater.check(readGlobalConfig().autoUpdate !== false));
        case 'POST /api/update/download':
          try {
            await updater.download();
            return json(res, 200, { ok: true, state: updater.state });
          } catch (e) {
            return json(res, 200, { ok: false, error: (e as Error).message });
          }
        case 'POST /api/update/install': {
          if (controller.busy) return json(res, 200, { ok: false, error: 'Stop the current task first.' });
          if (updater.state.status !== 'ready') return json(res, 200, { ok: false, error: 'No downloaded update yet.' });
          json(res, 200, { ok: true });
          // Let the page show "Updating…", then hand over to the setup (it reopens FreeCode).
          setTimeout(() => {
            process.stdout.write('FREECODE_UPDATING\n');
            if (updater.install()) setTimeout(() => process.exit(0), 400);
          }, 300);
          return;
        }
        case 'GET /api/skills': {
          const marketplaces = readGlobalConfig().skills?.marketplaces ?? DEFAULT_MARKETPLACES;
          const installed = loadSkills(controller.app.projectRoot).map((sk) => ({ ...sk, from: installedFrom(sk.dir) }));
          return json(res, 200, { installed, marketplaces });
        }
        case 'GET /api/skills/catalog': {
          const source = url.searchParams.get('source') ?? DEFAULT_MARKETPLACES[0]!;
          try {
            const cat = await fetchCatalog(source, url.searchParams.get('refresh') === '1');
            const have = new Set(loadSkills(controller.app.projectRoot).map((sk) => sk.name.toLowerCase()));
            return json(res, 200, { ...cat, skills: cat.skills.map((sk) => ({ ...sk, installed: have.has(sk.name.toLowerCase()) })) });
          } catch (e) {
            return json(res, 200, { source, skills: [], error: (e as Error).message });
          }
        }
        case 'POST /api/skills/install': {
          try {
            const r = await installSkill(s('source'), s('path'));
            clearSkillsCache();
            return json(res, 200, { ok: true, ...r });
          } catch (e) {
            return json(res, 200, { ok: false, error: (e as Error).message });
          }
        }
        case 'POST /api/skills/remove': {
          const ok = removeSkill(s('name'));
          clearSkillsCache();
          return json(res, 200, { ok });
        }
        case 'POST /api/skills/marketplaces': {
          const add = s('add').trim();
          const remove = s('remove').trim();
          if (add && !parseSource(add)) return json(res, 200, { ok: false, error: 'Use owner/repo or a github.com link' });
          const cfg = updateGlobalConfig((g) => {
            const list = g.skills?.marketplaces ?? [...DEFAULT_MARKETPLACES];
            const next = list.filter((m) => m !== remove);
            if (add && !next.includes(add)) next.push(add);
            g.skills = { ...(g.skills ?? {}), marketplaces: next };
          });
          return json(res, 200, { ok: true, marketplaces: cfg.skills?.marketplaces ?? [] });
        }
        case 'GET /api/launch': {
          const root = controller.app.projectRoot;
          const saved = controller.app.settings.runCommand;
          const detected = detectRunCommand(root);
          return json(res, 200, { targets: openTargets(root), run: saved ? { command: saved, source: 'saved' } : detected ? { command: detected, source: 'detected' } : null });
        }
        case 'POST /api/launch/file': {
          // A file:line reference clicked in the chat: resolve it inside the project and open it.
          const rel = s('path').replace(/^["']|["']$/g, '');
          const roots = [controller.app.session.cwd, controller.app.projectRoot];
          const file = path.isAbsolute(rel) ? rel : roots.map((r) => path.resolve(r, rel)).find((f) => existsSync(f)) ?? path.resolve(controller.app.projectRoot, rel);
          return json(res, 200, openFileAt(file, typeof body.line === 'number' ? body.line : undefined));
        }
        case 'POST /api/launch/open':
          return json(res, 200, await openIn(s('target'), controller.app.projectRoot));
        case 'POST /api/launch/run': {
          const root = controller.app.projectRoot;
          const command = s('command').trim() || controller.app.settings.runCommand || detectRunCommand(root) || '';
          if (!command) return json(res, 200, { ok: false, error: 'no-command' });
          if (body.save === true) {
            updateProjectSettings(root, (cfg) => {
              cfg.runCommand = command;
            });
            controller.app.settings.runCommand = command;
          }
          return json(res, 200, { ...runInTerminal(command, root), command });
        }
        case 'POST /api/open': {
          const u = s('url');
          if (/^https?:\/\//.test(u)) openInBrowser(u);
          return json(res, 200, { ok: true });
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      debug('server', 'request failed', e);
      try {
        json(res, 500, { error: (e as Error).message });
      } catch {
        // response already sent
      }
    }
  });

  const tryListen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });
  const preferred = opts.port ?? 7720;
  try {
    port = await tryListen(preferred);
  } catch {
    port = await tryListen(0);
  }
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return {
    url,
    token,
    port,
    controller,
    clientCount: () => clients.size,
    close: async () => {
      updater.stop();
      for (const c of clients) {
        try {
          c.end();
        } catch {
          // ignore
        }
      }
      controller.shutdown();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

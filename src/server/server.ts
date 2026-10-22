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
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
    if (size > 5 * 1024 * 1024) throw new Error('Request too large');
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
        case 'GET /api/state': {
          const st = await controller.state(true);
          st.pendingTrust = pendingTrust;
          return json(res, 200, st);
        }
        case 'POST /api/prompt':
          return json(res, 200, await controller.prompt(s('text')));
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
    close: async () => {
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

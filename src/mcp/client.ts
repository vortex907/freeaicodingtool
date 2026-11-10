// Minimal Model Context Protocol client (stdio and streamable HTTP transports).
import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '../config/config.js';
import { SseParser } from '../providers/sse.js';
import { VERSION } from '../version.js';
import { isWindows } from '../util/platform.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  status: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
  error?: string;
  tools: McpTool[] = [];
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  stderrTail = '';
  onToolsChanged?: () => void;

  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private sessionId?: string;

  constructor(
    public readonly name: string,
    private cfg: McpServerConfig,
    private projectRoot: string,
  ) {}

  get transport(): 'stdio' | 'http' {
    return this.cfg.url ? 'http' : 'stdio';
  }

  async start(): Promise<void> {
    try {
      if (this.transport === 'stdio') this.spawnStdio();
      const init = (await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'freecode', version: VERSION },
      }, 30_000)) as { serverInfo?: { name?: string; version?: string }; instructions?: string };
      this.serverInfo = init?.serverInfo;
      this.instructions = init?.instructions;
      await this.notify('notifications/initialized', {});
      await this.refreshTools();
      this.status = 'ready';
    } catch (e) {
      this.status = 'failed';
      this.error = (e as Error).message + (this.stderrTail ? `\n${this.stderrTail.slice(-500)}` : '');
      this.close();
      throw e;
    }
  }

  async refreshTools(): Promise<void> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, 30_000)) as { tools?: McpTool[]; nextCursor?: string };
      all.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.tools = all;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const timeout = this.cfg.timeoutMs ?? 300_000;
    const p = this.request('tools/call', { name, arguments: args }, timeout) as Promise<McpCallResult>;
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  close(): void {
    this.status = this.status === 'failed' ? 'failed' : 'closed';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server ${this.name} closed`));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin?.end();
        this.child.kill();
      } catch {
        // ignore
      }
    }
  }

  // ------------------------------------------------------------------ stdio

  private spawnStdio(): void {
    if (!this.cfg.command) throw new Error('MCP server config needs "command" or "url"');
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd ?? this.projectRoot,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows, // npx.cmd etc. on Windows
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handleMessage(line);
      }
    });
    child.stderr!.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString()).slice(-2000);
    });
    child.on('error', (e) => {
      this.error = e.message;
      this.status = 'failed';
      this.close();
    });
    child.on('exit', (code) => {
      if (this.status !== 'closed') {
        this.status = 'failed';
        this.error = `exited with code ${code}`;
      }
      this.close();
    });
  }

  private handleMessage(line: string): void {
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string; code?: number }; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // servers sometimes log to stdout
    }
    if (msg.method && msg.id !== undefined) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) {
      if (msg.method === 'notifications/tools/list_changed') {
        this.refreshTools().then(() => this.onToolsChanged?.(), () => undefined);
      }
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code}`));
    else p.resolve(msg.result);
  }

  private async handleServerRequest(id: number | string, method: string, _params: unknown): Promise<void> {
    let result: unknown;
    let error: { code: number; message: string } | undefined;
    if (method === 'ping') result = {};
    else if (method === 'roots/list') result = { roots: [{ uri: `file://${this.projectRoot}`, name: 'project' }] };
    else if (method === 'elicitation/create') result = { action: 'decline' };
    else error = { code: -32601, message: `Method not supported by FreeCode: ${method}` };
    await this.send({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  }

  // ------------------------------------------------------------------ transport-agnostic

  private async send(msg: Record<string, unknown>): Promise<unknown> {
    if (this.transport === 'stdio') {
      if (!this.child?.stdin?.writable) throw new Error(`MCP server ${this.name} is not running`);
      this.child.stdin.write(JSON.stringify(msg) + '\n');
      return undefined;
    }
    return this.postHttp(msg);
  }

  private async postHttp(msg: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.cfg.url!, { method: 'POST', headers, body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || msg.id === undefined) return undefined;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const parser = new SseParser();
      const text = await res.text();
      for (const ev of [...parser.push(text), ...parser.end()]) {
        try {
          const m = JSON.parse(ev.data);
          if (m.id === msg.id) this.handleMessage(ev.data);
          else if (m.method) this.handleMessage(ev.data);
        } catch {
          // ignore
        }
      }
      return undefined;
    }
    this.handleMessage(await res.text());
    return undefined;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: '2.0', method, params });
  }
}

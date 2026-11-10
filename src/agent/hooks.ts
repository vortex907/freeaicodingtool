// User-configured hooks: shell commands run on agent events (PreToolUse, PostToolUse, UserPromptSubmit,
// Stop, SessionStart). They receive a JSON payload on stdin. Exit code 2 blocks the action and the
// hook's stderr is shown to the model; other non-zero codes are reported as warnings.
import { spawn } from 'node:child_process';
import type { HookConfig, HookEvent, Settings } from '../config/config.js';
import { detectShell, isWindows } from '../util/platform.js';

export interface HookOutcome {
  blocked: boolean;
  /** Message explaining a block (sent to the model). */
  message?: string;
  /** Extra context to add (UserPromptSubmit / SessionStart stdout). */
  context: string[];
  warnings: string[];
}

function matches(h: HookConfig, value?: string): boolean {
  if (!h.matcher || h.matcher === '*' || !value) return true;
  try {
    return new RegExp(`^(?:${h.matcher})$`).test(value);
  } catch {
    return h.matcher === value;
  }
}

function runOne(h: HookConfig, payload: unknown, cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const sh = detectShell();
    const args = sh.kind === 'powershell' ? ['-NoProfile', '-Command', h.command] : sh.kind === 'cmd' ? ['/d', '/s', '/c', h.command] : ['-c', h.command];
    const child = spawn(sh.path, args, { cwd, env: { ...process.env, FREECODE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWindows });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      stderr += `\n[hook timed out after ${(h.timeoutMs ?? 60_000) / 1000}s]`;
    }, h.timeoutMs ?? 60_000);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: e.message });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runHooks(
  settings: Settings,
  event: HookEvent,
  payload: Record<string, unknown>,
  opts: { cwd: string; matchValue?: string; signal?: AbortSignal },
): Promise<HookOutcome> {
  const out: HookOutcome = { blocked: false, context: [], warnings: [] };
  const list = (settings.hooks?.[event] ?? []).filter((h) => h && h.command && matches(h, opts.matchValue));
  for (const h of list) {
    const r = await runOne(h, { hook_event_name: event, ...payload }, opts.cwd, opts.signal);
    if (r.code === 2) {
      out.blocked = true;
      out.message = r.stderr || r.stdout || `Blocked by ${event} hook`;
      break;
    }
    if (r.code !== 0) out.warnings.push(`${event} hook "${h.command}" failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`);
    else if (r.stdout && (event === 'UserPromptSubmit' || event === 'SessionStart')) out.context.push(r.stdout);
  }
  return out;
}

export function hasHooks(settings: Settings, event: HookEvent): boolean {
  return !!settings.hooks?.[event]?.length;
}

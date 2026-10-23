// Permission engine: decides whether a tool call runs, is denied, or needs the user's approval.
//
// Modes:  default      - reads run freely; edits, commands and fetches ask
//         acceptEdits  - file edits inside the project are auto-approved; commands still ask
//         plan         - read-only: no edits or side-effecting commands at all
//         bypassPermissions ("yolo") - everything runs without asking (catastrophic commands still ask)
// Rules:  "Tool", "Tool(specifier)". Bash(npm test) exact, Bash(npm run:*) prefix, Edit(src/**) glob,
//         WebFetch(domain:example.com), REPL(python), Debugger(node), mcp__server or mcp__server__tool.
import * as path from 'node:path';
import type { PermissionMode } from '../config/config.js';
import type { PermissionRequest } from '../tools/types.js';
import { dangerousCommandReason, isReadOnlyCommand, splitCommand } from './bashSafety.js';
import { matchGlob } from '../tools/glob.js';
import { isInside } from '../util/fs.js';

export type Decision = { action: 'allow' | 'deny' | 'ask'; reason?: string };

export interface ParsedRule {
  tool: string;
  spec?: string;
}

export function parseRule(rule: string): ParsedRule {
  const m = /^\s*([\w*.-]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
  if (!m) return { tool: rule.trim() };
  return { tool: m[1]!, spec: m[2]?.trim() || undefined };
}

function bashRuleMatches(spec: string, command: string): boolean {
  const cmd = command.trim();
  if (spec === '*' ) return true;
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    // Every chained part must be covered by the prefix rule to avoid "npm test && rm -rf ~" sneaking through.
    const parts = splitCommand(cmd);
    if (!parts) return false;
    return parts.every((p) => p === prefix || p.startsWith(prefix + ' '));
  }
  if (spec.endsWith('*')) return cmd.startsWith(spec.slice(0, -1)) && !!splitCommand(cmd) && splitCommand(cmd)!.length === 1;
  return cmd === spec;
}

export function ruleMatches(rule: string, req: PermissionRequest, projectRoot: string): boolean {
  const r = parseRule(rule);
  const tool = req.tool;
  const toolMatches =
    r.tool === '*' ||
    r.tool === tool ||
    // Edit rules cover all file-modifying tools
    (r.tool === 'Edit' && (tool === 'Write' || tool === 'MultiEdit' || (tool === 'LSP' && req.category === 'edit'))) ||
    (r.tool.startsWith('mcp__') && tool.startsWith(r.tool + '__')) ||
    (r.tool.startsWith('mcp__') && tool === r.tool);
  if (!toolMatches) return false;
  if (!r.spec) return true;
  if (tool === 'Bash') return req.command ? bashRuleMatches(r.spec, req.command) : false;
  if (req.category === 'edit' || tool === 'Read') {
    if (!req.path) return false;
    const rel = path.relative(projectRoot, req.path).split(path.sep).join('/');
    const spec = r.spec.replace(/^\.\//, '');
    if (path.isAbsolute(r.spec)) return matchGlob(r.spec.split(path.sep).join('/'), req.path.split(path.sep).join('/'));
    return matchGlob(spec, rel);
  }
  if (tool === 'WebFetch' || tool === 'Browser') {
    const d = r.spec.replace(/^domain:/, '');
    return !!req.domain && (req.domain === d || req.domain.endsWith('.' + d));
  }
  if (req.specifier !== undefined) return r.spec === '*' || r.spec === req.specifier;
  return r.spec === req.subject;
}

export interface PermissionContext {
  mode: PermissionMode;
  allow: string[];
  deny: string[];
  ask: string[];
  projectRoot: string;
  additionalDirectories: string[];
  /** Rules granted for this session only (not persisted). */
  sessionAllow: Set<string>;
  /** Non-interactive runs cannot ask: "ask" becomes "deny". */
  interactive: boolean;
}

/** Decides what to do with a tool call that requested permission. */
export function decide(req: PermissionRequest, ctx: PermissionContext): Decision {
  const root = ctx.projectRoot;
  // A multi-file edit is judged file by file: one denied file denies it, every file needs an allow.
  const each = req.paths?.length ? req.paths.map((p) => ({ ...req, path: p })) : [req];
  const anyMatch = (rule: string) => each.some((r) => ruleMatches(rule, r, root));
  for (const rule of ctx.deny) if (anyMatch(rule)) return { action: 'deny', reason: `blocked by rule ${rule}` };

  const danger = req.command ? dangerousCommandReason(req.command) : null;
  const finalize = (d: Decision): Decision => (d.action === 'ask' && !ctx.interactive ? { action: 'deny', reason: d.reason ?? 'needs approval (non-interactive run)' } : d);

  if (ctx.mode === 'plan') {
    if (req.category === 'edit') return { action: 'deny', reason: 'plan mode is read-only: present the plan with ExitPlanMode first' };
    if (req.category === 'execute') {
      if (req.command && isReadOnlyCommand(req.command)) return { action: 'allow' };
      return { action: 'deny', reason: 'plan mode is read-only: only read-only commands may run' };
    }
    if (req.category === 'mcp' && !req.readOnly) return { action: 'deny', reason: 'plan mode is read-only' };
  }

  if (danger) {
    for (const rule of [...ctx.allow, ...ctx.sessionAllow]) {
      const pr = parseRule(rule);
      // Only an exact rule for this very command overrides the danger check.
      if (pr.tool === 'Bash' && pr.spec === req.command?.trim()) return { action: 'allow' };
    }
    return finalize({ action: 'ask', reason: `this command ${danger}` });
  }

  for (const rule of ctx.ask) if (anyMatch(rule)) return finalize({ action: 'ask', reason: `rule ${rule}` });

  if (ctx.mode === 'bypassPermissions') return { action: 'allow' };

  const allowRules = [...ctx.allow, ...ctx.sessionAllow];
  const allowedBy = each.map((r) => allowRules.find((rule) => ruleMatches(rule, r, root)));
  if (allowedBy.every(Boolean)) return { action: 'allow', reason: `rule ${allowedBy[0]}` };

  switch (req.category) {
    case 'read':
    case 'meta':
      return { action: 'allow' };
    case 'network':
      if (req.tool === 'WebSearch' || req.readOnly) return { action: 'allow' };
      return finalize({ action: 'ask' });
    case 'edit': {
      const inside = each.every((r) => !!r.path && (isInside(r.path, root) || ctx.additionalDirectories.some((d) => isInside(r.path!, path.resolve(d)))));
      if (ctx.mode === 'acceptEdits' && inside) return { action: 'allow' };
      return finalize({ action: 'ask', reason: inside ? undefined : 'the file is outside the project' });
    }
    case 'execute':
      if (req.command && isReadOnlyCommand(req.command)) return { action: 'allow' };
      return finalize({ action: 'ask' });
    case 'mcp':
      if (req.readOnly) return { action: 'allow' };
      return finalize({ action: 'ask' });
    default:
      return finalize({ action: 'ask' });
  }
}

export const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept edits on';
    case 'plan':
      return 'plan mode on';
    case 'bypassPermissions':
      return 'bypass permissions on (yolo)';
    default:
      return 'default';
  }
}

export function parseMode(s: string): PermissionMode | null {
  const v = s.trim().toLowerCase();
  if (['default', 'normal', 'ask'].includes(v)) return 'default';
  if (['acceptedits', 'accept-edits', 'accept_edits', 'auto-edit', 'autoedit', 'edits'].includes(v)) return 'acceptEdits';
  if (v === 'plan') return 'plan';
  if (['bypasspermissions', 'bypass', 'yolo', 'auto', 'dangerously-skip-permissions'].includes(v)) return 'bypassPermissions';
  return null;
}
